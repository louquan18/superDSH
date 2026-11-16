/**
 * SuperAgent 管家：公共数据模型。
 *
 * 这里不 import 任何 dsh 运行时包；所有 dsh 能力都通过 Cordis ctx 上的服务取得。
 * 类型尽量用字符串/JSON，方便 storageDomain 持久化和跨 source 复用。
 */
import type { SourceKind } from './sources/types.js';
export type ProjectMode = 'plan_review' | 'gate_confirm';
export type HardStatus = 'running' | 'idle' | 'awaiting_approval' | 'awaiting_answer' | 'error' | 'interrupted' | 'unknown';
export type BlockerKind = 'approval' | 'question' | 'plan_review' | 'repeated_failure' | 'stall' | 'interrupted' | 'decision'
/** 上一轮 turn 报错（可恢复）：和「中断/崩溃」分开，错误原文一定带在证据里。 */
 | 'error'
/**
 * 建议销账（I-20/I-21/I-28）：活看起来干完了但没人确认。
 * 只是建议，**绝不自动销账**——点一下才关。
 */
 | 'settle_suggest';
export type BlockerStatus = 'open' | 'notified' | 'resolved' | 'auto_resolved' | 'dismissed' | 'superseded';
export type DispatchStatus = 'routing' | 'accepted' | 'delivered'
/** 上一轮出错但派发没结束（可恢复，门禁和进度照常）。 */
 | 'error' | 'completed' | 'failed' | 'superseded' | 'reassigned';
export type PlanStatus = 'pending_review' | 'approved' | 'changes_requested' | 'rejected' | 'superseded' | 'cancelled'
/** 提交了方案但当前不需要审查（手动 session / 卡点确认模式）：正文仍要落盘。 */
 | 'skipped';
export type ApprovalStatus = 'pending' | 'auto_approved' | 'user_approved' | 'user_rejected' | 'cancelled' | 'unavailable';
export type Risk = 'low' | 'high' | 'unknown';
export type Json = any;
export interface SoftStatus {
    goal: string;
    done: string[];
    next: string[];
    blockers: string[];
    decisions: string[];
    reportedAt: number;
    source: 'tool' | 'log-digest';
}
export interface Meta {
    schemaVersion: number;
    butlerSessionId: string | null;
    butlerPresetId: string;
    lastRecoveryAt: number | null;
    lastReminderAt: number | null;
    createdAt: number;
    updatedAt: number;
    /** 写这份 meta 时的代码版本（`git describe`，取不到则是 `pkg@x.y.z+unknown`）。 */
    codeVersion?: string;
    /** 有效配置的指纹，见 `version.ts`。 */
    configHash?: string;
    /** 进程启动时间。 */
    startedAt?: number;
}
export interface Project {
    key: string;
    workspaceId?: string;
    cwd: string;
    title: string;
    mode: ProjectMode;
    createdAt: number;
    updatedAt: number;
}
export interface ManagedSession {
    sessionId: string;
    title: string;
    cwd?: string;
    projectKey?: string;
    /** 会话来源；旧记录缺省按 'dsh'（见 sources/types.ts 的 sourceOf）。 */
    source: SourceKind;
    isButler: boolean;
    lastKnownSummary?: {
        running: boolean;
        agentAvailable: boolean;
        updatedAt: number;
        blank: boolean;
    };
    softStatus?: SoftStatus;
    lastTaskId?: string;
    firstSeenAt: number;
    lastSeenAt: number;
}
/**
 * 一条派发的巡检配置：按任务复杂度决定「多久没进展就该问一句」。
 *
 * 老记录没有这个字段，扫描会整段跳过，`runningStallMs` / `idleStallMs` 行为不变。
 */
export interface DispatchWatchdog {
    /** 管家对这条任务耗时的预估（分钟）。 */
    expectedMinutes?: number;
    /** 超过这么久没有任何进展事件，就发一条低优先级 progress。 */
    pollMinutes: number;
    /** 用户说了「别盯了」时置 true。 */
    quiet?: boolean;
    /** 管家显式填的，还是按任务文本粗估的。 */
    source?: 'butler' | 'estimate';
}
/**
 * 进度检测的持久化游标。
 *
 * 存在 dispatch 记录里（dispatch 本来就是 per-record 存储），重启后据此去重，
 * 不需要新表，也不改 storage schema 版本。
 */
