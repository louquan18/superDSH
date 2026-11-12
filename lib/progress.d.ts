/**
 * 进度事件检测（A）+ 按复杂度巡检（B）的纯逻辑。
 *
 * 这里不碰 ctx / store / inject：输入是「一次扫描看到的事实 + 持久化游标」，
 * 输出是「该推哪些 progress」。service.ts 只负责把结果接进现有提醒链路，
 * 所以去重、节流、阈值判定都能直接单测。
 */
import type { Config, Dispatch, DispatchProgressCursor, DispatchWatchdog, SoftStatus } from './types.js';
/** 游标里最多保留多少条已推签名。 */
export declare const NOTIFIED_LIMIT = 50;
export type ProgressEventKind = 'milestone' | 'stage_end' | 'blocker_resolved' | 'watchdog';
export interface ProgressEvent {
    kind: ProgressEventKind;
    /** 这条事件要落进游标的签名；第一个是判重用的主签名。 */
    signatures: string[];
    /** 卡片标签用的分类：里程碑 / 派发相关。 */
    category: 'milestone' | 'dispatch';
    title: string;
    detail?: string;
    /** 是否算「真实进展」。watchdog 不算，否则它会刷新自己的计时。 */
    real: boolean;
}
export interface ResolvedBlockerRef {
    signature: string;
    summary: string;
}
export interface DetectProgressInput {
    /** 会话标题，用来拼卡片标题。 */
    title: string;
    dispatch: Dispatch;
    soft?: SoftStatus;
    running: boolean;
    /**
     * 最近一次**会话活动**（事件时间，不是 `report_status`）。
     * watchdog 用它和 `lastProgressAt` 取较新者：worker 闷头干活但没上报时不算停滞。
     */
    lastActivityAt?: number;
    /** 本次扫描里刚刚消失的卡点。 */
    resolved?: ResolvedBlockerRef[];
    /** 最近一次 turn 结束（runtime.lastTurnEnd）。 */
    lastTurnEnd?: {
        at: number;
        kind: string;
    };
    /**
     * 会话硬状态（I-19）：`awaiting_approval` / `awaiting_answer` 期间人是瓶颈，
     * 会话本来就是静的，不能算「没进展」。
     */
    hardStatus?: string;
    config: Config;
    now: number;
}
export declare function milestoneSignature(item: string): string;
export declare function blockerResolvedSignature(signature: string): string;
export declare function stageEndSignature(cursor: DispatchProgressCursor): string;
/**
 * watchdog 签名带上「安静期的起点」，这样：
 * - 同一个安静期只问一次（15s 扫描不会刷屏）；
 * - 中间有了真实进展或会话活动，起点变化，下一段安静期可以再问；
 * - 一直没动静拖到 3 倍 poll 时，再问最后一次。
 *
 * `anchor` 是 `lastProgressAt` 与 `lastActivityAt` 的较新者（见 detectProgress 的 B 段）。
 */
export declare function watchdogSignature(anchor: number, elapsedMs: number, pollMs: number): string;
export declare function isNotified(cursor: DispatchProgressCursor | undefined, signature: string): boolean;
export declare function isOpenDispatch(dispatch: Dispatch): boolean;
/** 新建派发时的初始游标：lastRunning 先记成 false，「第一次 running」不会被当成阶段结束。 */
export declare function initialCursor(now: number): DispatchProgressCursor;
/**
 * 算这次扫描该推哪些 progress。
 *
 * 没有任何事件时返回空数组；调用方仍要推进游标（lastRunning / lastDoneCount），
 * 否则「一次都没 running 过就 idle」和「running → idle」分不开。
 */
