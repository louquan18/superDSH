import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { resolveConfig } from './config.js'
import { DshSource, digestText, type SourceSessionLite } from './source.js'
import { SourceRegistry } from './sources/registry.js'
import { ClaudeSource } from './sources/claude.js'
import { CodexSource } from './sources/codex.js'
import {
  SOURCE_KINDS,
  sourceOf,
  type SessionSource,
  type SourceCapabilities,
  type SourceKind,
} from './sources/types.js'
import { Store } from './store.js'
import { computeStats, decidePolicy, ruleMeta, type PolicyDecision, type RuleStat } from './policy.js'
import { labelDecisions } from './label.js'
import { resolveVersion, type VersionInfo } from './version.js'
import { applySessionEvent, createRuntime as newRuntime, deriveHardStatus, foldSession, parseReportStatus, type SessionRuntime } from './status.js'
import {
  ANSWERABLE_KINDS,
  NOTICE_KIND_LABEL,
  detectBlockers,
  buildBlockerNotice,
  noticeSource,
  type DetectedBlocker,
} from './blockers.js'
import { mcpParts, classifyTool, type RiskContext } from './risk.js'
import {
  buildCandidates,
  deliveryFor,
  parseExplicitPath,
  parseExplicitTarget,
  parseWorkspaceMention,
  validateDecision,
  type RouterSession,
} from './router.js'
import { planSummary,
  matchPlanCommand,
  matchPlanNetwork,
  matchPlanPath,
  planExcerpt,
  planRequiredFor,
} from './plans.js'
import {
  NOTIFIED_LIMIT,
  advanceCursor,
  detectProgress,
  initialCursor,
  isOpenDispatch,
  milestoneSignature,
  resolveWatchdog,
  seedCursor,
  seedDispatchCursor,
  decideWake,
  type ProgressEvent,
  type WakeDecision,
  type ResolvedBlockerRef,
} from './progress.js'
import type {
  Approval,
  Blocker,
  ButlerNotice,
  ButlerNoticePayload,
  ButlerNoticeSource,
  Config,
  Dispatch,
  HardStatus,
  ManagedSession,
  Meta,
  PendingQuestionRecord,
  Plan,
  PolicyStatsView,
  ProgressNoticeRecord,
  PlanScopeItem,
  Project,
  ResolvedBlockerView,
  RouteCandidate,
  RouteDecision,
  SessionView,
  Snapshot,
  Thread,
  SoftStatus,
  ToolIntent,
} from './types.js'
import {
  asText,
  canonicalPath,
  firstLine,
  hash,
  isDirectory,
  isInside,
  isRecoverableTurnError,
  now,
  redact,
  shortId,
  summarizeArgs,
  truncate,
  uuid,
} from './util.js'
import { createButlerTools } from './butler-tools.js'
import { createWorkerTools } from './worker-tools.js'
import { BashReviewer } from './bash-review.js'

const MANAGED_SOURCE = 'dsh' as const
const BUTLER_PRESET = 'superagent-butler'

export const WORKER_PROMPT = `You are a worker managed by the SuperAgent butler. The butler is a read-only router; it does not do the work. Report your state at the start, at major milestones, before ending a turn, when blocked, and when you need a user decision, using butler_report_status. Keep the report short and factual.

If you are working on a task dispatched by the butler (marked 【管家派发】) and the project is in plan-review mode, do not edit files or run mutating commands before your plan for this task is approved. Call butler_submit_plan with a complete plan and a structured scope (paths/commands). Then end the turn and wait. The host enforces this: a mutating tool call without an approved plan is denied. Do not try to bypass a denial; submit a plan or ask the butler.

If this project is in gate-confirm mode, proceed directly. High-risk or out-of-plan operations will be held for the user; low-risk operations may be approved automatically.`

interface ServiceOptions {
  ctx: any
  config: Config
  store: Store
}

export class SuperagentService {
  readonly ctx: any
  readonly config: Config
  readonly store: Store
  readonly source: DshSource
  /** 多来源注册表；P0 只注册 dsh，P1 起按配置注册 claude。 */
  readonly sources: SourceRegistry
  /** P0 版本戳：本次运行的代码版本与配置指纹。 */
  readonly version: VersionInfo
  private claude?: ClaudeSource
  private codex?: CodexSource
  private meta!: Meta
  private butlerId: string | null = null
  private runtimes = new Map<string, SessionRuntime>()
  /** P1：规则准确率的缓存（30s），避免每条决策都全量扫审计。 */
  private statsCache: { at: number; stats: RuleStat[] } | null = null
  private lastLabelAt = 0
  private runtimeLoadedAt = new Map<string, number>()
  private installed = new Map<string, () => void>()
  private intents = new Map<string, Map<string, ToolIntent>>()
  private approvalWaiters = new Map<
    string,
    {
      approvalId: string
      resolve: (outcome: string) => void
      reject: (error: any) => void
      signal?: AbortSignal
    }
  >()
  private questionWaiters = new Map<
    string,
    {
      callId: string
      sessionId: string
      resolve: (answer: any) => void
      reject: (error: any) => void
      signal?: AbortSignal
    }
  >()
  private nativePlanQuestions = new Map<
    string,
    { callId: string; questionId: string; approve: string }
  >()
  /** 管家不在线时暂存的提醒，按管家 sessionId 分；`*` 是还没有任何管家时的公共队列。 */
  private pendingButlerNotices = new Map<string, ButlerNoticePayload[]>()
  private hub = new Set<() => void>()
  private timers = new Set<ReturnType<typeof setInterval>>()
  private evaluateTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private emitTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private sessionsCache: { at: number; value: SourceSessionLite[] } | null = null
  private lastSnapshotAt = 0
  private progressTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private progressPending = new Map<string, ButlerNoticePayload[]>()
  private progressTarget = new Map<string, string | undefined>()
  private progressLastAt = new Map<string, number>()
  private progressKeys = new Set<string>()
  private planStartNotified = new Set<string>()
  /** 每条 dispatch 已唤醒管家的次数（与落盘的 woke 签名一起构成有界唤醒）。 */
  private wakeCounts = new Map<string, number>()
  /** 全局上一次唤醒时间，用于 minGapMs 节流。 */
  private lastWakeAt = 0
  /** 卡点真唤醒的节流时间（按 dispatch / blocker），进程内即可：签名本身已落盘去重。 */
  private lastBlockerWakeAt = new Map<string, number>()
  private bashReviewer: BashReviewer
  /** 本进程内看到的 `agent-preset/selected`：会话在第一轮前切换 preset 时，header 不会更新。 */
  private selectedPresets = new Map<string, string>()
  /** 每个来源的健康状态：来宾源坏掉只影响它自己，核心永远可用。 */
  private sourceHealth = new Map<
    SourceKind,
    { enabled: boolean; available: boolean; error?: string; at: number }
  >()

  private constructor(options: ServiceOptions) {
    this.ctx = options.ctx
    this.config = options.config
    this.store = options.store
    this.version = resolveVersion(this.config)
    this.store.setVersion(this.version)
    this.source = new DshSource({ ctx: options.ctx })
    this.sources = new SourceRegistry()
    this.sources.register(this.source)
    this.sourceHealth.set('dsh', { enabled: true, available: true, at: now() })
    const claudeConfig = this.config.sources?.claude
    if (claudeConfig?.enabled) {
      // 来宾源：构造/启动/首次扫描任何一步失败都只把它标成不可用，绝不冒泡到 init()
      this.registerGuestSource('claude', () => {
        this.claude = new ClaudeSource({
          config: claudeConfig,
          onChange: () => this.invalidateSources(),
        })
        this.claude.start()
        return this.claude
      })
    }
    const codexConfig = this.config.sources?.codex
    if (codexConfig?.enabled) {
      this.registerGuestSource('codex', () => {
        this.codex = new CodexSource({
          config: codexConfig,
          onChange: () => this.invalidateSources(),
        })
        return this.codex
      })
    }
    this.bashReviewer = new BashReviewer({
      llm: () => {
        try {
          return typeof this.ctx.get === 'function' ? this.ctx.get('llm') : this.ctx.llm
        } catch {
          return undefined
        }
      },
    })
  }

  static async create(ctx: any, rawConfig: any): Promise<SuperagentService> {
    const config = resolveConfig(rawConfig)
    const store = await Store.open(ctx)
    const service = new SuperagentService({ ctx, config, store })
    await service.init()
    return service
  }

