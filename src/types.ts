/**
 * SuperAgent 管家：公共数据模型。
 *
 * 这里不 import 任何 dsh 运行时包；所有 dsh 能力都通过 Cordis ctx 上的服务取得。
 * 类型尽量用字符串/JSON，方便 storageDomain 持久化和跨 source 复用。
 */

import type { SourceKind } from './sources/types.js'

export type ProjectMode = 'plan_review' | 'gate_confirm'

export type HardStatus =
  | 'running'
  | 'idle'
  | 'awaiting_approval'
  | 'awaiting_answer'
  | 'error'
  | 'interrupted'
  | 'unknown'

export type BlockerKind =
  | 'approval'
  | 'question'
  | 'plan_review'
  | 'repeated_failure'
  | 'stall'
  | 'interrupted'
  | 'decision'
  /** 上一轮 turn 报错（可恢复）：和「中断/崩溃」分开，错误原文一定带在证据里。 */
  | 'error'

export type BlockerStatus =
  | 'open'
  | 'notified'
  | 'resolved'
  | 'auto_resolved'
  | 'dismissed'
  | 'superseded'

export type DispatchStatus =
  | 'routing'
  | 'accepted'
  | 'delivered'
  /** 上一轮出错但派发没结束（可恢复，门禁和进度照常）。 */
  | 'error'
  | 'completed'
  | 'failed'
  | 'superseded'
  | 'reassigned'

export type PlanStatus =
  | 'pending_review'
  | 'approved'
  | 'changes_requested'
  | 'rejected'
  | 'superseded'
  | 'cancelled'
  /** 提交了方案但当前不需要审查（手动 session / 卡点确认模式）：正文仍要落盘。 */
  | 'skipped'

export type ApprovalStatus =
  | 'pending'
  | 'auto_approved'
  | 'user_approved'
  | 'user_rejected'
  | 'cancelled'
  | 'unavailable'

export type Risk = 'low' | 'high' | 'unknown'

export type Json = any

export interface SoftStatus {
  goal: string
  done: string[]
  next: string[]
  blockers: string[]
  decisions: string[]
  reportedAt: number
  source: 'tool' | 'log-digest'
}

export interface Meta {
  schemaVersion: number
  butlerSessionId: string | null
  butlerPresetId: string
  lastRecoveryAt: number | null
  lastReminderAt: number | null
  createdAt: number
  updatedAt: number
}

export interface Project {
  key: string
  workspaceId?: string
  cwd: string
  title: string
  mode: ProjectMode
  createdAt: number
  updatedAt: number
}

export interface ManagedSession {
  sessionId: string
  title: string
  cwd?: string
  projectKey?: string
  /** 会话来源；旧记录缺省按 'dsh'（见 sources/types.ts 的 sourceOf）。 */
  source: SourceKind
  isButler: boolean
  lastKnownSummary?: {
    running: boolean
    agentAvailable: boolean
    updatedAt: number
    blank: boolean
  }
  softStatus?: SoftStatus
  lastTaskId?: string
  firstSeenAt: number
  lastSeenAt: number
}

/**
 * 一条派发的巡检配置：按任务复杂度决定「多久没进展就该问一句」。
 *
 * 老记录没有这个字段，扫描会整段跳过，`runningStallMs` / `idleStallMs` 行为不变。
 */
export interface DispatchWatchdog {
  /** 管家对这条任务耗时的预估（分钟）。 */
  expectedMinutes?: number
  /** 超过这么久没有任何进展事件，就发一条低优先级 progress。 */
  pollMinutes: number
  /** 用户说了「别盯了」时置 true。 */
  quiet?: boolean
  /** 管家显式填的，还是按任务文本粗估的。 */
  source?: 'butler' | 'estimate'
}

/**
 * 进度检测的持久化游标。
 *
 * 存在 dispatch 记录里（dispatch 本来就是 per-record 存储），重启后据此去重，
 * 不需要新表，也不改 storage schema 版本。
 */
