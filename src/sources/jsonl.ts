/**
 * 外部来源共用的 JSONL 读取工具。
 *
 * 原则：**只读尾部**。外部会话文件可能几十 MB（本机 Claude 有 185MB / 189 个文件），
 * 全量读会拖垮面板；这里只取最后 N 字节，并把"半行"丢掉，保证不会因为截断产生假事件。
 */
import { open, stat } from 'node:fs/promises'

const DEFAULT_TAIL_BYTES = 64 * 1024

export interface TailResult {
  /** 读到的完整行（已去掉因为截断而不完整的首行）。 */
  lines: string[]
  /** 文件字节数。 */
  size: number
  /** 修改时间（毫秒）。 */
  mtimeMs: number
  /** 是否只读了尾部（文件比预算大）。 */
  truncated: boolean
}

/** 读文件尾部若干字节，按行切开；读不到（权限/不存在）时返回 undefined。 */
export async function readTail(path: string, maxBytes = DEFAULT_TAIL_BYTES): Promise<TailResult | undefined> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return undefined
    const budget = Math.max(1024, Math.min(maxBytes, info.size))
    const start = Math.max(0, info.size - budget)
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(budget)
      let offset = 0
      while (offset < budget) {
        const read = await handle.read(buffer, offset, budget - offset, start + offset)
        if (read.bytesRead <= 0) break
        offset += read.bytesRead
      }
      let text = buffer.subarray(0, offset).toString('utf8')
      if (start > 0) {
        // 丢掉被截断的第一行（除非它正好是文件开头）
        const newline = text.indexOf('\n')
        text = newline >= 0 ? text.slice(newline + 1) : ''
      }
      const lines = text.split('\n').filter((line) => line.trim().length > 0)
      return { lines, size: info.size, mtimeMs: info.mtimeMs, truncated: start > 0 }
    } finally {
      await handle.close()
    }
  } catch {
    // EACCES / ENOENT / EISDIR：当作读不到，由调用方标 unreadable
    return undefined
  }
}

/** 读文件头部若干字节，按行切开（拿 session_meta / 首条事件用）。 */
export async function readHead(path: string, maxBytes = 16 * 1024): Promise<TailResult | undefined> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return undefined
    const budget = Math.max(1024, Math.min(maxBytes, info.size))
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(budget)
      let offset = 0
      while (offset < budget) {
        const read = await handle.read(buffer, offset, budget - offset, offset)
        if (read.bytesRead <= 0) break
        offset += read.bytesRead
      }
      let text = buffer.subarray(0, offset).toString('utf8')
      if (budget < info.size) {
        // 末尾可能是半行，丢掉
        const newline = text.lastIndexOf('\n')
        text = newline >= 0 ? text.slice(0, newline) : text
      }
      const lines = text.split('\n').filter((line) => line.trim().length > 0)
      return { lines, size: info.size, mtimeMs: info.mtimeMs, truncated: budget < info.size }
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}

export interface ParsedLines<T> {
  values: T[]
  /** JSON 解析失败的行数（格式漂移的早期信号）。 */
  bad: number
  /** 解析成功但不是对象的行数。 */
  skipped: number
}

/** 逐行 JSON 解析；坏行跳过并计数，绝不因为一行坏掉整个文件。 */
export function parseLines<T = any>(lines: readonly string[]): ParsedLines<T> {
  const values: T[] = []
  let bad = 0
  let skipped = 0
  for (const line of lines) {
    let value: any
    try {
      value = JSON.parse(line)
    } catch {
      bad += 1
      continue
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      skipped += 1
      continue
    }
    values.push(value as T)
  }
  return { values, bad, skipped }
}

/** 把 ISO 时间 / 秒级时间戳 / 毫秒时间戳统一成毫秒；无法识别返回 undefined。 */
export function toMillis(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // 秒级（10 位）自动升到毫秒
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** 限制并发地跑一组异步任务（避免一次打开几百个文件句柄）。 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let cursor = 0
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      out[index] = await worker(items[index] as T, index)
    }
  })
  await Promise.all(lanes)
  return out
}