  private async init(): Promise<void> {
    await this.restorePendingNotices()
    // I-36 A：重启后内存 waiter 归零，凡是仍在的待答提问都只能去界面回答。
    for (const item of this.store.listPendingQuestions()) {
      await this.markQuestionNeedsUiAnswer(item.callId, '进程重启：内存中的应答句柄已丢失')
    }
    this.meta = await this.store.getMeta()
    this.meta.startedAt = this.version.startedAt
    await this.store.saveMeta(this.meta)
    this.butlerId = this.meta.butlerSessionId
    this.registerEvents()
    this.installExistingAgents()
    this.startTimers()
    await this.recover()
    await this.runLabeling()
    this.emit()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const timer of this.timers) clearInterval(timer)
    this.timers.clear()
    for (const timer of this.evaluateTimers.values()) clearTimeout(timer)
    this.evaluateTimers.clear()
    this.claude?.dispose()
    this.codex?.dispose()
    for (const timer of this.progressTimers.values()) clearTimeout(timer)
    this.progressTimers.clear()
    this.progressPending.clear()
    if (this.emitTimer) clearTimeout(this.emitTimer)
    for (const dispose of this.installed.values()) {
      try {
        dispose()
      } catch {
        // best effort
      }
    }
    this.installed.clear()
    for (const waiter of this.approvalWaiters.values()) {
      try {
        waiter.resolve('cancelled')
      } catch {
        // ignore
      }
    }
    this.approvalWaiters.clear()
    for (const waiter of this.questionWaiters.values()) {
      try {
        waiter.reject(new Error('superagent disposed'))
      } catch {
        // ignore
      }
    }
    this.questionWaiters.clear()
    void this.store.close()
  }

  private registerEvents(): void {
    const ctx = this.ctx
    ctx.on('session/event', (session: any, event: any) => {
      this.handleSessionEvent(session, event)
    })
    ctx.on('agent/status', (payload: any) => {
      this.handleAgentStatus(payload?.agent, payload?.status)
    })
    ctx.on('agent/created', (payload: any) => {
      this.handleAgentCreated(payload?.agent, payload?.source)
    })
    ctx.on('agent/disposed', (payload: any) => {
      const id = String(payload?.agent?.id ?? '')
      if (!id) return
      const dispose = this.installed.get(id)
      if (dispose) {
        try {
          dispose()
        } catch {
          // ignore
        }
        this.installed.delete(id)
      }
      this.runtimes.delete(id)
      this.runtimeLoadedAt.delete(id)
    })
    ctx.on('api-session/removed', (sessionId: string) => {
      this.runtimes.delete(String(sessionId))
      this.runtimeLoadedAt.delete(String(sessionId))
      this.queueEmit()
    })
  }

  private installExistingAgents(): void {
    try {
      const roots = this.ctx.agents.roots()
      for (const agent of roots ?? []) this.installWorker(agent)
    } catch {
      // registry may not be ready; agent/created covers later
    }
  }

  private handleAgentCreated(agent: any, _source: string): void {
    if (!agent) return
    // 新 session 立刻可见：否则 snapshot/routing 会拿 5 秒前的缓存漏掉刚建的管家/worker。
    this.sessionsCache = null
    if (this.isButlerAgent(agent)) {
      this.flushButlerNotices(agent)
      return
    }
    this.installWorker(agent)
    void this.ensureRuntime(String(agent.id))
    this.scheduleEvaluate(String(agent.id))
  }

  private handleAgentStatus(agent: any, status: string): void {
    if (!agent) return
    const id = String(agent.id)
    const runtime = this.runtimes.get(id) ?? this.createRuntime(id)
    runtime.running = status === 'running'
    runtime.lastActivityAt = Math.max(runtime.lastActivityAt, now())
    this.runtimes.set(id, runtime)
    this.scheduleEvaluate(id)
    this.queueEmit()
  }

  private handleSessionEvent(session: any, event: any): void {
    const id = String(session?.id ?? '')
    if (!id) return
    const runtime = this.runtimes.get(id) ?? this.createRuntime(id)
    runtime.running = Boolean(this.agentOf(id)?.status === 'running')
    this.runtimes.set(id, runtime)
    const type = String(event?.type ?? '')
    const data = event?.data ?? {}
    if (type === 'agent-preset/selected' && data?.agentPreset) {
      this.handlePresetSelected(id, String(data.agentPreset))
    }

    if (type === 'user/message' && data?.source?.rpcId) {
      const requestId = String(data.source.rpcId)
      const dispatch = this.store.findDispatchByRequestId(requestId)
      if (dispatch && dispatch.status === 'accepted') {
        dispatch.status = 'delivered'
        dispatch.deliveredAt = now()
        void this.store.putDispatch(dispatch).then(() => this.queueEmit())
      }
    }

    const callId = String(data?.callId ?? data?.message?.toolCallId ?? '')
    if (type === 'tool/result' && callId) {
      this.intents.get(id)?.delete(callId)
    }

    applySessionEvent(runtime, event, { now: now() })
    if (type === 'turn/end') this.noteTurnEnd(id, data)
    this.scheduleEvaluate(id)
  }

  private createRuntime(id: string): SessionRuntime {
    const runtime = newRuntime(id)
    runtime.running = Boolean(this.agentOf(id)?.status === 'running')
    return runtime
  }

  private scheduleEvaluate(id: string): void {
    if (this.disposed) return
    const existing = this.evaluateTimers.get(id)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.evaluateTimers.delete(id)
      void this.evaluateSession(id).catch(() => {})
    }, 250)
    this.evaluateTimers.set(id, timer)
  }

  async ensureRuntime(id: string, force = false): Promise<SessionRuntime> {
    if (this.sources.ownerOf(id).kind !== 'dsh') {
      // 外部来源不参与 dsh 的事件折叠/门禁；状态由适配器给（见 snapshot）
      const empty = this.runtimes.get(id) ?? this.createRuntime(id)
      this.runtimes.set(id, empty)
      return empty
    }
    const existing = this.runtimes.get(id)
    const loadedAt = this.runtimeLoadedAt.get(id) ?? 0
    const live = this.agentOf(id)
    if (existing && !force) {
      if (live) return existing
      if (now() - loadedAt < this.config.statusTtlMs) return existing
    }
    if (existing && force && !live && now() - loadedAt < 5000) return existing
    const observed = await this.source.observe(id)
    const events = Array.isArray(observed?.events) ? observed.events : []
    const runtime = foldSession(id, events, { now: now() })
    runtime.running = Boolean(live?.status === 'running')
    runtime.lastActivityAt = Math.max(
      runtime.lastActivityAt,
      Number(observed?.header?.createdAt ?? 0),
    )
    const userQuestions = observed?.projections?.values?.userQuestions
    if (userQuestions?.active && Array.isArray(userQuestions.active)) {
      for (const question of userQuestions.active) {
        const callId = String(question.callId ?? '')
        if (!callId) continue
        runtime.questions.set(callId, {
          callId,
          questions: question.questions ?? [],
          at: now(),
          state: question.state === 'continued' ? 'continued' : 'open',
        })
      }
    }
    this.runtimes.set(id, runtime)
    this.runtimeLoadedAt.set(id, now())
    return runtime
  }

  private liveInfo(id: string): { available: boolean; running: boolean } {
    const agent = this.agentOf(id)
    return { available: Boolean(agent), running: Boolean(agent?.status === 'running') }
  }

  hardStatusFor(id: string): HardStatus {
    const runtime = this.runtimes.get(id)
    return deriveHardStatus(runtime, this.liveInfo(id))
  }

  private agentOf(id: string): any {
    try {
      return this.ctx.agents.get(id)
    } catch {
      return undefined
    }
  }

  private isButlerAgent(agent: any): boolean {
    if (!agent) return false
    if (this.butlerId && String(agent.id) === this.butlerId) return true
    return this.presetOf(agent) === BUTLER_PRESET
  }

  /**
   * 会话当前的 preset。先建普通会话、第一轮前再切到管家时，session header 仍是旧 preset，
   * 所以以 preset 注册表记录的最新选择为准，读不到再退回 header。
   */
  private presetOf(agent: any): string | undefined {
    const id = String(agent?.id ?? '')
    const selected = this.selectedPresets.get(id)
    if (selected) return selected
    try {
      const registry = typeof this.ctx.get === 'function' ? this.ctx.get('agentPresets') : this.ctx.agentPresets
      const recorded = registry?.presetForSession?.(agent.session)
      if (recorded) return String(recorded)
    } catch {
      // registry not available
    }
    const header = agent?.session?.header?.agentPreset
    return header ? String(header) : undefined
  }

  /** 会话切换 preset：切到管家就卸掉 worker 注入并当管家；切走就按 worker 安装。 */
  private handlePresetSelected(sessionId: string, preset: string): void {
    this.selectedPresets.set(sessionId, preset)
    this.sessionsCache = null
    const agent = this.agentOf(sessionId)
    const managed = this.store.getSession(sessionId)
    if (preset === BUTLER_PRESET) {
      const dispose = this.installed.get(sessionId)
      if (dispose) {
        try {
          dispose()
        } catch {
          // ignore
        }
        this.installed.delete(sessionId)
      }
      this.intents.delete(sessionId)
      if (managed && !managed.isButler) void this.store.putSession({ ...managed, isButler: true })
      if (agent) this.flushButlerNotices(agent)
    } else {
      if (managed?.isButler && sessionId !== this.butlerId) {
        void this.store.putSession({ ...managed, isButler: false })
      }
      if (agent) this.installWorker(agent)
    }
    this.queueEmit()
  }

  private isRootAgent(agent: any): boolean {
    const header = agent?.session?.header
    if (!header) return false
    if (header.origin === 'subagent') return false
    if (header.parentSession) return false
    return true
  }

  private installWorker(agent: any): void {
    if (!agent) return
    const id = String(agent.id)
    if (this.installed.has(id)) return
    if (this.isButlerAgent(agent)) return
    if (!this.isRootAgent(agent)) return
    const disposers: Array<() => void> = []
    try {
      const report = createWorkerTools(this, agent)
      disposers.push(agent.ctx.tools.register(report.reportStatus))
      disposers.push(agent.ctx.tools.register(report.submitPlan))
      disposers.push(
        agent.ctx.systemPrompt.section({
          name: 'superagent:worker',
          order: 900,
          text: WORKER_PROMPT,
        }),
      )
      disposers.push(
        agent.ctx.on(
          'tools/pre-execute',
          async (exec: any, next: any) => this.gate(agent, exec, next),
          { prepend: true },
        ),
      )
      disposers.push(
        agent.ctx.on(
          'approval/request',
          async (request: any, next: any) => this.answerApproval(agent, request, next),
          { prepend: true },
        ),
      )
      disposers.push(
        agent.ctx.on(
          'user-questions/request',
          async (request: any, next: any) => this.answerQuestion(agent, request, next),
          { prepend: true },
        ),
      )
    } catch (error) {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          // ignore
        }
      }
      return
    }
    const dispose = () => {
      for (const item of disposers.reverse()) {
        try {
          item()
        } catch {
          // ignore
        }
      }
    }
    this.installed.set(id, dispose)
    void this.ensureRuntime(id)
  }

  private currentProjectForSession(sessionId: string, cwd?: string): Project {
    const existing = this.store.listSessions().find((session) => session.sessionId === sessionId)
    if (existing?.projectKey) {
      const project = this.store.getProject(existing.projectKey)
      if (project) return project
    }
    return this.ensureProjectForCwd(cwd ?? this.defaultCwd())
  }

  private defaultCwd(): string {
    const configured = this.config.butler.cwd
    if (configured) return configured
    try {
      return String(this.ctx.workingDirectory?.defaultDirectory ?? process.cwd())
    } catch {
      return process.cwd()
    }
  }

  private workspaceList(): Array<{ key: string; cwd: string; title: string; workspaceId?: string }> {
    try {
      const workspaces = this.ctx.workspaceRegistry?.list?.() ?? []
      return workspaces.map((workspace: any) => ({
        key: `ws_${String(workspace.id)}`,
        cwd: String(workspace.path),
        title: String(workspace.title ?? workspace.path),
        workspaceId: String(workspace.id),
      }))
    } catch {
      return []
    }
  }

  ensureProjectForCwd(cwd: string): Project {
    const absolute = path.resolve(cwd)
    const workspaces = this.workspaceList()
    const matching = workspaces
      .filter((workspace) => isInside(workspace.cwd, absolute))
      .sort((a, b) => b.cwd.length - a.cwd.length)
    const match = matching[0]
    const key = match?.key ?? `cwd_${hash(absolute)}`
    const existing = this.store.getProject(key)
    if (existing) return existing
    const project: Project = {
      key,
      workspaceId: match?.workspaceId,
      cwd: match?.cwd ?? absolute,
      title: match?.title ?? path.basename(absolute) ?? absolute,
      mode: 'plan_review',
      createdAt: now(),
      updatedAt: now(),
    }
    void this.store.putProject(project)
    return project
  }

  async listSessions(force = false): Promise<SourceSessionLite[]> {
    if (!force && this.sessionsCache && now() - this.sessionsCache.at < 5000) {
      return this.sessionsCache.value
    }
    const value = await this.sources.list({
      onError: (kind, error) => {
        this.markSourceHealth(kind, error)
        console.warn(`[superagent-butler] source "${kind}" list failed:`, String((error as any)?.message ?? error))
      },
    })
    for (const kind of this.sources.kinds()) this.markSourceHealth(kind)
    this.sessionsCache = { at: now(), value }
    for (const session of value) {
      if (!session.cwd) continue
      const project = this.ensureProjectForCwd(session.cwd)
      const existing = this.store.getSession(session.sessionId)
      const managed = {
        sessionId: session.sessionId,
        title: session.title,
        cwd: session.cwd,
        projectKey: project.key,
        source: session.source ?? MANAGED_SOURCE,
        isButler: this.isButlerSessionRow(session),
        lastKnownSummary: {
          running: session.running,
          agentAvailable: session.agentAvailable,
          updatedAt: session.updatedAt,
          blank: session.blank,
        },
        softStatus: existing?.softStatus ?? session.softStatus,
        lastTaskId: existing?.lastTaskId,
        firstSeenAt: existing?.firstSeenAt ?? now(),
        lastSeenAt: now(),
      } satisfies any
      try {
        await this.store.putSession(managed)
      } catch (error) {
        // 外部来源的 id/字段可能不合 storage 约束：跳过持久化，会话照常返回
        console.warn(
          `[superagent-butler] skip persisting session ${session.sessionId}:`,
          String((error as any)?.message ?? error),
        )
      }
    }
    return value
  }

  /** 外部来源有变化：清缓存并让面板刷新（不出提醒，只更新列表）。 */
  invalidateSources(): void {
    this.sessionsCache = null
    this.queueEmit()
  }

  /**
   * 注册一个来宾来源（claude / codex）。
   *
   * 构造、`start()`、首次 `list()` 都可能因为外部数据格式/权限出问题；任何一步失败都只把
   * 这个来源标成不可用并记下原因，**不允许冒泡到 init()** —— 否则 `provide('superagent')`
   * 不会执行，管家 preset 挂不上，整个管家的工具全没了（2026-11-09 的 P0 就是这么炸的）。
   */
  private registerGuestSource(kind: SourceKind, factory: () => SessionSource): void {
    try {
      const source = factory()
      this.sources.register(source)
      this.sourceHealth.set(kind, { enabled: true, available: true, at: now() })
    } catch (error: any) {
      const message = String(error?.message ?? error)
      this.sourceHealth.set(kind, {
        enabled: true,
        available: false,
        error: message,
        at: now(),
      })
      console.warn(`[superagent-butler] source "${kind}" unavailable at startup:`, message)
    }
  }

  /** 来源健康状态（快照里给面板看，不静默）。 */
  sourceStatus(): Array<{
    kind: SourceKind
    enabled: boolean
    available: boolean
    error?: string
    at: number
  }> {
    return SOURCE_KINDS.map((kind) => {
      const health = this.sourceHealth.get(kind)
      return {
        kind,
        enabled: health?.enabled ?? false,
        available: health?.available ?? false,
        error: health?.error,
        at: health?.at ?? 0,
      }
    })
  }

  private markSourceHealth(kind: SourceKind, error?: unknown): void {
    if (error === undefined) {
      const previous = this.sourceHealth.get(kind)
      this.sourceHealth.set(kind, {
        enabled: previous?.enabled ?? true,
        available: true,
        at: now(),
      })
      return
    }
    const message = String((error as any)?.message ?? error)
    this.sourceHealth.set(kind, { enabled: true, available: false, error: message, at: now() })
  }

  /** 某个会话属于哪个来源；缺省 dsh（旧记录兼容）。 */
  sourceKindOf(sessionId: string): SourceKind {
    const managed = this.store.getSession(String(sessionId))
    if (managed) return sourceOf(managed)
    return this.sources.ownerOf(String(sessionId)).kind
  }

  /** 某个会话所属来源的能力表。 */
  capabilitiesOf(sessionId: string): SourceCapabilities {
    return this.sources.ownerOf(String(sessionId)).capabilities
  }

  async ensureButler(): Promise<string> {
    if (this.butlerId) {
      const existing = this.store.getSession(this.butlerId)
      if (existing) return this.butlerId
      const live = this.agentOf(this.butlerId)
      if (live) return this.butlerId
    }
    const cwd = this.config.butler.cwd ?? this.defaultCwd()
    const created = await this.ctx.sessionController.create({
      cwd,
      agentPreset: 'superagent-butler',
    })
    const id = String(created.sessionId)
    this.butlerId = id
    this.meta.butlerSessionId = id
    await this.store.saveMeta(this.meta)
    await this.source.rename(id, this.config.butler.title)
    this.store.putSession({
      sessionId: id,
      title: this.config.butler.title,
      cwd,
      projectKey: this.ensureProjectForCwd(cwd).key,
      source: MANAGED_SOURCE,
      isButler: true,
      lastKnownSummary: {
        running: false,
        agentAvailable: true,
        updatedAt: now(),
        blank: true,
      },
      firstSeenAt: now(),
      lastSeenAt: now(),
    })
    this.queueEmit()
    return id
  }

  get butlerSessionId(): string | null {
    return this.butlerId
  }

  isButlerSessionId(id: string): boolean {
    return Boolean(this.butlerId && id === this.butlerId)
  }

  /**
   * 管家判定：既认本服务创建的那个管家会话，也认任何以 superagent-butler 预设启动的会话。
   * butler_* 工具与只读护栏都用这一处，避免两处判定不一致。
   */
  isButlerAgentSession(agent: any): boolean {
    return this.isButlerAgent(agent)
  }

  /**
   * 列表行的管家判定，依次看：本进程看到的 preset 切换、live agent 的当前 preset、
   * 已登记的管家标记（重启后冷 session 靠它）、session header。
   */
  private isButlerSessionRow(session: { sessionId: string; agentPreset?: string }): boolean {
    const id = session.sessionId
    if (this.isButlerSessionId(id)) return true
    const selected = this.selectedPresets.get(id)
    if (selected) return selected === BUTLER_PRESET
    const live = this.agentOf(id)
    if (live) return this.isButlerAgent(live)
    if (this.store.getSession(id)?.isButler) return true
    return session.agentPreset === BUTLER_PRESET
  }

  async noteReport(agent: any, args: any): Promise<any> {
    const sessionId = String(agent.id)
    const runtime = this.runtimes.get(sessionId) ?? (await this.ensureRuntime(sessionId))
    const soft = parseReportStatus(args, now())
    if (!soft) return { ok: false, error: 'report_status 需要 goal/done/next 等字段' }
    runtime.softStatus = soft
    const managed: ManagedSession = this.store.getSession(sessionId) ?? {
      sessionId,
      title: String(agent?.session?.header?.cwd ?? sessionId.slice(0, 8)),
      cwd: agent?.session?.header?.cwd,
      projectKey: this.ensureProjectForCwd(
        String(agent?.session?.header?.cwd ?? this.defaultCwd()),
      ).key,
      source: MANAGED_SOURCE,
      isButler: false,
      firstSeenAt: now(),
      lastSeenAt: now(),
    }
    managed.softStatus = soft
    await this.store.putSession(managed)
    this.noteProgress(sessionId, soft)
    this.queueEmit()
    this.scheduleEvaluate(sessionId)
    return { ok: true, at: soft.reportedAt }
  }

  async sendToButler(text: string): Promise<{ sessionId: string; accepted: boolean }> {
    const id = await this.ensureButler()
    await this.source.prompt(id, text, this.source.newRequestId())
    return { sessionId: id, accepted: true }
  }

  /** 所有已知的管家会话：默认管家 + 以管家 preset 运行或登记过的会话。 */
  private butlerSessionIds(): string[] {
    const ids = new Set<string>()
    if (this.butlerId) ids.add(this.butlerId)
    for (const session of this.store.listSessions()) {
      if (session.isButler) ids.add(session.sessionId)
    }
    try {
      for (const agent of this.ctx.agents.roots() ?? []) {
        if (this.isButlerAgent(agent)) ids.add(String(agent.id))
      }
    } catch {
      // registry not ready
    }
    return [...ids]
  }

  /**
   * 给管家发提醒（inject，不唤醒）。`butlerSessionId` 是任务的派发者：只发给它；
   * 没有派发者、或派发者已不存在，就广播给所有管家。
   *
   * 传字符串时行为与旧版一致（纯文本提醒）；传 payload 时可以带上结构化 source，
   * 客户端据此把这条消息渲染成一张可点按钮的卡片。
   */
  async injectButlerNotice(
    payload: ButlerNoticePayload | string,
    butlerSessionId?: string,
  ): Promise<{ delivered: boolean; queued: boolean; targets: number }> {
    const notice: ButlerNoticePayload =
      typeof payload === 'string'
        ? { text: payload, butlerSessionId }
        : { ...payload, butlerSessionId: payload.butlerSessionId ?? butlerSessionId }
    const known = this.butlerSessionIds()
    const targets =
      notice.butlerSessionId && known.includes(notice.butlerSessionId)
        ? [notice.butlerSessionId]
        : known
    if (targets.length === 0) {
      // 还没有任何管家：进公共队列（会落盘），等管家出现时补投。
      this.queueButlerNotice('*', notice)
      return { delivered: false, queued: true, targets: 0 }
    }
    let delivered = false
    for (const id of targets) {
      const agent = this.agentOf(id)
      if (agent) {
        if (this.injectMessage(agent, notice.text, notice.source)) delivered = true
      } else {
        this.queueButlerNotice(id, notice)
      }
    }
    return { delivered, queued: true, targets: targets.length }
  }

  private queueButlerNotice(butlerSessionId: string, notice: ButlerNoticePayload): void {
    const queue = this.pendingButlerNotices.get(butlerSessionId) ?? []
    queue.push(notice)
    if (queue.length > 20) queue.shift()
    this.pendingButlerNotices.set(butlerSessionId, queue)
    // I-34：落盘再投递。进程重启后由 restorePendingNotices() 重建，不再丢。
    this.persistPendingNotices()
  }

  /** 把内存队列整份写进存储（meta.pendingNotices）。失败只记日志，不影响主链路。 */
  private persistPendingNotices(): void {
    const items: Array<{ butlerSessionId: string; payload: ButlerNoticePayload }> = []
    for (const [butlerSessionId, queue] of this.pendingButlerNotices) {
      for (const payload of queue) items.push({ butlerSessionId, payload })
    }
    void this.store.savePendingNotices(items).catch(() => undefined)
  }

  /** 启动时从存储重建未读队列（I-34）。 */
  private async restorePendingNotices(): Promise<void> {
    const items = this.store.listPendingNotices()
    if (items.length === 0) return
    for (const item of items) {
      const key = String(item?.butlerSessionId ?? '*')
      const queue = this.pendingButlerNotices.get(key) ?? []
      if (item?.payload) queue.push(item.payload)
      this.pendingButlerNotices.set(key, queue)
    }
  }

  /** 通知来源的工作区（从 notice.sessionId → managed session.projectKey 取，不新造字段）。 */
  private noticeProjectKey(payload: ButlerNoticePayload | undefined): string | undefined {
    const sessionId = (payload?.source as any)?.notice?.sessionId
    if (!sessionId) return undefined
    return this.store.getSession(String(sessionId))?.projectKey
  }

  /** 某个管家会话的工作区。 */
  private butlerProjectKey(butlerSessionId: string): string | undefined {
    return this.store.getSession(String(butlerSessionId))?.projectKey
  }

  private injectMessage(agent: any, text: string, source?: ButlerNoticeSource): boolean {
    try {
      const message = {
        id: uuid(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: source ?? { kind: 'user' },
      }
      agent.inject(message)
      return true
    } catch {
      this.queueButlerNotice(String(agent?.id ?? '*'), { text, source })
      return false
    }
  }

  /**
   * 把队列里的提醒投给这个管家（I-34 补）。
   *
   * 三条规则：
   * 1. **原键优先**：`'*'` 与自己的 key 照旧取走、删除；
   * 2. **同项目才改投**：目标管家 agent 已不存在时，只有「通知来源的 projectKey == 当前管家 projectKey」才改投给它，
   *    避免把 A 工作区的通知塞进 B 工作区的管家；
   * 3. **绝不静默丢弃**：不满足改投条件的条目留在队列里（快照会标成「未送达」），不 delete。
   */
  /**
   * 还没送达的提醒（I-34 补）：按目标管家分组，供快照/面板展示。
   * 目的就是「既没送达，也要看得见」——否则队列静默堆积就是死信箱。
   */
  private pendingNoticesView():
    | Array<{
        targetButlerId: string
        count: number
        targetAlive: boolean
        projectKey?: string
        sample?: string
      }>
    | undefined {
    const rows: Array<{
      targetButlerId: string
      count: number
      targetAlive: boolean
      projectKey?: string
      sample?: string
    }> = []
    for (const [target, queue] of this.pendingButlerNotices) {
      if (queue.length === 0) continue
      const projectKey = queue.map((item) => this.noticeProjectKey(item)).find(Boolean)
      rows.push({
        targetButlerId: target,
        count: queue.length,
        targetAlive: target !== '*' && Boolean(this.agentOf(target)),
        ...(projectKey ? { projectKey } : {}),
        sample: firstLine(queue[queue.length - 1]?.text ?? '', 80),
      })
    }
    if (rows.length === 0) return undefined
    return rows.sort((a, b) => b.count - a.count)
  }

  /** 快照里的待答提问（I-36 A）：带正文与选项，needsUiAnswer 明确标出。 */
  private pendingQuestionsView(): PendingQuestionRecord[] | undefined {
    const items = this.store
      .listPendingQuestions()
      .filter((item) =>
        this.store
          .listBlockers()
          .some(
            (blocker) =>
              blocker.relatedCallId === item.callId &&
              (blocker.status === 'open' || blocker.status === 'notified'),
          ),
      )
    return items.length > 0 ? items : undefined
  }

  private flushButlerNotices(agent: any): void {
    const id = String(agent.id)
    const own = [
      ...(this.pendingButlerNotices.get('*') ?? []),
      ...(this.pendingButlerNotices.get(id) ?? []),
    ]
    this.pendingButlerNotices.delete('*')
    this.pendingButlerNotices.delete(id)

    const activeProject = this.butlerProjectKey(id)
    const redirected: Array<{ from: string; payload: ButlerNoticePayload }> = []
    for (const key of [...this.pendingButlerNotices.keys()]) {
      // 目标管家还活着：按原键等它自己来取，不动。
      if (this.agentOf(key)) continue
      const queue = this.pendingButlerNotices.get(key) ?? []
      const keep: ButlerNoticePayload[] = []
      for (const payload of queue) {
        const project = this.noticeProjectKey(payload)
        if (project && activeProject && project === activeProject) {
          redirected.push({ from: key, payload })
        } else {
          keep.push(payload)
        }
      }
      if (keep.length > 0) this.pendingButlerNotices.set(key, keep)
      else this.pendingButlerNotices.delete(key)
    }

    const notices = [...own, ...redirected.map((item) => item.payload)]
    this.persistPendingNotices()
    if (notices.length === 0) return
    const redirectNote =
      redirected.length > 0
        ? `\n（其中 ${redirected.length} 条原定发给已不存在的管家，已按「同工作区」改投到本会话：${[
            ...new Set(redirected.map((item) => item.from.slice(0, 12))),
          ].join(', ')}）`
        : ''
    const summary = `【SuperAgent 提醒】重启/离线期间新增 ${notices.length} 条提醒（已落盘，重启不丢）：\n${notices
      .slice(-5)
      .map((notice) => `- ${firstLine(notice.text, 120)}`)
      .join('\n')}\n在管家对话里点按钮处理，或让管家查 butler_status。${redirectNote}`
    const notice: ButlerNotice = {
      id: uuid(),
      at: now(),
      kind: 'summary',
      category: 'restart',
      severity: 'info',
      title: `重启/离线期间新增 ${notices.length} 条提醒`,
      detail: notices
        .slice(-5)
        .map((item) => firstLine(item.text, 80))
        .join(' / '),
      actions: [],
    }
    this.injectMessage(agent, summary, noticeSource(notice))
  }

  /** §6.4：只对管家派发的任务推进度，手动 session 只更新面板。 */
  private noteProgress(sessionId: string, soft: SoftStatus): void {
    const dispatch = this.store.currentDispatch(sessionId)
    if (!dispatch) return
    if (
      dispatch.status !== 'accepted' &&
      dispatch.status !== 'delivered' &&
      dispatch.status !== 'error'
    ) {
      return
    }
    const title = this.store.getSession(sessionId)?.title ?? sessionId.slice(0, 8)
    // 上报本身就是「有进展」，同时把 done 签名落进持久化游标，扫描路径据此不重复报。
    this.markReported(dispatch, soft.done ?? [], now())
    if (this.store.approvedPlan(dispatch.id) && !this.planStartNotified.has(dispatch.id)) {
      this.planStartNotified.add(dispatch.id)
      this.queueProgress(
        sessionId,
        `【SuperAgent 进度】\n- ${title}：计划已获批，开始执行`,
        dispatch.fromButlerSessionId,
        this.progressNotice(sessionId, `${title}：计划已获批，开始执行`, undefined),
      )
    }
    const fresh: string[] = []
    for (const item of soft.done ?? []) {
      const key = `${dispatch.id}:${item}`
      if (this.progressKeys.has(key)) continue
      this.progressKeys.add(key)
      fresh.push(item)
    }
    if (this.progressKeys.size > 4000) this.progressKeys.clear()
    if (fresh.length > 0 && this.config.progress.notifyMilestones) {
      const next = soft.next?.[0]
      this.queueProgress(
        sessionId,
        [
          '【SuperAgent 进度】',
          `- ${title}：完成 ${fresh.length} 项`,
          ...fresh.slice(-3).map((item) => `- ${truncate(item, 100)}`),
          next ? `- 下一步：${truncate(next, 100)}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        dispatch.fromButlerSessionId,
        this.progressNotice(
          sessionId,
          `${title}：完成 ${fresh.length} 项`,
          [...fresh.slice(-3), ...(next ? [`下一步：${next}`] : [])].join('；'),
        ),
      )
    }
    // 交过计划但还没批（含待审、被要求修改）时，「done 非空 + next 为空」只是交完计划，不算任务完成。
    // 一次计划都没交过的不受影响：只读型派发任务本来就不需要计划，必须能正常收尾。
    const planPending = this.store.pendingPlan(sessionId)?.dispatchId === dispatch.id
    const planSubmitted = this.store
      .listPlans()
      .some((plan) => plan.dispatchId === dispatch.id)
    const planMissing =
      planSubmitted && this.planRequired(dispatch) && !this.store.approvedPlan(dispatch.id)
    // I-28(2)：worker 自己报完（done 非空 / next 空 / 无 blocker）= 一条可核对的事实。
    // 只记在 dispatch 上，不据此销账；建议销账和 watchdog 文案都读它。
    if (
      (soft.next?.length ?? 0) === 0 &&
      (soft.done?.length ?? 0) > 0 &&
      (soft.blockers?.length ?? 0) === 0 &&
      !dispatch.suspectDoneAt
    ) {
      dispatch.suspectDoneAt = now()
      dispatch.suspectDoneReason = 'report'
      void this.store.putDispatch(dispatch)
    }
    if (
      (soft.next?.length ?? 0) === 0 &&
      (soft.done?.length ?? 0) > 0 &&
      !planPending &&
      !planMissing
    ) {
      void this.completeDispatch(dispatch, title, soft)
    }
  }

  /** 新开一条活。标题取派发首行，参与者先放目标会话。 */
  private async openThreadForDispatch(dispatch: Dispatch): Promise<Thread> {
    const at = now()
    const thread: Thread = {
      id: shortId('thd'),
      title: firstLine(dispatch.text, 60),
      state: 'active',
      participantSessionIds: [dispatch.targetSessionId],
      dispatchIds: [dispatch.id],
      createdAt: at,
      lastEventAt: at,
    }
    await this.store.putThread(thread)
    return thread
  }

  /** 沿用已有活：补上派发与会话。 */
  private async attachDispatchToThread(thread: Thread, dispatch: Dispatch): Promise<string> {
    if (!thread.dispatchIds.includes(dispatch.id)) thread.dispatchIds.push(dispatch.id)
    if (!thread.participantSessionIds.includes(dispatch.targetSessionId)) {
      thread.participantSessionIds.push(dispatch.targetSessionId)
    }
    thread.state = 'active'
    thread.lastEventAt = now()
    await this.store.putThread(thread)
    return thread.id
  }

  /**
   * I-28 第 1 层：判断某条派发是不是「看起来干完了但没人收尾」。
   *
   * 证据优先级：dispatch.suspectDoneAt（事实）→ cursor.stageEnds（阶段结束过）。
   * 返回一条 `settle_suggest` 卡点，交给现有提醒通道渲染成可点卡片。
   */
  private settleSuggestBlocker(input: {
    sessionId: string
    sessionTitle: string
    hardStatus: HardStatus
    dispatch?: Dispatch
    soft?: SoftStatus
  }): DetectedBlocker | undefined {
    if (!this.config.settleSuggest.enabled) return undefined
    const dispatch = input.dispatch
    if (!dispatch || !isOpenDispatch(dispatch)) return undefined
    // 只有真的静下来了才建议（运行中不打扰）
    if (input.hardStatus !== 'idle') return undefined
    if ((input.soft?.next?.length ?? 0) > 0) return undefined
    const stageEnded = (dispatch.progress?.stageEnds ?? 0) >= 1
    if (!dispatch.suspectDoneAt && !stageEnded) return undefined

    const signature = `settle:${dispatch.id}`
    const cooldown = this.config.settleSuggest.cooldownMs
    const dismissedRecently = this.store.listBlockers().some(
      (item) =>
        item.signature === signature &&
        item.status === 'dismissed' &&
        (item.resolvedAt ?? 0) > now() - cooldown,
    )
    if (dismissedRecently) return undefined

    return {
      kind: 'settle_suggest',
      severity: 'info',
      signature,
      summary: `${input.sessionTitle}：看起来已经干完，要不要销账？`,
      neededAction: '确认无误就点「确认完成，销账」；还在干就点「继续观察」',
      evidence: {
        dispatchId: dispatch.id,
        suspectDoneAt: dispatch.suspectDoneAt,
        suspectDoneReason: dispatch.suspectDoneReason ?? (stageEnded ? 'stage_end' : undefined),
        stageEnds: dispatch.progress?.stageEnds ?? 0,
      },
    }
  }

  /**
   * 派发收尾后重算活的状态。
   *
   * 注意：**不做自动销账**。没有进行中的派发就停在 `waiting_human`，等人（或管家）确认，
   * 因为销账会取消待审计划并解除 plan gate，自动做风险太大。
   */
  private async settleThread(threadId: string | undefined): Promise<void> {
    if (!this.config.thread.enabled || !threadId) return
    const thread = this.store.getThread(threadId)
    if (!thread) return
    if (thread.state === 'done' || thread.state === 'abandoned') return
    const open = thread.dispatchIds
      .map((id) => this.store.getDispatch(id))
      .filter((item): item is Dispatch => Boolean(item) && isOpenDispatch(item!))
    thread.state = open.length > 0 ? 'active' : 'waiting_human'
    thread.lastEventAt = now()
    await this.store.putThread(thread)
  }

  /** 管家工具 `butler_thread action=list` 的返回：只看还有意义的活。 */
  listThreadsView(): any {
    const threads = this.store
      .listThreads()
      .filter((thread) => thread.state === 'active' || thread.state === 'waiting_human')
      .sort((a, b) => b.lastEventAt - a.lastEventAt)
      .slice(0, 30)
      .map((thread) => ({
        threadId: thread.id,
        title: thread.title,
        state: thread.state,
        sessions: thread.participantSessionIds.length,
        dispatches: thread.dispatchIds.length,
        openDispatches: thread.dispatchIds
          .map((id) => this.store.getDispatch(id))
          .filter((item): item is Dispatch => Boolean(item) && isOpenDispatch(item!)).length,
        openBlockers: this.store
          .listBlockers()
          .filter(
            (item) =>
              item.threadId === thread.id &&
              (item.status === 'open' || item.status === 'notified'),
          ).length,
        lastEventAt: thread.lastEventAt,
      }))
    return { threads, count: threads.length }
  }

  /** 销账（或放弃）一条活：状态落定 + 名下卡点随之归档。 */
  async closeThread(
    threadId: string,
    state: 'done' | 'abandoned',
    by: 'user' | 'butler' | 'auto_ttl' = 'user',
  ): Promise<any> {
    if (!this.config.thread.enabled) return { ok: false, message: 'thread 功能未开启' }
    const thread = this.store.getThread(threadId)
    if (!thread) return { ok: false, message: 'thread 不存在' }
    if (thread.state === 'done' || thread.state === 'abandoned') {
      return { ok: false, message: `这条活已经结束（${thread.state}）` }
    }
    const open = thread.dispatchIds
      .map((id) => this.store.getDispatch(id))
      .filter((item): item is Dispatch => Boolean(item) && isOpenDispatch(item!))
    if (open.length > 0) {
      return { ok: false, message: `还有 ${open.length} 条派发没结束，先收尾派发` }
    }
    const before = this.store
      .listBlockers()
      .filter(
        (item) =>
          item.threadId === threadId && (item.status === 'open' || item.status === 'notified'),
      ).length
    thread.state = state
    thread.closedAt = now()
    thread.closedBy = by
    thread.lastEventAt = now()
    await this.store.putThread(thread)
    await this.resolveBlockersBy(
      (blocker) => blocker.threadId === threadId,
      state === 'done' ? '活已销账' : '活已放弃',
    )
    await this.store.appendAudit({
      sessionId: thread.participantSessionIds[0],
      kind: 'dispatch',
      action: state === 'done' ? 'thread_done' : 'thread_abandoned',
      threadId,
      by: by === 'user' ? 'user' : by === 'butler' ? 'butler-chat' : 'butler-auto',
      note: `${thread.title}（归档卡点 ${before} 条）`,
    })
    this.queueEmit()
    return { ok: true, threadId, state, archivedBlockers: before }
  }

  private async completeDispatch(
    dispatch: Dispatch,
    title: string,
    soft: SoftStatus,
  ): Promise<void> {
    if (dispatch.status === 'completed') return
    dispatch.status = 'completed'
    await this.store.putDispatch(dispatch)
    await this.settleThread(dispatch.threadId)
    await this.store.appendAudit({
      sessionId: dispatch.targetSessionId,
      kind: 'dispatch',
      action: 'completed',
      dispatchId: dispatch.id,
      threadId: dispatch.threadId,
      decision: 'completed',
      by: 'butler-auto',
      note: firstLine(soft.goal ?? dispatch.text, 120),
    })
    this.queueProgress(
      dispatch.targetSessionId,
      [
        '【SuperAgent 进度】',
        `- ${title}：任务完成`,
        soft.done?.length ? `- 完成 ${soft.done.length} 项：${truncate(soft.done.slice(-2).join('；'), 120)}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      dispatch.fromButlerSessionId,
      this.progressNotice(
        dispatch.targetSessionId,
        `${title}：任务完成`,
        soft.done?.length ? truncate(soft.done.slice(-2).join('；'), 200) : undefined,
        { category: 'dispatch' },
      ),
      { urgent: true },
    )
    this.queueEmit()
  }

  private noteTurnEnd(sessionId: string, data: any): void {
    const kind = String(data?.reason?.kind ?? '')
    const dispatch = this.store.currentDispatch(sessionId)
    if (!dispatch) return
    if (
      kind !== 'error' &&
      kind !== 'interrupted'
    ) {
      // 上一轮报错、这一轮正常结束：把派发从 error 恢复成正常进行中。
      if (dispatch.status === 'error' && kind === 'completed') {
        dispatch.status = 'delivered'
        void this.store.putDispatch(dispatch).catch(() => {})
      }
      return
    }
    if (
      dispatch.status !== 'accepted' &&
      dispatch.status !== 'delivered' &&
      dispatch.status !== 'error'
    ) {
      return
    }
    const title = this.store.getSession(sessionId)?.title ?? sessionId.slice(0, 8)
    const errorRaw = data?.reason?.error
    dispatch.error =
      kind === 'error'
        ? String(errorRaw?.message ?? errorRaw ?? 'turn error')
        : 'turn interrupted'
    // 工具参数/输出格式类错误改一下就能继续：派发标 error（可恢复），不判终态 failed。
    const recoverable =
      kind === 'error' && isRecoverableTurnError(dispatch.error, String(errorRaw?.code ?? ''))
    dispatch.status = recoverable ? 'error' : 'failed'
    void this.store
      .putDispatch(dispatch)
      .then(() => {
        this.queueProgress(
          sessionId,
          `【SuperAgent 进度】\n- ${title}：${
            recoverable ? '上一轮报错（可恢复）' : '任务失败'
          }（${truncate(dispatch.error ?? kind, 120)}）`,
          dispatch.fromButlerSessionId,
          this.progressNotice(
            sessionId,
            `${title}：${recoverable ? '上一轮报错（可恢复）' : '任务失败'}`,
            truncate(dispatch.error ?? kind, 200),
            {
              category: 'dispatch',
              severity: recoverable ? 'warning' : 'critical',
            },
          ),
          { urgent: true },
        )
        this.queueEmit()
      })
      .catch(() => {})
  }

  /**
   * 同一 session 的进度提醒 60 秒合并一次，避免刷屏。
   *
   * `urgent` 用于「任务完成 / 失败」这类关键事件：不等合并，立刻发出去。
   */
  private queueProgress(
    sessionId: string,
    text: string,
    butlerSessionId?: string,
    notice?: ButlerNotice,
    options: { urgent?: boolean } = {},
  ): void {
    this.progressTarget.set(sessionId, butlerSessionId)
    const pending = this.progressPending.get(sessionId) ?? []
    pending.push({
      text,
      source: notice ? noticeSource(notice) : undefined,
      butlerSessionId,
    })
    this.progressPending.set(sessionId, pending)
    if (options.urgent) {
      this.flushProgress(sessionId)
      return
    }
    const last = this.progressLastAt.get(sessionId) ?? 0
    const wait = 60_000 - (now() - last)
    if (wait <= 0) {
      this.flushProgress(sessionId)
      return
    }
    if (this.progressTimers.has(sessionId)) return
    const timer = setTimeout(() => {
      this.progressTimers.delete(sessionId)
      this.flushProgress(sessionId)
    }, wait)
    timer.unref?.()
    this.progressTimers.set(sessionId, timer)
  }

  /** 造一条进度/里程碑提醒（无阻塞动作，最多带一个「打开会话」）。 */
  private progressNotice(
    sessionId: string,
    title: string,
    detail: string | undefined,
    options: { category?: ButlerNotice['category']; severity?: ButlerNotice['severity'] } = {},
  ): ButlerNotice {
    const sessionTitle = this.store.getSession(sessionId)?.title ?? sessionId.slice(0, 8)
    return {
      id: uuid(),
      at: now(),
      kind: 'progress',
      category: options.category ?? 'milestone',
      severity: options.severity ?? 'info',
      sessionId,
      sessionTitle,
      source: this.sourceKindOf(sessionId),
      title,
      detail,
      actions: [{ verb: 'open_session', label: '打开会话' }],
    }
  }

  private flushProgress(sessionId: string): void {
    const pending = this.progressPending.get(sessionId)
    if (!pending || pending.length === 0) return
    this.progressPending.delete(sessionId)
    this.progressLastAt.set(sessionId, now())
    const text =
      pending.length === 1
        ? pending[0].text
        : `${pending[0].text}\n（另有 ${pending.length - 1} 条进度更新）`
    const first = pending[0]
    // 进度已有面板载体（snapshot.progressNotices），注入这份只给模型看：
    // 打 modelOnly 标记，客户端不再把它渲成卡片，用户就不会看到两遍。
    const withModelOnly = (source: any) =>
      source ? { ...source, modelOnly: true } : source
    const source =
      pending.length === 1
        ? withModelOnly(first.source)
        : withModelOnly(
            noticeSource(
              this.progressNotice(
                sessionId,
                `${this.store.getSession(sessionId)?.title ?? sessionId.slice(0, 8)}：${pending.length} 条进度更新`,
                pending
                  .slice(-3)
                  .map((item) => firstLine(item.text, 80))
                  .join(' / '),
              ),
            ),
          )
    void this.injectButlerNotice({
      text,
      source,
      butlerSessionId: this.progressTarget.get(sessionId),
    })
  }

  /**
   * worker 上报后：把这次上报算成「有进展」，并把 done 签名落进持久化游标，
   * 让扫描路径（evaluateProgress）不会把同一批里程碑再报一遍。
   */
  private markReported(dispatch: Dispatch, done: string[], at: number): void {
    const cursor = dispatch.progress ?? initialCursor(at)
    const notified = [...(cursor.notified ?? [])]
    for (const item of done) {
      const text = String(item ?? '').trim()
      if (!text) continue
      const signature = milestoneSignature(text)
      if (!notified.includes(signature)) notified.push(signature)
    }
    dispatch.progress = {
      ...cursor,
      notified: notified.slice(-NOTIFIED_LIMIT),
      lastProgressAt: at,
      lastMilestoneAt: at,
    }
    void this.store.putDispatch(dispatch).catch(() => {})
  }

  /**
   * 扫描态进度检测（A1 里程碑 / A2 阶段结束 / A3 卡点消失 / B watchdog）。
   *
   * progress 是通知：不进 blocker、不进待办条、不需要用户点按钮。
   * 只对管家派发的任务推送（§6.4）；手动 session 的软状态变化仍然只刷新面板。
   */
  private async evaluateProgress(input: {
    sessionId: string
    title: string
    dispatch?: Dispatch
    soft?: SoftStatus
    running: boolean
    /** 最近一次真实会话活动（runtime.lastActivityAt）；watchdog 与上报取较新者。 */
    lastActivityAt?: number
    resolved?: ResolvedBlockerRef[]
  }): Promise<void> {
    const dispatch = input.dispatch
    // 收尾（completed/failed/superseded）后不再推进度，也不再问 watchdog。
    if (!dispatch || !isOpenDispatch(dispatch)) return
    const at = now()
    const doneCount = input.soft?.done?.length ?? 0
    // 升级前创建的老派发没有游标：第一次扫描只播种，不补报历史 done。
    if (!dispatch.progress) {
      dispatch.progress = seedCursor(at, input.soft, input.running)
      dispatch.progress.lastTurnEndAt = this.runtimes.get(input.sessionId)?.lastTurnEnd?.at ?? at
      await this.store.putDispatch(dispatch)
      return
    }
    const lastTurnEnd = this.runtimes.get(input.sessionId)?.lastTurnEnd ?? undefined
    const events = detectProgress({
      title: input.title,
      dispatch,
      soft: input.soft,
      running: input.running,
      lastActivityAt: input.lastActivityAt,
      resolved: input.resolved,
      lastTurnEnd,
      // I-19：等审批/等回答期间不许报「没进展」
      hardStatus: this.hardStatusFor(input.sessionId),
      config: this.config,
      now: at,
    })
    // I-28(2)：阶段结束也是一条「疑似完成」的事实依据，写进 dispatch 而不是每次重新推断。
    if (events.some((event) => event.kind === 'stage_end') && !dispatch.suspectDoneAt) {
      dispatch.suspectDoneAt = at
      dispatch.suspectDoneReason = 'stage_end'
      await this.store.putDispatch(dispatch)
    }
    const before = JSON.stringify(dispatch.progress)
    dispatch.progress = advanceCursor({
      cursor: dispatch.progress,
      events,
      running: input.running,
      doneCount,
      now: at,
      lastTurnEndAt: lastTurnEnd?.at,
    })
    if (JSON.stringify(dispatch.progress) !== before) await this.store.putDispatch(dispatch)
    if (events.length === 0) return
    // P1：watchdog 是自动决策，先过策略引擎。shadow 时只记台账，不发通知、不唤醒管家。
    const emitted: typeof events = []
    for (const event of events) {
      if (event.kind !== 'watchdog') {
        emitted.push(event)
        continue
      }
      const decision = this.policyFor('watchdog_stall')
      const shadow = decision.mode === 'shadow'
      await this.store.appendAudit({
        sessionId: input.sessionId,
        kind: 'dispatch',
        action: 'watchdog_remind',
        dispatchId: dispatch.id,
        ruleId: 'watchdog_stall',
        shadow,
        note: `${shadow ? 'shadow：本会提醒' : 'watchdog'}「${event.title}」（${decision.reason}）`,
      })
      this.statsCache = null
      if (!shadow) emitted.push(event)
    }
    // 游标已经推进过（watchdog 不会因为被 shadow 掉而下一轮重发），这里只决定"要不要说出去"
    if (emitted.length === 0) return
    const first = emitted[0]!
    const notice = this.progressNotice(
      input.sessionId,
      emitted.length === 1 ? first.title : `${input.title}：${emitted.length} 条进度更新`,
      emitted.length === 1
        ? first.detail
        : emitted
            .map((event) => event.title)
            .slice(-3)
            .join(' / '),
      { category: first.category },
    )
    const text = [
      '【SuperAgent 进度】',
      ...emitted
        .slice(-4)
        .map(
          (event) =>
            `- ${event.title}${event.detail ? `｜${truncate(event.detail, 80)}` : ''}`,
        ),
    ].join('\n')
    this.queueProgress(input.sessionId, text, dispatch.fromButlerSessionId, notice)
    // B-1：先落盘（面板 2 秒轮询就能看到，不再依赖用户先说话），再看要不要唤醒管家。
    await this.recordProgressNotices(input.sessionId, input.title, dispatch, emitted)
    await this.maybeWakeButler(dispatch, emitted)
  }

  /**
   * 快照里可见的进度通知：只留 open 且没过期的，并借这次读把过期项标成 expired 落盘。
   *
   * 与 `blockerNotices` 完全分开：这里绝不返回 blocker，也绝不进待办条。
   */
  private visibleProgressNotices(): ButlerNotice[] {
    const config = this.config.progress
    const at = now()
    const stored = this.store.listProgressNotices()
    const expired = stored.filter((item) => item.status === 'open' && item.expiresAt <= at)
    const visible = stored.filter((item) => item.status === 'open' && item.expiresAt > at)
    if (expired.length > 0) {
      const expiredIds = new Set(expired.map((item) => item.id))
      void this.store
        .saveProgressNotices(
          stored.map((item) =>
            expiredIds.has(item.id) ? { ...item, status: 'expired' as const } : item,
          ),
        )
        .catch(() => {})
    }
    return visible.slice(0, config.queueLimit).map((item) => ({
      id: item.id,
      at: item.at,
      kind: 'progress' as const,
      category: item.category,
      severity: item.severity,
      sessionId: item.sessionId,
      sessionTitle: item.sessionTitle,
      source: item.source,
      title: item.title,
      detail: item.detail,
      dispatchId: item.dispatchId,
      status: item.status,
      expiresAt: item.expiresAt,
      // 只读来源不能跳转（dsh 里没有它的会话），就不渲染任何按钮（R6）
      actions: item.source && item.source !== 'dsh' ? [] : [{ verb: 'open_session' as const, label: '打开会话' }],
    }))
  }

  /** 把这一批进度事件写进持久化队列（快照 progressNotices 的来源）。 */
  private async recordProgressNotices(
    sessionId: string,
    sessionTitle: string,
    dispatch: Dispatch,
    events: readonly ProgressEvent[],
  ): Promise<void> {
    const config = this.config.progress
    const at = now()
    const source = this.sourceKindOf(sessionId)
    const fresh: ProgressNoticeRecord[] = events.map((event) => ({
      id: shortId('png'),
      at,
      sessionId,
      sessionTitle,
      source,
      kind: event.kind,
      category: event.category,
      severity: event.kind === 'watchdog' ? 'warning' : 'info',
      title: event.title,
      detail: event.detail,
      dispatchId: dispatch.id,
      signatures: event.signatures,
      status: 'open',
      expiresAt: at + config.ttlMs,
    }))
    const existing = this.store.listProgressNotices()
    const seen = new Set(existing.flatMap((item) => item.signatures))
    const deduped = fresh.filter((item) => !item.signatures.some((signature) => seen.has(signature)))
    if (deduped.length === 0) return
    const merged = [...deduped, ...existing]
      .filter((item) => item.status === 'open' && item.expiresAt > at)
      .slice(0, config.queueLimit)
    await this.store.saveProgressNotices(merged)
    this.queueEmit()
  }

  /**
   * B-1 §5：有界唤醒管家。
   *
   * 有界性论证见 `decideWake`：类型闸 + 签名闸 + 每 dispatch 配额 + 全局节流 + 管家忙时不唤醒。
   * 额外保证：**先落盘 woke 签名与计数，再发 prompt**——即使 prompt 失败也不会重试成二次唤醒。
   */
  private async maybeWakeButler(dispatch: Dispatch, events: readonly ProgressEvent[]): Promise<void> {
    const config = this.config.progress.wake
    if (!config.enabled) return
    if (!isOpenDispatch(dispatch)) return
    const butlerId = dispatch.fromButlerSessionId ?? this.butlerId
    if (!butlerId) return
    const wakeCount = this.wakeCounts.get(dispatch.id) ?? 0
    const decision = decideWake({
      enabled: config.enabled,
      kinds: config.kinds,
      maxPerDispatch: config.maxPerDispatch,
      minGapMs: config.minGapMs,
      events,
      woke: dispatch.progress?.woke ?? [],
      wakeCount,
      lastWakeAt: this.lastWakeAt,
      butlerRunning: this.agentOf(butlerId)?.status === 'running',
      now: now(),
    })
    if (!decision.wake) return

    const cursor = dispatch.progress ?? initialCursor(now())
    dispatch.progress = {
      ...cursor,
      woke: [...(cursor.woke ?? []), decision.signature].slice(-NOTIFIED_LIMIT),
    }
    await this.store.putDispatch(dispatch)
    this.wakeCounts.set(dispatch.id, wakeCount + 1)
    this.lastWakeAt = now()
    await this.store.appendAudit({
      sessionId: dispatch.targetSessionId,
      kind: 'dispatch',
      action: 'wake',
      decision: decision.kind,
      by: 'butler-auto',
      note: decision.title,
    })
    await this.sendToSession(
      butlerId,
      [
        '【管家·自动唤醒】',
        `派发 ${dispatch.id} 有新进展：${decision.title}`,
        `目标会话：${this.store.getSession(dispatch.targetSessionId)?.title ?? dispatch.targetSessionId}`,
        '这是系统替你排的一次唤醒，不是用户的新指令。只在确实需要推动/追问时才行动；',
        '不要为了回应这条而再派发或重复播报，也不要唤醒你自己。',
      ].join('\n'),
    )
  }

  private async evaluateSession(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId) ?? (await this.ensureRuntime(sessionId))
    const live = this.liveInfo(sessionId)
    const hardStatus = deriveHardStatus(runtime, live)
    const managed = this.store.getSession(sessionId)
    const sessionTitle = managed?.title ?? sessionId.slice(0, 8)
    const project = managed?.projectKey ? this.store.getProject(managed.projectKey) : undefined
    const currentDispatch = this.store.currentDispatch(sessionId)
    // 没有进行中的派发时，看看是不是最近一条派发已经中止（failed）：要出「中止但没审计划」的卡点。
    const abortedDispatch = currentDispatch
      ? undefined
      : (() => {
          const latest = this.store.latestDispatch(sessionId)
          if (!latest || latest.status !== 'failed') return undefined
          if (now() - latest.createdAt > 24 * 60 * 60_000) return undefined
          return latest
        })()
    const pendingPlan = this.store.pendingPlan(sessionId)
    const pendingApprovals = this.store
      .listApprovals()
      .filter((approval) => approval.sessionId === sessionId && approval.status === 'pending')
    const detected = detectBlockers({
      sessionId,
      sessionTitle,
      runtime,
      live,
      hardStatus,
      currentDispatch,
      abortedDispatch,
      pendingPlan,
      pendingApprovals,
      config: this.config,
      now: now(),
      lastActivityAt: Math.max(runtime.lastActivityAt, managed?.lastSeenAt ?? 0),
    })
    // I-28(1)：活看起来干完了，**只建议、不擅自销账**。
    const settleSuggest = this.settleSuggestBlocker({
      sessionId,
      sessionTitle,
      hardStatus,
      dispatch: currentDispatch,
      soft: runtime.softStatus ?? managed?.softStatus,
    })
    if (settleSuggest) detected.push(settleSuggest)
    const resolved = await this.syncBlockers(sessionId, detected)
    await this.evaluateProgress({
      sessionId,
      title: sessionTitle,
      dispatch: currentDispatch,
      soft: runtime.softStatus ?? managed?.softStatus,
      running: live.running,
      // 只用 runtime 的活动时间，不用 managed.lastSeenAt：后者每次 listSessions 扫描都会刷新，
      // 拿它当活动会让 watchdog 永远不触发。
      lastActivityAt: runtime.lastActivityAt,
      resolved,
    })
    void project
  }

  private async syncBlockers(
    sessionId: string,
    detected: DetectedBlocker[],
  ): Promise<ResolvedBlockerRef[]> {
    const existing = this.store.listBlockers().filter(
      (blocker) =>
        blocker.sessionId === sessionId &&
        (blocker.status === 'open' || blocker.status === 'notified'),
    )
    const detectedSignatures = new Set(detected.map((item) => item.signature))
    let changed = false
    for (const item of detected) {
      const current = this.store.findOpenBlocker(sessionId, item.signature)
      if (current) {
        current.summary = item.summary
        current.neededAction = item.neededAction
        current.evidence = item.evidence
        current.lastSeenAt = now()
        current.severity = item.severity
        await this.store.putBlocker(current)
        changed = true
        await this.maybeRemind(current)
        continue
      }
      const blocker: Blocker = {
        id: shortId('blk'),
        sessionId,
        kind: item.kind,
        subkind: item.subkind,
        severity: item.severity,
        status: 'open',
        signature: item.signature,
        summary: item.summary,
        neededAction: item.neededAction,
        evidence: item.evidence,
        detectedAt: now(),
        lastSeenAt: now(),
        reminderCount: 0,
        threadId: this.config.thread.enabled
          ? (this.store.currentDispatch(sessionId)?.threadId ??
            this.store.activeThreadForSession(sessionId)?.id)
          : undefined,
        relatedPlanId: item.relatedPlanId,
        relatedApprovalId: item.relatedApprovalId,
        relatedCallId: item.relatedCallId,
        relatedTurn: item.relatedTurn,
      }
      await this.store.putBlocker(blocker)
      changed = true
      await this.maybeRemind(blocker)
      await this.store.appendAudit({
        sessionId,
        kind: 'blocker',
        action: 'open',
        blockerId: blocker.id,
        note: blocker.summary,
      })
    }
    // 刚消失的卡点：交给进度检测发一条「卡点已解除」的通知（卡点本身仍走 blocker 表）。
    const resolved: ResolvedBlockerRef[] = []
    for (const blocker of existing) {
      if (detectedSignatures.has(blocker.signature)) continue
      blocker.status = 'auto_resolved'
      blocker.resolvedAt = now()
      blocker.resolution = '条件已消失'
      await this.store.putBlocker(blocker)
      changed = true
      resolved.push({ signature: blocker.signature, summary: blocker.summary })
      await this.store.appendAudit({
        sessionId,
        kind: 'blocker',
        action: 'auto_resolve',
        blockerId: blocker.id,
        note: blocker.summary,
      })
    }
    if (changed) this.queueEmit()
    return resolved
  }

  /**
   * 卡点是否该「真唤醒」管家（I-32 部分 (1)(3)：主动上报 + 主动开口）。
   *
   * 四道闸 + 两道防自激：
   *  - 闸① 同签名只唤醒一次（签名落盘，与 `dispatch.progress.woke` 同一套语义）；
   *  - 闸② 每派发配额 `maxPerDispatch`（数已落盘的 `blockerwake:` 签名）；
   *  - 闸③ 同一 dispatch 两次唤醒间隔 ≥ `minGapMs`；
   *  - 闸④ 管家正在 running 时不打断它的 turn；
   *  - 防自激①：卡点所在会话如果就是管家自己的会话，**绝不唤醒**（否则管家自己产生的审批会反复叫醒自己）；
   *  - 防自激②：签名在**发送之前**落盘，发送失败也不会下一轮立刻重发。
   */
  private shouldWakeForBlocker(
    blocker: Blocker,
    dispatch: Dispatch | undefined,
  ): { wake: boolean; reason: string; signature: string; butlerId?: string } {
    const config = this.config.blockerWake
    const signature = `blockerwake:${blocker.kind}:${blocker.id}`
    if (!config.enabled) return { wake: false, reason: 'disabled', signature }
    if (!config.kinds.includes(blocker.kind)) {
      return { wake: false, reason: `kind:${blocker.kind}`, signature }
    }
    if (this.isButlerSessionId(blocker.sessionId)) {
      return { wake: false, reason: 'butler-self', signature }
    }
    const butlerId = dispatch?.fromButlerSessionId ?? this.butlerId
    if (!butlerId) return { wake: false, reason: 'no-butler', signature }
    if (this.agentOf(butlerId)?.status === 'running') {
      return { wake: false, reason: 'butler-running', signature }
    }
    const woke = dispatch?.progress?.woke ?? blocker.woke ?? []
    if (woke.includes(signature)) return { wake: false, reason: 'already-woke', signature }
    const used = woke.filter((item) => item.startsWith('blockerwake:')).length
    // 没有派发的卡点没有「每派发配额」可言，最多唤一次
    const limit = dispatch ? config.maxPerDispatch : 1
    if (used >= limit) return { wake: false, reason: `quota:${used}/${limit}`, signature }
    const key = dispatch?.id ?? blocker.id
    const last = this.lastBlockerWakeAt.get(key) ?? 0
    if (last > 0 && now() - last < config.minGapMs) {
      return { wake: false, reason: 'throttled', signature }
    }
    return { wake: true, reason: 'ok', signature, butlerId }
  }

  /** 先落盘签名，再发送：签名在，就不会因为发送失败而陷入「醒了没成功→下一轮再醒」的环。 */
  private async recordBlockerWake(
    blocker: Blocker,
    dispatch: Dispatch | undefined,
    signature: string,
  ): Promise<void> {
    const key = dispatch?.id ?? blocker.id
    if (dispatch) {
      const cursor = dispatch.progress ?? initialCursor(now())
      const woke = [...(cursor.woke ?? []), signature].slice(-NOTIFIED_LIMIT)
      dispatch.progress = { ...cursor, woke }
      await this.store.putDispatch(dispatch)
    } else {
      blocker.woke = [...(blocker.woke ?? []), signature].slice(-NOTIFIED_LIMIT)
      await this.store.putBlocker(blocker)
    }
    this.lastBlockerWakeAt.set(key, now())
  }

  /** 会真正起 turn 的投递（与 inject 相对）。返回是否送出去。 */
  private async wakeSession(sessionId: string, text: string): Promise<boolean> {
    try {
      await this.source.prompt(sessionId, text, this.source.newRequestId())
      return true
    } catch {
      return false
    }
  }

  private async maybeRemind(blocker: Blocker): Promise<void> {
    if (blocker.status !== 'open' && blocker.status !== 'notified') return
    if (blocker.reminderCount >= this.config.maxRemindersPerBlocker) return
    if (
      blocker.lastRemindedAt &&
      now() - blocker.lastRemindedAt < this.config.reminderCooldownMs
    ) {
      return
    }
    const ruleId = this.reminderRuleFor(blocker)
    const decision = ruleId ? this.policyFor(ruleId) : undefined
    if (ruleId && decision?.mode === 'shadow') {
      // shadow：只记账、不发提醒。仍然推进节流时间，否则每轮扫描都会刷一条审计。
      blocker.lastRemindedAt = now()
      await this.store.putBlocker(blocker)
      await this.store.appendAudit({
        sessionId: blocker.sessionId,
        kind: 'blocker',
        action: 'remind',
        blockerId: blocker.id,
        ruleId,
        shadow: true,
        note: `shadow：本会提醒「${blocker.summary}」（${decision.reason}）`,
      })
      this.statsCache = null
      return
    }
    const dispatch = this.store.currentDispatch(blocker.sessionId)
    const dispatchInProgress = Boolean(
      dispatch &&
        (dispatch.status === 'accepted' ||
          dispatch.status === 'delivered' ||
          dispatch.status === 'error'),
    )
    const notice = buildBlockerNotice(blocker, {
      sessionTitle: this.store.getSession(blocker.sessionId)?.title,
      dispatchId: dispatch?.id,
      dispatchInProgress,
    })
    const text = [
      '【SuperAgent 提醒】',
      `- ${blocker.summary}`,
      `- 需要你：${blocker.neededAction}`,
      `- 用户会在对话里点按钮处理；这条只是通知，不是你的指令。`,
    ].join('\n')
    // I-32 部分：需要人拍板的三类卡点**真唤醒**管家（起 turn），其余仍走 inject（不唤醒）。
    const wake = this.shouldWakeForBlocker(blocker, dispatch)
    if (wake.wake && wake.butlerId) {
      // 先落盘签名（防自激），再发送；发送失败也不回滚签名，避免「醒了没成功 → 下一轮再醒」的环。
      await this.recordBlockerWake(blocker, dispatch, wake.signature)
      const woke = await this.wakeSession(
        wake.butlerId,
        [
          '【管家·自动唤醒】',
          `有一个${blocker.kind === 'approval' ? '审批' : blocker.kind === 'decision' ? '决策' : '故障'}需要你处理，不是用户的新指令：`,
          `- ${blocker.summary}`,
          `- 需要你：${blocker.neededAction}`,
          '先看 butler_inbox 确认状态，再按用户既有授权决定要不要处理；不要为了回应这条而重复播报。',
        ].join('\n'),
      )
      await this.store.appendAudit({
        sessionId: blocker.sessionId,
        kind: 'blocker',
        action: 'wake',
        blockerId: blocker.id,
        by: 'butler-auto',
        note: `${blocker.kind} 真唤醒（${woke ? '已送达' : '投递失败，已落盘签名'}）：${blocker.summary}`,
      })
      if (!woke) {
        // 真唤醒没送出去 → 退回注入/队列，保证内容不丢
        await this.injectButlerNotice({
          text,
          source: noticeSource(notice),
          butlerSessionId: dispatch?.fromButlerSessionId,
        })
      }
      await this.finishReminderAccounting(blocker, ruleId, 'wake')
      return
    }
    // I-34：先投递、拿到结果再记账。
    // 「已注入」= 真的送到管家上下文；「进队列」= 进了持久化队列，管家回来会补投。
    // 两者都不是时（理论上只在目标全挂时出现）**不记账**，保持 open 等下一轮重试，
    // 否则就会出现「账上有、内容没了，于是既不重发也不重算」。
    const delivery = await this.injectButlerNotice({
      text,
      source: noticeSource(notice),
      butlerSessionId: dispatch?.fromButlerSessionId,
    })
    if (!delivery.delivered && !delivery.queued) {
      await this.store.appendAudit({
        sessionId: blocker.sessionId,
        kind: 'blocker',
        action: 'notify_deferred',
        blockerId: blocker.id,
        ...(ruleId ? { ruleId } : {}),
        note: `投递失败（${delivery.targets} 个目标都不可用），保持待提醒，下一轮重试：${blocker.summary}`,
      })
      return
    }
    await this.finishReminderAccounting(
      blocker,
      ruleId,
      delivery.delivered ? 'injected' : 'queued',
    )
  }

  /**
   * 提醒记账（两条路径共用）：唤醒成功与注入/入队都算「这一轮提醒发出去了」。
   * 只有「既没唤醒也没注入、连队列都没进」才不记账（由调用方提前 return）。
   */
  private async finishReminderAccounting(
    blocker: Blocker,
    ruleId: string | undefined,
    mode: 'wake' | 'injected' | 'queued',
  ): Promise<void> {
    blocker.status = 'notified'
    blocker.notifiedAt = blocker.notifiedAt ?? now()
    blocker.lastRemindedAt = now()
    blocker.reminderCount += 1
    await this.store.putBlocker(blocker)
    await this.store.appendAudit({
      sessionId: blocker.sessionId,
      kind: 'blocker',
      action: 'remind',
      blockerId: blocker.id,
      ...(ruleId ? { ruleId } : {}),
      note:
        mode === 'wake'
          ? `${blocker.summary}（已真唤醒管家）`
          : mode === 'injected'
            ? blocker.summary
            : `${blocker.summary}（管家离线，已落盘排队，回来补投）`,
    })
    if (ruleId) this.statsCache = null
  }

  /** 卡点提醒归属于哪条规则；不可迁移的硬卡点（审批/提问/计划/决策）不参与策略引擎。 */
  private reminderRuleFor(blocker: Blocker): string | undefined {
    if (blocker.kind !== 'repeated_failure') return undefined
    return blocker.subkind === 'edit_thrash' ? 'blocker_edit_thrash' : 'blocker_repeat_failure'
  }

  /** 规则命中率（30s 缓存）：每条决策都全量扫审计太浪费。 */
  private ruleStats(): RuleStat[] {
    const at = now()
    if (this.statsCache && at - this.statsCache.at < 30_000) return this.statsCache.stats
    const stats = computeStats(this.store.listAudit(), this.config.policy.windowDays, at)
    this.statsCache = { at, stats }
    return stats
  }

  private policyFor(ruleId: string): PolicyDecision {
    const stat = this.ruleStats().find((item) => item.ruleId === ruleId)
    return decidePolicy(ruleId, stat, this.config.policy)
  }

  /**
   * 跑一轮决策标注（P1）。
   *
   * 只回填还没有 outcome 的审计；标注失败绝不影响主链路（门禁、提醒照常）。
   */
  private async runLabeling(): Promise<void> {
    if (!this.config.policy.enabled) return
    const at = now()
    try {
      const updates = labelDecisions({
        audits: this.store.listAudit(),
        blockers: this.store.listBlockers(),
        dispatches: this.store.listDispatches(),
        notices: this.store.listProgressNotices(),
        now: at,
        standard: this.config.policy.standard,
      })
      for (const update of updates) {
        await this.store.updateAudit(update.auditId, {
          outcome: update.outcome,
          outcomeRule: update.outcomeRule,
          outcomeAt: update.outcomeAt,
        })
      }
      if (updates.length > 0) {
        this.statsCache = null
        this.queueEmit()
      }
    } catch {
      // 标注是旁路，坏掉也不能影响门禁/提醒
    }
    this.lastLabelAt = at
  }

  /** 面板用的准确率视图：规则元信息 + 统计 + 当前模式，一次给全。 */
  private policyStatsView(): PolicyStatsView {
    const at = now()
    return {
      generatedAt: at,
      windowDays: this.config.policy.windowDays,
      standard: this.config.policy.standard,
      minSamples: this.config.policy.minSamples,
      rules: this.ruleStats().map((stat) => {
        const meta = ruleMeta(stat.ruleId)
        const decision = decidePolicy(stat.ruleId, stat, this.config.policy)
        return {
          ruleId: stat.ruleId,
          label: meta?.label ?? stat.ruleId,
          group: meta?.group ?? 'other',
          fpBasis: meta?.fpBasis ?? '',
          n: stat.n,
          tp: stat.tp,
          fp: stat.fp,
          fn: stat.fn,
          unknown: stat.unknown,
          precision: stat.precision,
          precisionLB: stat.precisionLB,
          mode: decision.mode,
          reason: decision.reason,
          lastAt: stat.lastAt,
        }
      }),
    }
  }

  private intentFor(sessionId: string): Map<string, ToolIntent> {
    let map = this.intents.get(sessionId)
    if (!map) {
      map = new Map()
      this.intents.set(sessionId, map)
    }
    return map
  }

  private riskContext(agent: any): RiskContext {
    const sessionId = String(agent.id)
    const cwd = String(agent?.session?.header?.cwd ?? this.defaultCwd())
    const currentDispatch = this.store.currentDispatch(sessionId)
    const project =
      (currentDispatch && this.store.getProject(currentDispatch.workspaceKey)) ??
      this.currentProjectForSession(sessionId, cwd)
    const gated = Boolean(currentDispatch && this.planRequired(currentDispatch))
    const plan = currentDispatch ? this.store.approvedPlan(currentDispatch.id) : undefined
    return {
      projectRoot: project.cwd,
      cwd,
      gated,
      policy: gated ? 'plan' : 'whitelist',
      plan,
      allowReadOnlyBash: this.config.planReview.allowReadOnlyBash,
    }
  }

  /**
   * §4.4：派发时与当前都是计划审查，这个 dispatch 才要求计划。
   * 项目取 dispatch 自己的 workspaceKey：新开的 session 还没进 store，不能按 session 反查。
   */
  private planRequired(dispatch: Dispatch): boolean {
    return planRequiredFor(dispatch, this.store.getProject(dispatch.workspaceKey))
  }

  /** §7.3：没有进行中的管家派发 = 手动 session，审批完全交给原生流程。 */
  private hasActiveDispatch(sessionId: string): boolean {
    return Boolean(this.store.currentDispatch(sessionId))
  }

  private classify(agent: any, toolName: string, args: any): ToolIntent {
    const context = this.riskContext(agent)
    const result = classifyTool(toolName, args, context)
    return {
      toolName,
      callId: undefined,
      argsSummary: summarizeArgs(toolName, args),
      risk: result.risk,
      gated: context.gated,
      policy: context.policy,
      planId: result.planId,
      planItemId: result.planItemId,
      deny: result.deny,
      reason: result.reason,
      review: result.review,
      flags: result.flags,
    }
  }

  /**
   * 规则判不了的 bash 交给管家模型看一眼：没风险就放行并写审计；有风险或审查失败返回 false，
   * 由调用方按原流程拒绝 / 转用户。只在管家派发的任务里调用。
   */
  private async reviewBash(agent: any, exec: any, intent: ToolIntent): Promise<boolean> {
    if (!this.config.bashReview.enabled || !intent.review) return false
    if (intent.toolName !== 'bash' && intent.toolName !== 'pwsh') return false
    const command = String(exec?.arguments?.command ?? '').trim()
    if (!command) return false
    const context = this.riskContext(agent)
    const verdict = await this.bashReviewer.review(
      agent,
      {
        command,
        mode: intent.review,
        cwd: context.cwd ?? context.projectRoot,
        projectRoot: context.projectRoot,
        flags: intent.flags ?? [],
      },
      exec?.signal,
    )
    const sessionId = String(agent.id)
    await this.store.appendAudit({
      sessionId,
      kind: 'approval',
      action: verdict.allow
        ? 'bash_review_allow'
        : verdict.failed
          ? 'bash_review_failed'
          : 'bash_review_deny',
      risk: verdict.allow ? 'low' : 'high',
      decision: verdict.allow ? 'allowed-once' : 'escalated',
      by: 'butler-auto',
      toolName: intent.toolName,
      callId: intent.callId,
      argsSummary: intent.argsSummary,
      // P1：拒绝是一次自动决策，要进台账；允许不单独成规则（漏报方向由 L3 反查）
      ...(verdict.allow ? {} : { ruleId: 'bash_deny' }),
      note: `${intent.review === 'readonly' ? '只读审查' : '危险审查'}：${verdict.reason}`,
    })
    if (!verdict.allow) {
      // 转给用户的理由只写管家给出的具体危险，或者说清楚是审查没跑成；不再写「含 shell 元字符」这类规则名。
      intent.reason = verdict.failed
        ? `管家没能完成审查（${verdict.reason}），无法确认是否危险，请你判断`
        : intent.deny
          ? `${intent.reason ?? '先交计划'}；管家审查：${verdict.reason}`
          : `危险原因：${verdict.reason}`
      return false
    }
    intent.risk = 'low'
    intent.deny = false
    intent.reason = `管家审查放行：${verdict.reason}`
    await this.store.putApproval({
      id: shortId('apv'),
      sessionId,
      toolName: intent.toolName,
      callId: intent.callId,
      argsSummary: intent.argsSummary,
      risk: 'low',
      reason: intent.reason,
      status: 'auto_approved',
      decidedBy: 'butler-auto',
      createdAt: now(),
      decidedAt: now(),
    })
    this.queueEmit()
    return true
  }

  /**
   * `job_kill` 的归属判定：只有「本会话启动的 job」免审批。
   *
   * 宿主 `ctx.jobs.get(id, caller)` 自带 owner 围栏——别人的或不存在 job 会抛错，
   * 所以这里不需要自己维护 job→session 表。拿不到 job registry 时返回否定结论：
   * 读不到归属就要求审批，绝不把「未知」当成「属于本会话」。
   */
  private jobKillVerdict(
    sessionId: string,
    jobId: string,
  ): { allow: boolean; reason?: string } {
    if (!jobId) return { allow: false, reason: 'job_kill 缺少 job_id' }
    let jobs: any
    try {
      jobs = typeof this.ctx.get === 'function' ? this.ctx.get('jobs') : this.ctx.jobs
    } catch {
      jobs = undefined
    }
    if (!jobs || typeof jobs.get !== 'function') {
      return {
        allow: false,
        reason: '宿主没有暴露 job registry，无法确认该 job 属于本会话，需要审批',
      }
    }
    try {
      const job = jobs.get(jobId, sessionId)
      if (job && String(job.owner ?? '') === sessionId) return { allow: true }
    } catch {
      // 别人的 job / 不存在的 id：get 会直接抛错，按「不属于本会话」处理。
    }
    return { allow: false, reason: '该 job 不属于本会话' }
  }

  /** 本会话是否已经批准过同一 MCP 工具（同 server 同方法）。 */
  private mcpAlreadyApproved(sessionId: string, toolName: string): boolean {
    if (!this.config.mcp.batchApprove) return false
    if (!mcpParts(toolName)) return false
    return this.store
      .listApprovals()
      .some(
        (approval) =>
          approval.sessionId === sessionId &&
          approval.toolName === toolName &&
          (approval.status === 'user_approved' || approval.status === 'auto_approved'),
      )
  }

  private async gate(agent: any, exec: any, next: any): Promise<any> {
    const downstream = await next()
    if (this.isButlerAgent(agent)) return downstream
    if (!this.hasActiveDispatch(String(agent.id))) return downstream
    const toolName = String(exec.name ?? '')
    const args = exec.arguments ?? {}
    const intent = this.classify(agent, toolName, args)
    intent.callId = exec.callId ? String(exec.callId) : undefined
    if (intent.callId) this.intentFor(String(agent.id)).set(intent.callId, intent)
    if (downstream?.kind === 'deny' || downstream?.kind === 'cancel') return downstream
    if (intent.deny) {
      if (await this.reviewBash(agent, exec, intent)) return downstream ?? { kind: 'allow' }
      return {
        kind: 'deny',
        reason: intent.reason ?? `${toolName} blocked by SuperAgent plan gate`,
      }
    }
    // worker 杀掉「自己这个会话启动的」job 不需要逐次审批；别人的 job（或读不到归属）
    // 仍然要求审批。只针对 job_kill，不能顺带放行 bash/write 等其它工具。
    if (toolName === 'job_kill') {
      const verdict = this.jobKillVerdict(String(agent.id), String(args?.job_id ?? '').trim())
      if (verdict.allow) return downstream ?? { kind: 'allow' }
      return { kind: 'ask', reason: verdict.reason ?? '该 job 不属于本会话' }
    }
    if (downstream?.kind === 'ask') return downstream
    // I-31(c)：同 server 同方法在本会话内已经批准过，就不再逐次问。
    // 依据是**已落盘的审批记录**（不是内存），重启后依然有效。
    if (mcpParts(toolName) && this.mcpAlreadyApproved(String(agent.id), toolName)) {
      await this.store.appendAudit({
        sessionId: String(agent.id),
        kind: 'approval',
        action: 'mcp_batch_allow',
        by: 'butler-auto',
        toolName,
        risk: intent.risk,
        note: `${toolName}：本会话已批准过同类调用，按批量放行`,
      })
      return downstream ?? { kind: 'allow' }
    }
    if (intent.risk === 'high' || intent.risk === 'unknown') {
      if (await this.reviewBash(agent, exec, intent)) return downstream ?? { kind: 'allow' }
      return {
        kind: 'ask',
        reason: intent.reason ?? `${toolName} requires approval`,
      }
    }
    return downstream ?? { kind: 'allow' }
  }

  private async answerApproval(agent: any, request: any, next: any): Promise<any> {
    if (this.isButlerAgent(agent) || !this.isRootAgent(agent)) return next()
    const sessionId = String(agent.id)
    if (!this.hasActiveDispatch(sessionId)) return next()
    const callId = request?.callId ? String(request.callId) : ''
    let intent = callId ? this.intentFor(sessionId).get(callId) : undefined
    if (!intent && callId) {
      const runtime = this.runtimes.get(sessionId)
      const call = runtime?.toolCalls.get(callId)
      if (call) {
        intent = this.classify(agent, call.name, call.args)
        intent.callId = callId
        this.intentFor(sessionId).set(callId, intent)
      }
    }
    if (!intent) {
      // Unknown request: always route to the user, never guess.
      return this.holdApproval(agent, request, {
        toolName: String(request?.toolName ?? 'unknown'),
        argsSummary: '（未能关联到工具参数）',
        risk: 'unknown',
        gated: false,
        policy: 'whitelist',
      })
    }
    if (intent.deny) return 'rejected'
    const auto =
      intent.risk === 'low' &&
      ((intent.policy === 'plan' && Boolean(intent.planItemId)) ||
        (intent.policy === 'whitelist' && Boolean(intent.argsSummary)))
    if (auto) {
      const approval: Approval = {
        id: shortId('apv'),
        sessionId,
        toolName: intent.toolName,
        callId: intent.callId,
        argsSummary: intent.argsSummary,
        risk: intent.risk,
        planId: intent.planId,
        planItemId: intent.planItemId,
        reason: intent.reason,
        status: 'auto_approved',
        decidedBy: 'butler-auto',
        createdAt: now(),
        decidedAt: now(),
      }
      await this.store.putApproval(approval)
      await this.store.appendAudit({
        sessionId,
        kind: 'approval',
        action: 'auto_approve',
        risk: intent.risk,
        decision: 'allowed-once',
        by: 'butler-auto',
        planId: intent.planId,
        planItemId: intent.planItemId,
        toolName: intent.toolName,
        callId: intent.callId,
        argsSummary: intent.argsSummary,
      })
      this.queueEmit()
      return 'allowed-once'
    }
    return this.holdApproval(agent, request, intent)
  }

  private async holdApproval(agent: any, request: any, intent: ToolIntent): Promise<any> {
    const sessionId = String(agent.id)
    const approval: Approval = {
      id: shortId('apv'),
      sessionId,
      toolName: intent.toolName,
      callId: intent.callId,
      argsSummary: intent.argsSummary,
      risk: intent.risk,
      planId: intent.planId,
      planItemId: intent.planItemId,
      reason: request?.reason ? String(request.reason) : intent.reason,
      status: 'pending',
      createdAt: now(),
    }
    await this.store.putApproval(approval)
    this.queueEmit()
    void this.evaluateSession(sessionId)
    return new Promise((resolve, reject) => {
      const waiter = { approvalId: approval.id, resolve, reject, signal: request?.signal }
      this.approvalWaiters.set(approval.id, waiter)
      if (request?.signal) {
        request.signal.addEventListener(
          'abort',
          () => {
            const current = this.approvalWaiters.get(approval.id)
            if (current) {
              this.approvalWaiters.delete(approval.id)
              void this.finishApproval(approval.id, 'cancelled', 'system', 'signal aborted')
              current.resolve('cancelled')
            }
          },
          { once: true },
        )
      }
    })
  }

  async decideApproval(
    approvalId: string,
    decision: 'allow' | 'deny',
    by: 'user' | 'butler-chat' = 'user',
    note?: string,
  ): Promise<{ ok: boolean; message: string }> {
    const approval = this.store.getApproval(approvalId)
    if (!approval) return { ok: false, message: 'approval 不存在' }
    if (approval.status !== 'pending') return { ok: false, message: `approval 已是 ${approval.status}` }
    const outcome = decision === 'allow' ? 'allowed-once' : 'rejected'
    await this.finishApproval(
      approvalId,
      decision === 'allow' ? 'user_approved' : 'user_rejected',
      by,
      note,
    )
    const waiter = this.approvalWaiters.get(approvalId)
    if (waiter) {
      this.approvalWaiters.delete(approvalId)
      waiter.resolve(outcome)
    } else {
      // Process restarted or the waiter is gone: tell the worker to retry.
      await this.sendToSession(
        approval.sessionId,
        `【管家】审批${decision === 'allow' ? '已通过' : '被拒绝'}（${approval.toolName}）。${
          decision === 'allow' ? '请重试该操作。' : `原因：${note ?? '用户拒绝'}`
        }`,
      )
    }
    return { ok: true, message: decision === 'allow' ? '已允许一次' : '已拒绝' }
  }

  private async finishApproval(
    approvalId: string,
    status: Approval['status'],
    by: 'butler-auto' | 'user' | 'butler-chat' | 'system',
    note?: string,
  ): Promise<void> {
    const approval = this.store.getApproval(approvalId)
    if (!approval) return
    approval.status = status
    approval.decidedBy = by
    approval.decisionNote = note
    approval.decidedAt = now()
    await this.store.putApproval(approval)
    await this.resolveBlockersBy(
      (blocker) => blocker.relatedApprovalId === approvalId,
      '审批已处理',
    )
    await this.store.appendAudit({
      sessionId: approval.sessionId,
      kind: 'approval',
      action: status,
      risk: approval.risk,
      decision: status,
      by,
      planId: approval.planId,
      planItemId: approval.planItemId,
      toolName: approval.toolName,
      callId: approval.callId,
      argsSummary: approval.argsSummary,
      note,
    })
    this.queueEmit()
  }

  /** 收到提问就落盘（I-36 A）：重启后据此知道「有这么个提问没答」。 */
  private async rememberPendingQuestion(input: {
    callId: string
    sessionId: string
    questions: any[]
  }): Promise<void> {
    const items = this.store
      .listPendingQuestions()
      .filter((item) => item.callId !== input.callId)
    items.push({
      callId: input.callId,
      sessionId: input.sessionId,
      at: now(),
      questions: (input.questions ?? []).map((question) => ({
        id: question?.id,
        question: question?.question,
        header: question?.header,
        options: (question?.options ?? []).map((option: any) => ({
          label: option?.label,
          description: option?.description,
        })),
      })),
    })
    await this.store.savePendingQuestions(items.slice(-50))
  }

  /** 已答/已取消：从落盘记录里摘掉。 */
  private async forgetPendingQuestion(callId: string): Promise<void> {
    const items = this.store.listPendingQuestions().filter((item) => item.callId !== callId)
    await this.store.savePendingQuestions(items)
  }

  /**
   * 标记「只能到界面回答」（I-36 A）。
   *
   * 触发：本进程不持有该提问句柄（重启后 / 非本进程发起），宿主 answer() 又拒绝。
   * 效果：落盘记录标 needsUiAnswer，对应卡点写进 evidence 并改 neededAction，
   * 面板/明细页可见——绝不静默。
   */
  private async markQuestionNeedsUiAnswer(callId: string, reason: string): Promise<void> {
    const items = this.store.listPendingQuestions()
    const index = items.findIndex((item) => item.callId === callId)
    if (index >= 0 && !items[index]!.needsUiAnswer) {
      items[index] = { ...items[index]!, needsUiAnswer: true }
      await this.store.savePendingQuestions(items)
    }
    for (const blocker of this.store.listBlockers()) {
      if (blocker.relatedCallId !== callId) continue
      if (blocker.status !== 'open' && blocker.status !== 'notified') continue
      const evidence = { ...(blocker.evidence ?? {}), needsUiAnswer: true, needsUiAnswerReason: reason }
      blocker.evidence = evidence
      blocker.neededAction = '该提问只能到界面上回答（管家代答通道够不着）'
      await this.store.putBlocker(blocker)
    }
    this.queueEmit()
  }

  private async answerQuestion(agent: any, request: any, next: any): Promise<any> {
    if (this.isButlerAgent(agent) || !this.isRootAgent(agent)) return next()
    const sessionId = String(agent.id)
    const callId = String(request?.wait?.callId ?? '')
    if (!callId) return next()
    const questions = Array.isArray(request?.questions) ? request.questions : []
    const planIntent = questions.find((item: any) => item?.intent?.kind === 'plan-review')
    if (planIntent) {
      const current = this.store.currentDispatch(sessionId)
      const plan: Plan = {
        id: shortId('plan'),
        sessionId,
        dispatchId: current?.id ?? `native_${callId}`,
        title: firstLine(String(planIntent.question ?? '计划审查'), 80),
        markdown: String(planIntent.detail ?? ''),
        scope: { items: [] },
        status: 'pending_review',
        submittedAt: now(),
        source: 'native_plan_mode',
      }
      await this.store.putPlan(plan)
      this.nativePlanQuestions.set(plan.id, {
        callId,
        questionId: String(planIntent.id ?? 'plan'),
        approve: String(planIntent.intent?.approve ?? 'Approve'),
      })
      await this.rememberPendingQuestion({ callId, sessionId, questions })
      this.queueEmit()
      void this.evaluateSession(sessionId)
      return new Promise((resolve, reject) => {
        this.questionWaiters.set(callId, {
          callId,
          sessionId,
          resolve,
          reject,
          signal: request?.signal,
        })
        if (request?.signal) {
          request.signal.addEventListener(
            'abort',
            () => {
              const waiter = this.questionWaiters.get(callId)
              if (waiter) {
                this.questionWaiters.delete(callId)
                const runtime = this.runtimes.get(waiter.sessionId)
                runtime?.questions.delete(callId)
                void this.resolveBlockersBy(
                  (blocker) => blocker.relatedCallId === callId,
                  '问题已取消',
                )
                waiter.reject(new Error('question aborted'))
              }
            },
            { once: true },
          )
        }
      })
    }
    await this.rememberPendingQuestion({ callId, sessionId, questions })
    const runtime = this.runtimes.get(sessionId) ?? (await this.ensureRuntime(sessionId))
    runtime.questions.set(callId, { callId, questions, at: now(), state: 'open' })
    return new Promise((resolve, reject) => {
      this.questionWaiters.set(callId, {
        callId,
        sessionId,
        resolve,
        reject,
        signal: request?.signal,
      })
      if (request?.signal) {
        request.signal.addEventListener(
          'abort',
          () => {
            const waiter = this.questionWaiters.get(callId)
            if (waiter) {
              this.questionWaiters.delete(callId)
              void this.resolveBlockersBy(
                (blocker) => blocker.relatedCallId === callId,
                '问题已取消',
              )
              waiter.reject(new Error('question aborted'))
            }
          },
          { once: true },
        )
      }
      void this.evaluateSession(sessionId)
    })
  }

  async answerQuestionByCall(
    callId: string,
    answer: any,
    by: 'user' | 'butler-chat' = 'user',
  ): Promise<{ ok: boolean; message: string; reason?: string }> {
    // 既接受「结构化批次」，也接受管家给的一句话（下面按问题 id 归一）
    const rawText =
      typeof answer === 'string' ? answer : String(answer?.text ?? answer?.rawText ?? '')
    const waiter = this.questionWaiters.get(callId)
    if (waiter) {
      this.questionWaiters.delete(callId)
      const runtime = this.runtimes.get(waiter.sessionId)
      const pending = runtime?.questions.get(callId)
      runtime?.questions.delete(callId)
      // I-36：按问题自己的 id 组包（answer 传进来的是原始文本时在这里归一）
      const payload = Array.isArray((answer as any)?.answers)
        ? answer
        : answerForQuestions(pending?.questions as any, rawText)
      waiter.resolve(payload)
      await this.forgetPendingQuestion(callId)
      await this.resolveBlockersBy(
        (blocker) => blocker.relatedCallId === callId,
        '问题已回答',
      )
      this.scheduleEvaluate(waiter.sessionId)
      await this.store.appendAudit({
        kind: 'blocker',
        action: 'answer_question',
        decision: 'answered',
        by,
        callId,
      })
      this.queueEmit()
      return { ok: true, message: '已回答' }
    }
    const blocker = this.store
      .listBlockers()
      .find(
        (item) =>
          item.relatedCallId === callId &&
          (item.status === 'open' || item.status === 'notified'),
      )
    if (!blocker) return { ok: false, message: '问题不存在或已处理' }
    const agent = await this.resolveAgentFor(blocker.sessionId)
    if (!agent) return { ok: false, message: 'session 无法恢复' }
    try {
      // I-36：`answer()` 只对 **continued**（超时后转后续轮次）的提问有效，
      // 找不到就 `return false` 且不抛错。以前忽略返回值 → 报「已回答」但什么都没发生。
      const payload = Array.isArray((answer as any)?.answers)
        ? answer
        : answerForQuestions(
            (blocker.evidence as any)?.questions,
            rawText,
          )
      const accepted = await this.ctx.userQuestions.answer(agent, callId, payload)
      if (accepted === false) {
        // I-36 A：本进程不持有这个提问 → 落盘标记 + 卡点标「到界面回答」，不清卡点。
        await this.markQuestionNeedsUiAnswer(
          callId,
          '本进程没有持有该提问的应答句柄（重启前发起或非本进程发起）',
        )
        // 绝不能当成功：不清卡点、返回可执行的原因。
        await this.store.appendAudit({
          sessionId: blocker.sessionId,
          kind: 'blocker',
          action: 'answer_question_failed',
          decision: 'not_pending',
          by,
          callId,
          note: '该提问不是「continued」状态，宿主拒绝；提问仍在前台等待，需在界面上回答或取消提问',
        })
        return {
          ok: false,
          reason: 'question_not_held',
          message:
            '该提问不由本进程持有（可能是重启前发起的），管家代答送不进去。请在界面上直接回答；卡点已标注「到界面回答」，并带上提问正文与选项。',
        }
      }
      await this.resolveBlockersBy(
        (item) => item.relatedCallId === callId,
        '问题已回答',
      )
      await this.store.appendAudit({
        sessionId: blocker.sessionId,
        kind: 'blocker',
        action: 'answer_question',
        decision: 'answered',
        by,
        callId,
      })
      this.queueEmit()
      return { ok: true, message: '已回答' }
    } catch (error) {
      return { ok: false, message: asText(error) }
    }
  }

  private async resolveAgentFor(sessionId: string): Promise<any> {
    const live = this.agentOf(sessionId)
    if (live) return live
    try {
      const result = await this.ctx.sessionController.resolveAgent(sessionId)
      return result?.agent
    } catch {
      return undefined
    }
  }

  private async resolveBlockersBy(
    predicate: (blocker: Blocker) => boolean,
    resolution: string,
  ): Promise<void> {
    for (const blocker of this.store.listBlockers()) {
      if (!predicate(blocker)) continue
      if (blocker.status !== 'open' && blocker.status !== 'notified') continue
      blocker.status = 'auto_resolved'
      blocker.resolvedAt = now()
      blocker.resolution = resolution
      await this.store.putBlocker(blocker)
    }
    this.queueEmit()
  }

  async submitPlan(agent: any, args: any): Promise<any> {
    const sessionId = String(agent.id)
    const title = String(args?.title ?? '').trim()
    const markdown = String(args?.plan ?? '').trim()
    const scope = normalizeScope(args?.scope)

    // R1：派发可能因为上一轮报错变成 error / failed，此时 currentDispatch 仍然找得到
    // （error 算进行中）；就算已经 failed，也要回退到这条派发记录，不能让方案静默消失。
    const current = this.store.currentDispatch(sessionId) ?? this.store.latestDispatch(sessionId)
    const finished =
      current != null &&
      (current.status === 'completed' ||
        current.status === 'superseded' ||
        current.status === 'reassigned')
    const needsReview = Boolean(current) && !finished && this.planRequired(current!)
    if (!needsReview) {
      // R2：不需要审查也要把正文落盘，并让派发方知道方案在哪。
      if (!title || !markdown) {
        return {
          status: 'not_required',
          reason: !current
            ? 'manual_session'
            : finished
              ? 'dispatch_finished'
              : current.modeAtDispatch !== 'plan_review'
                ? 'dispatch_started_in_gate_confirm'
                : 'gate_confirm',
          stored: false,
        }
      }
      const reason = !current
        ? 'manual_session'
        : finished
          ? 'dispatch_finished'
          : current.modeAtDispatch !== 'plan_review'
            ? 'dispatch_started_in_gate_confirm'
            : 'gate_confirm'
      const stored = await this.recordSkippedPlan(
        sessionId,
        current,
        { title, markdown, scope },
        reason,
      )
      return { status: 'not_required', reason, planId: stored.id, stored: true }
    }
    const existing = this.store.approvedPlan(current!.id)
    if (existing) return { status: 'already_approved', planId: existing.id }
    if (!title || !markdown) return { error: 'plan 需要 title 和 markdown' }
    if (scope.items.length === 0) return { error: 'plan 需要至少一个 scope.items 条目' }
    for (const plan of this.store.listPlans()) {
      if (plan.sessionId === sessionId && plan.status === 'pending_review') {
        plan.status = 'superseded'
        await this.store.putPlan(plan)
        await this.resolveBlockersBy(
          (blocker) => blocker.relatedPlanId === plan.id,
          '被新计划替代',
        )
      }
    }
    const plan: Plan = {
      id: shortId('plan'),
      sessionId,
      dispatchId: current!.id,
      title,
      markdown,
      scope,
      status: 'pending_review',
      submittedAt: now(),
      source: 'butler_submit_plan',
    }
    await this.store.putPlan(plan)
    await this.store.appendAudit({
      sessionId,
      kind: 'plan',
      action: 'submit',
      planId: plan.id,
      note: title,
    })
    this.queueEmit()
    void this.evaluateSession(sessionId)
    return { status: 'pending_review', planId: plan.id }
  }

  /**
   * R2：不需要审查的方案也要落盘。
   *
   * 之前 not_required 直接返回，方案正文只存在于工具参数里——工具调用一过就没了。
   * 现在写进 plans 表（status=skipped），并给派发方发一条带 planId 的通知。
   */
  private async recordSkippedPlan(
    sessionId: string,
    dispatch: Dispatch | undefined,
    input: { title: string; markdown: string; scope: { items: PlanScopeItem[] } },
    reason: string,
  ): Promise<Plan> {
    const plan: Plan = {
      id: shortId('plan'),
      sessionId,
      dispatchId: dispatch?.id ?? '',
      title: input.title,
      markdown: input.markdown,
      scope: input.scope,
      status: 'skipped',
      submittedAt: now(),
      source: 'butler_submit_plan',
    }
    await this.store.putPlan(plan)
    await this.store.appendAudit({
      sessionId,
      kind: 'plan',
      action: 'submit_skipped',
      planId: plan.id,
      note: `${reason}: ${input.title}`,
    })
    const title = this.store.getSession(sessionId)?.title ?? sessionId.slice(0, 8)
    const notice = this.progressNotice(
      sessionId,
      `${title}：提交了方案（不需要审查）`,
      `${planExcerpt(plan, 200)}｜planId ${plan.id}｜原因 ${reason}`,
      { category: 'dispatch' },
    )
    await this.injectButlerNotice({
      text: [
        // I-33(4)：不能只留一句系统提示。要说清「不阻塞」+ 方案在哪 + 规模。
        `【SuperAgent 进度】本次不阻塞：${title} 提交了方案（${reason}）`,
        `- ${planSummary(plan)}`,
        `- ${truncate(planExcerpt(plan, 160), 200)}`,
        `- 方案已落盘：planId ${plan.id}（侧栏「明细」可看全文）`,
      ].join('\n'),
      source: noticeSource(notice),
      butlerSessionId: dispatch?.fromButlerSessionId,
    })
    this.queueEmit()
    return plan
  }

  async reviewPlan(
    planId: string,
    decision: 'approve' | 'changes' | 'reject',
    feedback: string | undefined,
    by: 'user' | 'butler-chat' = 'user',
  ): Promise<{ ok: boolean; message: string }> {
    const plan = this.store.getPlan(planId)
    if (!plan) return { ok: false, message: '计划不存在' }
    if (plan.status !== 'pending_review') {
      return { ok: false, message: `计划已是 ${plan.status}` }
    }
    plan.status =
      decision === 'approve'
        ? 'approved'
        : decision === 'changes'
          ? 'changes_requested'
          : 'rejected'
    plan.feedback = feedback
    plan.reviewedAt = now()
    plan.reviewedBy = by === 'butler-chat' ? 'butler-chat' : 'user'
    await this.store.putPlan(plan)
    await this.resolveBlockersBy(
      (blocker) => blocker.relatedPlanId === plan.id,
      decision === 'approve' ? '计划已批准' : '计划已驳回',
    )
    const native = this.nativePlanQuestions.get(plan.id)
    if (native) {
      this.nativePlanQuestions.delete(plan.id)
      const waiter = this.questionWaiters.get(native.callId)
      if (waiter) {
        this.questionWaiters.delete(native.callId)
        const answer =
          decision === 'approve'
            ? { answers: [{ id: native.questionId, selected: [native.approve] }] }
            : {
                answers: [
                  {
                    id: native.questionId,
                    selected: [],
                    custom: feedback ?? (decision === 'changes' ? 'keep planning' : 'rejected'),
                  },
                ],
              }
        waiter.resolve(answer)
      }
      await this.store.appendAudit({
        sessionId: plan.sessionId,
        kind: 'plan',
        action: decision,
        decision: plan.status,
        by,
        planId: plan.id,
        note: feedback,
      })
      this.queueEmit()
      return {
        ok: true,
        message: decision === 'approve' ? '已批准原生计划' : '已退回原生计划',
      }
    }
    const message =
      decision === 'approve'
        ? `【管家】计划已批准（${plan.title}）。按 scope 执行；高风险/计划外仍需审批。`
        : decision === 'changes'
          ? `【管家】计划需要修改（${plan.title}）：${feedback ?? '请补充/调整后重新提交'}`
          : `【管家】计划被驳回（${plan.title}）：${feedback ?? '请停止该任务'}`
    await this.sendToSession(plan.sessionId, message)
    await this.store.appendAudit({
      sessionId: plan.sessionId,
      kind: 'plan',
      action: decision,
      decision: plan.status,
      by,
      planId: plan.id,
      note: feedback,
    })
    this.queueEmit()
    return { ok: true, message }
  }

  async setMode(projectKey: string, mode: 'plan_review' | 'gate_confirm'): Promise<any> {
    const project = this.store.getProject(projectKey)
    if (!project) return { ok: false, message: '项目不存在' }
    if (project.mode === mode) return { ok: true, message: '模式未变' }
    project.mode = mode
    await this.store.putProject(project)
    if (mode === 'gate_confirm') {
      for (const plan of this.store.listPlans()) {
        if (plan.status !== 'pending_review') continue
        const session = this.store.getSession(plan.sessionId)
        if (session?.projectKey !== projectKey) continue
        plan.status = 'cancelled'
        await this.store.putPlan(plan)
        await this.resolveBlockersBy(
          (blocker) => blocker.relatedPlanId === plan.id,
          '模式切换到卡点确认',
        )
        await this.sendToSession(
          plan.sessionId,
          '【管家】项目已切换到卡点确认模式；计划不再阻塞，可直接执行。',
        )
      }
    }
    await this.store.appendAudit({
      kind: 'mode',
      action: mode,
      decision: mode,
      by: 'user',
      note: projectKey,
    })
    this.queueEmit()
    return { ok: true, message: `已切换到 ${mode}` }
  }

  async dispatchCandidates(
    text: string,
    workspaceKey?: string,
    cwd?: string,
  ): Promise<any> {
    const project = await this.resolveProjectForText(text, workspaceKey, cwd)
    if (!project) {
      return {
        kind: 'clarify',
        reason: 'workspace_ambiguous',
        projects: this.store.listProjects(),
      }
    }
    const sessions = await this.listSessions()
    const archived = new Set<string>(
      (() => {
        try {
          return this.ctx.workspaceRegistry?.archivedSessionIds ?? []
        } catch {
          return []
        }
      })(),
    )
    const routerSessions: RouterSession[] = []
    for (const session of sessions) {
      if (!session.cwd) continue
      // §9.4：外部来源只读，不进候选（否则管家会把任务派给送不进去的会话）
      if (this.sources.ownerOf(session.sessionId).capabilities.send !== true) continue
      const sessionProject = this.ensureProjectForCwd(session.cwd)
      const runtime = this.runtimes.get(session.sessionId)
      const hardStatus = this.hardStatusFor(session.sessionId)
      const dispatch = this.store.currentDispatch(session.sessionId)
      routerSessions.push({
        sessionId: session.sessionId,
        title: session.title,
        cwd: session.cwd,
        projectKey: sessionProject.key,
        isButler: this.isButlerSessionRow(session),
        isRoot: session.origin !== 'subagent' && !session.parentSessionId,
        archived: archived.has(session.sessionId),
        blank: session.blank,
        running: session.running,
        hardStatus,
        lastActivityAt: session.updatedAt,
        queueCount: this.queuedCount(session.sessionId),
        softStatus: runtime?.softStatus ?? this.store.getSession(session.sessionId)?.softStatus,
        recentUserMessages: [],
        openDispatch: dispatch ? { id: dispatch.id, text: dispatch.text } : undefined,
        openBlockerKinds: this.openBlockerKinds(session.sessionId),
      })
    }
    const candidates = buildCandidates({
      projectKey: project.key,
      sessions: routerSessions,
      windowDays: this.config.routingWindowDays,
      maxCandidates: this.config.routingMaxCandidates,
      now: now(),
      topicRecentMessages: this.config.topicRecentMessages,
    })
    const explicit = parseExplicitTarget(
      text,
      sessions.map((session) => ({ sessionId: session.sessionId, title: session.title })),
    )
    if (explicit && !candidates.some((candidate) => candidate.sessionId === explicit)) {
      const target = routerSessions.find((session) => session.sessionId === explicit)
      if (target && target.isRoot && !target.isButler && !target.archived) {
        candidates.unshift({
          sessionId: target.sessionId,
          title: target.title,
          projectKey: target.projectKey ?? project.key,
          hardStatus: target.hardStatus,
          lastActivityAt: target.lastActivityAt,
          queuedCount: target.queueCount,
          softStatus: target.softStatus,
          recentUserMessages: [],
          openDispatch: target.openDispatch,
          openBlockerKinds: target.openBlockerKinds,
        })
      }
    }
    await Promise.all(
      candidates.map(async (candidate) => {
        candidate.recentUserMessages = await this.source.readUserMessages(
          candidate.sessionId,
          this.config.topicRecentMessages,
        )
      }),
    )
    return {
      kind: 'candidates',
      project,
      workspace: project.cwd,
      explicitTargetId: explicit,
      candidates,
    }
  }

  private async resolveProjectForText(
    text: string,
    workspaceKey?: string,
    cwd?: string,
  ): Promise<Project | undefined> {
    if (workspaceKey) {
      const project = this.store.getProject(workspaceKey)
      if (project) return project
    }
    if (cwd) {
      const canonical = await canonicalPath(cwd)
      if (await isDirectory(canonical)) return this.ensureProjectForCwd(canonical)
    }
    const explicitPath = parseExplicitPath(text)
    if (explicitPath) {
      const canonical = await canonicalPath(explicitPath)
      if (await isDirectory(canonical)) return this.ensureProjectForCwd(canonical)
    }
    const mention = parseWorkspaceMention(text, this.workspaceList())
    if (mention) return this.ensureProjectForCwd(mention.cwd)
    const recentDispatch = this.store
      .listDispatches()
      .sort((a, b) => b.createdAt - a.createdAt)
      .find((dispatch) => dispatch.workspaceKey)
    if (recentDispatch) {
      const project = this.store.getProject(recentDispatch.workspaceKey)
      if (project) return project
    }
    const projects = this.store.listProjects()
    if (projects.length === 1) return projects[0]
    const defaultCwd = this.defaultCwd()
    if (await isDirectory(defaultCwd)) {
      const defaultProject = this.ensureProjectForCwd(defaultCwd)
      if (defaultProject) return defaultProject
    }
    return undefined
  }

  /**
   * I-29：把常见的字段误用归一化（`mode`→`kind`、`targetSessionId`→`sessionId`），
   * 但**不放松校验**——归一之后仍然只接受 kind 语义。
   * 报错必须能自我纠正：带上实际收到的键名和最小可用示例。
   */
  private normalizeDecision(raw: any): { decision: any; error?: string } {
    const input = (raw ?? {}) as any
    const keys = Object.keys(input)
    const kind = input.kind ?? input.mode
    const sessionId = input.sessionId ?? input.targetSessionId
    const decision: any = { ...input, kind, sessionId }
    delete decision.mode
    delete decision.targetSessionId
    const received = keys.length > 0 ? keys.join(', ') : '无'
    const example = `新建会话：{"kind":"new","cwd":"/abs/path"}；复用会话：{"kind":"reuse","sessionId":"session-…"}`
    if (!['new', 'reuse', 'clarify', 'status_query'].includes(String(kind))) {
      return {
        decision,
        error: `decision.kind 必须是 'new' | 'reuse' | 'clarify'（实际收到 ${kind == null ? '空' : JSON.stringify(kind)}；收到键：${received}）。${example}`,
      }
    }
    if (kind === 'new' && typeof input.cwd !== 'string') {
      return {
        decision,
        error: `decision.kind='new' 需要 cwd 绝对路径（收到键：${received}）。${example}`,
      }
    }
    if (kind === 'reuse' && typeof sessionId !== 'string') {
      return {
        decision,
        error: `decision.kind='reuse' 需要 sessionId（不是 targetSessionId；收到键：${received}）。${example}`,
      }
    }
    return { decision }
  }

  async dispatchExecute(
    decision: RouteDecision,
    text: string,
    fromButlerSessionId?: string,
    watchdog?: any,
  ): Promise<any> {
    const normalized = this.normalizeDecision(decision)
    if (normalized.error) {
      return { kind: 'clarify', reason: 'invalid_decision', message: normalized.error }
    }
    decision = normalized.decision as RouteDecision
    if (decision.kind === 'clarify') return decision
    if (decision.kind === 'status_query') return decision
    if (decision.kind === 'new') {
      const canonical = await canonicalPath(decision.cwd)
      if (!(await isDirectory(canonical))) {
        return { kind: 'clarify', reason: 'workspace_missing' }
      }
      const project = this.ensureProjectForCwd(canonical)
      if (decision.projectKey && decision.projectKey !== project.key) {
        return { kind: 'clarify', reason: 'workspace_ambiguous' }
      }
      const targetSessionId = await this.source.create(canonical)
      await this.source.rename(targetSessionId, firstLine(text, 60))
      const dispatch = await this.startDispatch({
        text,
        targetSessionId,
        project,
        mode: 'new',
        reason: decision.reason,
        relatedSessionIds: decision.relatedSessionIds ?? [],
        fromButlerSessionId,
        watchdog,
      })
      return {
        kind: 'reuse',
        sessionId: targetSessionId,
        reason: decision.reason,
        dispatchId: dispatch.id,
        delivery: dispatch.status === 'accepted' ? 'wake' : 'queue',
      }
    }
    // 归一化之后仍可能是别的 kind（例如缺少必填字段被上游放过）：这里兜一层，报错要说清收到什么。
    if ((decision as any).kind !== 'reuse') {
      return {
        kind: 'clarify',
        reason: 'target_ambiguous',
        message: `只接受 decision.kind='reuse' 或 'new'（实际收到 ${JSON.stringify((decision as any).kind)}）。复用会话请传 {"kind":"reuse","sessionId":"session-…"}。`,
      }
    }
    const sessions = await this.listSessions()
    const target = sessions.find((session) => session.sessionId === decision.sessionId)
    if (!target) {
      return {
        kind: 'clarify',
        reason: 'target_ambiguous',
        message: `decision.sessionId 不在当前候选里（收到 ${JSON.stringify(String((decision as any).sessionId ?? ''))}）：请先不带 decision 调一次 butler_dispatch 拿候选 sessionId。`,
      }
    }
    if (this.sources.ownerOf(target.sessionId).capabilities.send !== true) {
      return { kind: 'clarify', reason: 'target_read_only' }
    }
    const project = this.ensureProjectForCwd(target.cwd ?? this.defaultCwd())
    const routerSessions: RouterSession[] = sessions.map((session) => ({
      sessionId: session.sessionId,
      title: session.title,
      cwd: session.cwd,
      projectKey: session.cwd ? this.ensureProjectForCwd(session.cwd).key : undefined,
      isButler: this.isButlerSessionRow(session),
      isRoot: session.origin !== 'subagent' && !session.parentSessionId,
      archived: false,
      blank: session.blank,
      running: session.running,
      hardStatus: this.hardStatusFor(session.sessionId),
      lastActivityAt: session.updatedAt,
      queueCount: this.queuedCount(session.sessionId),
      softStatus: this.store.getSession(session.sessionId)?.softStatus,
      recentUserMessages: [],
      openDispatch: this.store.currentDispatch(session.sessionId)
        ? {
            id: this.store.currentDispatch(session.sessionId)!.id,
            text: this.store.currentDispatch(session.sessionId)!.text,
          }
        : undefined,
      openBlockerKinds: this.openBlockerKinds(session.sessionId),
    }))
    const candidates = buildCandidates({
      projectKey: project.key,
      sessions: routerSessions,
      windowDays: this.config.routingWindowDays,
      maxCandidates: this.config.routingMaxCandidates,
      now: now(),
      topicRecentMessages: this.config.topicRecentMessages,
    })
    const explicit = parseExplicitTarget(
      text,
      sessions.map((session) => ({ sessionId: session.sessionId, title: session.title })),
    )
    const validation = validateDecision({
      decision,
      candidates,
      sessions: routerSessions,
      projectKey: project.key,
      explicitTargets: explicit ? [explicit] : [],
    })
    if (!validation.ok) return { kind: 'clarify', reason: 'target_ambiguous', message: validation.reason }
    const previous = this.store.currentDispatch(decision.sessionId)
    if (previous) {
      previous.status = 'superseded'
      await this.store.putDispatch(previous)
      await this.settleThread(previous.threadId)
      for (const plan of this.store.listPlans()) {
        if (plan.dispatchId === previous.id && plan.status === 'pending_review') {
          plan.status = 'superseded'
          await this.store.putPlan(plan)
        }
      }
    }
    const dispatch = await this.startDispatch({
      text,
      targetSessionId: decision.sessionId,
      project,
      mode: 'reuse',
      // 取代了上一条派发 = 同一件活，沿用它的 thread
      reuseThreadId: previous?.threadId,
      reason: decision.reason,
      relatedSessionIds: [],
      fromButlerSessionId,
      watchdog,
    })
    return {
      kind: 'reuse',
      sessionId: decision.sessionId,
      reason: decision.reason,
      dispatchId: dispatch.id,
      delivery: dispatch.delivery,
    }
  }

  private async startDispatch(input: {
    /** 续活：上一条被取代 / 改派前的派发属于同一件活时传入，沿用它的 thread。 */
    reuseThreadId?: string
    text: string
    targetSessionId: string
    project: Project
    mode: 'reuse' | 'new'
    reason: string
    relatedSessionIds: string[]
    fromButlerSessionId?: string
    /** 管家显式填的巡检配置；不填就按任务文本粗估（`progress.ts`）。 */
    watchdog?: any
  }): Promise<Dispatch & { delivery: 'queue' | 'wake' }> {
    const requestId = this.source.newRequestId()
    const status = this.hardStatusFor(input.targetSessionId)
    const delivery = deliveryFor(status)
    const at = now()
    // 用目标会话「当前」的软状态播种游标：上一轮任务的 done 不是这次任务的进展。
    // runtime 优先（noteReport 刚写过），没有再退回 store 里上一次扫描/上报的结果。
    const soft =
      this.runtimes.get(input.targetSessionId)?.softStatus ??
      this.store.getSession(input.targetSessionId)?.softStatus
    const dispatch: Dispatch = {
      id: shortId('dsp'),
      text: input.text,
      targetSessionId: input.targetSessionId,
      targetTitle: this.store.getSession(input.targetSessionId)?.title,
      workspaceKey: input.project.key,
      mode: input.mode,
      modeAtDispatch: input.project.mode,
      requestId,
      status: 'routing',
      reason: input.reason,
      relatedSessionIds: input.relatedSessionIds,
      fromButlerSessionId: input.fromButlerSessionId,
      createdAt: at,
      watchdog: resolveWatchdog(input.watchdog, input.text, this.config.watchdog),
      progress: seedDispatchCursor(at, soft?.done),
    }
    // P2：派发挂到「一件活」上。有前一条派发（被取代/改派）就沿用它的活，否则新开一条。
    if (this.config.thread.enabled) {
      const thread = input.reuseThreadId
        ? this.store.getThread(input.reuseThreadId)
        : undefined
      dispatch.threadId = thread
        ? await this.attachDispatchToThread(thread, dispatch)
        : (await this.openThreadForDispatch(dispatch)).id
    }
    // 报告路径（noteProgress）用进程内的 progressKeys 去重。把目标会话的历史 done 按这条
    // 派发的 key 预先登记：worker 首次上报若原样带回上一轮的 done，不会被当成新里程碑再推一遍
    // （noteProgress 所在区域由另一条会话维护，这里不动它，只在派发创建处登记）。
    for (const item of soft?.done ?? []) {
      if (String(item ?? '').trim()) this.progressKeys.add(`${dispatch.id}:${item}`)
    }
    await this.store.putDispatch(dispatch)
    let related = ''
    for (const relatedId of input.relatedSessionIds.slice(0, 2)) {
      const digest = await this.source.readDigest(relatedId)
      const text = digestText(digest, 600)
      if (text) related += `\n相关背景（${relatedId}）：\n${text}`
    }
    const message = `【管家派发】\n任务：${input.text}\n工作区：${input.project.cwd}${
      related ? `\n${related}` : ''
    }\n要求：先确认目标；按当前项目模式执行（计划审查/卡点确认）。`
    try {
      await this.source.prompt(input.targetSessionId, message, requestId)
      dispatch.status = 'accepted'
      dispatch.acceptedAt = now()
    } catch (error) {
      dispatch.status = 'failed'
      dispatch.error = asText(error)
    }
    // prompt 期间 worker 可能已经上报，noteReport 会把新签名合并进游标；
    // 以持久化记录为准，别用创建时的种子把它覆盖回去。
    const persisted = this.store.getDispatch(dispatch.id)
    if (persisted?.progress) dispatch.progress = persisted.progress
    await this.store.putDispatch(dispatch)
    await this.store.appendAudit({
      sessionId: input.targetSessionId,
      kind: 'dispatch',
      action: dispatch.status === 'accepted' ? 'dispatch' : 'dispatch_failed',
      decision: dispatch.status,
      by: 'butler-chat',
      dispatchId: dispatch.id,
      ruleId: 'dispatch_route',
      note: input.reason,
    })
    this.queueEmit()
    return { ...dispatch, delivery }
  }

  async sendToSession(sessionId: string, text: string): Promise<void> {
    try {
      await this.source.prompt(sessionId, text, this.source.newRequestId())
    } catch {
      // best effort
    }
  }

  /**
   * 设计 §4.2 的「用户标记完成」：把一条进行中的派发收尾。
   *
   * 只允许 accepted/delivered；结束时同步做四件事——写审计、关掉这条派发的待审计划、
   * 解除计划门禁（门禁只看 currentDispatch，状态一变就失效）、失败时告诉 worker 别干了。
   */
  async markDispatch(
    dispatchId: string,
    outcome: string,
    note?: string,
    by: 'user' | 'butler-chat' | 'butler-auto' | 'system' = 'user',
  ): Promise<any> {
    if (outcome !== 'completed' && outcome !== 'failed') {
      return { ok: false, message: "outcome 只能是 'completed' 或 'failed'" }
    }
    const dispatch = this.store.getDispatch(dispatchId)
    if (!dispatch) return { ok: false, message: 'dispatch 不存在' }
    if (
      dispatch.status !== 'accepted' &&
      dispatch.status !== 'delivered' &&
      // 上一轮报错的派发也要能被用户收尾。
      dispatch.status !== 'error'
    ) {
      return { ok: false, message: `这条派发已经结束（${dispatch.status}），不能再标记` }
    }
    dispatch.status = outcome
    dispatch.suspectDoneAt = undefined
    dispatch.suspectDoneReason = undefined
    if (outcome === 'failed') dispatch.error = note ? String(note) : '用户放弃'
    await this.store.putDispatch(dispatch)
    await this.settleThread(dispatch.threadId)
    // P2：人工把派发标成完成，就是对「这件活」的确认 → 顺势销账；
    // 标记失败只是重算状态（活可能还要重派），不销账。
    if (outcome === 'completed' && dispatch.threadId) {
      await this.closeThread(dispatch.threadId, 'done', by === 'user' ? 'user' : 'butler')
    }

    let cancelledPlans = 0
    for (const plan of this.store.listPlans()) {
      if (plan.dispatchId !== dispatch.id) continue
      if (plan.status !== 'pending_review' && plan.status !== 'changes_requested') continue
      plan.status = 'cancelled'
      await this.store.putPlan(plan)
      cancelledPlans += 1
      await this.resolveBlockersBy(
        (blocker) => blocker.relatedPlanId === plan.id,
        '计划已随派发关闭',
      )
    }

    // 收尾之后，这个 session 上一批「因为任务还在跑」才成立的卡点也该跟着结束；
    // 审批 / 提问 / 待审计划不在此列——它们各有自己的处理入口，不能被顺手清掉。
    await this.resolveBlockersBy(
      (blocker) =>
        blocker.sessionId === dispatch.targetSessionId &&
        (blocker.kind === 'stall' ||
          blocker.kind === 'interrupted' ||
          blocker.kind === 'repeated_failure' ||
          blocker.kind === 'decision' ||
          blocker.kind === 'settle_suggest'),
      '派发已收尾',
    )

    await this.store.appendAudit({
      sessionId: dispatch.targetSessionId,
      kind: 'dispatch',
      action: outcome === 'completed' ? 'mark_completed' : 'mark_abandoned',
      decision: outcome,
      by,
      note: note ?? (outcome === 'completed' ? '用户标记完成' : '用户放弃'),
    })

    if (outcome === 'failed') {
      await this.sendToSession(
        dispatch.targetSessionId,
        `【管家】这条任务已经结束，你不需要继续：${note ? String(note) : '用户已放弃'}。有新的安排我会再派给你。`,
      )
    }

    this.queueEmit()
    this.scheduleEvaluate(dispatch.targetSessionId)
    return { ok: true, dispatchId: dispatch.id, status: dispatch.status, cancelledPlans }
  }

  async reassign(dispatchId: string, targetSessionId: string): Promise<any> {
    const old = this.store.getDispatch(dispatchId)
    if (!old) return { ok: false, message: 'dispatch 不存在' }
    const target = (await this.listSessions()).find(
      (session) => session.sessionId === targetSessionId,
    )
    if (!target) {
      return {
        ok: false,
        error: 'session_not_found',
        sessionId: targetSessionId,
        message: '目标 session 不存在',
      }
    }
    // 与 butler_send / dispatchExecute 同一条约束：只读来源不能改派进去。
    // 校验必须发生在任何状态变更之前，失败时不留副作用。
    if (this.sources.ownerOf(target.sessionId).capabilities.send !== true) {
      return {
        ok: false,
        error: 'target_read_only',
        sessionId: targetSessionId,
        message: '目标 session 是只读来源，不能改派',
      }
    }
    if (old.status === 'accepted') {
      const queued = await this.source.findQueuedMessage(old.targetSessionId, old.requestId)
      if (queued) await this.source.removeQueued(old.targetSessionId, queued.id)
      old.status = 'reassigned'
      await this.store.putDispatch(old)
      const project = this.ensureProjectForCwd(target.cwd ?? this.defaultCwd())
      const next = await this.startDispatch({
        text: old.text,
        targetSessionId,
        project,
        mode: 'reuse',
        reason: '用户改派',
        relatedSessionIds: old.relatedSessionIds,
        fromButlerSessionId: old.fromButlerSessionId,
        watchdog: old.watchdog,
      })
      await this.store.appendAudit({
        sessionId: targetSessionId,
        kind: 'dispatch',
        action: 'reassign',
        decision: 'reassigned',
        by: 'user',
        note: `from ${old.targetSessionId}`,
      })
      return { ok: true, dispatch: next }
    }
    old.status = 'superseded'
    await this.store.putDispatch(old)
    const project = this.ensureProjectForCwd(target.cwd ?? this.defaultCwd())
    const next = await this.startDispatch({
      text: old.text,
      targetSessionId,
      project,
      mode: 'reuse',
      reason: '用户改派（旧任务已投递）',
      relatedSessionIds: old.relatedSessionIds,
      fromButlerSessionId: old.fromButlerSessionId,
    })
    await this.sendToSession(
      old.targetSessionId,
      '【管家】任务已改派，若已开始请停止并汇报现状。',
    )
    await this.store.appendAudit({
      sessionId: targetSessionId,
      kind: 'dispatch',
      action: 'reassign',
      decision: 'superseded_old',
      by: 'user',
      note: `from ${old.targetSessionId}`,
    })
    return { ok: true, dispatch: next }
  }

  /**
   * 把一条文本转发给 worker 会话，并如实返回有没有送到。
   *
   * `sendToSession` 是 best-effort（吞掉错误），答复类动作不能静默失败——用户点了「回答」
   * 却什么也没发生，比不给按钮更糟。
   */
  private async forwardToSession(sessionId: string, text: string): Promise<boolean> {
    const managed = this.store.getSession(sessionId)
    if (!managed && !this.agentOf(sessionId)) return false
    try {
      await this.source.prompt(sessionId, text, this.source.newRequestId())
      return true
    } catch {
      return false
    }
  }

  /**
   * 决策被用户回答后，从已存的软状态里摘掉它。
   *
   * 否则下一次扫描会按同一条 `decisions` 重新生成一个一模一样的卡点，
   * 用户会看到「刚答完又冒出来」。
   */
  private async consumeDecision(blocker: Blocker): Promise<void> {
    const prefix = 'decision:'
    if (!blocker.signature.startsWith(prefix)) return
    const signature = blocker.signature
    const prune = (soft: SoftStatus | undefined): boolean => {
      if (!soft?.decisions?.length) return false
      const kept = soft.decisions.filter((item) => `decision:${hash(item)}` !== signature)
      if (kept.length === soft.decisions.length) return false
      soft.decisions = kept
      return true
    }
    const managed = this.store.getSession(blocker.sessionId)
    if (managed?.softStatus && prune(managed.softStatus)) {
      await this.store.putSession(managed)
    }
    const runtime = this.runtimes.get(blocker.sessionId)
    if (runtime?.softStatus) prune(runtime.softStatus)
  }

  async resolveBlocker(
    blockerId: string,
    action: 'approve' | 'reject' | 'answer' | 'dismiss' | 'retry' | 'resolve',
    text?: string,
    by: 'user' | 'butler-chat' = 'user',
  ): Promise<any> {
    const blocker = this.store.getBlocker(blockerId)
    if (!blocker) return { ok: false, message: '卡点不存在' }
    if (blocker.kind === 'approval' && blocker.relatedApprovalId) {
      if (action === 'approve') return this.decideApproval(blocker.relatedApprovalId, 'allow', by, text)
      if (action === 'reject') return this.decideApproval(blocker.relatedApprovalId, 'deny', by, text)
      if (action === 'dismiss') {
        blocker.status = 'dismissed'
        blocker.resolvedAt = now()
        await this.store.putBlocker(blocker)
        this.queueEmit()
        return { ok: true, message: '已忽略' }
      }
    }
    if (blocker.kind === 'question' && !blocker.relatedCallId && action === 'answer') {
      return { ok: false, message: '这条提问卡点缺少 callId，无法回答；可以让 worker 重新提一次' }
    }
    if (blocker.kind === 'question' && blocker.relatedCallId) {
      if (action === 'answer' || action === 'resolve' || action === 'approve') {
        // 传原始文本：由 answerQuestionByCall 按问题 id 组包（I-36）
        return this.answerQuestionByCall(blocker.relatedCallId, String(text ?? ''), by)
      }
      if (action === 'dismiss') {
        blocker.status = 'dismissed'
        blocker.resolvedAt = now()
        await this.store.putBlocker(blocker)
        this.queueEmit()
        return { ok: true, message: '已忽略' }
      }
    }
    if (blocker.kind === 'settle_suggest') {
      const dispatchId = String((blocker.evidence as any)?.dispatchId ?? '')
      if (action === 'approve' || action === 'resolve' || action === 'retry') {
        if (!dispatchId) return { ok: false, message: '这条建议缺少 dispatchId，只能忽略后人工收尾' }
        return this.markDispatch(dispatchId, 'completed', '用户确认销账', by)
      }
      if (action === 'dismiss') {
        blocker.status = 'dismissed'
        blocker.resolvedAt = now()
        blocker.resolution = '继续观察'
        await this.store.putBlocker(blocker)
        this.queueEmit()
        return { ok: true, message: '已忽略，冷却期内不再提醒' }
      }
    }
    if (blocker.kind === 'plan_review' && blocker.relatedPlanId) {
      if (action === 'approve') return this.reviewPlan(blocker.relatedPlanId, 'approve', text, by)
      if (action === 'reject') return this.reviewPlan(blocker.relatedPlanId, 'reject', text, by)
      if (action === 'answer') return this.reviewPlan(blocker.relatedPlanId, 'changes', text, by)
      if (action === 'dismiss') {
        blocker.status = 'dismissed'
        blocker.resolvedAt = now()
        await this.store.putBlocker(blocker)
        this.queueEmit()
        return { ok: true, message: '已忽略' }
      }
    }
    // 决策卡点（worker 通过 butler_report_status 报上来的 decisions）必须能回答：
    // 把答复转给 worker，再把卡点收掉。之前这里直接落到「不支持的操作」，卡片上的
    // 「回答」按钮点了不生效，只能手工 butler_send 补发。
    if (blocker.kind === 'decision' && action === 'answer') {
      const answer = String(text ?? '').trim()
      if (!answer) return { ok: false, message: '回答不能为空' }
      const delivered = await this.forwardToSession(
        blocker.sessionId,
        `【管家】用户答复：${answer}`,
      )
      if (!delivered) {
        return {
          ok: false,
          message: '这个卡点对应的会话已不存在，答复发不出去；先忽略它或重派任务',
        }
      }
      await this.consumeDecision(blocker)
      blocker.status = 'resolved'
      blocker.resolvedAt = now()
      blocker.resolution = answer
      await this.store.putBlocker(blocker)
      await this.store.appendAudit({
        sessionId: blocker.sessionId,
        kind: 'blocker',
        action: 'answer',
        decision: 'resolved',
        by,
        note: answer,
      })
      this.queueEmit()
      return { ok: true, message: '已把答复转发给该会话' }
    }
    if (action === 'dismiss') {
      blocker.status = 'dismissed'
      blocker.resolvedAt = now()
      await this.store.putBlocker(blocker)
      this.queueEmit()
      return { ok: true, message: '已忽略' }
    }
    if (action === 'retry' || action === 'resolve') {
      if (blocker.kind === 'interrupted' || blocker.kind === 'stall') {
        await this.sendToSession(
          blocker.sessionId,
          text
            ? `【管家】${text}`
            : '【管家】请继续/重试当前任务，并先用 butler_report_status 汇报现状。',
        )
      }
      blocker.status = 'resolved'
      blocker.resolvedAt = now()
      blocker.resolution = text ?? '用户标记处理'
      await this.store.putBlocker(blocker)
      await this.store.appendAudit({
        sessionId: blocker.sessionId,
        kind: 'blocker',
        action,
        decision: 'resolved',
        by,
        note: text,
      })
      this.queueEmit()
      return { ok: true, message: '已处理' }
    }
    if (action === 'answer') {
      // 和客户端渲染的按钮同源：不能回答的类型不给「回答」，这里也不能装作支持。
      const label = NOTICE_KIND_LABEL[blocker.kind] ?? blocker.kind
      return {
        ok: false,
        message: `${label} 卡点不支持回答；可以「忽略」或「重试」`,
      }
    }
    return { ok: false, message: `不支持的操作：${action}` }
  }

  queuedCount(sessionId: string): number {
    const agent = this.agentOf(sessionId)
    if (!agent?.inbox) return 0
    try {
      return (agent.inbox.nextTurn?.length ?? 0) + (agent.inbox.nextStep?.length ?? 0)
    } catch {
      return 0
    }
  }

  openBlockerKinds(sessionId: string): any[] {
    const kinds = new Set<string>()
    for (const blocker of this.store.listBlockers()) {
      if (blocker.sessionId !== sessionId) continue
      if (blocker.status === 'open' || blocker.status === 'notified') kinds.add(blocker.kind)
    }
    return [...kinds]
  }

  /** 运行期自检：面板/CLI 用来确认门禁和 worker 工具真的挂到了真实 agent 上。 */
  diagnostics(): any {
    let roots: any[] = []
    try {
      roots = this.ctx.agents?.roots?.() ?? []
    } catch {
      roots = []
    }
    return {
      version: this.version,
      butlerSessionId: this.butlerId,
      agents: roots.map((agent: any) => ({
        id: String(agent?.id ?? ''),
        preset: agent?.session?.header?.agentPreset,
        status: agent?.status,
        isButler: this.isButlerAgent(agent),
        installed: this.installed.has(String(agent?.id ?? '')),
      })),
      installedCount: this.installed.size,
      pendingNotices: [...this.pendingButlerNotices.values()].reduce(
        (sum, queue) => sum + queue.length,
        0,
      ),
      butlerSessionIds: this.butlerSessionIds(),
      runtimes: this.runtimes.size,
      counts: {
        projects: this.store.listProjects().length,
        sessions: this.store.listSessions().length,
        dispatches: this.store.listDispatches().length,
        plans: this.store.listPlans().length,
        blockers: this.store.listBlockers().length,
        approvals: this.store.listApprovals().length,
        audit: this.store.listAudit().length,
        threads: this.store.listThreads().length,
      },
    }
  }

  async snapshot(): Promise<Snapshot> {
    const sessions = await this.listSessions()
    const managed = new Map(
      this.store.listSessions().map((session) => [session.sessionId, session]),
    )
    const views: SessionView[] = []
    for (const session of sessions) {
      const managedSession = managed.get(session.sessionId)
      const runtime = this.runtimes.get(session.sessionId)
      const hardStatus =
        session.source !== 'dsh'
          ? (session.hardStatus ?? 'unknown')
          : runtime || session.running
            ? this.hardStatusFor(session.sessionId)
            : derivedFromLite(session)
      const project = managedSession?.projectKey
        ? this.store.getProject(managedSession.projectKey)
        : undefined
      views.push({
        sessionId: session.sessionId,
        source: managedSession?.source ?? session.source ?? 'dsh',
        capabilities: this.capabilitiesOf(session.sessionId),
        title: session.title,
        cwd: session.cwd,
        projectKey: project?.key,
        mode: project?.mode,
        hardStatus,
        running: session.running,
        lastActivityAt: session.updatedAt,
        queuedCount: this.queuedCount(session.sessionId),
        softStatus: runtime?.softStatus ?? managedSession?.softStatus,
        openBlockerKinds: this.openBlockerKinds(session.sessionId) as any,
        openBlockerCount: this.store
          .listBlockers()
          .filter(
            (blocker) =>
              blocker.sessionId === session.sessionId &&
              (blocker.status === 'open' || blocker.status === 'notified'),
          ).length,
        isButler: this.isButlerSessionRow(session),
      })
    }
    const butlerRuntime = this.butlerId ? this.runtimes.get(this.butlerId) : undefined
    const butlerStatus = this.butlerId
      ? deriveHardStatus(butlerRuntime, this.liveInfo(this.butlerId))
      : 'idle'
    const blockers = this.store
      .listBlockers()
      .filter((blocker) => blocker.status === 'open' || blocker.status === 'notified')
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    const plans = this.store
      .listPlans()
      .filter(
        (plan) =>
          plan.status === 'pending_review' ||
          plan.status === 'approved' ||
          plan.status === 'changes_requested',
      )
      .sort((a, b) => b.submittedAt - a.submittedAt)
      .slice(0, 30)
    const dispatches = this.store
      .listDispatches()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 50)
    const approvals = this.store
      .listApprovals()
      .filter((approval) => approval.status === 'pending')
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 30)
    const cutoff = now() - 24 * 60 * 60_000
    for (const approval of approvals) {
      if (approval.createdAt < cutoff) approval.stale = true
    }
    for (const plan of plans) {
      if (plan.status === 'pending_review' && plan.submittedAt < cutoff) plan.stale = true
    }
    const audit = this.store.listAudit().slice(0, 100)
    const blockerNotices: ButlerNotice[] = blockers.map((blocker) => {
      const dispatch = this.store.currentDispatch(blocker.sessionId)
      const dispatchInProgress = Boolean(
        dispatch &&
          (dispatch.status === 'accepted' ||
            dispatch.status === 'delivered' ||
            dispatch.status === 'error'),
      )
      return buildBlockerNotice(blocker, {
        sessionTitle: this.store.getSession(blocker.sessionId)?.title,
        dispatchId: dispatch?.id,
        dispatchInProgress,
      })
    })
    const resolvedBlockers: ResolvedBlockerView[] = this.store
      .listBlockers()
      .filter(
        (blocker) =>
          blocker.status === 'resolved' ||
          blocker.status === 'auto_resolved' ||
          blocker.status === 'dismissed' ||
          blocker.status === 'superseded',
      )
      .sort((a, b) => (b.resolvedAt ?? b.lastSeenAt) - (a.resolvedAt ?? a.lastSeenAt))
      .slice(0, 60)
      .map((blocker) => ({
        id: blocker.id,
        kind: blocker.kind,
        status: blocker.status,
        sessionId: blocker.sessionId,
        summary: blocker.summary,
        resolution: blocker.resolution,
        resolvedAt: blocker.resolvedAt,
      }))
    const progressNotices = this.visibleProgressNotices()
    this.lastSnapshotAt = now()
    return {
      generatedAt: now(),
      version: this.version,
      butler: {
        sessionId: this.butlerId,
        title: this.config.butler.title,
        status: butlerStatus,
      },
      projects: this.store.listProjects().sort((a, b) => a.title.localeCompare(b.title)),
      sessions: views,
      blockers,
      blockerNotices,
      progressNotices,
      pendingNotices: this.pendingNoticesView(),
      pendingQuestions: this.pendingQuestionsView(),
      sources: this.sourceStatus(),
      resolvedBlockers,
      plans,
      dispatches,
      approvals,
      audit,
      threads: this.config.thread.enabled
        ? this.store
            .listThreads()
            .sort((a, b) => b.lastEventAt - a.lastEventAt)
            .slice(0, 60)
            .map((thread) => ({
              ...thread,
              openDispatches: thread.dispatchIds
                .map((id) => this.store.getDispatch(id))
                .filter((item): item is Dispatch => Boolean(item) && isOpenDispatch(item!)).length,
              openBlockers: this.store
                .listBlockers()
                .filter(
                  (item) =>
                    item.threadId === thread.id &&
                    (item.status === 'open' || item.status === 'notified'),
                ).length,
            }))
        : [],
      policyStats: this.policyStatsView(),
    }
  }

  async handleAction(action: string, payload: any = {}): Promise<any> {
    switch (action) {
      case 'butler_message':
        return this.sendToButler(String(payload.text ?? ''))
      case 'snapshot':
        return this.snapshot()
      case 'blocker_action':
        return this.resolveBlocker(
          String(payload.blockerId ?? ''),
          (payload.action ?? 'resolve') as any,
          payload.text,
          'user',
        )
      case 'plan_review':
        return this.reviewPlan(
          String(payload.planId ?? ''),
          (payload.decision ?? 'approve') as any,
          payload.feedback,
          'user',
        )
      case 'approval_decide':
        return this.decideApproval(
          String(payload.approvalId ?? ''),
          payload.decision === 'deny' ? 'deny' : 'allow',
          'user',
          payload.note,
        )
      case 'project_mode':
        return this.setMode(String(payload.projectKey ?? ''), payload.mode)
      case 'dispatch_reassign':
        return this.reassign(String(payload.dispatchId ?? ''), String(payload.targetSessionId ?? ''))
      case 'dispatch_mark':
        return this.markDispatch(
          String(payload.dispatchId ?? ''),
          String(payload.outcome ?? ''),
          payload.note ? String(payload.note) : undefined,
          'user',
        )
      case 'ensure_butler':
        return { sessionId: await this.ensureButler() }
      case 'plan_detail': {
        // I-33：卡片上的「查看完整方案」。只读、按需拉，不进快照轮询。
        const plan = this.store.getPlan(String(payload.planId ?? ''))
        if (!plan) return { error: 'plan_not_found', planId: payload.planId }
        return {
          planId: plan.id,
          title: plan.title,
          status: plan.status,
          summary: planSummary(plan),
          markdown: plan.markdown,
          scope: plan.scope,
        }
      }
      case 'diagnostics':
        return this.diagnostics()
      case 'refresh':
        return this.snapshot()
      default:
        return { ok: false, message: `unknown action: ${action}` }
    }
  }

  subscribe(listener: () => void): () => void {
    this.hub.add(listener)
    return () => this.hub.delete(listener)
  }

  private queueEmit(): void {
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.emit()
    }, 80)
  }

  private emit(): void {
    for (const listener of this.hub) {
      try {
        listener()
      } catch {
        // ignore
      }
    }
  }

  private startTimers(): void {
    const timer = setInterval(() => {
      void this.scan().catch(() => {})
    }, Math.max(5000, this.config.scanIntervalMs))
    timer.unref?.()
    this.timers.add(timer)
  }

  private async scan(): Promise<void> {
    if (this.disposed) return
    const sessions = await this.listSessions(true)
    const cutoff = now() - this.config.recoveryScanDays * 24 * 60 * 60_000
    const recent = sessions
      .filter((session) => session.updatedAt >= cutoff)
      .slice(0, this.config.statusRefreshLimit)
    for (const session of recent) {
      if (this.sources.ownerOf(session.sessionId).kind !== 'dsh') continue
      const runtime = this.runtimes.get(session.sessionId)
      if (!runtime || (!session.running && now() - (this.runtimeLoadedAt.get(session.sessionId) ?? 0) > this.config.statusTtlMs)) {
        await this.ensureRuntime(session.sessionId).catch(() => undefined)
      }
      await this.evaluateSession(session.sessionId).catch(() => undefined)
    }
    // P1：按间隔跑一轮决策标注（默认 5 分钟），把"后来怎么样"回填进台账
    if (now() - this.lastLabelAt >= this.config.policy.labelIntervalMs) {
      await this.runLabeling()
    }
    // P2：长期不动的活标 abandoned。只动 abandoned，**绝不动 done**——
    // 自动销账会解除 plan gate，那件事必须由人确认。
    if (this.config.thread.enabled) {
      const cutoff = now() - this.config.thread.idleAbandonMs
      for (const thread of this.store.listThreads()) {
        if (thread.state !== 'active' && thread.state !== 'waiting_human') continue
        if (thread.lastEventAt > cutoff) continue
        const open = thread.dispatchIds
          .map((id) => this.store.getDispatch(id))
          .filter((item): item is Dispatch => Boolean(item) && isOpenDispatch(item!))
        if (open.length > 0) continue
        const pendingPlan = this.store.listPlans().some(
          (plan) =>
            thread.dispatchIds.includes(plan.dispatchId) && plan.status === 'pending_review',
        )
        if (pendingPlan) continue
        await this.closeThread(thread.id, 'abandoned', 'auto_ttl')
      }
    }
    // I-28(3)：TTL 兜底。**默认关闭**；只处理「确认无待审计划 + 长时间无活动」的派发。
    if (this.config.settleTtl.enabled) {
      const ttlMs = Math.max(1, this.config.settleTtl.minutes) * 60_000
      for (const dispatch of this.store.listDispatches()) {
        if (!isOpenDispatch(dispatch)) continue
        const anchor = Math.max(
          dispatch.suspectDoneAt ?? 0,
          dispatch.progress?.lastProgressAt ?? 0,
          dispatch.acceptedAt ?? dispatch.createdAt,
        )
        if (now() - anchor < ttlMs) continue
        // 有待审计划绝不能自动销账：销账会取消计划并解除 plan gate。
        if (this.store.pendingPlan(dispatch.targetSessionId)?.dispatchId === dispatch.id) continue
        const blocking = this.store
          .listBlockers()
          .filter(
            (item) =>
              item.sessionId === dispatch.targetSessionId &&
              (item.status === 'open' || item.status === 'notified') &&
              item.kind !== 'settle_suggest',
          )
        if (blocking.length > 0) continue
        await this.markDispatch(
          dispatch.id,
          'completed',
          'TTL 兜底自动销账（无待审计划、无活动）',
          'butler-auto',
        )
        await this.store.appendAudit({
          sessionId: dispatch.targetSessionId,
          kind: 'dispatch',
          action: 'settle_ttl',
          dispatchId: dispatch.id,
          threadId: dispatch.threadId,
          by: 'butler-auto',
          note: `超过 ${this.config.settleTtl.minutes} 分钟无活动，自动销账`,
        })
      }
    }
    this.queueEmit()
  }

  private async recover(): Promise<void> {
    const sessions = await this.listSessions(true)
    const cutoff = now() - this.config.recoveryScanDays * 24 * 60 * 60_000
    const recent = sessions
      .filter((session) => session.updatedAt >= cutoff)
      .slice(0, this.config.statusRefreshLimit)
    for (const session of recent) {
      if (this.sources.ownerOf(session.sessionId).kind !== 'dsh') continue
      await this.ensureRuntime(session.sessionId).catch(() => undefined)
      await this.evaluateSession(session.sessionId).catch(() => undefined)
    }
    for (const dispatch of this.store.listDispatches()) {
      if (dispatch.status === 'accepted') {
        const delivered = await this.source
          .findDelivered(dispatch.targetSessionId, dispatch.requestId)
          .catch(() => false)
        if (delivered) {
          dispatch.status = 'delivered'
          dispatch.deliveredAt = now()
          await this.store.putDispatch(dispatch)
          continue
        }
        let retried = false
        for (let attempt = 0; attempt < this.config.dispatchRetryLimit; attempt += 1) {
          try {
            await this.source.prompt(
              dispatch.targetSessionId,
              `【管家派发】\n任务：${dispatch.text}`,
              dispatch.requestId,
            )
            retried = true
            break
          } catch {
            // retry
          }
        }
        if (!retried) {
          dispatch.status = 'failed'
          dispatch.error = '重启后重试投递失败'
          await this.store.putDispatch(dispatch)
        }
      } else if (dispatch.status === 'routing') {
        const targetExists = sessions.some(
          (session) => session.sessionId === dispatch.targetSessionId,
        )
        if (targetExists) {
          try {
            await this.source.prompt(
              dispatch.targetSessionId,
              `【管家派发】\n任务：${dispatch.text}`,
              dispatch.requestId,
            )
            dispatch.status = 'accepted'
            dispatch.acceptedAt = now()
          } catch {
            dispatch.status = 'failed'
            dispatch.error = '重启后重试投递失败'
          }
          await this.store.putDispatch(dispatch)
        } else {
          dispatch.status = 'failed'
          dispatch.error = '目标 session 不存在'
          await this.store.putDispatch(dispatch)
        }
      }
    }
    for (const approval of this.store.listApprovals()) {
      if (approval.status === 'pending') {
        approval.recovered = true
        await this.store.putApproval(approval)
      }
    }
    const open = this.store
      .listBlockers()
      .filter((blocker) => blocker.status === 'open' || blocker.status === 'notified')
    if (open.length > 0) {
      const notice: ButlerNotice = {
        id: uuid(),
        at: now(),
        kind: 'summary',
        category: 'restart',
        severity: 'warning',
        title: `重启后仍有 ${open.length} 个未处理卡点`,
        detail: open
          .slice(0, 5)
          .map((blocker) => blocker.summary)
          .join(' / '),
        actions: [],
      }
      await this.injectButlerNotice({
        text: `【SuperAgent 提醒】重启后仍有 ${open.length} 个未处理卡点；在管家对话里点按钮处理。`,
        source: noticeSource(notice),
      })
    }
    this.meta.lastRecoveryAt = now()
    await this.store.saveMeta(this.meta)
    await this.store.appendAudit({
      kind: 'recovery',
      action: 'startup',
      note: `恢复 ${recent.length} 个 session，${open.length} 个未处理卡点`,
    })
  }
}

