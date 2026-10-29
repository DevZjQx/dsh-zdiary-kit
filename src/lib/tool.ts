/** 最小 JSON Schema 参数构造器 + 校验（工具定义只依赖这些，不 import 任何 dsh 包）。 */

export type SchemaNode = Record<string, unknown>

export const S = {
  str: (description: string): SchemaNode => ({ type: 'string', description }),
  num: (description: string): SchemaNode => ({ type: 'number', description }),
  bool: (description: string): SchemaNode => ({ type: 'boolean', description }),
  enum: (description: string, values: string[]): SchemaNode => ({ type: 'string', description, enum: values }),
  arr: (description: string, items: SchemaNode): SchemaNode => ({ type: 'array', description, items }),
  obj: (description: string, properties: Record<string, SchemaNode>, required: string[] = []): SchemaNode => ({
    type: 'object',
    description,
    properties,
    required,
    additionalProperties: false,
  }),
}

function typeOk(type: string, value: unknown): boolean {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'array': return Array.isArray(value)
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'null': return value === null
    default: return true
  }
}

/** 校验模型传来的参数；返回问题列表（空 = 通过）。DSH 对直接注册的裸工具不做输入校验，这里自己兜。 */
export function validateArgs(schema: SchemaNode, value: unknown, at = 'arguments'): string[] {
  const issues: string[] = []
  const oneOf = schema.oneOf
  if (Array.isArray(oneOf)) {
    const hits = oneOf.filter((branch) => validateArgs(branch as SchemaNode, value, at).length === 0)
    if (hits.length !== 1) issues.push(`${at} 必须正好匹配一种结构`)
    return issues
  }
  const type = typeof schema.type === 'string' ? schema.type : ''
  if (type && !typeOk(type, value)) {
    issues.push(`${at} 类型应为 ${type}`)
    return issues
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) {
    issues.push(`${at} 只能是：${(schema.enum as unknown[]).join(' / ')}`)
  }
  if ('const' in schema && schema.const !== value) issues.push(`${at} 只能是 ${String(schema.const)}`)

  if (type === 'object') {
    const obj = value as Record<string, unknown>
    const props = (schema.properties ?? {}) as Record<string, SchemaNode>
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (obj[key] === undefined || obj[key] === null) issues.push(`缺少必填参数 ${key}`)
    }
    for (const [key, sub] of Object.entries(props)) {
      if (obj[key] !== undefined && obj[key] !== null) issues.push(...validateArgs(sub, obj[key], `${at}.${key}`))
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) if (!(key in props)) issues.push(`不认识的参数 ${key}`)
    }
  }
  if (type === 'array' && schema.items) {
    const arr = value as unknown[]
    arr.forEach((item, i) => issues.push(...validateArgs(schema.items as SchemaNode, item, `${at}[${i}]`)))
  }
  return issues
}
