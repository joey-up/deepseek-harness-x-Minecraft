/** 检查三个工具注册时的 schema 是否合法：node validate-schema.mjs */
import { apply } from './index.js'
import { check } from './schema-guard.mjs'

const tools = new Map()
const fakeTools = {
  register(def) {
    tools.set(def.name, def)
    return () => tools.delete(def.name)
  },
}
const attachments = { async saveImage() { throw new Error('not used') } }
const fakeCtx = {
  tools: fakeTools,
  attachments,
  inject(_deps, fn) {
    fn(fakeCtx)
  },
  get(name) {
    return name === 'attachments' ? attachments : undefined
  },
  effect(fn) {
    return fn()
  },
}

let failure
try {
  apply(fakeCtx, {})
} catch (error) {
  failure = error
}
if (failure) {
  console.error('apply/register threw:', failure.message)
  process.exit(1)
}

console.log('registered tools:', [...tools.keys()].join(', '))
let bad = 0
for (const [name, def] of tools) {
  for (const [label, schema] of [
    ['parameters', def.parameters],
    ['output.schema', def.output?.schema],
  ]) {
    const violations = []
    check(schema, label, violations)
    if (violations.length === 0) console.log(`OK   ${name}.${label}`)
    else {
      bad++
      console.error(`FAIL ${name}.${label}:\n  ${violations.join('\n  ')}`)
    }
  }
  if (typeof def.execute !== 'function') {
    bad++
    console.error(`FAIL ${name}: no execute`)
  }
  if (typeof def.output?.render !== 'function') {
    bad++
    console.error(`FAIL ${name}: no output.render`)
  }
}
process.exit(bad === 0 ? 0 : 1)
