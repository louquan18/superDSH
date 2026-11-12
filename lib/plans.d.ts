import type { Dispatch, Plan, PlanScopeItem, Project } from './types.js';
export declare function scopeItems(plan: Plan | undefined): PlanScopeItem[];
export interface PlanMatch {
    item: PlanScopeItem;
    score: number;
}
export declare function matchPlanPath(plan: Plan | undefined, projectRoot: string, targetPath: string): PlanMatch | undefined;
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
