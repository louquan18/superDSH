import path from 'node:path';
import { firstLine, hash, isInside, matchGlob, toRelative, truncate } from './util.js';
export function scopeItems(plan) {
    return Array.isArray(plan?.scope?.items) ? plan.scope.items : [];
}
function matchPath(item, relPath) {
    return (item.paths ?? []).some((pattern) => matchGlob(pattern, relPath));
}
function matchCommand(item, command) {
    return (item.commands ?? []).some((pattern) => {
        if (pattern.endsWith('*'))
            return command.startsWith(pattern.slice(0, -1));
        return command === pattern;
    });
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
export function scopePatternToRelative(projectRoot, pattern) {
    const raw = String(pattern ?? '').trim();
    if (!raw)
        return undefined;
    if (!path.isAbsolute(raw))
        return normGlob(raw);
    const rel = toRelative(projectRoot, raw);
    if (!rel || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel))
        return undefined;
    return normGlob(rel);
}
/** 去掉 `./` 前缀、统一分隔符，避免同一规则因为写法不同而漏匹配。 */
function normGlob(pattern) {
    const unified = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
    return unified === '.' ? '' : unified;
}
export function matchPlanPath(plan, projectRoot, targetPath) {
    if (!plan)
        return undefined;
    const absolute = path.isAbsolute(targetPath)
        ? targetPath
        : path.resolve(projectRoot, targetPath);
    if (!isInside(projectRoot, absolute))
        return undefined;
    const rel = toRelative(projectRoot, absolute);
    let best;
    for (const item of scopeItems(plan)) {
        for (const pattern of item.paths ?? []) {
            // I-35：先把 scope 规则归一化到相对路径，再和目标比。
            const normalized = scopePatternToRelative(projectRoot, pattern);
            if (!normalized)
                continue;
            if (!matchGlob(normalized, rel))
                continue;
            const score = normalized.replace(/\*/g, '').length;
            if (!best || score > best.score)
                best = { item, score };
        }
    }
    return best;
}
/**
 * 命中失败时的可解释信息（I-35 的 (b)）：
 * 把「目标相对路径」和「计划里实际声明了哪些规则」一起给出来，
 * 而不是只留一句「计划外写操作」让人无从判断。
 */
export function explainPlanMiss(plan, projectRoot, targetPath) {
    const absolute = path.isAbsolute(targetPath)
        ? targetPath
        : path.resolve(projectRoot, targetPath);
    const relPath = toRelative(projectRoot, absolute);
    const patterns = [];
    for (const item of scopeItems(plan)) {
        for (const pattern of item.paths ?? []) {
            const normalized = scopePatternToRelative(projectRoot, pattern);
            patterns.push(normalized ? `${pattern}${normalized !== pattern ? ` → ${normalized}` : ''}` : `${pattern}（项目外，已忽略）`);
        }
    }
    return { relPath, patterns };
}
export function matchPlanCommand(plan, command) {
    if (!plan)
        return undefined;
    let best;
    for (const item of scopeItems(plan)) {
        for (const pattern of item.commands ?? []) {
            const matches = pattern.endsWith('*')
                ? command.startsWith(pattern.slice(0, -1))
                : command === pattern;
            if (!matches)
                continue;
            const score = pattern.replace(/\*/g, '').length;
            if (!best || score > best.score)
                best = { item, score };
        }
    }
    return best;
}
export function matchPlanNetwork(plan) {
    if (!plan)
        return undefined;
    const item = scopeItems(plan).find((candidate) => candidate.network === true);
    return item ? { item, score: 1 } : undefined;
}
export function scopeHash(plan) {
    return hash(JSON.stringify(plan.scope ?? { items: [] }));
}
export function planSummary(plan) {
    const items = scopeItems(plan);
    const paths = items.flatMap((item) => item.paths ?? []).length;
    const commands = items.flatMap((item) => item.commands ?? []).length;
    return `${items.length} 个计划条目，${paths} 条路径，${commands} 条命令`;
}
/**
 * 这条派发要不要计划审查。
 *
 * **只看派发时的模式和项目当前模式，不看派发状态**：派发因为上一轮报错变成
 * `error` / `failed`，不代表这个任务不需要审计划——那正是「方案交了没人看」的根因。
 */
export function planRequiredFor(dispatch, project) {
    return (dispatch.modeAtDispatch === 'plan_review' &&
        (project?.mode ?? 'plan_review') === 'plan_review');
}
/** 方案摘要：一行正文 + 范围统计，给管家在对话里直接看。 */
export function planExcerpt(plan, max = 240) {
    const body = firstLine(String(plan.markdown ?? ''), max);
    return `${planSummary(plan)}｜${truncate(body, max)}`;
}
