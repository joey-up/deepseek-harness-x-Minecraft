/**
 * desktop-eye 的“持续观察”模块（CommonJS：由 index.js 用 createRequire 加载，避免 ESM 解析差异）。
 *
 * 每隔 N 秒截一帧低分辨率画面（截图时顺带和上一帧比较）：
 *   - 变化很小（鼠标动一下、视频字幕跳动）→ 什么都不做，不打扰、不花钱
 *   - 变化明显 → 通过 agent.followup() 叫醒当前会话的模型，让它亲自看一眼，
 *     由模型判断“这算不算关键事件”，算才在对话里开口。
 */

const { randomUUID } = require('node:crypto')

/** 每个会话的观察状态：sessionId -> record */
const watching = new Map()

/** 给界面上显示用的事件记录（最多保留 30 条）。 */
const recentEvents = []

function noteEvent(entry) {
  recentEvents.unshift({ at: Date.now(), ...entry })
  if (recentEvents.length > 30) recentEvents.length = 30
}

function makeNoticeMessage(text) {
  // UserMessage 的最小合法形状：role + content + source + id。
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function clamp(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

/**
 * 启动观察。
 * @param {object} deps - { ctx, config, callHelper, shotDir, sessionCwd }
 * @param {object} args - { target, interval_ms, threshold, cooldown_ms }
 * @param {object} exec - 当前工具执行上下文（拿 agent / cwd）
 */
function startWatch(deps, args, exec) {
  const { ctx, config, callHelper, shotDir, sessionCwd } = deps
  const agent = exec && exec.agent
  if (!agent) throw new Error('screen_watch: 拿不到当前会话的 agent，无法主动发话')
  const sessionId = String(agent.id || agent)
  if (watching.has(sessionId)) return describeWatch(sessionId) + '\n（已在观察中，先 stop 再改参数）'

  const target = args && typeof args.target === 'string' && args.target.trim() ? args.target.trim() : 'game'
  const intervalMs = clamp(args && args.interval_ms, 5000, 10 * 60 * 1000, 20000)
  const threshold = clamp(args && args.threshold, 0.001, 1, 0.02)
  const cooldownMs = clamp(args && args.cooldown_ms, 30 * 1000, 6 * 60 * 60 * 1000, 3 * 60 * 1000)
  const cwd = sessionCwd(ctx, exec)
  const dir = shotDir(config, cwd)

  const record = {
    sessionId,
    agent,
    target,
    intervalMs,
    threshold,
    cooldownMs,
    cwd,
    dir,
    running: true,
    timer: undefined,
    lastFrame: undefined,
    lastNotifiedAt: 0,
    checks: 0,
    notifications: 0,
    lastDiff: undefined,
    lastError: undefined,
    startedAt: Date.now(),
  }
  watching.set(sessionId, record)
  noteEvent({ kind: 'start', sessionId, target, intervalMs, threshold, cooldownMs })

  const tick = async () => {
    if (!record.running) return
    try {
      record.checks += 1
      const request = {
        cmd: 'see',
        target,
        scale: 18,
        max_width: 480,
        frames: 1,
        outdir: dir,
      }
      if (record.lastFrame) request.compare_with = record.lastFrame
      const shot = await callHelper(config, cwd, request)
      const frame = (shot.frames || [])[0]
      if (!frame) return
      record.lastFrame = frame.path
      const diff = frame.diff
      if (!diff) return
      record.lastDiff = { at: Date.now(), ...diff }
      if (!diff.changed) return
      if (Number(diff.diff_ratio || 0) < threshold) return
      const now = Date.now()
      if (now - record.lastNotifiedAt < cooldownMs) return
      if (typeof agent.followup !== 'function') {
        record.lastError = 'agent 不支持 followup，无法主动发话'
        return
      }
      // agent 正在跑就别再塞消息，等下一轮
      if (agent.status === 'running') return
      agent.followup(
        makeNoticeMessage(
          [
            '[desktop-eye 后台观察] 屏幕出现了明显变化。',
            `目标：${target}；变化像素占比：${(Number(diff.diff_ratio || 0) * 100).toFixed(1)}%。`,
            '请先用 screen_see 看一眼当前画面，判断是不是需要告诉用户的关键事件',
            '（死亡/掉线/挨打/弹窗/报错/聊天里有人找用户等）。',
            '如果不是关键事件，保持安静，不要发消息。如果是，用一句话简短提醒，并说明你看到了什么。',
          ].join('\n'),
        ),
      )
      record.lastNotifiedAt = now
      record.notifications += 1
      noteEvent({ kind: 'notify', sessionId, diffRatio: diff.diff_ratio, target })
    } catch (error) {
      record.lastError = String((error && error.message) || error)
    }
  }

  record.timer = setInterval(() => {
    tick().catch((error) => {
      record.lastError = String((error && error.message) || error)
    })
  }, intervalMs)
  if (typeof record.timer.unref === 'function') record.timer.unref()

  return describeWatch(sessionId)
}

function stopWatch(sessionId) {
  const record = watching.get(String(sessionId))
  if (!record) return '当前没有在观察。'
  record.running = false
  if (record.timer) clearInterval(record.timer)
  watching.delete(String(sessionId))
  noteEvent({ kind: 'stop', sessionId: String(sessionId) })
  return '已停止观察。'
}

function describeWatch(sessionId) {
  const record = watching.get(String(sessionId))
  if (!record) return '当前没有在观察。'
  const last = record.lastDiff
  const lastText = last
    ? `最近一次比较：变化像素 ${(Number(last.diff_ratio || 0) * 100).toFixed(1)}%，平均差 ${Number(last.mean_diff || 0).toFixed(2)}/255（${new Date(last.at).toLocaleTimeString('zh-CN')}）`
    : '还没完成第一次比较'
  return [
    `正在观察：target=${record.target}，每 ${Math.round(record.intervalMs / 1000)}s 截一帧并比较`,
    `已检查 ${record.checks} 次，主动提醒 ${record.notifications} 次`,
    `变化阈值 ${(record.threshold * 100).toFixed(1)}%，提醒冷却 ${Math.round(record.cooldownMs / 1000)}s`,
    lastText,
    record.lastError ? `最近错误：${record.lastError}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** 插件卸载 / 会话销毁时清掉所有计时器。 */
function stopAllWatches() {
  for (const record of watching.values()) {
    record.running = false
    if (record.timer) clearInterval(record.timer)
  }
  watching.clear()
}

function watchEvents() {
  return recentEvents.slice()
}

module.exports = { startWatch, stopWatch, describeWatch, stopAllWatches, watchEvents }
