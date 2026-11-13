import type { Dispatch, Plan, PlanScopeItem, Project } from './types.js';
export declare function scopeItems(plan: Plan | undefined): PlanScopeItem[];
export interface PlanMatch {
    item: PlanScopeItem;
    score: number;
}
/**
 * 把计划 scope 里的一条路径规则归一化成「相对 projectRoot」的 glob（I-35）。
 *
 * 历史原因，worker 提交的 scope 常常是**绝对路径**（`/Users/.../src/main/...`），
 * 而匹配时目标被转成了相对路径 `src/main/...`。直接拿绝对 pattern 去 glob 相对字符串
 * 恒不命中，于是「计划内的文件」被判成「计划外写操作」。
 *
 * 规则：绝对路径先 `toRelative` 到项目根；落在项目根外（`..` 开头）的规则直接忽略，
 * 因为它本来就不该匹配本项目内的文件。相对规则原样保留。
 */
export declare function scopePatternToRelative(projectRoot: string, pattern: string): string | undefined;
export declare function matchPlanPath(plan: Plan | undefined, projectRoot: string, targetPath: string): PlanMatch | undefined;
/**
 * 命中失败时的可解释信息（I-35 的 (b)）：
 * 把「目标相对路径」和「计划里实际声明了哪些规则」一起给出来，
 * 而不是只留一句「计划外写操作」让人无从判断。
 */
export declare function explainPlanMiss(plan: Plan | undefined, projectRoot: string, targetPath: string): {
    relPath: string;
    patterns: string[];
};
export declare function matchPlanCommand(plan: Plan | undefined, command: string): PlanMatch | undefined;
export declare function matchPlanNetwork(plan: Plan | undefined): PlanMatch | undefined;
export declare function scopeHash(plan: Plan): string;
export declare function planSummary(plan: Plan): string;
/**
 * 这条派发要不要计划审查。
 *
 * **只看派发时的模式和项目当前模式，不看派发状态**：派发因为上一轮报错变成
 * `error` / `failed`，不代表这个任务不需要审计划——那正是「方案交了没人看」的根因。
 */
export declare function planRequiredFor(dispatch: Dispatch, project: Project | undefined): boolean;
/** 方案摘要：一行正文 + 范围统计，给管家在对话里直接看。 */
export declare function planExcerpt(plan: Plan, max?: number): string;