export interface DispatchProgressCursor {
  /** 已推送过的进度签名，保留最近 50 条。 */
  notified: string[]
  /** 最近一次「真实进展」（里程碑 / 阶段结束 / 卡点消失 / worker 上报）。
   *  watchdog 用它算「多久没进展」；watchdog 自己发的提醒不刷新它。 */
  lastProgressAt?: number
  /** 上次扫描看到的 running，用来识别 running → idle 的「阶段结束」。 */
  lastRunning?: boolean
  /** 上次看到的 turn 结束时间：turn 太短、扫描没看到 running 时靠它兜「阶段结束」。 */
  lastTurnEndAt?: number
  lastDoneCount?: number
  /** 最近一次里程碑提醒时间，里程碑之间的节流只看它（不受上报影响）。 */
  lastMilestoneAt?: number
  /** 最近一次 watchdog 提醒时间。 */
  lastWatchdogAt?: number
  /** 已经唤醒过管家的签名：同一 dispatch 同一签名只唤醒一次（防自激）。 */
  woke?: string[]
  /** 已经报过几次「阶段结束」，用来让抖动只报一次。 */
  stageEnds?: number
}

export interface Dispatch {
  id: string
  /** 目标会话的来源；缺省按 'dsh'。 */
  source?: SourceKind
  fromButlerTurn?: number
  /** 派出这个任务的管家会话；进度和卡点提醒只发给它。旧记录没有这个字段时广播给所有管家。 */
  fromButlerSessionId?: string
  text: string
  targetSessionId: string
  targetTitle?: string
  workspaceKey: string
  mode: 'reuse' | 'new'
  modeAtDispatch: ProjectMode
  requestId: string
  status: DispatchStatus
  reason: string
  relatedSessionIds: string[]
  createdAt: number
  acceptedAt?: number
  deliveredAt?: number
  error?: string
  /** 按复杂度巡检的配置；缺省 = 老记录，扫描不生成 watchdog 提醒。 */
  watchdog?: DispatchWatchdog
  /** 进度检测的持久化游标（去重 + 阶段跃迁 + 节流）。 */
  progress?: DispatchProgressCursor
}

export interface PlanScopeItem {
  id: string
  description: string
  paths?: string[]
  commands?: string[]
  network?: boolean
}

export interface Plan {
  id: string
  sessionId: string
  dispatchId: string
  /** 所属会话的来源；缺省按 'dsh'。注意与下面的 `source`（计划来源）不是一回事。 */
  sessionSource?: SourceKind
  title: string
  markdown: string
  scope: { items: PlanScopeItem[] }
  status: PlanStatus
  feedback?: string
  submittedAt: number
  reviewedAt?: number
  reviewedBy?: 'user' | 'butler-chat'
  source: 'butler_submit_plan' | 'native_plan_mode'
  stale?: boolean
}

export interface Blocker {
  id: string
  sessionId: string
  /** 所属会话的来源；缺省按 'dsh'。 */
  source?: SourceKind
  kind: BlockerKind
  subkind?: 'test' | 'error' | 'edit_thrash' | 'running_stall' | 'idle_stall' | 'loop'
  severity: 'info' | 'warning' | 'critical'
  status: BlockerStatus
  signature: string
  summary: string
  neededAction: string
  evidence: Json
  detectedAt: number
  lastSeenAt: number
  notifiedAt?: number
  reminderCount: number
  lastRemindedAt?: number
  resolvedAt?: number
  resolution?: string
  relatedPlanId?: string
  relatedApprovalId?: string
  relatedCallId?: string
  relatedTurn?: number
}

export interface Approval {
  id: string
  sessionId: string
  toolName: string
  callId?: string
  argsSummary: string
  risk: Risk
  planId?: string
  planItemId?: string
  reason?: string
  status: ApprovalStatus
  stale?: boolean
  decidedBy?: 'butler-auto' | 'user' | 'butler-chat' | 'system'
  decisionNote?: string
  createdAt: number
  decidedAt?: number
  recovered?: boolean
}

export interface AuditEntry {
  id: string
  at: number
  sessionId?: string
  /** 涉及会话的来源；缺省按 'dsh'。 */
  source?: SourceKind
  kind:
    | 'dispatch'
    | 'route'
    | 'plan'
    | 'approval'
    | 'blocker'
    | 'mode'
    | 'recovery'
    | 'command'
  action: string
  risk?: Risk
  decision?: string
  by?: 'butler-auto' | 'user' | 'butler-chat' | 'system'
  planId?: string
  planItemId?: string
  toolName?: string
  callId?: string
  argsSummary?: string
  note?: string
}

