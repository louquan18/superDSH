/**
 * SessionSource 抽象（二期 P0）。
 *
 * 设计对齐 `docs/dsh-superagent-butler-design.md` §9.2 / §9.4：
 * - 核心（路由/卡点/计划/审计/UI）只依赖本文件，不直接依赖 dsh 类型；
 * - `SourceKind` 区分来源，`SourceCapabilities` 声明能做什么，不能做的必须显式 false；
 * - 一期只有 dsh，二期加 claude（Claude Code）与 codex（Codex），两者只读。
 *
 * P0 阶段不改变任何行为：只落地类型 + 注册表 + 记录上的 `source` 字段。
 */
import type { HardStatus, SoftStatus } from '../types.js'

/**
 * 会话来源。
 *
 * 设计文档 §9.2 写的是 `'ducc'`；落地值用 `'claude'`（Claude Code 的实际来源），
 * `'ducc'` 保留为别名，读入时归一化成 `'claude'`（见 {@link normalizeSourceKind}）。
 */
export type SourceKind = 'dsh' | 'claude' | 'codex' | 'remote'

/** 运行时可见的全部来源，按展示顺序排列（dsh 永远在前）。 */
export const SOURCE_KINDS: readonly SourceKind[] = ['dsh', 'claude', 'codex', 'remote']

/**
 * 把一个来路不明的值归一化成 {@link SourceKind}。
 *
 * - `'ducc'` / `'claude-code'` → `'claude'`（文档别名）
 * - 大小写与空白不敏感
 * - 空值或未知值 → `undefined`（调用方用 {@link sourceOf} 兜底成 `'dsh'`）
 */
export function normalizeSourceKind(value: unknown): SourceKind | undefined {
  if (typeof value !== 'string') return undefined
  const kind = value.trim().toLowerCase()
  if (kind === 'dsh') return 'dsh'
  if (kind === 'claude' || kind === 'ducc' || kind === 'claude-code') return 'claude'
  if (kind === 'codex') return 'codex'
  if (kind === 'remote') return 'remote'
  return undefined
}

/**
 * 读一条记录的来源：缺字段一律按 `'dsh'` 解释（P0 不做数据迁移）。
 *
 * 旧的 dispatch/blocker/plan/audit 记录没有 `source`，行为必须与引入字段前完全一致。
 */
export function sourceOf(record: { source?: unknown } | null | undefined): SourceKind {
  return normalizeSourceKind(record?.source) ?? 'dsh'
}

/** 来源能力声明：false 表示"不支持"，UI 置灰、路由过滤，绝不假装支持。 */
export interface SourceCapabilities {
  readonly list: boolean
  readonly readEvents: boolean
  readonly readDigest: boolean
  readonly subscribe: boolean
  readonly create: boolean
  readonly resume: boolean
  readonly queue: boolean
  readonly cancel: boolean
  readonly approvals: boolean
  readonly questions: boolean
  readonly plans: boolean
  readonly hardStatus: boolean
  readonly softStatusTool: boolean
  readonly reassign: boolean
  /** 能不能往里投递消息（派发的硬前提，§9.4 二期外部来源为 false）。 */
  readonly send: boolean
}

/** dsh 本机会话：全能力。 */
export const DSH_CAPABILITIES: SourceCapabilities = Object.freeze({
  list: true,
  readEvents: true,
  readDigest: true,
  subscribe: true,
  create: true,
  resume: true,
  queue: true,
  cancel: true,
  approvals: true,
  questions: true,
  plans: true,
  hardStatus: true,
  softStatusTool: true,
  reassign: true,
  send: true,
})

/**
 * 只读旁路（Claude Code / Codex 的基线）。
 *
 * §9.4：外部来源只开 list/readEvents/readDigest/subscribe；create/resume/send/queue/cancel/
 * approvals/questions/plans 全部 false。具体来源可以在此基础上再关掉 subscribe 或 hardStatus。
 */
export const READ_ONLY_CAPABILITIES: SourceCapabilities = Object.freeze({
  list: true,
  readEvents: true,
  readDigest: true,
  subscribe: false,
  create: false,
  resume: false,
  queue: false,
  cancel: false,
  approvals: false,
  questions: false,
  plans: false,
  hardStatus: false,
  softStatusTool: false,
  reassign: false,
  send: false,
})

