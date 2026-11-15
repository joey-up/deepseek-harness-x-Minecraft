/** 观察模块测试：假 agent + 真 helper，验证变化检测和 followup 被调用。 */
import { createRequire } from 'node:module'
import { startWatch, describeWatch, stopWatch, watchEvents } from './watch.cjs'
import { spawn } from 'node:child_process'
import { mkdir, writeFile, unlink, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const HELPER = join(HERE, 'helper', 'screen_helper.py')
const PY = join(process.env.USERPROFILE, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe')
const OUT = join(HERE, 'watch-test-shots')

let seq = 0
async function callHelper(config, cwd, request) {
  await mkdir(OUT, { recursive: true })
  seq += 1
  const reqPath = join(OUT, `req-${seq}.json`)
  const resPath = join(OUT, `res-${seq}.json`)
  await writeFile(reqPath, JSON.stringify({ ...request, outdir: OUT }), 'utf8')
  await new Promise((resolvePromise, reject) => {
    const child = spawn(PY, [HELPER, reqPath, resPath], { windowsHide: true, stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', (code) => resolvePromise(code))
  })
  const text = await readFile(resPath, 'utf8')
  await unlink(reqPath).catch(() => {})
  await unlink(resPath).catch(() => {})
  return JSON.parse(text)
}

const notifications = []
const agent = {
  id: 'test-session',
  status: 'idle',
  followup(message) {
    notifications.push(message)
  },
}

const deps = {
  ctx: { get: () => undefined },
  config: {},
  callHelper,
  shotDir: () => OUT,
  sessionCwd: () => HERE,
}

startWatch(deps, { target: 'desktop', interval_ms: 5000, threshold: 0.003, cooldown_ms: 30000 }, { agent })
console.log('started:', describeWatch('test-session').split('\n')[0])

// 第一帧已经截过；等 6 秒让第一轮 tick 完成，再换个前台窗口制造明显变化
await new Promise((r) => setTimeout(r, 6500))
console.log('after first tick:', describeWatch('test-session').split('\n').slice(0, 4).join(' | '))

// 用 PowerShell 把资源管理器拉到前台，制造画面变化
spawn('powershell', ['-NoProfile', '-Command', '(New-Object -ComObject WScript.Shell).AppActivate("deepseek") | Out-Null'], { windowsHide: true, stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 9000))

console.log('after change:', describeWatch('test-session'))
console.log('notifications:', notifications.length)
if (notifications.length > 0) {
  console.log('first message:', notifications[0].content[0].text.slice(0, 240))
}
stopWatch('test-session')
console.log('events:', watchEvents().map((e) => e.kind).join(','))
