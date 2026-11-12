/**
 * 复刻 dsh 0.2.2 的 `snapshotJsonValue` 规则（`@deepseek-ai/dsh-util-values`），
 * 用来在测试里断言「工具返回值能过 dsh 的输出校验」。
 *
 * 判为有损的情况：显式 undefined、非有限数字（NaN/Infinity/-0）、函数/symbol/bigint、
 * 类实例（含 Date/Map/Set）、稀疏数组或多出的自有键、循环引用、访问器属性/不可枚举属性。
 */
export function isLosslessJson(value: any, ancestors: Set<any> = new Set()): boolean {
  if (value === null) return true
  const type = typeof value
  if (type === 'string' || type === 'boolean') return true
  if (type === 'number') return Number.isFinite(value) && !Object.is(value, -0)
  if (type !== 'object') return false
  if (ancestors.has(value)) return false
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return false
      if (Reflect.ownKeys(value).length !== value.length + 1) return false
      for (let index = 0; index < value.length; index += 1) {
        if (!isLosslessJson(value[index], ancestors)) return false
      }
      return true
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return false
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor) return false
      if (!('value' in descriptor)) return false
      if (!descriptor.enumerable) return false
      if (!isLosslessJson(descriptor.value, ancestors)) return false
    }
    return true
  } finally {
    ancestors.delete(value)
  }
}

/** 列出第一处有损位置，方便断言失败时看清是哪个字段。 */
export function findLossyPath(value: any, path = '$', seen: Set<any> = new Set()): string | null {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return null
  if (type === 'number') {
    if (Number.isFinite(value) && !Object.is(value, -0)) return null
    return `${path} = ${String(value)}`
  }
  if (type !== 'object') return `${path} is ${type}`
  if (seen.has(value)) return `${path} is circular`
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const found = findLossyPath(value[index], `${path}[${index}]`, seen)
        if (found) return found
      }
      return null
    }
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) return `${path}.${key} is undefined`
      const found = findLossyPath(item, `${path}.${key}`, seen)
      if (found) return found
    }
    return null
  } finally {
    seen.delete(value)
  }
}
