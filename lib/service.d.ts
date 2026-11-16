import { DshSource, type SourceSessionLite } from './source.js';
import { SourceRegistry } from './sources/registry.js';
import { type SourceCapabilities, type SourceKind } from './sources/types.js';
import { Store } from './store.js';
import { type VersionInfo } from './version.js';
import { type SessionRuntime } from './status.js';
import type { ButlerNoticePayload, Config, HardStatus, Project, RouteDecision, Snapshot } from './types.js';
export declare const WORKER_PROMPT = "You are a worker managed by the SuperAgent butler. The butler is a read-only router; it does not do the work. Report your state at the start, at major milestones, before ending a turn, when blocked, and when you need a user decision, using butler_report_status. Keep the report short and factual.\n\nIf you are working on a task dispatched by the butler (marked \u3010\u7BA1\u5BB6\u6D3E\u53D1\u3011) and the project is in plan-review mode, do not edit files or run mutating commands before your plan for this task is approved. Call butler_submit_plan with a complete plan and a structured scope (paths/commands). Then end the turn and wait. The host enforces this: a mutating tool call without an approved plan is denied. Do not try to bypass a denial; submit a plan or ask the butler.\n\nIf this project is in gate-confirm mode, proceed directly. High-risk or out-of-plan operations will be held for the user; low-risk operations may be approved automatically.";
export declare class SuperagentService {
    readonly ctx: any;
    readonly config: Config;
    readonly store: Store;
    readonly source: DshSource;
    /** 多来源注册表；P0 只注册 dsh，P1 起按配置注册 claude。 */
    readonly sources: SourceRegistry;
    /** P0 版本戳：本次运行的代码版本与配置指纹。 */
    readonly version: VersionInfo;
    private claude?;
    private codex?;
    private meta;
    private butlerId;
    private runtimes;
    /** P1：规则准确率的缓存（30s），避免每条决策都全量扫审计。 */
    private statsCache;
    private lastLabelAt;
    private runtimeLoadedAt;
    private installed;
    private intents;
    private approvalWaiters;
    private questionWaiters;
    private nativePlanQuestions;
    /** 管家不在线时暂存的提醒，按管家 sessionId 分；`*` 是还没有任何管家时的公共队列。 */
    private pendingButlerNotices;
    private hub;
    private timers;
    private evaluateTimers;
    private emitTimer;
    private disposed;
    private sessionsCache;
    private lastSnapshotAt;
    private progressTimers;
    private progressPending;
    private progressTarget;
    private progressLastAt;
    private progressKeys;
    private planStartNotified;
    /** 每条 dispatch 已唤醒管家的次数（与落盘的 woke 签名一起构成有界唤醒）。 */
    private wakeCounts;
    /** 全局上一次唤醒时间，用于 minGapMs 节流。 */
    private lastWakeAt;
    /** 卡点真唤醒的节流时间（按 dispatch / blocker），进程内即可：签名本身已落盘去重。 */
    private lastBlockerWakeAt;
    /**
     * 唤醒后「必须开口」的监测（I-37）：唤醒时登记，管家 turn 结束时检查这一轮有没有
     * 产生过用户可见的助手消息；没有就写 `wake_silent` 审计（可查、可统计）。
     */
    private wakeWatch;
    /**
     * 落盘写入串行化：多次 `persistWakeWatch()` 并发时，旧快照不能盖掉新快照
     * （否则盘上可能永远停在 `spoke:false`，让对账把「已开口」误记成缺陷）。
     */
    private wakeWatchWrite;
    private bashReviewer;
    /** 本进程内看到的 `agent-preset/selected`：会话在第一轮前切换 preset 时，header 不会更新。 */
    private selectedPresets;
    /** 每个来源的健康状态：来宾源坏掉只影响它自己，核心永远可用。 */
    private sourceHealth;
    private constructor();
    static create(ctx: any, rawConfig: any): Promise<SuperagentService>;
    private init;
    dispose(): void;
    private registerEvents;
    private installExistingAgents;
    private handleAgentCreated;
    private handleAgentStatus;
    private handleSessionEvent;
    private createRuntime;
    private scheduleEvaluate;
    ensureRuntime(id: string, force?: boolean): Promise<SessionRuntime>;
    private liveInfo;
    hardStatusFor(id: string): HardStatus;
    private agentOf;
    private isButlerAgent;
    /**
     * 会话当前的 preset。先建普通会话、第一轮前再切到管家时，session header 仍是旧 preset，
     * 所以以 preset 注册表记录的最新选择为准，读不到再退回 header。
     */
    private presetOf;
    /** 会话切换 preset：切到管家就卸掉 worker 注入并当管家；切走就按 worker 安装。 */
    private handlePresetSelected;
    private isRootAgent;
    private installWorker;
    private currentProjectForSession;
    private defaultCwd;
    private workspaceList;
    ensureProjectForCwd(cwd: string): Project;
    listSessions(force?: boolean): Promise<SourceSessionLite[]>;
    /** 外部来源有变化：清缓存并让面板刷新（不出提醒，只更新列表）。 */
    invalidateSources(): void;
    /**
     * 注册一个来宾来源（claude / codex）。
     *
     * 构造、`start()`、首次 `list()` 都可能因为外部数据格式/权限出问题；任何一步失败都只把
     * 这个来源标成不可用并记下原因，**不允许冒泡到 init()** —— 否则 `provide('superagent')`
     * 不会执行，管家 preset 挂不上，整个管家的工具全没了（2026-11-09 的 P0 就是这么炸的）。
     */
    private registerGuestSource;
    /** 来源健康状态（快照里给面板看，不静默）。 */
    sourceStatus(): Array<{
        kind: SourceKind;
        enabled: boolean;
        available: boolean;
        error?: string;
        at: number;
    }>;
    private markSourceHealth;
    /** 某个会话属于哪个来源；缺省 dsh（旧记录兼容）。 */
    sourceKindOf(sessionId: string): SourceKind;
    /** 某个会话所属来源的能力表。 */
    capabilitiesOf(sessionId: string): SourceCapabilities;
    ensureButler(): Promise<string>;
    get butlerSessionId(): string | null;
    isButlerSessionId(id: string): boolean;
    /**
     * 管家判定：既认本服务创建的那个管家会话，也认任何以 superagent-butler 预设启动的会话。
     * butler_* 工具与只读护栏都用这一处，避免两处判定不一致。
     */
    isButlerAgentSession(agent: any): boolean;
    /**
     * 列表行的管家判定，依次看：本进程看到的 preset 切换、live agent 的当前 preset、
     * 已登记的管家标记（重启后冷 session 靠它）、session header。
     */
    private isButlerSessionRow;
    noteReport(agent: any, args: any): Promise<any>;
    sendToButler(text: string): Promise<{
        sessionId: string;
        accepted: boolean;
    }>;
    /** 所有已知的管家会话：默认管家 + 以管家 preset 运行或登记过的会话。 */
    private butlerSessionIds;
    /**
     * 给管家发提醒（inject，不唤醒）。`butlerSessionId` 是任务的派发者：只发给它；
     * 没有派发者、或派发者已不存在，就广播给所有管家。
     *
     * 传字符串时行为与旧版一致（纯文本提醒）；传 payload 时可以带上结构化 source，
     * 客户端据此把这条消息渲染成一张可点按钮的卡片。
     */
    /**
     * 选择提醒/唤醒的目标管家（I-37）。
     *
     * 顺序：派发者（且在线）→ 当前活跃管家（且在线）→ 任一在线管家 → 都不在线。
     * 与 I-34 的「离线队列改投」不同：这里是**实时投递**，必须在投递前就选对目标，
     * 不能等下一次 flush。
     */
    private resolveButlerTarget;
    /** 从会话 id 取它所属工作区（通知来源用）。 */
    private noticeProjectKeyForSession;
    injectButlerNotice(payload: ButlerNoticePayload | string, butlerSessionId?: string): Promise<{
        delivered: boolean;
        queued: boolean;
        targets: number;
    }>;
    private queueButlerNotice;
    /** 把内存队列整份写进存储（meta.pendingNotices）。失败只记日志，不影响主链路。 */
    private persistPendingNotices;
    /** 启动时从存储重建未读队列（I-34）。 */
    private restorePendingNotices;
    /** 通知来源的工作区（从 notice.sessionId → managed session.projectKey 取，不新造字段）。 */
    private noticeProjectKey;
    /** 某个管家会话的工作区。 */
    private butlerProjectKey;
    private injectMessage;
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
    private pendingNoticesView;
    /** 快照里的待答提问（I-36 A）：带正文与选项，needsUiAnswer 明确标出。 */
    private pendingQuestionsView;
    private flushButlerNotices;
    /** §6.4：只对管家派发的任务推进度，手动 session 只更新面板。 */
    private noteProgress;
    /** 新开一条活。标题取派发首行，参与者先放目标会话。 */
    private openThreadForDispatch;
    /** 沿用已有活：补上派发与会话。 */
    private attachDispatchToThread;
    /**
     * I-28 第 1 层：判断某条派发是不是「看起来干完了但没人收尾」。
     *
     * 证据优先级：dispatch.suspectDoneAt（事实）→ cursor.stageEnds（阶段结束过）。
     * 返回一条 `settle_suggest` 卡点，交给现有提醒通道渲染成可点卡片。
     */
    private settleSuggestBlocker;
    /**
     * 派发收尾后重算活的状态。
     *
     * 注意：**不做自动销账**。没有进行中的派发就停在 `waiting_human`，等人（或管家）确认，
     * 因为销账会取消待审计划并解除 plan gate，自动做风险太大。
     */
    private settleThread;
    /** 管家工具 `butler_thread action=list` 的返回：只看还有意义的活。 */
    listThreadsView(): any;
    /** 销账（或放弃）一条活：状态落定 + 名下卡点随之归档。 */
    closeThread(threadId: string, state: 'done' | 'abandoned', by?: 'user' | 'butler' | 'auto_ttl'): Promise<any>;
    private completeDispatch;
    private noteTurnEnd;
    /**
     * 同一 session 的进度提醒 60 秒合并一次，避免刷屏。
     *
     * `urgent` 用于「任务完成 / 失败」这类关键事件：不等合并，立刻发出去。
     */
    private queueProgress;
    /** 造一条进度/里程碑提醒（无阻塞动作，最多带一个「打开会话」）。 */
    private progressNotice;
    private flushProgress;
    /**
     * worker 上报后：把这次上报算成「有进展」，并把 done 签名落进持久化游标，
     * 让扫描路径（evaluateProgress）不会把同一批里程碑再报一遍。
     */
    private markReported;
    /**
     * 扫描态进度检测（A1 里程碑 / A2 阶段结束 / A3 卡点消失 / B watchdog）。
     *
     * progress 是通知：不进 blocker、不进待办条、不需要用户点按钮。
     * 只对管家派发的任务推送（§6.4）；手动 session 的软状态变化仍然只刷新面板。
     */
    private evaluateProgress;
    /**
     * 快照里可见的进度通知：只留 open 且没过期的，并借这次读把过期项标成 expired 落盘。
     *
     * 与 `blockerNotices` 完全分开：这里绝不返回 blocker，也绝不进待办条。
     */
    private visibleProgressNotices;
    /** 把这一批进度事件写进持久化队列（快照 progressNotices 的来源）。 */
    private recordProgressNotices;
    /**
     * B-1 §5：有界唤醒管家。
     *
     * 有界性论证见 `decideWake`：类型闸 + 签名闸 + 每 dispatch 配额 + 全局节流 + 管家忙时不唤醒。
     * 额外保证：**先落盘 woke 签名与计数，再发 prompt**——即使 prompt 失败也不会重试成二次唤醒。
     */
    private maybeWakeButler;
    private evaluateSession;
    private syncBlockers;
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
    private shouldWakeForBlocker;
    /** 先落盘签名，再发送：签名在，就不会因为发送失败而陷入「醒了没成功→下一轮再醒」的环。 */
    private recordBlockerWake;
    /** 内存态监测的落盘形态。 */
    private snapshotWakeWatch;
    /**
     * 把内存里的开口监测整份落盘（I-37 2A）。
     * 写入串行化，避免旧快照覆盖新快照；返回的 promise 可 await 以确认「已落盘」。
     */
    private persistWakeWatch;
    /**
     * `turn/end` 结算（I-37 2A）：**先写审计、再清落盘记录**。
     *
     * 顺序不能反：若先清记录再写审计，正好在这两步之间重启，就变成「记录没了、缺陷也没记」——
     * 那正是本任务要堵的静默漏账。现在即使在这里挂掉，记录还在盘上，启动对账会补记
     * （`reconcileWakeWatch` 幂等，审计已写过就只清记录，不会重复记）。
     * 审计本身写失败时不删记录，留给下次启动再补。
     */
    private settleWakeWatch;
    /**
     * 启动对账（I-37 2A）：把「唤醒过但没看到开口」的记录补记成 `wake_silent`。
     *
     * 语义说明（不假装精确）：重启后**无法确知**上一轮有没有开口——
     * 能用的信号是会话事件里有没有该时间的 `assistant/message`。能读到就按实际判定；
     * 读不到（来源不支持 / 读取失败）就**宁可补记**，并在 note 里写明是重启补记，
     * 避免「只查不说」因为一次重启就彻底漏账。
     *
     * 幂等：`turn/end` 结算可能「审计已写、记录未清」就被重启，这里用
     * (会话, 卡点, 时间) 查重，避免同一条静默被记两次。
     */
    private reconcileWakeWatch;
    /** 会真正起 turn 的投递（与 inject 相对）。返回是否送出去。 */
    private wakeSession;
    private maybeRemind;
    /**
     * 提醒记账（两条路径共用）：唤醒成功与注入/入队都算「这一轮提醒发出去了」。
     * 只有「既没唤醒也没注入、连队列都没进」才不记账（由调用方提前 return）。
     */
    private finishReminderAccounting;
    /** 卡点提醒归属于哪条规则；不可迁移的硬卡点（审批/提问/计划/决策）不参与策略引擎。 */
    private reminderRuleFor;
    /** 规则命中率（30s 缓存）：每条决策都全量扫审计太浪费。 */
    private ruleStats;
    private policyFor;
    /**
     * 跑一轮决策标注（P1）。
     *
     * 只回填还没有 outcome 的审计；标注失败绝不影响主链路（门禁、提醒照常）。
     */
    private runLabeling;
    /** 面板用的准确率视图：规则元信息 + 统计 + 当前模式，一次给全。 */
    private policyStatsView;
    private intentFor;
    private riskContext;
    /**
     * §4.4：派发时与当前都是计划审查，这个 dispatch 才要求计划。
     * 项目取 dispatch 自己的 workspaceKey：新开的 session 还没进 store，不能按 session 反查。
     */
    private planRequired;
    /** §7.3：没有进行中的管家派发 = 手动 session，审批完全交给原生流程。 */
    private hasActiveDispatch;
    private classify;
    /**
     * 规则判不了的 bash 交给管家模型看一眼：没风险就放行并写审计；有风险或审查失败返回 false，
     * 由调用方按原流程拒绝 / 转用户。只在管家派发的任务里调用。
     */
    private reviewBash;
    /**
     * `job_kill` 的归属判定：只有「本会话启动的 job」免审批。
     *
     * 宿主 `ctx.jobs.get(id, caller)` 自带 owner 围栏——别人的或不存在 job 会抛错，
     * 所以这里不需要自己维护 job→session 表。拿不到 job registry 时返回否定结论：
     * 读不到归属就要求审批，绝不把「未知」当成「属于本会话」。
     */
    private jobKillVerdict;
    /** 本会话是否已经批准过同一 MCP 工具（同 server 同方法）。 */
    private mcpAlreadyApproved;
    private gate;
    private answerApproval;
    private holdApproval;
    decideApproval(approvalId: string, decision: 'allow' | 'deny', by?: 'user' | 'butler-chat', note?: string): Promise<{
        ok: boolean;
        message: string;
    }>;
    private finishApproval;
    /** 收到提问就落盘（I-36 A）：重启后据此知道「有这么个提问没答」。 */
    private rememberPendingQuestion;
    /** 已答/已取消：从落盘记录里摘掉。 */
    private forgetPendingQuestion;
    /**
     * 标记「只能到界面回答」（I-36 A）。
     *
     * 触发：本进程不持有该提问句柄（重启后 / 非本进程发起），宿主 answer() 又拒绝。
     * 效果：落盘记录标 needsUiAnswer，对应卡点写进 evidence 并改 neededAction，
     * 面板/明细页可见——绝不静默。
     */
    private markQuestionNeedsUiAnswer;
    private answerQuestion;
    answerQuestionByCall(callId: string, answer: any, by?: 'user' | 'butler-chat'): Promise<{
        ok: boolean;
        message: string;
        reason?: string;
    }>;
    private resolveAgentFor;
    private resolveBlockersBy;
    submitPlan(agent: any, args: any): Promise<any>;
    /**
     * R2：不需要审查的方案也要落盘。
     *
     * 之前 not_required 直接返回，方案正文只存在于工具参数里——工具调用一过就没了。
     * 现在写进 plans 表（status=skipped），并给派发方发一条带 planId 的通知。
     */
    private recordSkippedPlan;
    reviewPlan(planId: string, decision: 'approve' | 'changes' | 'reject', feedback: string | undefined, by?: 'user' | 'butler-chat'): Promise<{
        ok: boolean;
        message: string;
    }>;
    setMode(projectKey: string, mode: 'plan_review' | 'gate_confirm'): Promise<any>;
    dispatchCandidates(text: string, workspaceKey?: string, cwd?: string): Promise<any>;
    private resolveProjectForText;
    /**
     * I-29：把常见的字段误用归一化（`mode`→`kind`、`targetSessionId`→`sessionId`），
     * 但**不放松校验**——归一之后仍然只接受 kind 语义。
     * 报错必须能自我纠正：带上实际收到的键名和最小可用示例。
     */
    private normalizeDecision;
    dispatchExecute(decision: RouteDecision, text: string, fromButlerSessionId?: string, watchdog?: any): Promise<any>;
    private startDispatch;
    sendToSession(sessionId: string, text: string): Promise<void>;
    /**
     * 设计 §4.2 的「用户标记完成」：把一条进行中的派发收尾。
     *
     * 只允许 accepted/delivered；结束时同步做四件事——写审计、关掉这条派发的待审计划、
     * 解除计划门禁（门禁只看 currentDispatch，状态一变就失效）、失败时告诉 worker 别干了。
     */
    markDispatch(dispatchId: string, outcome: string, note?: string, by?: 'user' | 'butler-chat' | 'butler-auto' | 'system'): Promise<any>;
    reassign(dispatchId: string, targetSessionId: string): Promise<any>;
    /**
     * 把一条文本转发给 worker 会话，并如实返回有没有送到。
     *
     * `sendToSession` 是 best-effort（吞掉错误），答复类动作不能静默失败——用户点了「回答」
     * 却什么也没发生，比不给按钮更糟。
     */
    private forwardToSession;
    /**
     * 决策被用户回答后，从已存的软状态里摘掉它。
     *
     * 否则下一次扫描会按同一条 `decisions` 重新生成一个一模一样的卡点，
     * 用户会看到「刚答完又冒出来」。
     */
    private consumeDecision;
    resolveBlocker(blockerId: string, action: 'approve' | 'reject' | 'answer' | 'dismiss' | 'retry' | 'resolve', text?: string, by?: 'user' | 'butler-chat'): Promise<any>;
    queuedCount(sessionId: string): number;
    openBlockerKinds(sessionId: string): any[];
    /** 运行期自检：面板/CLI 用来确认门禁和 worker 工具真的挂到了真实 agent 上。 */
    diagnostics(): any;
    snapshot(): Promise<Snapshot>;
    handleAction(action: string, payload?: any): Promise<any>;
    subscribe(listener: () => void): () => void;
    private queueEmit;
    private emit;
    private startTimers;
    private scan;
    private recover;
}
/**
 * 把管家的一句话回答，转成宿主 `ask_user_question` 认识的**结构化应答批次**。
 *
 * 关键点（I-36）：`answer` 的 `id` 必须是**问题自己的 id**（模型靠它对应问题），
 * 以前写死成 `id:'answer'` 会让模型看到一个对不上号的答复。
 * 另外：文本正好等于某个选项标签时放进 `selected`（模型和 UI 都更好处理），
 * 否则放进 `custom`；多问题时只答第一个，其余显式留空（宿主语义 = 跳过）。
 */
export declare function answerForQuestions(questions: Array<{
    id?: unknown;
    options?: Array<{
        label?: unknown;
    }>;
}> | undefined, text: string): any;
