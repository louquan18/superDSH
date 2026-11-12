/**
 * 策略引擎：决定一条自动决策「该不该真的执行」，以及它当前处在快路径还是慢路径。
 *
 * 背景（开发计划 §4）：固化下来的规则会腐烂 —— 它快到不需要解释，也就没人再检查它。
 * 所以规则必须带**可观测的准确率**，准确率跌破阈值就自动退回只记录（shadow），
 * 恢复到高位再自动放行。这是对「Fast Path 会腐烂」的直接应答。
 */
import type { AuditEntry, Config } from './types.js';
export type PolicyMode = 'act' | 'shadow';
export interface RuleMeta {
    id: string;
    label: string;
    /** 决策大类，面板分组用。 */
    group: 'watchdog' | 'blocker' | 'bash' | 'dispatch';
    /** 首发是否默认只记录不动作（新规则一律先进 shadow 攒证据）。 */
    defaultShadow: boolean;
    /** 一句话说明「判成误报」的依据，面板上直接展示，避免口径变成黑盒。 */
    fpBasis: string;
}
/**
 * 规则清单。`id` 是审计记录里的 `ruleId`，一旦发布不要改名（改历史就断代了）。
 */
export declare const RULES: RuleMeta[];
export declare const RULE_IDS: string[];
export declare function ruleMeta(id: string): RuleMeta | undefined;
export interface RuleStat {
    ruleId: string;
    /** 已判定样本数（tp + fp + fn）。 */
    n: number;
    tp: number;
    fp: number;
    fn: number;
    /** 未判定（规则不适用或证据不足）。 */
    unknown: number;
    /** tp / (tp + fp)；没有判定样本时为 0。 */
    precision: number;
    /** Wilson 95% 下界：小样本时自动压低，避免"3 次全对"就当成可靠的规则。 */
    precisionLB: number;
    lastAt: number;
}
/**
 * Wilson score 区间下界。
 *
 * 为什么不用直接命中率：watchdog 到现在只醒过 14 次，3 次误报就是 79% 命中率，
 * 但这在三五个样本上没有统计意义。下界让"样本不足"自然表现为低分，
 * 配合 minSamples 门槛，避免凭感觉撤规则（I-12 就是这么误改的）。
 */
export declare function wilsonLower(successes: number, n: number, z?: number): number;
/** 从审计记录汇总每条规则的准确率。窗口外的、没 ruleId 的、没判定的都不计入 n。 */
export declare function computeStats(audits: AuditEntry[], windowDays: number, at?: number): RuleStat[];
export interface PolicyDecision {
    mode: PolicyMode;
    /** 判定依据，写进审计便于复盘（不参与逻辑）。 */
    reason: string;
}
/**
 * 双向迁移：
 * - 不在 shadow 名单：样本够且下界跌破 `demoteBelow` → 降级为 shadow（自动退休）；
 * - 在 shadow 名单：样本够且下界升破 `promoteAbove` → 晋升为 act（自动放行）；
 * - 样本不足：保持各自默认（名单内的仍 shadow，名单外的照常 act）。
 */
export declare function decidePolicy(ruleId: string, stat: RuleStat | undefined, config: Config['policy']): PolicyDecision;