export interface DispatchProgressCursor {
    /** 已推送过的进度签名，保留最近 50 条。 */
    notified: string[];
    /** 最近一次「真实进展」（里程碑 / 阶段结束 / 卡点消失 / worker 上报）。
     *  watchdog 用它算「多久没进展」；watchdog 自己发的提醒不刷新它。 */
    lastProgressAt?: number;
    /** 上次扫描看到的 running，用来识别 running → idle 的「阶段结束」。 */
    lastRunning?: boolean;
    /** 上次看到的 turn 结束时间：turn 太短、扫描没看到 running 时靠它兜「阶段结束」。 */
    lastTurnEndAt?: number;
    lastDoneCount?: number;
    /** 最近一次里程碑提醒时间，里程碑之间的节流只看它（不受上报影响）。 */
    lastMilestoneAt?: number;
    /** 最近一次 watchdog 提醒时间。 */
    lastWatchdogAt?: number;
    /** 已经唤醒过管家的签名：同一 dispatch 同一签名只唤醒一次（防自激）。 */
    woke?: string[];
    /** 已经报过几次「阶段结束」，用来让抖动只报一次。 */
    stageEnds?: number;
}
/**
 * 一件「持续进行的活」（P2）。
 *
 * 调度单位本来是一条 `Dispatch`（一条派发消息），但「活」和「消息」不是一回事：
 * 同一条活可能派发多次，卡点、计划、进度都该挂在活上而不是某条消息上。
 * 有了它才能干净地销账、归档卡点、把审计按活归因。
 */