/** 覆盖若干能力位，生成某个来源的能力表。 */
export function withCapabilities(
  base: SourceCapabilities,
  overrides: Partial<SourceCapabilities>,
): SourceCapabilities {
  return Object.freeze({ ...base, ...overrides })
}

/**
 * 列表用的轻量会话条目。
 *
 * 这是 P0 的落地形态：字段沿用一期（`live/persisted/blank/agentAvailable` 是 dsh 概念），
 * 外部来源没有这些概念时填保守值（`live:false`、`blank:false`、`agentAvailable:false`）。
 * 二期 P1 再按 §9.2 的 `SourceSession`（`id/status/isRoot/parentId`）收敛。
 */
export interface SourceSessionLite {
  sessionId: string
  /** 来源；由 SourceRegistry 统一填充，适配器自己也要写对。 */
  source: SourceKind
  title: string
  cwd?: string
  agentPreset?: string
  parentSessionId?: string
  origin?: string
  live: boolean
  persisted: boolean
  blank: boolean
  running: boolean
  agentAvailable: boolean
  updatedAt: number
  /** 外部来源自己算出的状态；dsh 不填（由事件折叠得出）。 */
  hardStatus?: HardStatus
  /** 外部来源从 log digest 得到的软状态；dsh 走 worker 工具上报。 */
  softStatus?: SoftStatus
}

/** 会话摘要（给管家/面板阅读的事件抽样）。 */
export interface SourceDigest {
  sessionId: string
  title: string
  events: any[]
  softStatus?: SoftStatus
  lastTurnOpen: boolean
  lastTurnEndKind?: string
  lastActivityAt: number
}

/** 会话状态（§9.2 的 HardStatus 在此复用以避免两套定义）。 */
export type SourceStatus = HardStatus

/**
 * 一个来源必须实现的最小面。
 *
 * P0 只有 dsh 实现；外部来源只读时，`prompt`/`create`/`rename`/`cancel`/
 * `findQueuedMessage`/`removeQueued`/`findDelivered` 可以不实现——调用方必须先看
 * {@link SourceCapabilities}，不能靠"调了才知道"。
 */
export interface SessionSource {
  readonly kind: SourceKind
  readonly capabilities: SourceCapabilities
  /** 列出该来源的全部会话（含非 root，由上层过滤）。 */
  list(): Promise<SourceSessionLite[]>
  /** 观察一个会话的原始状态（dsh: observeSession；外部来源: 解析后的等价物）。 */
  observe(sessionId: string): Promise<any>
  /** 最近事件（升序）。 */
  readEvents(sessionId: string): Promise<any[]>
  /** 会话摘要；读不到返回 undefined，不要抛。 */
  readDigest(sessionId: string, limit?: number): Promise<SourceDigest | undefined>
  /** 最近的用户消息文本（升序）。 */
  readUserMessages(sessionId: string, limit: number): Promise<string[]>
  /** 投递一条消息；只有 `capabilities.send` 为真时才允许调用。 */
  prompt(sessionId: string, text: string, requestId: string): Promise<unknown>
  /** 新建会话；只有 `capabilities.create` 为真时才允许调用。 */
  create(cwd: string, agentPreset?: string): Promise<string>
  /** 改标题；不支持时上层跳过。 */
  rename(sessionId: string, title: string): Promise<void>
  /** 取消当前回合；不支持时上层跳过。 */
  cancel(sessionId: string): Promise<void>
  /** 幂等请求 id 工厂。 */
  newRequestId(): string
  /** 找出仍在队列里的那条消息（改派用）。 */
  findQueuedMessage(sessionId: string, requestId: string): Promise<any>
  /** 从队列里移除（改派用）。 */
  removeQueued(sessionId: string, itemId: string): Promise<boolean>
  /** 消息是否已投递（accepted → delivered 判定）。 */
  findDelivered(sessionId: string, requestId: string): Promise<boolean>
}

/** 判断一个能力位是否可用（给调用点用，避免各处手写 `=== true`）。 */
export function supports(
  source: SessionSource | undefined,
  capability: keyof SourceCapabilities,
): boolean {
  return source?.capabilities?.[capability] === true
}
