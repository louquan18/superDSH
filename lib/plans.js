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
            if (!matchGlob(pattern, rel))
                continue;
            const score = pattern.replace(/\*/g, '').length;
            if (!best || score > best.score)
                best = { item, score };
        }
    }
    return best;
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