export interface SessionView {
  sessionId: string
  /** 来源（P0 恒为 'dsh'，二期会出现 claude/codex）。 */
  source: SourceKind
  /**
   * 该来源的能力表。UI 只按它决定"渲不渲染按钮"：
   * capabilities 为 false 的操作一律不渲染可点按钮（R6）。
   */
  capabilities?: import('./sources/types.js').SourceCapabilities
  title: string
  cwd?: string
  projectKey?: string
  mode?: ProjectMode
  hardStatus: HardStatus
  running: boolean
  lastActivityAt: number
  queuedCount: number
  softStatus?: SoftStatus
  openBlockerKinds: BlockerKind[]
  openBlockerCount: number
  isButler: boolean
  missing?: boolean
}

export interface Snapshot {
  generatedAt: number
  butler: {
    sessionId: string | null
    title: string
    status: HardStatus
  }
  projects: Project[]
  sessions: SessionView[]
  blockers: Blocker[]
  /** 待处理卡点的卡片数据（含按钮），管家对话里的「待处理条」直接用。 */
  blockerNotices: ButlerNotice[]
  /**
   * 各来源的健康状态。来宾源（claude/codex）坏掉时这里会显示 available=false + 原因，
   * 核心（dsh 会话/卡点/派发/审批）不受影响。
   */
  sources: Array<{
    kind: SourceKind
    enabled: boolean
    available: boolean
    error?: string
    at: number
  }>
  /**
   * 进度通知（B-1）。**语义与 blockerNotices 严格分开**：
   * 不进待办、不阻塞、不需要点击，只是"发生了什么"的实时时间线。
   */
  progressNotices: ButlerNotice[]
  /** 最近处理过的卡点：提醒消息行要靠它判断自己是否已处理。 */
  resolvedBlockers: ResolvedBlockerView[]
  plans: Plan[]
  dispatches: Dispatch[]
  approvals: Approval[]
  audit: AuditEntry[]
}

/** 已处理卡点的只读视图，供对话里的提醒卡片回显「已处理」。 */
export interface ResolvedBlockerView {
  id: string
  kind: BlockerKind
  status: BlockerStatus
  sessionId: string
  summary: string
  resolution?: string
  resolvedAt?: number
}

/** 提醒卡片上的一个可点动作。 */
export type ButlerNoticeVerb =
  | 'approve'
  | 'reject'
  | 'answer'
  | 'dismiss'
  | 'retry'
  | 'dispatch_completed'
  | 'dispatch_failed'
  | 'open_session'

export interface ButlerNoticeAction {
  verb: ButlerNoticeVerb
  label: string
  style?: 'primary' | 'danger' | 'plain'
  /** 需要用户在行内 textarea 里填文本（回答 / 提修改意见 / 驳回原因）。 */
  requiresText?: boolean
  placeholder?: string
}

/**
 * 一条提醒的结构化内容。
 *
 * 写进 `user/message` 的 source 里，客户端只读它就能渲染整张卡；
 * 消息 content 仍保留原来的纯文本，管家模型看到的东西不变。
 */
/** 进度通知的生命周期：open（可见）→ resolved（被新进展取代）/ expired（超时）。 */
export type NoticeStatus = 'open' | 'resolved' | 'expired'

/**
 * 已发出的进度通知的持久化记录。
 *
 * 这是「实时可见」的载体：事件发生时立刻落盘，`snapshot.progressNotices` 读它，
 * 客户端 2 秒轮询就能看到——不再依赖用户先说话触发的 inject。
 */
export interface ProgressNoticeRecord {
  id: string
  at: number
  sessionId: string
  sessionTitle?: string
  /** 会话来源（dsh/claude/codex），卡片上打徽标。 */
  source?: SourceKind
  /** 事件类型：milestone / stage_end / blocker_resolved / watchdog。 */
  kind: string
  category: 'milestone' | 'dispatch'
  severity: 'info' | 'warning' | 'critical'
  title: string
  detail?: string
  dispatchId?: string
  /** 去重签名（与 dispatch.progress.notified 同一套）。 */
  signatures: string[]
  status: NoticeStatus
  expiresAt: number
}

export interface ButlerNotice {
  id: string
  at: number
  /** blocker=卡点提醒，progress=进度/里程碑，summary=离线汇总。 */
  kind: 'blocker' | 'progress' | 'summary'
  category: BlockerKind | 'dispatch' | 'restart' | 'milestone'
  severity: 'info' | 'warning' | 'critical'
  sessionId?: string
  sessionTitle?: string
  /** 这条提醒属于哪个来源（缺省 dsh）；面板/卡片用它打来源徽标。 */
  source?: SourceKind
  /** 卡片标题，例如「repo-a · 等审批」。 */
  title: string
  /** 证据摘要 / 计划标题 / 新完成的条目。 */
  detail?: string
  neededAction?: string
  blockerId?: string
  planId?: string
  approvalId?: string
  dispatchId?: string
  callId?: string
  /** ask_user 的候选项标签；有就直接给按钮。 */
  options?: string[]
  /** 进度通知的生命周期状态（仅 progress 类有）。 */
  status?: NoticeStatus
  /** 过期时间（毫秒时间戳，仅 progress 类有）。 */
  expiresAt?: number
  actions: ButlerNoticeAction[]
}

