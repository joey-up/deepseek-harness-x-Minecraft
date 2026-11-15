/**
 * desktop-eye — 让 AI 看见并操作这台 Windows 电脑，并接入 dsh_minecraft 模组。
 *
 * 工具：
 *   screen_see / screen_act / screen_windows / screen_watch  截屏与真实键鼠
 *   mc_status / mc_state / mc_act / mc_chat_send             通过模组直接读写 MC
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { describeWatch, startWatch, stopAllWatches, stopWatch, watchEvents } = require('./watch.cjs')

const HERE = dirname(fileURLToPath(import.meta.url))
const HELPER = join(HERE, 'helper', 'screen_helper.py')
const MAX_FRAMES = 8

function pickTitle(messages, agentId) {
  const list = Array.isArray(messages) ? messages : []
  for (const message of list) {
    if (message?.role !== 'user') continue
    const text = message?.content?.find?.((block) => block.type === 'text')?.text
    if (!text) continue
    const clean = String(text).replace(/\s+/g, ' ').trim()
    if (/^This is an automatically/i.test(clean)) continue
    if (clean.startsWith('[MC chat]') || clean.startsWith('[MC聊天]')) continue
    return clean.slice(0, 24)
  }
  return String(agentId || '').slice(0, 8)
}

let activeBridgePort = 34567
function bridgeUrl(path = '') {
  return `http://127.0.0.1:${activeBridgePort}${path}`
}

function shotDir(config, cwd) {
  const configured = typeof config?.shotDir === 'string' && config.shotDir.trim() ? config.shotDir.trim() : ''
  if (configured) return resolve(configured)
  return join(cwd || process.cwd(), 'desktop-eye-shots')
}

const activeShotDirs = new Map()

function sessionCwd(ctx, exec) {
  try {
    if (ctx.workingDirectory && exec?.agent) {
      const cwd = ctx.workingDirectory.get(exec.agent)
      if (typeof cwd === 'string' && cwd) return cwd
    }
  } catch {}
  try {
    if (ctx.workingDirectory?.defaultDirectory) return ctx.workingDirectory.defaultDirectory
  } catch {}
  return process.cwd()
}

const PYTHON_CANDIDATES = [
  process.env.DSH_DESKTOP_EYE_PYTHON,
  process.env.DSH_PYTHON,
  join(process.env.USERPROFILE || '', '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
]

let pythonPath

async function resolvePython(config) {
  if (pythonPath) return pythonPath
  for (const candidate of [config?.python, ...PYTHON_CANDIDATES].filter((p) => typeof p === 'string' && p)) {
    if (!existsSync(candidate)) continue
    if (await probePython(candidate)) {
      pythonPath = candidate
      return pythonPath
    }
  }
  for (const name of ['python', 'py']) {
    if (await probePython(name)) {
      pythonPath = name
      return pythonPath
    }
  }
  throw new Error('desktop-eye: no Python with Pillow found')
}

async function probePython(exe) {
  try {
    return (await spawnIgnore(exe, ['-c', 'import PIL'], 15000)) === 0
  } catch {
    return false
  }
}

function spawnIgnore(exe, args, timeoutMs = 90000) {
  return new Promise((resolvePromise, reject) => {
    let child
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: 'ignore' })
    } catch (error) {
      reject(error)
      return
    }
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {}
      reject(new Error('desktop-eye: helper timeout'))
    }, timeoutMs)
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(code ?? 0)
    })
  })
}

let requestSeq = 0

async function callHelper(config, cwd, request) {
  const python = await resolvePython(config)
  const outdir = shotDir(config, cwd)
  await mkdir(outdir, { recursive: true })
  activeShotDirs.set(outdir, true)
  const box = join(outdir, '.requests')
  await mkdir(box, { recursive: true })
  requestSeq += 1
  const stamp = `${Date.now()}-${process.pid}-${requestSeq}`
  const reqPath = join(box, `req-${stamp}.json`)
  const resPath = join(box, `res-${stamp}.json`)
  await writeFile(reqPath, JSON.stringify({ ...request, outdir }), 'utf8')
  try {
    const code = await spawnIgnore(python, [HELPER, reqPath, resPath], 90000)
    const text = await readFile(resPath, 'utf8').catch(() => undefined)
    let parsed
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {}
    }
    if (parsed === undefined) throw new Error(`desktop-eye: helper returned nothing (exit ${code})`)
    if (!parsed.ok) throw new Error(`desktop-eye: ${parsed.error || 'unknown error'}`)
    return parsed
  } finally {
    unlink(reqPath).catch(() => {})
    unlink(resPath).catch(() => {})
  }
}

const pendingImages = new Map()

async function imagesFromFrames(attachments, frames, callId) {
  const blocks = []
  for (const [index, frame] of (frames || []).entries()) {
    const data = await readFile(frame.path).catch(() => undefined)
    if (!data) continue
    const ref = await attachments.saveImage({
      data,
      mediaType: 'image/png',
      name: `desktop-eye-${callId ? String(callId).slice(0, 8) : 'shot'}${(frames || []).length > 1 ? `-${index}` : ''}.png`,
    })
    blocks.push({ type: 'image', attachment: ref })
  }
  return blocks
}

function describeWindow(w) {
  if (!w) return 'no window'
  const title = w.title ? `"${w.title}"` : ''
  return `${title}${w.class ? ` class=${w.class}` : ''} hwnd=${w.hwnd} pid=${w.pid} @${w.x},${w.y} ${w.width}x${w.height}${w.foreground ? ' [foreground]' : ''}`
}

function textBlock(text) {
  return { type: 'text', text }
}

const FRAME_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'width', 'height', 'source'],
  properties: {
    path: { type: 'string' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    source: {
      type: 'object',
      additionalProperties: false,
      required: ['x', 'y', 'width', 'height'],
      properties: { x: { type: 'integer' }, y: { type: 'integer' }, width: { type: 'integer' }, height: { type: 'integer' } },
    },
  },
}

const WINDOW_OBJECT = {
  type: 'object',
  additionalProperties: true,
  properties: {
    hwnd: { type: 'integer' },
    title: { type: 'string' },
    class: { type: 'string' },
    pid: { type: 'integer' },
    x: { type: 'integer' },
    y: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    foreground: { type: 'boolean' },
    minimized: { type: 'boolean' },
    client: { type: 'object', additionalProperties: true },
  },
}

const WINDOW_OUTPUT = { oneOf: [{ type: 'null' }, WINDOW_OBJECT] }
const POINT = { type: 'object', additionalProperties: false, required: ['x', 'y'], properties: { x: { type: 'integer' }, y: { type: 'integer' } } }

const TARGET_DESCRIPTION = 'Target: desktop | game | focused | hwnd:<n> | title:<substr> | class:<name>. Default game.'

function renderEnvelope(value) {
  const lines = [
    `<screen target="${value.target}" resolved="${value.resolved || ''}" foreground_hwnd="${value.foreground ?? 0}" cursor="${value.cursor?.x ?? 0},${value.cursor?.y ?? 0}">`,
  ]
  if (value.hint) lines.push(`hint: ${value.hint}`)
  lines.push(`window: ${describeWindow(value.window)}`)
  if (value.game) lines.push(`game: ${describeWindow(value.game)}`)
  for (const [index, frame] of (value.frames || []).entries()) lines.push(`frame ${index}: ${frame.width}x${frame.height}px -> ${frame.path}`)
  lines.push('</screen>')
  return lines.join('\n')
}

function renderActEnvelope(value) {
  const lines = [`<act resolved="${value.resolved || ''}" focused="${value.focused ? 'yes' : 'no'}">`, `window: ${describeWindow(value.window)}`]
  if (value.done?.length) lines.push(`actions: ${value.done.join('; ')}`)
  lines.push('</act>')
  return lines.join('\n')
}

function seeTool(ctx, config) {
  return {
    name: 'screen_see',
    description: '截屏：整个桌面 / 指定窗口 / 前台窗口 / Minecraft 窗口，返回真实画面。默认 game。只读。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: { type: 'string', description: TARGET_DESCRIPTION },
        scale: { type: 'number' },
        max_width: { type: 'integer' },
        frames: { type: 'integer' },
        interval_ms: { type: 'integer' },
        region: {
          type: 'object',
          additionalProperties: false,
          required: ['x', 'y', 'width', 'height'],
          properties: { x: { type: 'integer' }, y: { type: 'integer' }, width: { type: 'integer' }, height: { type: 'integer' } },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'target', 'frames'],
        properties: {
          ok: { type: 'boolean' },
          target: { type: 'string' },
          resolved: { type: 'string' },
          window: WINDOW_OUTPUT,
          game: WINDOW_OUTPUT,
          foreground: { type: 'integer' },
          cursor: POINT,
          virtual_screen: { type: 'object', additionalProperties: true },
          frames: { type: 'array', items: FRAME_OUTPUT },
          hint: { type: 'string' },
        },
      },
      render(_args, value) {
        return [textBlock(renderEnvelope(value))]
      },
    },
    isConcurrencySafe: () => false,
    async execute(args = {}, exec) {
      const cwd = sessionCwd(ctx, exec)
      const target = typeof args.target === 'string' && args.target.trim() ? args.target.trim() : 'game'
      const request = {
        cmd: 'see',
        target,
        scale: clampNumber(args.scale, 1, 100, 75),
        max_width: clampNumber(args.max_width, 0, 100000, 0),
        frames: clampNumber(args.frames, 1, MAX_FRAMES, 1),
        interval_ms: clampNumber(args.interval_ms, 0, 10000, 350),
      }
      if (args.region && typeof args.region === 'object') request.region = args.region
      const result = await callHelper(config, cwd, request)
      const attachments = ctx.get('attachments')
      if (attachments === undefined) throw new Error('desktop-eye: no attachments service')
      const blocks = await imagesFromFrames(attachments, result.frames || [], exec?.callId)
      pendingImages.set(String(exec?.callId), { blocks })
      return {
        ok: true,
        target: result.target,
        resolved: result.resolved,
        window: result.window ?? null,
        game: result.game ?? null,
        foreground: result.foreground ?? 0,
        cursor: result.cursor ?? { x: 0, y: 0 },
        virtual_screen: result.virtual_screen ?? {},
        frames: result.frames || [],
        ...(result.hint ? { hint: result.hint } : {}),
      }
    },
    finalizeContent(exec, result) {
      if (result.isError) return undefined
      const value = result.value
      if (!value || !Array.isArray(value.frames)) return undefined
      const key = String(exec?.callId)
      const entry = pendingImages.get(key)
      pendingImages.delete(key)
      return [textBlock(renderEnvelope(value)), ...((entry && entry.blocks) || [])]
    },
  }
}

function actTool(ctx, config) {
  return {
    name: 'screen_act',
    description: '真实鼠标键盘：转视角、点击、WASD、打字。默认作用在 Minecraft 窗口；target=desktop 不切窗口。结束松开所有键。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['actions'],
      properties: {
        actions: {
          type: 'array',
          description:
            'look{dx,dy,duration_ms} / move_abs{x,y,duration_ms,curve_px} / move_by{dx,dy} / move{dx,dy,steps} / click{button,count,hold_ms} / key{key,ms} / keydown|keyup{key} / hold{key,ms} / type{text} / sleep{ms}.',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              type: { type: 'string' },
              dx: { type: 'integer' },
              dy: { type: 'integer' },
              x: { type: 'integer' },
              y: { type: 'integer' },
              steps: { type: 'integer' },
              duration_ms: { type: 'integer' },
              curve_px: { type: 'integer' },
              button: { type: 'string' },
              count: { type: 'integer' },
              hold_ms: { type: 'integer' },
              amount: { type: 'integer' },
              key: { type: 'string' },
              keys: { type: 'array', items: { type: 'string' } },
              ms: { type: 'integer' },
              text: { type: 'string' },
              delay_ms: { type: 'integer' },
            },
          },
        },
        target: { type: 'string', description: TARGET_DESCRIPTION },
        focus: { type: 'boolean' },
        capture: { type: 'string', enum: ['after', 'before', 'both', 'none'] },
        settle_ms: { type: 'integer' },
        scale: { type: 'number' },
        max_width: { type: 'integer' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'frames'],
        properties: {
          ok: { type: 'boolean' },
          resolved: { type: 'string' },
          window: WINDOW_OUTPUT,
          game: WINDOW_OUTPUT,
          focused: { type: 'boolean' },
          foreground: { type: 'integer' },
          cursor: POINT,
          done: { type: 'array', items: { type: 'string' } },
          frames: { type: 'array', items: FRAME_OUTPUT },
          before: { type: 'array', items: FRAME_OUTPUT },
        },
      },
      render(_args, value) {
        return [textBlock(renderActEnvelope(value))]
      },
    },
    isConcurrencySafe: () => false,
    async execute(args = {}, exec) {
      const cwd = sessionCwd(ctx, exec)
      const actions = Array.isArray(args.actions) ? args.actions : []
      if (actions.length === 0) throw new Error('screen_act: actions required')
      const target = typeof args.target === 'string' && args.target.trim() ? args.target.trim() : 'game'
      const capture = ['after', 'before', 'both', 'none'].includes(args.capture) ? args.capture : 'after'
      const scale = clampNumber(args.scale, 1, 100, 60)
      const maxWidth = clampNumber(args.max_width, 0, 100000, 0)
      const attachments = ctx.get('attachments')
      if (attachments === undefined) throw new Error('desktop-eye: no attachments service')
      const collect = async (shotTarget) => {
        const shot = await callHelper(config, cwd, { cmd: 'see', target: shotTarget, scale, max_width: maxWidth, frames: 1 })
        return shot.frames || []
      }
      let before = []
      if (capture === 'before' || capture === 'both') before = await collect(target)
      const result = await callHelper(config, cwd, {
        cmd: 'act',
        target,
        actions,
        focus: args.focus !== false,
        settle_ms: clampNumber(args.settle_ms, 0, 10000, 250),
        scale,
        max_width: maxWidth,
        capture: false,
      })
      let frames = []
      if (capture !== 'none') frames = await collect(result.window ? `hwnd:${result.window.hwnd}` : target)
      const blocks = await imagesFromFrames(attachments, [...before, ...frames], exec?.callId)
      pendingImages.set(String(exec?.callId), { blocks })
      return {
        ok: true,
        resolved: result.resolved,
        window: result.window ?? null,
        game: result.game ?? null,
        focused: result.focused === true,
        foreground: result.foreground ?? 0,
        cursor: result.cursor ?? { x: 0, y: 0 },
        done: result.done || [],
        frames,
        before,
      }
    },
    finalizeContent(exec, result) {
      if (result.isError) return undefined
      const value = result.value
      if (!value || !Array.isArray(value.frames)) return undefined
      const key = String(exec?.callId)
      const entry = pendingImages.get(key)
      pendingImages.delete(key)
      return [textBlock(renderActEnvelope(value)), ...((entry && entry.blocks) || [])]
    },
  }
}

function windowsTool(ctx, config) {
  return {
    name: 'screen_windows',
    description: '列出可见窗口（hwnd/title/class/pid/位置/是否前台），只读。',
    parameters: { type: 'object', additionalProperties: false, properties: { include_invisible: { type: 'boolean' } } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'windows'],
        properties: {
          ok: { type: 'boolean' },
          windows: { type: 'array', items: WINDOW_OBJECT },
          foreground: { type: 'integer' },
          cursor: POINT,
          virtual_screen: { type: 'object', additionalProperties: true },
        },
      },
      render(_args, value) {
        const lines = [`<windows count="${value.windows?.length ?? 0}">`]
        for (const [i, w] of (value.windows || []).slice(0, 60).entries()) lines.push(`${i}. ${describeWindow(w)}`)
        lines.push('</windows>')
        return [textBlock(lines.join('\n'))]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args = {}, exec) {
      const cwd = sessionCwd(ctx, exec)
      const result = await callHelper(config, cwd, { cmd: 'windows', include_invisible: args.include_invisible === true })
      return {
        ok: true,
        windows: (result.windows || []).slice(0, 200),
        foreground: result.foreground ?? 0,
        cursor: result.cursor ?? { x: 0, y: 0 },
        virtual_screen: result.virtual_screen ?? {},
      }
    },
  }
}

function watchTool(ctx, config) {
  return {
    name: 'screen_watch',
    description: '后台观察：定时截低清帧做像素差分，明显变化时唤醒当前会话复看。action=start/stop/status。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'status'] },
        target: { type: 'string' },
        interval_ms: { type: 'integer' },
        threshold: { type: 'number' },
        cooldown_ms: { type: 'integer' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'status'],
        properties: { ok: { type: 'boolean' }, status: { type: 'string' }, events: { type: 'array', items: { type: 'object', additionalProperties: true } } },
      },
      render(_args, value) {
        return [textBlock(`<watch>\n${value.status}\n</watch>`)]
      },
    },
    isConcurrencySafe: () => false,
    async execute(args = {}, exec) {
      const action = String(args.action || 'status').toLowerCase()
      const sessionId = String(exec?.agent?.id ?? '')
      if (action === 'start') {
        if (!sessionId) throw new Error('screen_watch: no session id')
        return { ok: true, status: startWatch({ ctx, config, callHelper, shotDir, sessionCwd }, args, exec), events: watchEvents() }
      }
      if (action === 'stop') return { ok: true, status: stopWatch(sessionId), events: watchEvents() }
      return { ok: true, status: sessionId ? describeWatch(sessionId) : 'no session', events: watchEvents() }
    },
  }
}

async function mcCall(path, init = {}) {
  let res
  try {
    res = await fetch(bridgeUrl(path), {
      ...init,
      signal: AbortSignal.timeout(4000),
      headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    })
  } catch (error) {
    throw new Error(`cannot reach MC bridge on 127.0.0.1:${activeBridgePort} (${error.message})`)
  }
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = { raw: text }
  }
  if (!res.ok) throw new Error(`MC bridge ${res.status}: ${data.error || text}`)
  return data
}

async function discoverBridges(from = 34567, to = 34580) {
  const found = []
  const tasks = []
  for (let port = from; port <= to; port += 1) {
    tasks.push(
      fetch(`http://127.0.0.1:${port}/ping`, { signal: AbortSignal.timeout(600) })
        .then(async (res) => {
          if (!res.ok) return
          const data = await res.json().catch(() => undefined)
          if (data && data.mod === 'dsh_minecraft') found.push({ port, ...data })
        })
        .catch(() => {}),
    )
  }
  await Promise.all(tasks)
  return found
}

function mcTools() {
  const textOut = (name) => ({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['ok', 'result'],
      properties: { ok: { type: 'boolean' }, result: { type: 'string' } },
    },
    render(_args, value) {
      return [textBlock(`<${name}>\n${value.result}\n</${name}>`)]
    },
  })

  return [
    {
      name: 'mc_status',
      description: '检查 dsh_minecraft 模组是否在线、允许查看/控制开关、绑定会话。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: textOut('mc_status'),
      isConcurrencySafe: () => true,
      async execute() {
        return { ok: true, result: JSON.stringify(await mcCall('/ping'), null, 2) }
      },
    },
    {
      name: 'mc_state',
      description: '读取 MC 玩家状态：坐标/朝向/血量/饥饿/维度/主手/当前界面。需要「允许查看」。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: textOut('mc_state'),
      isConcurrencySafe: () => true,
      async execute() {
        return { ok: true, result: JSON.stringify(await mcCall('/state'), null, 2) }
      },
    },
    {
      name: 'mc_act',
      description:
        '直接操作 MC（不受焦点影响）：look{dx,dy} / key{key,ms} / keydown / keyup / place / break / close / click{button} / chat{text} / stop。place/break 作用于准星方块。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: {
            type: 'object',
            additionalProperties: true,
            required: ['type'],
            properties: {
              type: { type: 'string' },
              dx: { type: 'number' },
              dy: { type: 'number' },
              key: { type: 'string' },
              ms: { type: 'integer' },
              button: { type: 'string' },
              text: { type: 'string' },
            },
          },
        },
      },
      output: textOut('mc_act'),
      isConcurrencySafe: () => false,
      async execute(args = {}) {
        const action = args.action && typeof args.action === 'object' ? args.action : undefined
        if (!action) throw new Error('mc_act: action required')
        return { ok: true, result: JSON.stringify(await mcCall('/action', { method: 'POST', body: JSON.stringify(action) })) }
      },
    },
    {
      name: 'mc_chat_send',
      description: '把一句话发到 MC 右上角聊天面板（游戏内可见）。用于回复玩家在游戏里按 Y 发来的消息。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string' } },
      },
      output: textOut('mc_chat_send'),
      isConcurrencySafe: () => true,
      async execute(args = {}) {
        if (typeof args.text !== 'string' || !args.text.trim()) throw new Error('mc_chat_send: text required')
        return { ok: true, result: JSON.stringify(await mcCall('/chat/send', { method: 'POST', body: JSON.stringify({ text: args.text }) })) }
      },
    },
  ]
}

function startMcChatBridge(ctx) {
  const agentList = () => (typeof ctx.get('agents')?.list === 'function' ? ctx.get('agents').list() : [])

  async function pushSessions() {
    try {
      const list = agentList().map((agent) => {
        let title = String(agent.id).slice(0, 8)
        try {
          const session = ctx.get('sessions')?.get?.(agent.id)
          const messages = session?.deriveMessages?.() ?? []
          title = pickTitle(messages, agent.id)
        } catch {}
        return { id: String(agent.id), title }
      })
      await fetch(bridgeUrl('/sessions'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ list }),
        signal: AbortSignal.timeout(3000),
      })
    } catch {}
  }

  async function pollChat() {
    try {
      const ping = await fetch(bridgeUrl('/ping'), { signal: AbortSignal.timeout(3000) })
      if (!ping.ok) return
      const info = await ping.json()
      const target = typeof info.targetAgentId === 'string' ? info.targetAgentId : ''
      if (!target) return
      const agent = ctx.get('agents')?.get?.(target)
      if (!agent || typeof agent.followup !== 'function' || agent.status === 'running') return
      const res = await fetch(bridgeUrl('/chat/poll'), { signal: AbortSignal.timeout(3000) })
      if (!res.ok) return
      const data = await res.json()
      for (const text of Array.isArray(data.messages) ? data.messages : []) {
        agent.followup({
          id: crypto.randomUUID(),
          role: 'user',
          content: [
            {
              type: 'text',
              text: `[MC chat] player in Minecraft says: ${text}\nReply only via mc_chat_send (one or two short sentences). Do not write prose in this DSH conversation.`,
            },
          ],
          source: { kind: 'user' },
        })
      }
    } catch {}
  }

  let chatTimer
  let sessionTimer
  try {
    chatTimer = setInterval(pollChat, 2500)
    chatTimer.unref?.()
    sessionTimer = setInterval(pushSessions, 20000)
    sessionTimer.unref?.()
    setTimeout(pushSessions, 3000).unref?.()
  } catch {}
  ctx.effect(() => () => {
    if (chatTimer) clearInterval(chatTimer)
    if (sessionTimer) clearInterval(sessionTimer)
  }, 'mc chat bridge')
}

function clampNumber(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n * 100) / 100))
}

export function apply(ctx, config = {}) {
  ctx.inject(['tools', 'attachments', 'workingDirectory'], (toolCtx) => {
    toolCtx.effect(() => {
      const disposers = [
        toolCtx.tools.register(seeTool(toolCtx, config)),
        toolCtx.tools.register(actTool(toolCtx, config)),
        toolCtx.tools.register(windowsTool(toolCtx, config)),
        toolCtx.tools.register(watchTool(toolCtx, config)),
        ...mcTools().map((definition) => toolCtx.tools.register(definition)),
      ]
      return () => {
        pendingImages.clear()
        stopAllWatches()
        for (const dispose of disposers) dispose()
      }
    }, 'desktop-eye tools')
  })

  ctx.inject(['agents', 'sessions'], (agentCtx) => {
    startMcChatBridge(agentCtx)
  })

  ctx.inject(['webServer'], (wsCtx) => {
    const server = wsCtx.webServer
    wsCtx.effect(() => {
      const json = (res, code, data) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(data))
      }
      const readBody = (req) =>
        new Promise((resolveBody) => {
          let data = ''
          req.on('data', (chunk) => (data += chunk))
          req.on('end', () => resolveBody(data))
        })
      const currentAgentInfo = () => {
        const list = typeof wsCtx.get('agents')?.list === 'function' ? wsCtx.get('agents').list() : []
        const agent = list[list.length - 1]
        if (!agent) return { id: '', title: '' }
        let title = String(agent.id).slice(0, 8)
        try {
          const session = wsCtx.get('sessions')?.get?.(agent.id)
          const messages = session?.deriveMessages?.() ?? []
          title = pickTitle(messages, agent.id)
        } catch {}
        return { id: String(agent.id), title }
      }
      const offCurrent = server.register({
        kind: 'exact',
        path: '/dsh-minecraft/current-session',
        handler: async (_req, res) => json(res, 200, currentAgentInfo()),
      })
      const offSessions = server.register({
        kind: 'exact',
        path: '/dsh-minecraft/sessions',
        handler: async (_req, res) => {
          const list = typeof wsCtx.get('agents')?.list === 'function' ? wsCtx.get('agents').list() : []
          const items = list.map((agent) => {
            let title = String(agent.id).slice(0, 8)
            try {
              const session = wsCtx.get('sessions')?.get?.(agent.id)
              const messages = session?.deriveMessages?.() ?? []
              title = pickTitle(messages, agent.id)
            } catch {}
            return { id: String(agent.id), title, status: agent.status }
          })
          json(res, 200, { list: items })
        },
      })
      const offDiscover = server.register({
        kind: 'exact',
        path: '/dsh-minecraft/discover',
        handler: async (_req, res) => json(res, 200, { list: await discoverBridges(), active: activeBridgePort }),
      })
      const offConnect = server.register({
        kind: 'exact',
        path: '/dsh-minecraft/connect',
        handler: async (req, res) => {
          try {
            const body = JSON.parse((await readBody(req)) || '{}')
            const port = Number(body.port)
            if (!Number.isInteger(port) || port < 1 || port > 65535) return json(res, 400, { ok: false, error: 'invalid port' })
            activeBridgePort = port
            const agentId = typeof body.agentId === 'string' && body.agentId ? body.agentId : currentAgentInfo().id
            if (agentId) {
              await fetch(bridgeUrl('/sessions'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ selected: agentId }),
                signal: AbortSignal.timeout(3000),
              }).catch(() => {})
            }
            json(res, 200, { ok: true, port, agentId })
          } catch (error) {
            json(res, 400, { ok: false, error: String(error && error.message) })
          }
        },
      })
      return () => {
        offCurrent()
        offSessions()
        offDiscover()
        offConnect()
      }
    }, 'dsh-minecraft web routes')
  })

  ctx.on?.('agent/disposed', (payload) => {
    try {
      if (payload?.agent?.id) stopWatch(String(payload.agent.id))
    } catch {}
  })

  ctx.effect(() => {
    const timer = setInterval(() => {
      for (const dir of activeShotDirs.keys()) cleanupShots(dir).catch(() => {})
    }, 10 * 60 * 1000)
    return () => clearInterval(timer)
  }, 'desktop-eye cleanup')
}

async function cleanupShots(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  const now = Date.now()
  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.png') continue
    const path = join(dir, entry.name)
    try {
      const info = await stat(path)
      if (now - info.mtimeMs > 6 * 60 * 60 * 1000) await unlink(path)
    } catch {}
  }
}

export const inject = []