export interface Thread {
    id: string;
    title: string;
    state: 'active' | 'waiting_human' | 'done' | 'abandoned';
    /** 参与这条活的所有会话（可能换过会话）。 */
    participantSessionIds: string[];
    /** 归属的派发，按时间先后。 */
    dispatchIds: string[];
    projectKey?: string;
    /** 外部线程标识（GitHub PR / IM 话题等），本期只留字段不写入。 */
    externalKeys?: Array<{
        kind: 'github_pr' | 'im' | 'email' | 'file';
        key: string;
    }>;
    createdAt: number;
    lastEventAt: number;
    closedAt?: number;
    closedBy?: 'user' | 'butler' | 'auto_ttl';
}
export interface Dispatch {
    id: string;
    /** 目标会话的来源；缺省按 'dsh'。 */
    source?: SourceKind;
    fromButlerTurn?: number;
    /** 派出这个任务的管家会话；进度和卡点提醒只发给它。旧记录没有这个字段时广播给所有管家。 */
    fromButlerSessionId?: string;
    text: string;
    targetSessionId: string;
    targetTitle?: string;
    workspaceKey: string;
    mode: 'reuse' | 'new';
    modeAtDispatch: ProjectMode;
    requestId: string;
    status: DispatchStatus;
    reason: string;
    relatedSessionIds: string[];
    createdAt: number;
    acceptedAt?: number;
    deliveredAt?: number;
    error?: string;
    /** 归属的活（P2）。老记录没有，读时按 dispatch 自身兜底。 */
    threadId?: string;
    /**
     * 「疑似完成」的时间与依据（I-28 第 2 层）。
     *
     * 这是**记录的事实**，不是推断：worker 自己报完（done 非空、next 空、无 blocker），
     * 或者检测到阶段结束后仍然安静。建议销账用它做依据，不再靠拼条件猜。
     */
    suspectDoneAt?: number;
    suspectDoneReason?: 'report' | 'stage_end';
    /** 按复杂度巡检的配置；缺省 = 老记录，扫描不生成 watchdog 提醒。 */
    watchdog?: DispatchWatchdog;
    /** 进度检测的持久化游标（去重 + 阶段跃迁 + 节流）。 */
    progress?: DispatchProgressCursor;
}
export interface PlanScopeItem {
    id: string;
    description: string;
    paths?: string[];
    commands?: string[];
    network?: boolean;
}
export interface Plan {
    id: string;
    sessionId: string;
    dispatchId: string;
    /** 所属会话的来源；缺省按 'dsh'。注意与下面的 `source`（计划来源）不是一回事。 */
    sessionSource?: SourceKind;
    title: string;
    markdown: string;
    scope: {
        items: PlanScopeItem[];
    };
    status: PlanStatus;
    feedback?: string;
    submittedAt: number;
    reviewedAt?: number;
    reviewedBy?: 'user' | 'butler-chat';
    source: 'butler_submit_plan' | 'native_plan_mode';
    stale?: boolean;
    /** 归属的活（P2）。 */
    threadId?: string;
}
export interface Blocker {
    id: string;
    sessionId: string;
    /** 所属会话的来源；缺省按 'dsh'。 */
    source?: SourceKind;
    kind: BlockerKind;
    subkind?: 'test' | 'error' | 'edit_thrash' | 'running_stall' | 'idle_stall' | 'loop';
    severity: 'info' | 'warning' | 'critical';
    status: BlockerStatus;
    signature: string;
    summary: string;
    neededAction: string;
    evidence: Json;
    detectedAt: number;
    lastSeenAt: number;
    notifiedAt?: number;
    reminderCount: number;
    lastRemindedAt?: number;
    resolvedAt?: number;
    resolution?: string;
    /** 归属的活（P2）。 */
    threadId?: string;
    /**
     * 已经用它唤醒过管家的签名（与 `dispatch.progress.woke` 同一套语义：先落盘、同签名只一次）。
     * 没有派发的卡点没有 dispatch 可挂，就落在自己身上。
     */
    woke?: string[];
    relatedPlanId?: string;
    relatedApprovalId?: string;
    relatedCallId?: string;
    relatedTurn?: number;
}
export interface Approval {
    id: string;
    sessionId: string;
    toolName: string;
    callId?: string;
    argsSummary: string;
    risk: Risk;
    planId?: string;
    planItemId?: string;
    reason?: string;
    status: ApprovalStatus;
    stale?: boolean;
    decidedBy?: 'butler-auto' | 'user' | 'butler-chat' | 'system';
    decisionNote?: string;
    createdAt: number;
    decidedAt?: number;
    recovered?: boolean;
}
export interface AuditEntry {
    id: string;
    at: number;
    sessionId?: string;
    /** 涉及会话的来源；缺省按 'dsh'。 */
    source?: SourceKind;
    kind: 'dispatch' | 'route' | 'plan' | 'approval' | 'blocker' | 'mode' | 'recovery' | 'command';
    action: string;
    risk?: Risk;
    decision?: string;
    by?: 'butler-auto' | 'user' | 'butler-chat' | 'system';
    planId?: string;
    planItemId?: string;
    toolName?: string;
    callId?: string;
    argsSummary?: string;
    note?: string;
    /** 改投三要素（I-37）：原目标 / 最终目标 / 原因，结构化可查，不必从 note 里抠。 */
    fromButlerId?: string;
    toButlerId?: string;
    redirectReason?: string;
    /** 改投是否跨工作区（true = 没找到同 projectKey 的在线管家）。 */
    crossProject?: boolean;
    /**
     * 产生这条决策的代码版本与配置指纹（P0 版本戳）。
     * 由 `Store.setVersion()` 统一注入，调用方不传。
     */
    codeVersion?: string;
    configHash?: string;
    /** 归属的派发（P1 台账外键）。老记录没有，按 sessionId + 时间窗兜底。 */
    dispatchId?: string;
    /** 归属的活（P2）。 */
    threadId?: string;
    /** 归属的卡点（P1）：把「提醒」和「卡点最终怎么消失」对上。 */
    blockerId?: string;
    /** 这条审计是哪条自动规则的决策（见 `policy.ts` 的 RULES）。为空 = 不是规则决策。 */
    ruleId?: string;
    /** 决策被 shadow 拦下：只记录、未执行（没发提醒、没真拦）。 */
    shadow?: boolean;
    /** 事后标注的结论（见 `label.ts`）。 */
    outcome?: 'tp' | 'fp' | 'fn' | 'unknown';
    /** 哪条标注规则判的，可复算。 */
    outcomeRule?: string;
    outcomeAt?: number;
}
export interface SessionView {
    sessionId: string;
    /** 来源（P0 恒为 'dsh'，二期会出现 claude/codex）。 */
    source: SourceKind;
    /**
     * 该来源的能力表。UI 只按它决定"渲不渲染按钮"：
     * capabilities 为 false 的操作一律不渲染可点按钮（R6）。
     */
    capabilities?: import('./sources/types.js').SourceCapabilities;
    title: string;
    cwd?: string;
    projectKey?: string;
    mode?: ProjectMode;
    hardStatus: HardStatus;
    running: boolean;
    lastActivityAt: number;
    queuedCount: number;
    softStatus?: SoftStatus;
    openBlockerKinds: BlockerKind[];
    openBlockerCount: number;
    isButler: boolean;
    missing?: boolean;
}
/**
 * 待回答的提问（I-36 A）：插件收到提问时落盘。
 *
 * 用途：进程重启后内存里的 waiter 没了，靠这份记录知道「有这么个提问还没答」，
 * 并把对应卡点标成「请到界面回答」——而不是装作能代答。
 */