function derivedFromLite(session: SourceSessionLite): HardStatus {
  if (session.running) return 'running'
  return 'idle'
}

function normalizeScope(input: any): { items: PlanScopeItem[] } {
  const items = Array.isArray(input?.items) ? input.items : []
  const out: PlanScopeItem[] = []
  let index = 0
  for (const item of items) {
    index += 1
    if (!item || typeof item !== 'object') continue
    const paths = Array.isArray(item.paths)
      ? item.paths.filter((value: any) => typeof value === 'string' && value.length > 0)
      : undefined
    const commands = Array.isArray(item.commands)
      ? item.commands.filter((value: any) => typeof value === 'string' && value.length > 0)
      : undefined
    out.push({
      id: String(item.id ?? `P${index}`),
      description: String(item.description ?? ''),
      paths,
      commands,
      network: item.network === true,
    })
  }
  return { items: out }
}

/**
 * 把管家的一句话回答，转成宿主 `ask_user_question` 认识的**结构化应答批次**。
 *
 * 关键点（I-36）：`answer` 的 `id` 必须是**问题自己的 id**（模型靠它对应问题），
 * 以前写死成 `id:'answer'` 会让模型看到一个对不上号的答复。
 * 另外：文本正好等于某个选项标签时放进 `selected`（模型和 UI 都更好处理），
 * 否则放进 `custom`；多问题时只答第一个，其余显式留空（宿主语义 = 跳过）。
 */
export function answerForQuestions(
  questions: Array<{ id?: unknown; options?: Array<{ label?: unknown }> }> | undefined,
  text: string,
): any {
  const trimmed = String(text ?? '').trim()
  const list = Array.isArray(questions) ? questions : []
  if (list.length === 0) {
    return { answers: [{ id: 'answer', selected: trimmed ? [trimmed] : [], custom: trimmed || undefined }] }
  }
  return {
    answers: list.map((question, index) => {
      const id = String(question?.id ?? `q${index + 1}`)
      if (index > 0) return { id, selected: [] }
      const labels = (question?.options ?? []).map((option) => String(option?.label ?? '')).filter(Boolean)
      const matched = labels.find((label) => label.trim() === trimmed)
      if (matched) return { id, selected: [matched] }
      return { id, selected: [], ...(trimmed ? { custom: trimmed } : {}) }
    }),
  }
}
