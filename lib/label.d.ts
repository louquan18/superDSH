/**
 * 决策标注：事后判断一条自动决策是「判对了」还是「误报」。
 *
 * 铁律：**只用确定性信号，绝不调模型**。用同一种可能出错的智能去评估自己，
 * 得到的数字只会让人更自信，而不是更准确。
 *
 * 两种口径并存（计划 §4.3）：
 * - `self_heal`（默认）：没人管、自己好了 → 算误报。样本来得快，但会把
 *   「worker 自己绕过去的真卡点」也记成误报。
 * - `strict`：只有明确的人工动作（用户处理了卡点、用户批准了被拒命令）才算，
 *   没人工动作的一律留 `unknown`。样本少，但准。
 *
 * 无论哪种口径，**判不了的就不判**（`unknown`），不用推断凑数。
 */
import type { AuditEntry, Blocker, Dispatch, ProgressNoticeRecord } from './types.js';
export type LabelStandard = 'self_heal' | 'strict';
export type Outcome = 'tp' | 'fp' | 'fn' | 'unknown';
export interface LabelUpdate {
    auditId: string;
    outcome: Exclude<Outcome, 'unknown'>;
    /** 哪条标注规则判的，可复算、可解释。 */
    outcomeRule: string;
    outcomeAt: number;
}
export interface LabelContext {
    audits: AuditEntry[];
    blockers: Blocker[];
    dispatches: Dispatch[];
    notices: ProgressNoticeRecord[];
    now: number;
    standard: LabelStandard;
}
/**
 * 标注一批决策。只处理**还没有 outcome** 的审计；已判过的不重复判
 * （幂等：定时跑多少次结果都一样）。
 */
export declare function labelDecisions(ctx: LabelContext): LabelUpdate[];