export interface PendingQuestionRecord {
    callId: string;
    sessionId: string;
    at: number;
    /** true = 本进程已经不持有这个提问（重启后 / 非本进程发起），只能去界面回答。 */
    needsUiAnswer?: boolean;
    questions: Array<{
        id?: string;
        question?: string;
        header?: string;
        options?: Array<{
            label?: string;
            description?: string;
        }>;
    }>;
}
export interface Snapshot {
    generatedAt: number;
    /**
     * 运行期版本标识（P0）：面板上显示、排查「哪版代码 + 哪版配置」用。
     * 老客户端不认这个字段，缺省也不影响任何行为。
     */
    version?: {
        codeVersion: string;
        configHash: string;
        startedAt: number;
    };
    butler: {
        sessionId: string | null;
        title: string;
        status: HardStatus;
    };
    projects: Project[];
    sessions: SessionView[];
    blockers: Blocker[];
    /** 待处理卡点的卡片数据（含按钮），管家对话里的「待处理条」直接用。 */
    blockerNotices: ButlerNotice[];
    /**
     * 各来源的健康状态。来宾源（claude/codex）坏掉时这里会显示 available=false + 原因，
     * 核心（dsh 会话/卡点/派发/审批）不受影响。
     */
    sources: Array<{
        kind: SourceKind;
        enabled: boolean;
        available: boolean;
        error?: string;
        at: number;
    }>;
    /**
     * 进度通知（B-1）。**语义与 blockerNotices 严格分开**：
     * 不进待办、不阻塞、不需要点击，只是"发生了什么"的实时时间线。
     */
    progressNotices: ButlerNotice[];
    /** 最近处理过的卡点：提醒消息行要靠它判断自己是否已处理。 */
    resolvedBlockers: ResolvedBlockerView[];
    plans: Plan[];
    dispatches: Dispatch[];
    approvals: Approval[];
    audit: AuditEntry[];
    /**
     * 待回答的提问（I-36 A）：含正文与选项，`needsUiAnswer=true` 表示管家代答通道够不着，
     * 只能到界面回答。面板用它显式提示，避免「卡着但没人知道」。
     */
    pendingQuestions?: PendingQuestionRecord[];
    /**
     * 还没送达的提醒（I-34 补）：落盘队列里按目标管家分组的积压。
     * 存在的意义是「既没送达也要看得见」——UI 用它提示「有 N 条通知没送到」。
     */
    pendingNotices?: Array<{
        targetButlerId: string;
        count: number;
        /** 目标管家是否还在（false = 没人认领，正在等改投或等它回来）。 */
        targetAlive: boolean;
        /** 通知来源的工作区，改投时用来判断是否同项目。 */
        projectKey?: string;
        /** 最早一条的摘要，便于辨认是什么通知。 */
        sample?: string;
    }>;
    /**
     * 「一件件活」（P2）。只给面板看：状态、参与会话、未结束派发/卡点数。
     * `thread.enabled=false` 时为空数组，老客户端忽略这个字段也不影响。
     */
    threads?: Array<Thread & {
        openDispatches: number;
        openBlockers: number;
    }>;
    /**
     * 自动决策的准确率台账（P1）。每条规则给 n / tp / fp / fn / Wilson 下界 / 当前模式，
     * 面板「明细」页直接渲染。没有它，shadow 攒的证据就没人看得到。
     */
    policyStats?: PolicyStatsView;
}
/** 单条规则的准确率视图（面板用）。 */
export interface PolicyStatsView {
    generatedAt: number;
    windowDays: number;
    /** 标注口径与判定标准，面板上要写清楚，避免口径变黑盒。 */
    standard: 'self_heal' | 'strict';
    minSamples: number;
    rules: Array<{
        ruleId: string;
        label: string;
        group: string;
        fpBasis: string;
        n: number;
        tp: number;
        fp: number;
        fn: number;
        unknown: number;
        precision: number;
        precisionLB: number;
        mode: 'act' | 'shadow';
        reason: string;
        lastAt: number;
    }>;
}
/** 已处理卡点的只读视图，供对话里的提醒卡片回显「已处理」。 */
export interface ResolvedBlockerView {
    id: string;
    kind: BlockerKind;
    status: BlockerStatus;
    sessionId: string;
    summary: string;
    resolution?: string;
    resolvedAt?: number;
}
/** 提醒卡片上的一个可点动作。 */
export type ButlerNoticeVerb = 'approve' | 'reject' | 'answer' | 'dismiss' | 'retry' | 'dispatch_completed' | 'dispatch_failed'
/** 只读展开：把计划正文拉到卡片里看（I-33）。 */
 | 'open_plan' | 'open_session';
