import type { Plan, Risk } from './types.js';
export interface RiskContext {
    projectRoot: string;
    cwd?: string;
    gated: boolean;
    policy: 'plan' | 'whitelist';
    plan?: Plan;
    allowReadOnlyBash?: boolean;
}
export interface RiskResult {
    risk: Risk;
    planId?: string;
    planItemId?: string;
    deny?: boolean;
    reason?: string;
    /**
     * 规则判不了的 bash，交给管家模型审查（`bash-review.ts`）：
     * `readonly` 只在命令只读时放行（计划审查、计划还没批准），
     * `danger` 只拦真正危险的命令（其余情况）。sandbox 升级不设这个字段，始终转用户。
     */
    review?: 'readonly' | 'danger';
    /** 命中的危险关键词，交给审查模型重点核对；不再直接转用户。 */
    flags?: string[];
}
/**
 * §7.3：带 `sandbox_permissions` 的调用是在申请更宽的沙箱权限（bash、write/edit 都有这个参数），
 * 即使基础操作是低风险/计划内，也按 high 处理；门禁本身的 deny 保持不变。
 */
export declare function classifyTool(toolName: string, args: any, ctx: RiskContext): RiskResult;
export declare function isMutating(toolName: string): boolean;
export declare function isReadOnly(toolName: string): boolean;
