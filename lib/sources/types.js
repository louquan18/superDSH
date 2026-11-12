/** 运行时可见的全部来源，按展示顺序排列（dsh 永远在前）。 */
export const SOURCE_KINDS = ['dsh', 'claude', 'codex', 'remote'];
/**
 * 把一个来路不明的值归一化成 {@link SourceKind}。
 *
 * - `'ducc'` / `'claude-code'` → `'claude'`（文档别名）
 * - 大小写与空白不敏感
 * - 空值或未知值 → `undefined`（调用方用 {@link sourceOf} 兜底成 `'dsh'`）
 */
export function normalizeSourceKind(value) {
    if (typeof value !== 'string')
        return undefined;
    const kind = value.trim().toLowerCase();
    if (kind === 'dsh')
        return 'dsh';
    if (kind === 'claude' || kind === 'ducc' || kind === 'claude-code')
        return 'claude';
    if (kind === 'codex')
        return 'codex';
    if (kind === 'remote')
        return 'remote';
    return undefined;
}
/**
 * 读一条记录的来源：缺字段一律按 `'dsh'` 解释（P0 不做数据迁移）。
 *
 * 旧的 dispatch/blocker/plan/audit 记录没有 `source`，行为必须与引入字段前完全一致。
 */
export function sourceOf(record) {
    return normalizeSourceKind(record?.source) ?? 'dsh';
}
/** dsh 本机会话：全能力。 */
export const DSH_CAPABILITIES = Object.freeze({
    list: true,
    readEvents: true,
    readDigest: true,
    subscribe: true,
    create: true,
    resume: true,
    queue: true,
    cancel: true,
    approvals: true,
    questions: true,
    plans: true,
    hardStatus: true,
    softStatusTool: true,
    reassign: true,
    send: true,
});
/**
 * 只读旁路（Claude Code / Codex 的基线）。
 *
 * §9.4：外部来源只开 list/readEvents/readDigest/subscribe；create/resume/send/queue/cancel/
 * approvals/questions/plans 全部 false。具体来源可以在此基础上再关掉 subscribe 或 hardStatus。
 */
export const READ_ONLY_CAPABILITIES = Object.freeze({
    list: true,
    readEvents: true,
    readDigest: true,
    subscribe: false,
    create: false,
    resume: false,
    queue: false,
    cancel: false,
    approvals: false,
    questions: false,
    plans: false,
    hardStatus: false,
    softStatusTool: false,
    reassign: false,
    send: false,
});
/** 覆盖若干能力位，生成某个来源的能力表。 */
export function withCapabilities(base, overrides) {
    return Object.freeze({ ...base, ...overrides });
}
/** 判断一个能力位是否可用（给调用点用，避免各处手写 `=== true`）。 */
export function supports(source, capability) {
    return source?.capabilities?.[capability] === true;
}
