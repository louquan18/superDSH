/** 自愈窗口：提醒发出后这么久之内自己好了，就当它本来没事。 */
const SELF_HEAL_WINDOW_MS = 15 * 60_000;
/** 「被拒命令随后被人工批准」的匹配窗口。 */
const DENY_WINDOW_MS = 10 * 60_000;
function isHumanAction(audit) {
    return audit.by === 'user' || audit.by === 'butler-chat';
}
/**
 * 标注一批决策。只处理**还没有 outcome** 的审计；已判过的不重复判
 * （幂等：定时跑多少次结果都一样）。
 */
export function labelDecisions(ctx) {
    const updates = [];
    // 按时间排序，便于做「之后发生了什么」的窗口查询
    const audits = [...ctx.audits].sort((a, b) => a.at - b.at);
    const blockers = new Map(ctx.blockers.map((blocker) => [blocker.id, blocker]));
    const dispatches = new Map(ctx.dispatches.map((dispatch) => [dispatch.id, dispatch]));
    for (const audit of audits) {
        if (!audit.ruleId)
            continue;
        if (audit.outcome && audit.outcome !== 'unknown')
            continue;
        let verdict;
        switch (audit.ruleId) {
            case 'watchdog_stall':
                verdict = labelWatchdog(audit, audits, ctx);
                break;
            case 'blocker_repeat_failure':
            case 'blocker_edit_thrash':
                verdict = labelBlocker(audit, blockers, ctx);
                break;
            case 'bash_deny':
                verdict = labelBashDeny(audit, audits);
                break;
            case 'dispatch_route':
                verdict = labelDispatch(audit, dispatches);
                break;
            default:
                break;
        }
        if (verdict) {
            updates.push({
                auditId: audit.id,
                outcome: verdict.outcome,
                outcomeRule: verdict.rule,
                outcomeAt: ctx.now,
            });
        }
    }
    return updates;
}
/** L1：提醒之后 worker 自己又产出了真实进度，且期间没人动手 → 这条提醒是白喊的。 */
function labelWatchdog(audit, audits, ctx) {
    if (ctx.standard === 'strict')
        return undefined;
    const dispatchId = audit.dispatchId;
    if (!dispatchId)
        return undefined;
    const from = audit.at;
    const to = audit.at + SELF_HEAL_WINDOW_MS;
    // 真实进度：里程碑 / 阶段结束 / 卡点消失（watchdog 自己不算）
    const resumed = ctx.notices
        .filter((notice) => notice.dispatchId === dispatchId &&
        notice.at > from &&
        notice.at <= to &&
        notice.kind !== 'watchdog')
        .sort((a, b) => a.at - b.at)[0];
    if (!resumed)
        return undefined;
    // 期间有人工动作 → 不能算自愈（是被人推醒的）
    const human = audits.some((item) => item.at > from && item.at <= resumed.at && isHumanAction(item) && item.sessionId === audit.sessionId);
    if (human)
        return undefined;
    return { outcome: 'fp', rule: 'L1-watchdog-self-heal' };
}
/** L2：卡点没人管、条件自己消失 → 这条卡点是噪音。 */
function labelBlocker(audit, blockers, ctx) {
    const blocker = audit.blockerId ? blockers.get(audit.blockerId) : undefined;
    if (!blocker)
        return undefined;
    // 人工处理过 → 这条卡点确实需要人（判对）
    if (blocker.status === 'resolved' && blocker.resolution !== '条件已消失') {
        return { outcome: 'tp', rule: 'L2-human-resolved' };
    }
    if (blocker.status !== 'auto_resolved')
        return undefined;
    // 严格口径：自动消失不算数（可能是 worker 自己绕过去了）
    if (ctx.standard === 'strict')
        return undefined;
    const resolvedAt = blocker.resolvedAt ?? 0;
    if (resolvedAt > 0 && resolvedAt - audit.at <= SELF_HEAL_WINDOW_MS) {
        return { outcome: 'fp', rule: 'L2-blocker-self-heal' };
    }
    return undefined;
}
/** L3：被拒的命令随后被人工批准 → 我们判得太严（漏报方向，记 fn）。 */
function labelBashDeny(audit, audits) {
    const command = normalizeCommand(audit.argsSummary);
    if (!command)
        return undefined;
    const approved = audits.some((item) => item.at > audit.at &&
        item.at - audit.at <= DENY_WINDOW_MS &&
        item.kind === 'approval' &&
        item.action === 'user_approved' &&
        normalizeCommand(item.argsSummary) === command);
    return approved ? { outcome: 'fn', rule: 'L3-deny-then-approved' } : undefined;
}
/** L4：派发随后被 superseded → 这次路由指向的活不再需要了，记误报。 */
function labelDispatch(audit, dispatches) {
    const dispatch = audit.dispatchId ? dispatches.get(audit.dispatchId) : undefined;
    if (!dispatch)
        return undefined;
    if (dispatch.status === 'superseded')
        return { outcome: 'fp', rule: 'L4-dispatch-superseded' };
    if (dispatch.status === 'completed')
        return { outcome: 'tp', rule: 'L4-dispatch-completed' };
    return undefined;
}
/** 命令归一：去掉首尾空白、压掉连续空白，避免因为空格差异匹配不上。 */
function normalizeCommand(text) {
    if (typeof text !== 'string')
        return '';
    return text.trim().replace(/\s+/g, ' ');
}