/**
 * 提醒消息的 source。
 *
 * - `kind` 让 chat 不再把它当成用户自己发的消息（走 context 行）。
 * - `form:'notice'` + `summary` 让 dsh 原生在没有本插件时也能降级成一行 notice。
 * - `notice` 是本插件客户端渲染卡片的数据来源。
 */
export interface ButlerNoticeSource {
  kind: 'superagent-notice'
  form: 'notice'
  /**
   * 只给模型看的注入，不在对话里渲染成卡片（进度类走这条）：
   * 进度已经有面板载体，再渲一次会让用户看到两遍（幂等要求）。
   */
  modelOnly?: boolean
  summary: string
  notice: ButlerNotice
}

/** 注入提醒时给 service 的入参。 */
export interface ButlerNoticePayload {
  text: string
  source?: ButlerNoticeSource
  /** 派发这条任务的管家；缺省时广播给所有管家。 */
  butlerSessionId?: string
}

export interface RouteCandidate {
  sessionId: string
  title: string
  projectKey: string
  hardStatus: HardStatus
  lastActivityAt: number
  queuedCount: number
  softStatus?: SoftStatus
  recentUserMessages: string[]
  openDispatch?: { id: string; text: string }
  openBlockerKinds: BlockerKind[]
}

export type RouteDecision =
  | { kind: 'status_query'; query?: string }
  | { kind: 'reuse'; sessionId: string; reason: string; delivery?: 'queue' | 'wake' }
  | {
      kind: 'new'
      projectKey: string
      cwd: string
      reason: string
      relatedSessionIds?: string[]
    }
  | {
      kind: 'clarify'
      reason: 'workspace_ambiguous' | 'workspace_missing' | 'target_ambiguous'
      candidateIds?: string[]
    }

export interface ToolIntent {
  toolName: string
  callId?: string
  argsSummary: string
  risk: Risk
  gated: boolean
  policy: 'plan' | 'whitelist'
  planId?: string
  planItemId?: string
  deny?: boolean
  reason?: string
  review?: 'readonly' | 'danger'
  flags?: string[]
}

export interface DispatchReceipt {
  dispatchId: string
  sessionId: string
  status: DispatchStatus
  delivery: 'queue' | 'wake'
  reason: string
}

export interface ResolveResult {
  ok: boolean
  action: string
  blockerId?: string
  message: string
}

/** 单个外部来源的配置（二期 P1 只用到 claude，codex 复用同一形状）。 */
export interface ClaudeSourceConfig {
  /** 默认 false：不开就不读这个目录，隐私优先。 */
  enabled: boolean
  /** 数据根目录，默认 `~/.claude`（测试时指向 fixture）。 */
  home?: string
  /** 只扫最近这么多天有更新的会话文件。 */
  scanDays: number
  /** 单次扫描最多处理的会话文件数（防止历史堆积拖慢）。 */
  maxSessions: number
  /** 读文件尾部这么多字节来拿标题/cwd/最后事件，不读全文。 */
  tailBytes: number
  /** 是否把 <root>/subagents/*.jsonl 也列出来（标记为非 root）。 */
  includeSubagents: boolean
  /** 是否用 fs.watch 触发缓存失效；关掉则只靠定时扫描。 */
  watch: boolean
}

