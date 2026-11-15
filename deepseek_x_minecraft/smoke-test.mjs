/** 离线冒烟测试：用假 ctx 注册工具，真实调用 screen_see / screen_windows / screen_act，并按输出 schema 校验返回值。 */
import { apply } from './index.js'
import { check, checkValue } from './schema-guard.mjs'

const tools = new Map()
const disposers = []
const fakeTools = {
  register(def) {
    tools.set(def.name, def)
    return () => tools.delete(def.name)
  },
}
const attachments = {
  async saveImage({ data, mediaType, name }) {
    return { attachmentId: `att-${name}-${data.length}`, mediaType, bytes: data.length, width: 100, height: 100, name }
  },
}
const fakeCtx = {
  tools: fakeTools,
  attachments,
  inject(_deps, fn) {
    fn(fakeCtx)
  },
  get(name) {
    if (name === 'attachments') return attachments
    if (name === 'tools') return fakeTools
    return undefined
  },
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
  },
  systemPrompt: { section() {} },
}

apply(fakeCtx, {})
console.log('tools:', [...tools.keys()].join(', '))

const exec = { callId: 'call-123', cwd: process.cwd(), signal: new AbortController().signal }

async function run(name, args, { validate = true } = {}) {
  const def = tools.get(name)
  const value = await def.execute(args, exec)
  if (validate) {
    const violations = checkValue(def.output.schema, value)
    if (violations.length > 0) {
      console.error(`\n=== ${name} OUTPUT SCHEMA FAIL ===\n${violations.join('\n')}`)
      process.exitCode = 1
    }
  }
  const content = await def.output.render(args, value)
  const finalContent = def.finalizeContent?.({ callId: exec.callId }, { isError: false, value, content }) ?? content
  const text = finalContent.find((b) => b.type === 'text')?.text ?? ''
  const images = finalContent.filter((b) => b.type === 'image')
  console.log(`\n=== ${name} ===`)
  console.log(text.slice(0, 700))
  console.log('images:', images.length)
  return { value, content: finalContent }
}

await run('screen_windows', {})
await run('screen_see', { target: 'desktop', scale: 30 })
await run('screen_act', { target: 'desktop', actions: [{ type: 'sleep', ms: 60 }], capture: 'after', settle_ms: 0, scale: 30 })
for (const dispose of disposers) dispose()
if (process.exitCode) console.error('smoke test had schema violations')
else console.log('\nsmoke test OK')
