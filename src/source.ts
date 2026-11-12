import { randomUUID } from 'node:crypto'
import { extractText, firstLine, truncate } from './util.js'
import type { SoftStatus } from './types.js'
import {
  DSH_CAPABILITIES,
  type SessionSource,
  type SourceCapabilities,
  type SourceDigest,
  type SourceKind,
  type SourceSessionLite,
} from './sources/types.js'

// 类型从 sources/types.ts 上来；这里继续 re-export，保持既有 import 路径可用。
export type { SourceDigest, SourceSessionLite }

export interface DshSourceOptions {
  ctx: any
}

/**
 * dsh 本机 session 的 SessionSource 实现。
 * 这一层只做「读/建/发/队列」的薄封装；状态推导在 status.ts，业务在 service.ts。
 */
export class DshSource implements SessionSource {
  readonly kind: SourceKind = 'dsh'
  readonly capabilities: SourceCapabilities = DSH_CAPABILITIES

  constructor(private readonly options: DshSourceOptions) {}

  private get ctx(): any {
    return this.options.ctx
  }

  private signal(): AbortSignal {
    return new AbortController().signal
  }

  async list(): Promise<SourceSessionLite[]> {
    const controller = this.ctx.sessionController
    const query = this.ctx.sessionQuery
    const [listValue, records] = await Promise.all([
      controller.list({}, this.signal()),
      query.listSessions(this.signal()),
    ])
    const summaries = new Map<string, any>()
    for (const item of listValue?.items ?? []) summaries.set(String(item.sessionId), item)
    const ids = new Set<string>()
    for (const item of listValue?.items ?? []) ids.add(String(item.sessionId))
    for (const record of records ?? []) ids.add(String(record.header?.id ?? ''))

    const titleMap = new Map<string, string>()
    try {
      const titles = await query.readTitleSnapshots([...ids], this.signal())
      for (const result of titles ?? []) {
        if (result?.status !== 'fulfilled') continue
        const title =
          result.value?.title?.title ??
          result.value?.title?.text ??
          result.value?.title?.snapshot?.title
        if (title) titleMap.set(String(result.sessionId), String(title))
      }
    } catch {
      // title is display-only; a failed batch must not break routing
    }

    const out: SourceSessionLite[] = []
    for (const id of ids) {
      const summary = summaries.get(id)
      const record = (records ?? []).find((item: any) => String(item.header?.id) === id)
      const header = record?.header ?? summary
      if (!header) continue
      const cwd = header.cwd ?? summary?.cwd
      out.push({
        sessionId: id,
        source: 'dsh',
        title: titleMap.get(id) ?? (cwd ? cwd.split(/[\\/]/).filter(Boolean).pop()! : `Session ${id.slice(0, 8)}`),
        cwd,
        agentPreset: header.agentPreset,
        parentSessionId: header.parentSession ?? summary?.parentSessionId,
        origin: header.origin ?? summary?.origin,
        live: Boolean(record?.live ?? summary?.agentAvailable),
        persisted: Boolean(record?.persisted ?? true),
        blank: Boolean(summary?.blank),
        running: Boolean(summary?.running),
        agentAvailable: Boolean(summary?.agentAvailable),
        updatedAt: Number(summary?.updatedAt ?? header.createdAt ?? Date.now()),
      })
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async observe(sessionId: string): Promise<any> {
    const query = this.ctx.sessionQuery
    try {
      if (typeof query.observeSession === 'function') {
        const observation = await query.observeSession(sessionId, { projectionMode: 'all' })
        return observation
      }
    } catch {
      // fall through to readSession
    }
    try {
      return await query.readSession(sessionId)
    } catch {
      return undefined
    }
  }

  async readEvents(sessionId: string): Promise<any[]> {
    const observed = await this.observe(sessionId)
    return Array.isArray(observed?.events) ? observed.events : []
  }

  async readDigest(sessionId: string, limit = 8): Promise<SourceDigest | undefined> {
    const observed = await this.observe(sessionId)
    if (!observed) return undefined
    const events = Array.isArray(observed.events) ? observed.events : []
    let lastActivityAt = 0
    let lastTurnOpen = false
    let lastTurnEndKind: string | undefined
    let softStatus: SoftStatus | undefined
    const messages: string[] = []
    for (const event of events) {
      lastActivityAt = Math.max(lastActivityAt, Number(event.time ?? 0))
      if (event.type === 'turn/start') lastTurnOpen = true
      if (event.type === 'turn/end') {
        lastTurnOpen = false
        lastTurnEndKind = event.data?.reason?.kind
      }
      if (event.type === 'user/message') {
        const text = extractText(event.data?.content)
        if (text) messages.push(`user: ${text}`)
      }
      if (event.type === 'assistant/message') {
        const text = extractText(event.data?.message?.content)
        if (text) messages.push(`assistant: ${text}`)
      }
    }
    const session = observed.session ?? observed.header
    return {
      sessionId,
      title: String(session?.title ?? session?.cwd ?? sessionId),
      events,
      softStatus,
      lastTurnOpen,
      lastTurnEndKind,
      lastActivityAt,
    }
  }

  async readUserMessages(sessionId: string, limit: number): Promise<string[]> {
    const events = await this.readEvents(sessionId)
    const out: string[] = []
    for (const event of events) {
      if (event.type !== 'user/message') continue
      const text = extractText(event.data?.content)
      if (!text) continue
      if (String(event.data?.source?.kind ?? '') !== 'user') continue
      out.push(truncate(text, 500))
    }
    return out.slice(-limit)
  }

  async create(cwd: string, agentPreset?: string): Promise<string> {
    const value = await this.ctx.sessionController.create({ cwd, agentPreset })
    return String(value.sessionId)
  }

  async prompt(sessionId: string, text: string, requestId: string): Promise<void> {
    await this.ctx.sessionController.prompt(
      {
        requestId,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      },
      this.signal(),
    )
  }

  async rename(sessionId: string, title: string): Promise<void> {
    try {
      await this.ctx.sessionController.rename({ sessionId, title: truncate(title, 80) })
    } catch {
      // naming is nonessential
    }
  }

  async cancel(sessionId: string): Promise<void> {
    try {
      await this.ctx.sessionController.cancel({ sessionId })
    } catch {
      // best effort
    }
  }

  async findQueuedMessage(
    sessionId: string,
    requestId: string,
  ): Promise<{ id: string; text: string } | undefined> {
    const observed = await this.observe(sessionId)
    const inbox = observed?.projections?.values?.inbox
    if (!inbox) return undefined
    const lists = [inbox['next-turn'], inbox['next-step']]
    for (const list of lists) {
      if (!Array.isArray(list)) continue
      for (const message of list) {
        if (String(message?.source?.rpcId ?? '') === requestId && message?.id) {
          return { id: String(message.id), text: extractText(message.content) }
        }
      }
    }
    return undefined
  }

  async removeQueued(sessionId: string, itemId: string): Promise<boolean> {
    try {
      await this.ctx.sessionController.updateQueue({
        sessionId,
        itemId,
        action: { kind: 'remove' },
      })
      return true
    } catch {
      return false
    }
  }

  async findDelivered(sessionId: string, requestId: string): Promise<boolean> {
    const events = await this.readEvents(sessionId)
    return events.some(
      (event) =>
        event.type === 'user/message' &&
        String(event.data?.source?.rpcId ?? '') === requestId,
    )
  }

  newRequestId(): string {
    return randomUUID()
  }
}

export function digestText(digest: SourceDigest | undefined, max = 1200): string {
  if (!digest) return ''
  const lines: string[] = []
  lines.push(`标题：${digest.title}`)
  const events = digest.events ?? []
  const relevant = events
    .filter((event) => event.type === 'user/message' || event.type === 'assistant/message')
    .slice(-8)
  for (const event of relevant) {
    const text =
      event.type === 'user/message'
        ? extractText(event.data?.content)
        : extractText(event.data?.message?.content)
    if (!text) continue
    lines.push(`${event.type === 'user/message' ? '用户' : '助手'}：${firstLine(text, 200)}`)
  }
  return truncate(lines.join('\n'), max)
}