export interface Config {
  butler: {
    title: string
    model?: string
    cwd?: string
  }
  routingWindowDays: number
  routingMaxCandidates: number
  topicRecentMessages: number
  approvalRemindAfterMs: number
  answerRemindAfterMs: number
  repeatFailureThreshold: number
  repeatWindowMs: number
  repeatToolCallThreshold: number
  editThrashThreshold: number
  editThrashWindowMs: number
  runningStallMs: number
  idleStallMs: number
  reminderCooldownMs: number
  maxRemindersPerBlocker: number
  statusTtlMs: number
  statusRefreshLimit: number
  recoveryScanDays: number
  scanIntervalMs: number
  dispatchRetryLimit: number
  planReview: {
    allowReadOnlyBash: boolean
  }
  auditAllLowRisk: boolean
  progress: {
    notifyMilestones: boolean
    /** running → idle 且仍有 open dispatch 时报「阶段结束」。 */
    notifyStageEnd: boolean
    /** 卡点自动消失时报一条通知（卡点新增仍走现有 blocker 提醒）。 */
    notifyBlockerResolved: boolean
    /** 同一 dispatch 两次「里程碑」进度之间的最小间隔。 */
    minGapMs: number
    /** 进度通知持久化队列上限（最近的在前）。 */
    queueLimit: number
    /** 进度通知存活时间，超时从快照里消失。 */
    ttlMs: number
    /** 唤醒管家（B-1 §5）；默认开，但被类型/签名/配额/节流四道闸夹住。 */
    wake: {
      enabled: boolean
      minGapMs: number
      /** 只有这些事件类型会唤醒（纯里程碑不唤醒）。 */
      kinds: string[]
      maxPerDispatch: number
    }
  }
  /** 按任务复杂度的巡检默认值（dispatch.watchdog 缺省时按文本粗估）。 */
  watchdog: {
    enabled: boolean
    defaultPollMinutes: number
    minMinutes: number
    maxMinutes: number
  }
  /** 规则判不了的 bash 交给管家模型审查，没风险就放行（`bash-review.ts`）。 */
  /** 外部只读来源（二期）。默认全部关闭，显式开启才扫描。 */
  sources: {
    claude: ClaudeSourceConfig
    codex: ClaudeSourceConfig
  }
  bashReview: {
    enabled: boolean
  }
}

export const DEFAULT_CONFIG: Config = {
  butler: { title: 'SuperAgent 管家' },
  routingWindowDays: 14,
  routingMaxCandidates: 10,
  topicRecentMessages: 20,
  approvalRemindAfterMs: 60_000,
  answerRemindAfterMs: 60_000,
  repeatFailureThreshold: 3,
  repeatWindowMs: 600_000,
  repeatToolCallThreshold: 3,
  editThrashThreshold: 5,
  editThrashWindowMs: 900_000,
  runningStallMs: 600_000,
  idleStallMs: 3_600_000,
  reminderCooldownMs: 1_800_000,
  maxRemindersPerBlocker: 3,
  statusTtlMs: 60_000,
  statusRefreshLimit: 50,
  recoveryScanDays: 14,
  scanIntervalMs: 15_000,
  dispatchRetryLimit: 3,
  planReview: { allowReadOnlyBash: false },
  auditAllLowRisk: false,
  progress: {
    notifyMilestones: true,
    notifyStageEnd: true,
    notifyBlockerResolved: true,
    minGapMs: 180_000,
    queueLimit: 50,
    ttlMs: 24 * 60 * 60_000,
    wake: {
      enabled: true,
      minGapMs: 120_000,
      kinds: ['stage_end', 'watchdog'],
      maxPerDispatch: 2,
    },
  },
  watchdog: { enabled: true, defaultPollMinutes: 10, minMinutes: 3, maxMinutes: 60 },
  sources: {
    claude: {
      enabled: false,
      scanDays: 14,
      maxSessions: 500,
      tailBytes: 65536,
      includeSubagents: true,
      watch: true,
    },
    codex: { enabled: false, scanDays: 14, maxSessions: 200, tailBytes: 65536, includeSubagents: false, watch: true },
  },
  bashReview: { enabled: true },
}

export const READ_ONLY_TOOLS = new Set([
  'read',
  'read_image',
  'glob',
  'grep',
  'session_search',
  'session_event_search',
  'session_event_trace',
  'session_event_read',
  'session_trace',
  'job_output',
  'job_list',
  'present',
  'todo_write',
  'ask_user_question',
  'butler_report_status',
  'butler_submit_plan',
])

export const MUTATING_TOOLS = new Set([
  'write',
  'edit',
  'str_replace_editor',
  'bash',
  'pwsh',
  'run_code',
  'terminal_open',
  'terminal_send',
  'terminal_signal',
  'terminal_close',
  'subagent',
  'subagent_fork',
  'workflow',
  'schedule_create',
  'schedule_update',
  'schedule_delete',
  'cordis_define',
  'cordis_run',
  'cordis_stop',
  'cordis_undefine',
  'web_fetch',
  'web_search',
])
