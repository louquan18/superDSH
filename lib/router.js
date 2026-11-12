export function buildCandidates(input) {
    const cutoff = input.now - input.windowDays * 24 * 60 * 60_000;
    return input.sessions
        .filter((session) => session.projectKey === input.projectKey)
        .filter((session) => !session.isButler)
        .filter((session) => session.isRoot)
        .filter((session) => !session.archived)
        .filter((session) => !session.blank)
        .filter((session) => session.lastActivityAt >= cutoff ||
        session.running ||
        Boolean(session.openDispatch))
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
        .slice(0, Math.max(1, input.maxCandidates))
        .map((session) => ({
        sessionId: session.sessionId,
        title: session.title,
        projectKey: session.projectKey ?? input.projectKey,
        hardStatus: session.hardStatus,
        lastActivityAt: session.lastActivityAt,
        queuedCount: session.queueCount,
        softStatus: session.softStatus,
        recentUserMessages: input.topicRecentMessages > 0
            ? session.recentUserMessages.slice(-input.topicRecentMessages)
            : [],
        openDispatch: session.openDispatch,
        openBlockerKinds: session.openBlockerKinds,
    }));
}
export function validateDecision(input) {
    const decision = input.decision;
    if (decision.kind === 'status_query' || decision.kind === 'clarify')
        return { ok: true };
    if (decision.kind === 'reuse') {
        const target = input.sessions.find((session) => session.sessionId === decision.sessionId);
        if (!target)
            return { ok: false, reason: '目标 session 不存在' };
        if (target.isButler)
            return { ok: false, reason: '不能把任务派给管家自己' };
        if (!target.isRoot)
            return { ok: false, reason: '只能派给 root session' };
        if (target.archived)
            return { ok: false, reason: '目标 session 已归档' };
        if (target.projectKey !== input.projectKey) {
            return { ok: false, reason: '目标 session 不属于当前项目' };
        }
        const explicit = new Set(input.explicitTargets ?? []);
        const inCandidates = input.candidates.some((candidate) => candidate.sessionId === decision.sessionId);
        if (!inCandidates && !explicit.has(decision.sessionId)) {
            return { ok: false, reason: '目标不在本次候选集中；请重新选或问用户' };
        }
        return { ok: true, target };
    }
    if (decision.kind === 'new') {
        if (!decision.cwd || typeof decision.cwd !== 'string') {
            return { ok: false, reason: 'new 决策缺少 cwd' };
        }
        if (!decision.projectKey)
            return { ok: false, reason: 'new 决策缺少 projectKey' };
        if (decision.projectKey !== input.projectKey) {
            return { ok: false, reason: 'new 决策的 projectKey 与当前项目不一致' };
        }
        return { ok: true };
    }
    return { ok: false, reason: '未知决策' };
}
export function deliveryFor(status) {
    return status === 'running' || status === 'awaiting_approval' || status === 'awaiting_answer'
        ? 'queue'
        : 'wake';
}
export function parseExplicitTarget(text, sessions) {
    const idMatch = /(?:^|\s)[@#]([A-Za-z0-9_-]{6,})/.exec(text);
    if (idMatch) {
        const id = idMatch[1];
        return sessions.find((session) => session.sessionId === id)?.sessionId;
    }
    const at = /(?:^|\s)@([^\s@#]{1,80})/.exec(text);
    if (!at)
        return undefined;
    const needle = at[1].toLowerCase();
    const matches = sessions.filter((session) => session.title.toLowerCase().includes(needle));
    return matches.length === 1 ? matches[0].sessionId : undefined;
}
export function parseExplicitPath(text) {
    const absolute = /(?:^|\s)(\/[^\s"'`]+|~\/[^\s"'`]+)/.exec(text);
    if (absolute)
        return absolute[1];
    const relative = /(?:^|\s)(\.\.?\/[^\s"'`]+)/.exec(text);
    return relative?.[1];
}
export function parseWorkspaceMention(text, workspaces) {
    const lower = text.toLowerCase();
    const matches = workspaces
        .filter((workspace) => {
        const title = workspace.title.toLowerCase();
        const path = workspace.cwd.toLowerCase();
        return lower.includes(title) || lower.includes(path);
    })
        .sort((a, b) => b.cwd.length - a.cwd.length);
    return matches[0] ? { key: matches[0].key, cwd: matches[0].cwd } : undefined;
}
export function projectModeAtDispatch(mode, fallback = 'plan_review') {
    return mode ?? fallback;
}