export interface ButlerNoticeAction {
    verb: ButlerNoticeVerb;
    label: string;
    style?: 'primary' | 'danger' | 'plain';
    /** 需要用户在行内 textarea 里填文本（回答 / 提修改意见 / 驳回原因）。 */
    requiresText?: boolean;
    placeholder?: string;
}
/**
 * 一条提醒的结构化内容。
 *
 * 写进 `user/message` 的 source 里，客户端只读它就能渲染整张卡；
 * 消息 content 仍保留原来的纯文本，管家模型看到的东西不变。
 */
/** 进度通知的生命周期：open（可见）→ resolved（被新进展取代）/ expired（超时）。 */
export type NoticeStatus = 'open' | 'resolved' | 'expired';
/**
 * 已发出的进度通知的持久化记录。
 *
 * 这是「实时可见」的载体：事件发生时立刻落盘，`snapshot.progressNotices` 读它，
 * 客户端 2 秒轮询就能看到——不再依赖用户先说话触发的 inject。
 */
export interface ProgressNoticeRecord {
    id: string;
    at: number;
    sessionId: string;
    sessionTitle?: string;
    /** 会话来源（dsh/claude/codex），卡片上打徽标。 */
    source?: SourceKind;
    /** 事件类型：milestone / stage_end / blocker_resolved / watchdog。 */
    kind: string;
    category: 'milestone' | 'dispatch';
    severity: 'info' | 'warning' | 'critical';
    title: string;
    detail?: string;
    dispatchId?: string;
    /** 去重签名（与 dispatch.progress.notified 同一套）。 */
    signatures: string[];
    status: NoticeStatus;
    expiresAt: number;
}
export interface ButlerNotice {
    id: string;
    at: number;
    /** blocker=卡点提醒，progress=进度/里程碑，summary=离线汇总。 */
    kind: 'blocker' | 'progress' | 'summary';
    category: BlockerKind | 'dispatch' | 'restart' | 'milestone';
    severity: 'info' | 'warning' | 'critical';
    sessionId?: string;
    sessionTitle?: string;
    /** 这条提醒属于哪个来源（缺省 dsh）；面板/卡片用它打来源徽标。 */
    source?: SourceKind;
    /** 卡片标题，例如「repo-a · 等审批」。 */
    title: string;
    /** 证据摘要 / 计划标题 / 新完成的条目。 */
    detail?: string;
    neededAction?: string;
    blockerId?: string;
    planId?: string;
    approvalId?: string;
    dispatchId?: string;
    callId?: string;
    /** ask_user 的候选项标签；有就直接给按钮。 */
    options?: string[];
    /** 进度通知的生命周期状态（仅 progress 类有）。 */
    status?: NoticeStatus;
    /** 过期时间（毫秒时间戳，仅 progress 类有）。 */
    expiresAt?: number;
    actions: ButlerNoticeAction[];
}
/**
 * 提醒消息的 source。
 *
 * - `kind` 让 chat 不再把它当成用户自己发的消息（走 context 行）。
 * - `form:'notice'` + `summary` 让 dsh 原生在没有本插件时也能降级成一行 notice。
 * - `notice` 是本插件客户端渲染卡片的数据来源。
 */
