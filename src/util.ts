import { createHash, randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'

export function now(): number {
  return Date.now()
}

export function uuid(): string {
  return randomUUID()
}

export function shortId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

export function hash(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 16)
}

export function stableStringify(value: any): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
}

/**
 * 工具返回值必须能无损通过 JSON 往返：dsh 0.2.2 起在 `snapshotJsonValue` 里硬校验，
 * 只要结果里出现显式 `undefined`（或 NaN/Infinity/Date 之类）整个工具调用就会被判
 * `INVALID_TOOL_OUTPUT: value is not lossless JSON`。
 *
 * 这里只做最小归一：深度去掉值为 `undefined` 的对象键（数组元素按 JSON 语义补 null）。
 * 其它类型原样保留——真出现 NaN/Date 属于新缺陷，宁可继续报错也不要静默改数据。
 */
export function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) =>
      item === undefined ? null : stripUndefined(item),
    ) as unknown as T
  }
  if (value !== null && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    // 只处理普通对象；类实例/Date 等保持原样，交给上层校验暴露问题。
    if (prototype === Object.prototype || prototype === null) {
      const out: any = {}
      for (const [key, item] of Object.entries(value as any)) {
        if (item === undefined) continue
        out[key] = stripUndefined(item)
      }
      return out as T
    }
  }
  return value
}

export function truncate(text: string, max: number): string {
  if (typeof text !== 'string') return ''
  if (max <= 0) return ''
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

export function asText(value: any): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function extractText(content: any): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return asText(content)
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return ''
      if (block.type === 'text') return String(block.text ?? '')
      if (block.type === 'reasoning') return ''
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

export function safeJson(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function normalizeError(error: any): string {
  if (!error) return ''
  if (typeof error === 'string') return error
  if (typeof error.message === 'string') return error.message
  return asText(error)
}

/**
 * 这条 turn 错误是不是「工具参数/输出格式」类的可恢复错误。
 *
 * 实例：worker 把 `done` 传成裸字符串，`butler_report_status` 的参数不是合法 JSON，
 * 整个 turn 报错。这种错误改一下参数就能继续，不该把派发判成终态 failed。
 */
export function isRecoverableTurnError(text: string, code?: string): boolean {
  const haystack = `${code ?? ''} ${text ?? ''}`
  return /INVALID_TOOL_OUTPUT|INVALID_TOOL_INPUT|INVALID_ARGUMENTS|TOOL_OUTCOME_UNKNOWN|unexpected token|is not valid json|invalid arguments|schema validation|参数格式/i.test(
    haystack,
  )
}

export async function canonicalPath(input: string, cwd?: string): Promise<string> {
  const resolved = path.isAbsolute(input)
    ? input
    : path.resolve(cwd ?? process.cwd(), input)
  try {
    return await realpath(resolved)
  } catch {
    return path.resolve(resolved)
  }
}

export async function isDirectory(input: string): Promise<boolean> {
  try {
    const info = await stat(input)
    return info.isDirectory()
  } catch {
    return false
  }
}

export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  if (rel === '') return true
  if (path.isAbsolute(rel)) return false
  // 只把「..」本身或「../x」当作父目录逃逸；`..cache` 这种合法子路径不算。
  return rel !== '..' && !rel.startsWith(`..${path.sep}`)
}

export function toRelative(parent: string, child: string): string {
  return path.relative(parent, child).split(path.sep).join('/')
}

export function matchGlob(pattern: string, relPath: string): boolean {
  const normalized = relPath.split(path.sep).join('/')
  try {
    const matches: any = (path as any).matchesGlob
    if (typeof matches === 'function') return matches(normalized, pattern)
  } catch {
    // fall through
  }
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*')
  try {
    return new RegExp(`^${escaped}$`).test(normalized)
  } catch {
    return false
  }
}

export function deepMerge<T>(base: T, patch: any): T {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) }
  for (const [key, value] of Object.entries(patch)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      out[key] &&
      typeof out[key] === 'object' &&
      !Array.isArray(out[key])
    ) {
      out[key] = deepMerge(out[key], value)
    } else if (value !== undefined) {
      out[key] = value
    }
  }
  return out
}

const SECRET_KEY = /(token|secret|password|passwd|authorization|cookie|credential|api[_-]?key|private[_-]?key)/i

export function redact(value: any, depth = 0): any {
  if (depth > 6) return '[deep]'
  if (value == null) return value
  if (typeof value === 'string') return truncate(value, 2000)
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1))
  const out: any = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redact(item, depth + 1)
  }
  return out
}

export function summarizeArgs(toolName: string, args: any): string {
  if (!args || typeof args !== 'object') return truncate(asText(args), 2000)
  if (toolName === 'write' || toolName === 'edit') {
    const file = args.file_path ?? args.path ?? '?'
    const content = String(args.content ?? args.new_string ?? '')
    return `${file} (${content.length} chars, sha1=${hash(content).slice(0, 8)})`
  }
  if (toolName === 'bash' || toolName === 'pwsh') {
    return truncate(String(args.command ?? ''), 2000)
  }
  try {
    return truncate(JSON.stringify(redact(args)), 2000)
  } catch {
    return truncate(asText(args), 2000)
  }
}

const SHELL_META = /[;&|><`$\n]|\$\(/

export function hasShellMeta(command: string): boolean {
  return SHELL_META.test(command)
}

export function firstLine(text: string, max = 160): string {
  return truncate(String(text || '').split('\n').find((line) => line.trim()) ?? '', max)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