export declare function detectProgress(input: DetectProgressInput): ProgressEvent[];
export interface AdvanceCursorInput {
    cursor?: DispatchProgressCursor;
    events: ProgressEvent[];
    running: boolean;
    doneCount: number;
    now: number;
    /** 最近一次 turn 结束时间（写进游标，避免同一次 turn 结束重复报阶段结束）。 */
    lastTurnEndAt?: number;
    /** 这次扫描看到 worker 上报了状态：即使没事件可发，也算一次进展。 */
    activity?: boolean;
}
/** 推进游标（纯函数，返回新对象）。service 只负责把它写回 dispatch。 */
export declare function advanceCursor(input: AdvanceCursorInput): DispatchProgressCursor;
/** 老派发第一次被扫描时播种：把当前已有的 done 记成已报，避免升级后补报历史。 */
export declare function seedCursor(now: number, soft: SoftStatus | undefined, running: boolean): DispatchProgressCursor;
/**
 * 新派发创建时的游标种子：把目标会话**当前已有**的 done 记成「已通知」。
 *
 * 派发记录新建时游标是空的，而目标会话常常还带着上一轮任务的 softStatus.done；
 * 不播种的话，第一次扫描会把历史里程碑当成这次任务的新进展补报一遍
 * （2026-11-09 的真实事故：新派发 dsp_b32e20ef848049d0 立刻补报上一轮的 5 项）。
 * 播种之后新增的 done 不在 notified 里，仍然照常推送。
 *
 * lastRunning / lastTurnEndAt 沿用 {@link initialCursor} 的语义：
 * 第一次 running 不算阶段结束，创建之前的 turn 结束也不算。
 */
export declare function seedDispatchCursor(now: number, done: readonly string[] | undefined): DispatchProgressCursor;
/**
 * 按任务文本粗估巡检频率。
 *
 * 只读/看一下 → 10 分钟就问；重构/实现/全量测试 → 30 分钟再问。
 * poll 取 expected 的一半，夹在 min/max 之间。
 */
export declare function estimateWatchdog(text: string, limits: Config['watchdog']): DispatchWatchdog;
/**
 * 合并「管家显式填的 watchdog」和「按文本粗估」。
 *
 * 管家只填 expectedMinutes 时 poll 取一半；什么都没填就整条走粗估。
 */
export declare function resolveWatchdog(raw: any, text: string, limits: Config['watchdog']): DispatchWatchdog | undefined;
export interface WakeInput {
    /** 总开关；false 时完全静默。 */
    enabled: boolean;
    /** 只对这些事件类型唤醒（默认 stage_end / watchdog；纯里程碑不唤醒）。 */
    kinds: readonly string[];
    /** 同一条 dispatch 最多唤醒几次。 */
    maxPerDispatch: number;
    /** 两次唤醒之间的最小间隔（全局）。 */
    minGapMs: number;
    events: readonly ProgressEvent[];
    /** 这条 dispatch 已经唤醒过的签名。 */
    woke: readonly string[];
    /** 这条 dispatch 已经唤醒的次数。 */
    wakeCount: number;
    /** 上一次唤醒的时间（全局，0 表示从没唤过）。 */
    lastWakeAt: number;
    /** 管家当前是不是正在跑一个 turn（跑着就不唤醒，否则等于排队烧 token）。 */
    butlerRunning: boolean;
    now: number;
}
export type WakeDecision = {
    wake: false;
    reason: string;
} | {
    wake: true;
    signature: string;
    kind: string;
    title: string;
};
/**
 * 要不要因为这次进度事件唤醒管家。
 *
 * 防自激靠四道闸，任何一道不满足都不唤醒：
 * 1. **类型闸**：只有 `kinds` 里的类型（默认 stage_end / watchdog）才唤醒——纯里程碑绝不唤醒；
 * 2. **签名闸**：同一 dispatch 同一签名只唤醒一次（落盘在 `dispatch.progress.woke`）；
 * 3. **配额闸**：同一 dispatch 最多 `maxPerDispatch` 次；
 * 4. **节流闸**：两次唤醒至少间隔 `minGapMs`，且管家正在跑的时候不唤醒。
 *
 * 之所以是**有界**的：唤醒会让管家进入 running，于是闸 4 天然挡住并发唤醒；
 * 每次唤醒都消耗配额，配额用完这条 dispatch 再也不会唤醒；而唤醒后管家要么推动、
 * 要么结束派发，派发一旦收尾就不再产生进度事件（evaluateProgress 里 isOpenDispatch 早退）。
 */
export declare function decideWake(input: WakeInput): WakeDecision;
