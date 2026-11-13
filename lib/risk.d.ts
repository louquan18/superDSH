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
/**
 * MCP 工具分级（I-31）。
 *
 * 工具名形如 `mcp__<server>__<method>`。宿主默认把整批 MCP 当「未知工具」，于是
 * 真机验证时每一步都弹一次审批（实测一条审批挂了 14 小时）。这里按 **server + 方法名**
 * 分级，而不是按 server 一刀切。
 *
 * 安全底线：
 * - 只把**确知只读**的方法算 `low`；
 * - `evaluate_script` 能执行任意 JS（可读写页面、可发请求），**不算只读**，仍需审批；
 * - 表里没有的方法回落到 `unknown`（要人确认），**绝不因为「是 MCP」就默认放行**。
 */
export declare function mcpParts(toolName: string): {
    server: string;
    method: string;
} | undefined;
/** 只读方法：只观察、不改state、不产生副作用。 */
export declare const MCP_READ_ONLY_METHODS: Set<string>;
/** 明确会产生副作用的方法：需要审批（不是只读，但也不是未知）。 */
export declare const MCP_MUTATING_METHODS: Set<string>;
export declare function isMutating(toolName: string): boolean;
export declare function isReadOnly(toolName: string): boolean;
