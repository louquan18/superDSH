/**
 * Claude Code 只读来源（二期 P1）。
 *
 * 只读三样东西：
 * - `~/.claude/projects/<slug>/<session-uuid>.jsonl`：会话事件流（只读尾部）
 * - `~/.claude/projects/<slug>/<session-uuid>/subagents/agent-*.jsonl`：子会话
 * - `~/.claude/sessions/<pid>.json`：活进程表（唯一可靠的 running/awaiting 信号）
 *
 * 绝不读 `sessions/<pid>.key`（peer 鉴权密钥），绝不写 `~/.claude`。
 * cwd 一律从事件里读——目录名是路径把 `/` 换成 `-`，反向不可靠。
 */
import { watch, type FSWatcher } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'
import type { HardStatus, SoftStatus } from '../types.js'
import {
  READ_ONLY_CAPABILITIES,
  withCapabilities,
  type SessionSource,
  type SourceCapabilities,
  type SourceDigest,
  type SourceKind,
  type SourceSessionLite,
} from './types.js'
import { mapLimit, parseLines, readHead, readTail, toMillis } from './jsonl.js'
import { extractText, firstLine, truncate } from '../util.js'

export interface ClaudeSourceConfig {
  enabled: boolean
  home?: string
  scanDays: number
  maxSessions: number
  tailBytes: number
  includeSubagents: boolean
  watch: boolean
}

export interface ClaudeSourceOptions {
  config: ClaudeSourceConfig
  /** 缓存失效时回调（service 用它清 session 缓存 + 广播面板）。 */
  onChange?: () => void
  now?: () => number
  /** 注入用（测试）；默认读 `<home>/projects`。 */
  projectsDir?: string
}

interface SessionMeta {
  sessionId: string
  title: string
  cwd?: string
  parentSessionId?: string
  isSubagent: boolean
  agentType?: string
  spawnDepth?: number
  lastKind?: string
  lastText?: string
  errorText?: string
  /** 最近事件的毫秒时间。 */
  lastEventAt?: number
  updatedAt: number
  /** 尾部解析出来的事件（dsh 形状，供 digest 用）。 */
  events: any[]
  bad: number
}

interface CacheEntry {
  size: number
  mtimeMs: number
  meta: SessionMeta
}

const EVENT_KINDS = new Set(['user', 'assistant', 'system', 'ai-title', 'summary', 'error'])

/** 命中这些文案说明 Claude 在等人确认（只读观测，不能代答）。 */
const PERMISSION_HINTS = ['permission', 'approve', 'allow', '确认', '授权', '批准']

export class ClaudeSource implements SessionSource {
  readonly kind: SourceKind = 'claude'
  readonly capabilities: SourceCapabilities = withCapabilities(READ_ONLY_CAPABILITIES, {
    subscribe: true,
    hardStatus: true,
  })

  private readonly config: ClaudeSourceConfig
  private readonly home: string
  private readonly projectsDir: string
  private readonly sessionsDir: string
  private readonly historyPath: string
  private readonly now: () => number
  private readonly onChange?: () => void

  private readonly cache = new Map<string, CacheEntry>()
  private historyCache: { mtimeMs: number; goals: Map<string, string> } | null = null
  private liveCache: { at: number; entries: Map<string, LiveEntry> } | null = null
  private watchers: FSWatcher[] = []
  private debounce: ReturnType<typeof setTimeout> | null = null
  private lastScan: { at: number; items: SourceSessionLite[] } | null = null

  constructor(options: ClaudeSourceOptions) {
    this.config = options.config
    this.home = options.config.home ?? path.join(homedir(), '.claude')
    this.projectsDir = options.projectsDir ?? path.join(this.home, 'projects')
    this.sessionsDir = path.join(this.home, 'sessions')
    this.historyPath = path.join(this.home, 'history.jsonl')
    this.now = options.now ?? (() => Date.now())
    this.onChange = options.onChange
  }

  /** 启动 fs.watch；失败（目录不存在/不支持）时静默降级到定时扫描。 */
  start(): void {
    if (!this.config.watch || this.watchers.length > 0) return
    for (const dir of [this.projectsDir, this.sessionsDir]) {
      try {
        const watcher = watch(dir, { persistent: false }, () => this.invalidate())
        watcher.on('error', () => undefined)
        this.watchers.push(watcher)
      } catch {
        // 目录不存在：只靠 15s 定时扫描
      }
    }
  }