export interface ButlerNoticeSource {
    kind: 'superagent-notice';
    form: 'notice';
    /**
     * 只给模型看的注入，不在对话里渲染成卡片（进度类走这条）：
     * 进度已经有面板载体，再渲一次会让用户看到两遍（幂等要求）。
     */
    modelOnly?: boolean;
    summary: string;
    notice: ButlerNotice;
}
/** 注入提醒时给 service 的入参。 */
export interface ButlerNoticePayload {
    text: string;
    source?: ButlerNoticeSource;
    /** 派发这条任务的管家；缺省时广播给所有管家。 */
    butlerSessionId?: string;
}
export interface RouteCandidate {
    sessionId: string;
    title: string;
    projectKey: string;
    hardStatus: HardStatus;
    lastActivityAt: number;
    queuedCount: number;
    softStatus?: SoftStatus;
    recentUserMessages: string[];
    openDispatch?: {
        id: string;
        text: string;
    };
    openBlockerKinds: BlockerKind[];
}
export type RouteDecision = {
    kind: 'status_query';
    query?: string;
} | {
    kind: 'reuse';
    sessionId: string;
    reason: string;
    delivery?: 'queue' | 'wake';
} | {
    kind: 'new';
    projectKey: string;
    cwd: string;
    reason: string;
    relatedSessionIds?: string[];
} | {
    kind: 'clarify';
    reason: 'workspace_ambiguous' | 'workspace_missing' | 'target_ambiguous';
    candidateIds?: string[];
};
export interface ToolIntent {
    toolName: string;
    callId?: string;
    argsSummary: string;
    risk: Risk;
    gated: boolean;
    policy: 'plan' | 'whitelist';
    planId?: string;
    planItemId?: string;
    deny?: boolean;
    reason?: string;
    review?: 'readonly' | 'danger';
    flags?: string[];
}
export interface DispatchReceipt {
    dispatchId: string;
    sessionId: string;
    status: DispatchStatus;
    delivery: 'queue' | 'wake';
    reason: string;
}
export interface ResolveResult {
    ok: boolean;
    action: string;
    blockerId?: string;
    message: string;
}
/** 单个外部来源的配置（二期 P1 只用到 claude，codex 复用同一形状）。 */
export interface ClaudeSourceConfig {
    /** 默认 false：不开就不读这个目录，隐私优先。 */
    enabled: boolean;
    /** 数据根目录，默认 `~/.claude`（测试时指向 fixture）。 */
    home?: string;
    /** 只扫最近这么多天有更新的会话文件。 */
    scanDays: number;
    /** 单次扫描最多处理的会话文件数（防止历史堆积拖慢）。 */
    maxSessions: number;
    /** 读文件尾部这么多字节来拿标题/cwd/最后事件，不读全文。 */
    tailBytes: number;
    /** 是否把 <root>/subagents/*.jsonl 也列出来（标记为非 root）。 */
    includeSubagents: boolean;
    /** 是否用 fs.watch 触发缓存失效；关掉则只靠定时扫描。 */
    watch: boolean;
}
export interface Config {
    butler: {
        title: string;
        model?: string;
        cwd?: string;
    };
    routingWindowDays: number;
    routingMaxCandidates: number;
    topicRecentMessages: number;
    approvalRemindAfterMs: number;
    answerRemindAfterMs: number;
    repeatFailureThreshold: number;
    repeatWindowMs: number;
    repeatToolCallThreshold: number;
    editThrashThreshold: number;
    editThrashWindowMs: number;
    runningStallMs: number;
    idleStallMs: number;
    reminderCooldownMs: number;
    maxRemindersPerBlocker: number;
    statusTtlMs: number;
    statusRefreshLimit: number;
    recoveryScanDays: number;
    scanIntervalMs: number;
    dispatchRetryLimit: number;
    planReview: {
        allowReadOnlyBash: boolean;
    };
    auditAllLowRisk: boolean;
    /**
     * 策略引擎（P1）：让自动决策带可观测的准确率，跌破阈值就自动退回「只记录」。
     * 整段关掉 = 回到今天的语义（所有规则照常执行）。
     */
    /**
     * 建议销账（I-28 第 1 层）：活看起来干完时发一条提醒让人点一下。
     * 不擅自销账；用户忽略后在这段时间内不再重复出现。
     */
    settleSuggest: {
        enabled: boolean;
        /** 同一 dispatch 被忽略后，多久内不再提。 */
        cooldownMs: number;
    };
    /**
     * 销账 TTL 兜底（I-28 第 3 层）。**默认关闭**：自动销账会解除 plan gate，
     * 只在「确认无待审计划 + 长时间无活动」时才允许，且默认不启用。
     */
    settleTtl: {
        enabled: boolean;
        minutes: number;
    };
    /**
     * 卡点真唤醒（I-32 部分）：只有「确实需要人」的卡点才起 turn 叫管家，
     * 其余类型仍走 inject（不唤醒）。
     */
    blockerWake: {
        enabled: boolean;
        /** 允许真唤醒的卡点类型。 */
        kinds: string[];
        /** 同一派发最多唤醒几次。 */
        maxPerDispatch: number;
        /** 同一派发两次唤醒的最小间隔。 */
        minGapMs: number;
    };
    /**
     * MCP 工具（I-31）：同 server 同方法在本会话内批过一次后，后续同类调用不再逐次问。
     * 默认开；关掉就恢复「每次都要批」。
     */
    mcp: {
        batchApprove: boolean;
    };
    /** Thread 聚合（P2）。关掉 = 销账回到按 dispatch、卡点不随活归档。 */
    thread: {
        enabled: boolean;
        /** 活闲置这么久（毫秒）没有活动且无待审计划 → 自动标 abandoned。 */
        idleAbandonMs: number;
    };
    policy: {
        enabled: boolean;
        /** 首发只记录不动作的规则（攒证据）；证明自己够准后会被自动晋升。 */
        shadowRules: string[];
        /** 样本不足不下结论（Wilson 下界在小样本上没有意义）。 */
        minSamples: number;
        /** 下界跌破它 → 降级为 shadow（自动退休）。 */
        demoteBelow: number;
        /** 下界升破它 → 从 shadow 晋升为 act（自动放行）。 */
        promoteAbove: number;
        /** 统计与标注的时间窗（天）。 */
        windowDays: number;
        /** 标注口径。 */
        standard: 'self_heal' | 'strict';
        /** 标注任务的执行间隔。 */
        labelIntervalMs: number;
    };
    progress: {
        notifyMilestones: boolean;
        /** running → idle 且仍有 open dispatch 时报「阶段结束」。 */
        notifyStageEnd: boolean;
        /** 卡点自动消失时报一条通知（卡点新增仍走现有 blocker 提醒）。 */
        notifyBlockerResolved: boolean;
        /** 同一 dispatch 两次「里程碑」进度之间的最小间隔。 */
        minGapMs: number;
        /** 进度通知持久化队列上限（最近的在前）。 */
        queueLimit: number;
        /** 进度通知存活时间，超时从快照里消失。 */
        ttlMs: number;
        /** 唤醒管家（B-1 §5）；默认开，但被类型/签名/配额/节流四道闸夹住。 */
        wake: {
            enabled: boolean;
            minGapMs: number;
            /** 只有这些事件类型会唤醒（纯里程碑不唤醒）。 */
            kinds: string[];
            maxPerDispatch: number;
        };
    };
    /** 按任务复杂度的巡检默认值（dispatch.watchdog 缺省时按文本粗估）。 */
    watchdog: {
        enabled: boolean;
        defaultPollMinutes: number;
        minMinutes: number;
        maxMinutes: number;
    };
    /** 规则判不了的 bash 交给管家模型审查，没风险就放行（`bash-review.ts`）。 */
    /** 外部只读来源（二期）。默认全部关闭，显式开启才扫描。 */
    sources: {
        claude: ClaudeSourceConfig;
        codex: ClaudeSourceConfig;
    };
    bashReview: {
        enabled: boolean;
    };
}
export declare const DEFAULT_CONFIG: Config;
export declare const READ_ONLY_TOOLS: Set<string>;
export declare const MUTATING_TOOLS: Set<string>;
