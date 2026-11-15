/**
 * 本地 schema 守卫：复刻 DSH 的 enforced JSON Schema 子集
 * （type/oneOf/properties/required/additionalProperties/items/enum/const + description/title/default/examples）。
 */

const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
const CONSTRAINT = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const ANNOTATION = new Set(['description', 'title', 'default', 'examples'])
const ONE_OF_SIBLINGS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']

function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 检查 schema 是否落在 DSH 支持的子集内；违约项追加到 violations。 */
export function check(schema, path, violations) {
  if (!isRecord(schema)) {
    violations.push(`${path} must be a schema object`)
    return
  }
  for (const key of Object.keys(schema)) {
    if (CONSTRAINT.has(key) || ANNOTATION.has(key)) continue
    violations.push(`${path}.${key} is not a supported keyword`)
  }
  const hasType = Object.hasOwn(schema, 'type')
  const hasOneOf = Object.hasOwn(schema, 'oneOf')
  if (hasType && hasOneOf) {
    violations.push(`${path} cannot declare both type and oneOf`)
    return
  }
  if (!hasType && !hasOneOf) {
    for (const key of ONE_OF_SIBLINGS) if (Object.hasOwn(schema, key)) violations.push(`${path}.${key} requires type or oneOf`)
    return
  }
  if (hasType) {
    if (!SCHEMA_TYPES.includes(schema.type)) violations.push(`${path}.type ${JSON.stringify(schema.type)} is not one of ${SCHEMA_TYPES.join('/')}`)
    if (Object.hasOwn(schema, 'enum') && (!Array.isArray(schema.enum) || schema.enum.length === 0)) violations.push(`${path}.enum must be a non-empty array`)
    if (Object.hasOwn(schema, 'const') && schema.const === undefined) violations.push(`${path}.const must be defined`)
    const t = schema.type
    if (t === 'object') {
      const props = Object.hasOwn(schema, 'properties') ? schema.properties : undefined
      if (props !== undefined) {
        if (!isRecord(props)) violations.push(`${path}.properties must be an object`)
        else for (const [key, child] of Object.entries(props)) check(child, `${path}.properties.${key}`, violations)
      }
      if (Object.hasOwn(schema, 'required')) {
        if (!Array.isArray(schema.required) || schema.required.some((k) => typeof k !== 'string')) violations.push(`${path}.required must be an array of strings`)
        else for (const key of schema.required) if (!props || !Object.hasOwn(props, key)) violations.push(`${path}.required names "${key}" which is not in properties`)
      }
      if (Object.hasOwn(schema, 'additionalProperties') && typeof schema.additionalProperties !== 'boolean') {
        violations.push(`${path}.additionalProperties must be a boolean`)
      }
    }
    if (t === 'array') {
      if (!Object.hasOwn(schema, 'items')) violations.push(`${path}.items is required for arrays`)
      else check(schema.items, `${path}.items`, violations)
    }
    return
  }
  for (const key of ONE_OF_SIBLINGS) if (Object.hasOwn(schema, key)) violations.push(`${path}.${key} is not supported beside oneOf`)
  if (!Array.isArray(schema.oneOf) || schema.oneOf.length !== 2) violations.push(`${path}.oneOf must have exactly two branches in this plugin`)
  else schema.oneOf.forEach((branch, index) => check(branch, `${path}.oneOf[${index}]`, violations))
}

/**
 * 极简值校验：只覆盖本插件用到的 type/required/additionalProperties/items/oneOf。
 * 返回违约描述数组。
 */
export function checkValue(schema, value, path = 'value') {
  const violations = []
  walkValue(schema, value, path, violations)
  return violations
}

function walkValue(schema, value, path, violations) {
  if (!isRecord(schema)) return
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((branch) => checkValue(branch, value, path).length === 0)
    if (matches.length !== 1) violations.push(`${path} must match exactly one oneOf branch (matched ${matches.length})`)
    return
  }
  const type = schema.type
  if (type === 'null') {
    if (value !== null) violations.push(`${path} must be null`)
    return
  }
  if (type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      violations.push(`${path} must be an object`)
      return
    }
    const props = schema.properties || {}
    for (const key of schema.required || []) if (!(key in value)) violations.push(`${path}.${key} is required`)
    for (const [key, child] of Object.entries(value)) {
      if (props[key]) walkValue(props[key], child, `${path}.${key}`, violations)
      else if (schema.additionalProperties === false) violations.push(`${path}.${key} is not allowed`)
    }
    return
  }
  if (type === 'array') {
    if (!Array.isArray(value)) {
      violations.push(`${path} must be an array`)
      return
    }
    value.forEach((item, index) => walkValue(schema.items, item, `${path}[${index}]`, violations))
    return
  }
  if (type === 'string' && typeof value !== 'string') violations.push(`${path} must be a string`)
  if (type === 'integer' && !(Number.isInteger(value) && Number.isFinite(value))) violations.push(`${path} must be an integer`)
  if (type === 'number' && !(typeof value === 'number' && Number.isFinite(value))) violations.push(`${path} must be a number`)
  if (type === 'boolean' && typeof value !== 'boolean') violations.push(`${path} must be a boolean`)
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) violations.push(`${path} must be one of ${JSON.stringify(schema.enum)}`)
}