  dispose(): void {
    for (const watcher of this.watchers) {
      try {
        watcher.close()
      } catch {
        // ignore
      }
    }
    this.watchers = []
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = null
    this.cache.clear()
    this.lastScan = null
  }

  /** 清缓存并（去抖后）通知上层刷新。 */
  private invalidate(): void {
    this.cache.clear()
    this.liveCache = null
    this.lastScan = null
    if (!this.onChange) return
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.debounce = null
      try {
        this.onChange?.()
      } catch {
        // 上层回调失败不影响读取
      }
    }, 500)
    this.debounce.unref?.()
  }

  async list(): Promise<SourceSessionLite[]> {
    const candidates = await this.collectFiles()
    const goals = await this.goals()
    const live = await this.liveSessions()
    const metas = await mapLimit(candidates, 8, async (file) => {
      const meta = await this.readMeta(file.path, file.sessionId, file.parentSessionId)
      return meta ? { meta, file } : undefined
    })

    const items: SourceSessionLite[] = []
    for (const entry of metas) {
      if (!entry) continue
      const { meta } = entry
      if (!meta.cwd) continue
      const liveEntry = live.get(meta.sessionId)
      const status = inferStatus({
        meta,
        live: liveEntry,
        now: this.now(),
      })
      items.push({
        sessionId: meta.sessionId,
        source: 'claude',
        title: meta.title || goals.get(meta.sessionId) || `Claude ${meta.sessionId.slice(0, 8)}`,
        cwd: meta.cwd,
        parentSessionId: meta.parentSessionId,
        origin: meta.isSubagent ? 'subagent' : 'claude',
        live: Boolean(status.live),
        persisted: true,
        blank: false,
        running: status.running,
        agentAvailable: Boolean(status.live),
        updatedAt: meta.updatedAt,
        hardStatus: status.hardStatus,
        softStatus: this.softStatusFor(meta, status, goals.get(meta.sessionId)),
      })
    }
    items.sort((a, b) => b.updatedAt - a.updatedAt)
    this.lastScan = { at: this.now(), items }
    return items
  }

  /** 最近一次扫描结果（readDigest/readEvents 复用，避免重复读盘）。 */
  private async snapshotItems(): Promise<SourceSessionLite[]> {
    if (this.lastScan && this.now() - this.lastScan.at < 5000) return this.lastScan.items
    return this.list()
  }

  async readDigest(sessionId: string, limit = 8): Promise<SourceDigest | undefined> {
    const meta = await this.metaFor(sessionId)
    if (!meta) return undefined
    const items = await this.snapshotItems()
    const lite = items.find((item) => item.sessionId === sessionId)
    return {
      sessionId,
      title: meta.title,
      events: meta.events.slice(-Math.max(1, limit)),
      softStatus: lite?.softStatus,
      lastTurnOpen: lite?.running === true,
      lastTurnEndKind: meta.lastKind,
      lastActivityAt: meta.updatedAt,
    }
  }

  async readEvents(sessionId: string): Promise<any[]> {
    const meta = await this.metaFor(sessionId)
    return meta?.events ?? []
  }

  async observe(sessionId: string): Promise<any> {
    const meta = await this.metaFor(sessionId)
    if (!meta) return undefined
    const live = (await this.liveSessions()).get(sessionId)
    return {
      header: { id: sessionId, cwd: meta.cwd, createdAt: meta.lastEventAt ?? meta.updatedAt },
      events: meta.events,
      projections: {
        values: {
          workingDirectory: meta.cwd ?? null,
          claudeStatus: live?.status ?? null,
        },
      },
    }
  }

  async readUserMessages(sessionId: string, limit: number): Promise<string[]> {
    const meta = await this.metaFor(sessionId)
    if (!meta) return []
    const messages = meta.events
      .filter((event) => event.type === 'user/message')
      .map((event) => extractText(event.data?.content))
      .filter(Boolean)
    return messages.slice(-Math.max(1, limit))
  }

  newRequestId(): string {
    return `claude-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }

  // ---- 只读来源：写操作必须显式失败，不能"看起来能调" ----

  async prompt(): Promise<never> {
    throw new Error('claude 来源是只读的：不支持投递消息（capabilities.send=false）')
  }

  async create(): Promise<never> {
    throw new Error('claude 来源是只读的：不支持新建会话（capabilities.create=false）')
  }

  async rename(): Promise<void> {
    // 改标题是 dsh 的能力；claude 侧不支持，静默跳过（上层只在 create 后用）
  }

  async cancel(): Promise<void> {
    // 不能取消别人的回合
  }

  async findQueuedMessage(): Promise<undefined> {
    return undefined
  }

  async removeQueued(): Promise<boolean> {
    return false
  }

  async findDelivered(): Promise<boolean> {
    return false
  }

  // ---------------------------------------------------------------- 扫描实现

  private async collectFiles(): Promise<
    Array<{ path: string; sessionId: string; parentSessionId?: string }>
  > {
    const cutoff = this.now() - Math.max(1, this.config.scanDays) * 24 * 60 * 60_000
    const out: Array<{ path: string; sessionId: string; parentSessionId?: string }> = []
    let projects: string[] = []
    try {
      projects = (await readdir(this.projectsDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name !== 'memory')
        .map((entry) => entry.name)
    } catch {
      return out
    }

    for (const project of projects) {
      if (out.length >= this.config.maxSessions) break
      const dir = path.join(this.projectsDir, project)
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (out.length >= this.config.maxSessions) break
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          const sessionId = entry.name.slice(0, -'.jsonl'.length)
          out.push({ path: path.join(dir, entry.name), sessionId })
          continue
        }
        if (!this.config.includeSubagents || !entry.isDirectory()) continue
        // <root-uuid>/subagents/agent-*.jsonl
        const subagents = path.join(dir, entry.name, 'subagents')
        let files
        try {
          files = await readdir(subagents, { withFileTypes: true })
        } catch {
          continue
        }
        for (const file of files) {
          if (!file.isFile() || !file.name.endsWith('.jsonl')) continue
          if (out.length >= this.config.maxSessions) break
          out.push({
            path: path.join(subagents, file.name),
            // per-record key 只允许 [A-Za-z0-9_-]，这里绝不能拼 ':'（会把整个插件拖挂）
            sessionId: `${entry.name}-${file.name.slice(0, -'.jsonl'.length)}`,
            parentSessionId: entry.name,
          })
        }
      }
    }

    // 按 mtime 过滤掉太老的会话（避免读 189 个历史文件）
    const kept: typeof out = []
    for (const item of out) {
      try {
        const tail = await readTail(item.path, 1024)
        if (!tail) continue
        if (tail.mtimeMs < cutoff) continue
        kept.push(item)
      } catch {
        // 读不到就跳过
      }
    }
    return kept
  }

  private async readMeta(
    file: string,
    sessionId: string,
    parentSessionId?: string,
  ): Promise<SessionMeta | undefined> {
    // 先取 stat 判断缓存是否还有效：用尾部读取一次性拿到 size/mtime
    const tail = await readTail(file, this.config.tailBytes)
    if (!tail) return undefined
    const cached = this.cache.get(file)
    if (cached && cached.size === tail.size && cached.mtimeMs === tail.mtimeMs) {
      return cached.meta
    }

    const parsed = parseLines<any>(tail.lines)
    let title = ''
    let cwd: string | undefined
    let lastKind: string | undefined
    let lastText: string | undefined
    let errorText: string | undefined
    let lastEventAt: number | undefined
    let agentType: string | undefined
    let spawnDepth: number | undefined
    const events: any[] = []

    for (const event of parsed.values) {
      const kind = String(event?.type ?? '')
      const at = toMillis(event?.timestamp)
      if (at !== undefined) lastEventAt = Math.max(lastEventAt ?? 0, at)
      if (typeof event?.cwd === 'string' && event.cwd) cwd = event.cwd

      if (kind === 'ai-title') {
        const aiTitle = String(event?.aiTitle ?? '').trim()
        if (aiTitle) title = aiTitle
        continue
      }
      if (kind === 'summary') {
        if (!title && event?.summary) title = truncate(String(event.summary), 60)
        continue
      }
      if (!EVENT_KINDS.has(kind)) continue

      // 子会话 meta（agent-*.jsonl 第一行可能是 {agentType, description, name, spawnDepth}）
      if (!kind && typeof event?.agentType === 'string') {
        agentType = String(event.agentType)
        spawnDepth = typeof event?.spawnDepth === 'number' ? event.spawnDepth : undefined
        if (!title && event?.description) title = truncate(String(event.description), 60)
        continue
      }

      if (kind === 'user' && event?.isMeta !== true) {
        const text = extractText(event?.message?.content)
        if (text) {
          lastKind = 'user'
          lastText = text
        }
        events.push({
          type: 'user/message',
          time: at ?? 0,
          data: { content: [{ type: 'text', text }] },
        })
        continue
      }
      if (kind === 'assistant') {
        const text = extractText(event?.message?.content)
        if (text) {
          lastKind = 'assistant'
          lastText = text
        }
        const isError = event?.isApiErrorMessage === true || event?.message?.type === 'error'
        if (isError) {
          errorText = text || 'Claude 返回错误'
          lastKind = 'error'
        }
        if (!title && text && events.length === 0) title = truncate(firstLine(text, 60), 60)
        events.push({
          type: 'assistant/message',
          time: at ?? 0,
          data: { message: { content: [{ type: 'text', text }] } },
        })
        continue
      }
      if (kind === 'system' && String(event?.level ?? '') === 'error') {
        errorText = String(event?.content ?? 'system error')
        lastKind = 'error'
      }
      if (kind === 'error') {
        errorText = String(event?.message ?? event?.content ?? 'error')
        lastKind = 'error'
      }
    }

    // 尾部没覆盖到 cwd 时，读头部第一条事件补
    if (!cwd) {
      const head = await readHead(file, 16 * 1024)
      if (head) {
        const headParsed = parseLines<any>(head.lines)
        for (const event of headParsed.values) {
          if (typeof event?.cwd === 'string' && event.cwd) {
            cwd = event.cwd
            break
          }
        }
      }
    }

    // 子会话的 meta.json 里有 agentType / description，比 jsonl 首行更可靠
    if (parentSessionId && !agentType) {
      const metaFile = file.replace(/\.jsonl$/, '.meta.json')
      const metaHead = await readHead(metaFile, 4096)
      if (metaHead?.lines[0]) {
        try {
          const parsedMeta = JSON.parse(metaHead.lines[0])
          agentType = typeof parsedMeta?.agentType === 'string' ? parsedMeta.agentType : undefined
          spawnDepth = typeof parsedMeta?.spawnDepth === 'number' ? parsedMeta.spawnDepth : undefined
          if (!title && parsedMeta?.description) title = truncate(String(parsedMeta.description), 60)
        } catch {
          // 坏 meta 不影响主流程
        }
      }
    }

    const meta: SessionMeta = {
      sessionId,
      title,
      cwd,
      parentSessionId,
      isSubagent: Boolean(parentSessionId),
      agentType,
      spawnDepth,
      lastKind,
      lastText,
      errorText,
      lastEventAt,
      updatedAt: Math.max(tail.mtimeMs, lastEventAt ?? 0),
      events: events.slice(-40),
      bad: parsed.bad,
    }
    this.cache.set(file, { size: tail.size, mtimeMs: tail.mtimeMs, meta })
    return meta
  }

  private async metaFor(sessionId: string): Promise<SessionMeta | undefined> {
    // 子会话 id 形如 <root-uuid>-agent-xxxx；两种形式都要能找回原文件
    const wanted = sessionId
    const candidates = await this.collectFiles()
    const hit = candidates.find(
      (item) => item.sessionId === sessionId || path.basename(item.path).startsWith(wanted),
    )
    if (!hit) return undefined
    return this.readMeta(hit.path, hit.sessionId, hit.parentSessionId)
  }

  /** 每个 session 的第一条用户提示（goal），来自 history.jsonl，一次读入按 mtime 缓存。 */
  private async goals(): Promise<Map<string, string>> {
    const goals = new Map<string, string>()
    const head = await readHead(this.historyPath, 4 * 1024 * 1024)
    if (!head) return goals
    if (this.historyCache && this.historyCache.mtimeMs === head.mtimeMs) return this.historyCache.goals
    const parsed = parseLines<any>(head.lines)
    for (const entry of parsed.values) {
      const id = String(entry?.sessionId ?? '')
      if (!id) continue
      const display = String(entry?.display ?? '').trim()
      if (!display) continue
      if (!goals.has(id)) goals.set(id, truncate(firstLine(display, 80), 80))
    }
    this.historyCache = { mtimeMs: head.mtimeMs, goals }
    return goals
  }

  /** 活进程表：`~/.claude/sessions/<pid>.json`（按 5s 缓存，目录很小）。 */
  private async liveSessions(): Promise<Map<string, LiveEntry>> {
    if (this.liveCache && this.now() - this.liveCache.at < 5000) return this.liveCache.entries
    const entries = new Map<string, LiveEntry>()
    let files: string[] = []
    try {
      files = (await readdir(this.sessionsDir)).filter((name) => name.endsWith('.json'))
    } catch {
      files = []
    }
    for (const name of files) {
      const head = await readHead(path.join(this.sessionsDir, name), 8192)
      if (!head?.lines[0]) continue
      try {
        const raw = JSON.parse(head.lines[0])
        const sessionId = String(raw?.sessionId ?? '')
        if (!sessionId) continue
        const pid = Number(raw?.pid ?? 0)
        entries.set(sessionId, {
          pid,
          alive: pid > 0 ? pidAlive(pid) : false,
          status: String(raw?.status ?? ''),
          waitingFor: raw?.waitingFor ? String(raw.waitingFor) : undefined,
          cwd: raw?.cwd ? String(raw.cwd) : undefined,
          kind: raw?.kind ? String(raw.kind) : undefined,
          updatedAt: Number(raw?.updatedAt ?? 0),
          name: raw?.name ? String(raw.name) : undefined,
        })
      } catch {
        // 坏文件跳过
      }
    }
    this.liveCache = { at: this.now(), entries }
    return entries
  }

  private softStatusFor(
    meta: SessionMeta,
    status: { hardStatus: HardStatus },
    goal: string | undefined,
  ): SoftStatus | undefined {
    // 只读来源：done/next 不臆造（保持空），blockers 只写能确证的事实
    const blockers: string[] = []
    if (status.hardStatus === 'awaiting_approval') blockers.push('在 Claude Code 里等待你确认权限')
    if (status.hardStatus === 'error' && meta.errorText) blockers.push(truncate(meta.errorText, 160))
    if (!goal && !meta.lastText && blockers.length === 0) return undefined
    return {
      goal: goal ?? truncate(firstLine(meta.lastText ?? '', 80), 80),
      done: [],
      next: [],
      blockers,
      decisions: [],
      reportedAt: meta.updatedAt,
      source: 'log-digest',
    }
  }
}

interface LiveEntry {
  pid: number
  alive: boolean
  status: string
  waitingFor?: string
  cwd?: string
  kind?: string
  updatedAt: number
  name?: string
}

/** pid 是否还活着（EPERM 说明存在但不属于我们）。 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: any) {
    return error?.code === 'EPERM'
  }
}

export function inferStatus(input: {
  meta: SessionMeta
  live?: LiveEntry
  now: number
}): { hardStatus: HardStatus; running: boolean; live: boolean } {
  const { meta, live, now } = input
  const alive = live?.alive === true
  if (alive) {
    const status = live?.status ?? ''
    if (status === 'shell') return { hardStatus: 'running', running: true, live: true }
    if (status === 'waiting') {
      const waitingFor = (live?.waitingFor ?? '').toLowerCase()
      const isPermission = PERMISSION_HINTS.some((hint) => waitingFor.includes(hint.toLowerCase()))
      return {
        hardStatus: isPermission ? 'awaiting_approval' : 'awaiting_answer',
        running: false,
        live: true,
      }
    }
    if (status === 'idle') {
      // idle 但有错误尾巴时仍报 error，方便面板看见失败
      if (meta.lastKind === 'error') return { hardStatus: 'error', running: false, live: true }
      return { hardStatus: 'idle', running: false, live: true }
    }
    return { hardStatus: 'unknown', running: false, live: true }
  }

  // 没有活进程：靠文件尾部推断
  if (meta.lastKind === 'error') return { hardStatus: 'error', running: false, live: false }
  const fresh = meta.updatedAt > 0 && now - meta.updatedAt < 120_000
  if (meta.lastKind === 'user' || meta.lastKind === 'tool') {
    // 用户刚发了消息还没有回复：新文件算 running，旧文件算 unknown（进程可能已经没了）
    return fresh
      ? { hardStatus: 'running', running: true, live: false }
      : { hardStatus: 'unknown', running: false, live: false }
  }
  return { hardStatus: 'idle', running: false, live: false }
}
