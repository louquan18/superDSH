import type { Approval, Blocker, BlockerKind, ButlerNotice, ButlerNoticeAction, ButlerNoticeSource, Config, Dispatch, HardStatus, Plan } from './types.js';
import type { SessionRuntime } from './status.js';
export interface DetectedBlocker {
    kind: BlockerKind;
    subkind?: 'test' | 'error' | 'edit_thrash' | 'running_stall' | 'idle_stall' | 'loop';
    severity: 'info' | 'warning' | 'critical';
    signature: string;
    summary: string;
    neededAction: string;
    evidence: any;
    relatedPlanId?: string;
    relatedApprovalId?: string;
    relatedCallId?: string;
    relatedTurn?: number;
}
export interface BlockerContext {
    sessionId: string;
    sessionTitle: string;
    runtime: SessionRuntime;
    live: {
        available: boolean;
        running: boolean;
    };
    hardStatus: HardStatus;
    currentDispatch?: Dispatch;
    /** 最近一条派发已中止（failed），用来补「任务中止但计划没审」的卡点。 */
    abortedDispatch?: Dispatch;
    pendingPlan?: Plan;
    pendingApprovals?: Approval[];
    config: Config;
    now: number;
    lastActivityAt: number;
}
/**
 * 最近一个「被打断的 ask_user_question」。
 *
 * 正常回答完会落一条成功结果；结果缺失或结果本身是错误（`TOOL_OUTCOME_UNKNOWN`、
 * turn 被重启）时问题正文就没人记得了，卡点必须把它带上，否则用户只看到「turn 被中断」。
 */
export declare function interruptedQuestion(runtime: SessionRuntime, at: number): {
    callId: string;
    questions: any[];
} | undefined;
export declare function detectBlockers(ctx: BlockerContext): DetectedBlocker[];
/** 卡片标题里的卡点中文名。 */
export declare const NOTICE_KIND_LABEL: Record<BlockerKind, string>;
/**
 * 宿主（`service.resolveBlocker`）真正能处理「回答」的卡点类型。
 *
 * 客户端按它渲染「回答」按钮：能回答的类型才给按钮，避免出现「点了没反应」的卡片。
 */
export declare const ANSWERABLE_KINDS: ReadonlySet<BlockerKind>;
/** 从 ask_user 的 evidence 里取候选项标签，最多 6 个。 */
export declare function questionOptionLabels(blocker: Blocker): string[] | undefined;
/**
 * 一个卡点该给用户哪些按钮。
 *
 * 只描述「用户能做什么」，不关心界面长什么样；客户端按 verb 落回已有的
 * `blocker_action` / `dispatch_mark` 动作。
 */
export declare function noticeActionsFor(blocker: Blocker, options?: {
    dispatchInProgress?: boolean;
}): ButlerNoticeAction[];
/** 把一个卡点变成一条可交互提醒。 */
export declare function buildBlockerNotice(blocker: Blocker, context?: {
    sessionTitle?: string;
    dispatchId?: string;
    dispatchInProgress?: boolean;
    now?: number;
}): ButlerNotice;
/** 包成写进 `user/message.source` 的形状；summary 是折叠行的一行话。 */
export declare function noticeSource(notice: ButlerNotice): ButlerNoticeSource;
