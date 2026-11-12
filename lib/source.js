import { randomUUID } from 'node:crypto';
import { extractText, firstLine, truncate } from './util.js';
import { DSH_CAPABILITIES, } from './sources/types.js';
/**
 * dsh 本机 session 的 SessionSource 实现。
 * 这一层只做「读/建/发/队列」的薄封装；状态推导在 status.ts，业务在 service.ts。
 */
export class DshSource {
    options;
    kind = 'dsh';
    capabilities = DSH_CAPABILITIES;
    constructor(options) {
        this.options = options;
    }
    get ctx() {
        return this.options.ctx;
    }
    signal() {
        return new AbortController().signal;
    }
    async list() {
        const controller = this.ctx.sessionController;
        const query = this.ctx.sessionQuery;
        const [listValue, records] = await Promise.all([
            controller.list({}, this.signal()),
            query.listSessions(this.signal()),
        ]);
        const summaries = new Map();
        for (const item of listValue?.items ?? [])
            summaries.set(String(item.sessionId), item);
        const ids = new Set();
        for (const item of listValue?.items ?? [])
            ids.add(String(item.sessionId));
        for (const record of records ?? [])
            ids.add(String(record.header?.id ?? ''));
        const titleMap = new Map();
        try {
            const titles = await query.readTitleSnapshots([...ids], this.signal());
            for (const result of titles ?? []) {
                if (result?.status !== 'fulfilled')
                    continue;
                const title = result.value?.title?.title ??
                    result.value?.title?.text ??
                    result.value?.title?.snapshot?.title;
                if (title)
                    titleMap.set(String(result.sessionId), String(title));
            }
        }
        catch {
            // title is display-only; a failed batch must not break routing
        }
        const out = [];
        for (const id of ids) {
            const summary = summaries.get(id);
            const record = (records ?? []).find((item) => String(item.header?.id) === id);
            const header = record?.header ?? summary;
            if (!header)
                continue;
            const cwd = header.cwd ?? summary?.cwd;
            out.push({
                sessionId: id,
                source: 'dsh',
                title: titleMap.get(id) ?? (cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : `Session ${id.slice(0, 8)}`),
                cwd,
                agentPreset: header.agentPreset,
                parentSessionId: header.parentSession ?? summary?.parentSessionId,
                origin: header.origin ?? summary?.origin,
                live: Boolean(record?.live ?? summary?.agentAvailable),
                persisted: Boolean(record?.persisted ?? true),
                blank: Boolean(summary?.blank),
                running: Boolean(summary?.running),
                agentAvailable: Boolean(summary?.agentAvailable),
                updatedAt: Number(summary?.updatedAt ?? header.createdAt ?? Date.now()),
            });
        }
        return out.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    async observe(sessionId) {
        const query = this.ctx.sessionQuery;
        try {
            if (typeof query.observeSession === 'function') {
                const observation = await query.observeSession(sessionId, { projectionMode: 'all' });
                return observation;
            }
        }
        catch {
            // fall through to readSession
        }
        try {
            return await query.readSession(sessionId);
        }
        catch {
            return undefined;
        }
    }
    async readEvents(sessionId) {
        const observed = await this.observe(sessionId);
        return Array.isArray(observed?.events) ? observed.events : [];
    }
    async readDigest(sessionId, limit = 8) {
        const observed = await this.observe(sessionId);
        if (!observed)
            return undefined;
        const events = Array.isArray(observed.events) ? observed.events : [];
        let lastActivityAt = 0;
        let lastTurnOpen = false;
        let lastTurnEndKind;
        let softStatus;
        const messages = [];
        for (const event of events) {
            lastActivityAt = Math.max(lastActivityAt, Number(event.time ?? 0));
            if (event.type === 'turn/start')
                lastTurnOpen = true;
            if (event.type === 'turn/end') {
                lastTurnOpen = false;
                lastTurnEndKind = event.data?.reason?.kind;
            }
            if (event.type === 'user/message') {
                const text = extractText(event.data?.content);
                if (text)
                    messages.push(`user: ${text}`);
            }
            if (event.type === 'assistant/message') {
                const text = extractText(event.data?.message?.content);
                if (text)
                    messages.push(`assistant: ${text}`);
            }
        }
        const session = observed.session ?? observed.header;
        return {
            sessionId,
            title: String(session?.title ?? session?.cwd ?? sessionId),
            events,
            softStatus,
            lastTurnOpen,
            lastTurnEndKind,
            lastActivityAt,
        };
    }
    async readUserMessages(sessionId, limit) {
        const events = await this.readEvents(sessionId);
        const out = [];
        for (const event of events) {
            if (event.type !== 'user/message')
                continue;
            const text = extractText(event.data?.content);
            if (!text)
                continue;
            if (String(event.data?.source?.kind ?? '') !== 'user')
                continue;
            out.push(truncate(text, 500));
        }
        return out.slice(-limit);
    }
    async create(cwd, agentPreset) {
        const value = await this.ctx.sessionController.create({ cwd, agentPreset });
        return String(value.sessionId);
    }
    async prompt(sessionId, text, requestId) {
        await this.ctx.sessionController.prompt({
            requestId,
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text }],
        }, this.signal());
    }
    async rename(sessionId, title) {
        try {
            await this.ctx.sessionController.rename({ sessionId, title: truncate(title, 80) });
        }
        catch {
            // naming is nonessential
        }
    }
    async cancel(sessionId) {
        try {
            await this.ctx.sessionController.cancel({ sessionId });
        }
        catch {
            // best effort
        }
    }
    async findQueuedMessage(sessionId, requestId) {
        const observed = await this.observe(sessionId);
        const inbox = observed?.projections?.values?.inbox;
        if (!inbox)
            return undefined;
        const lists = [inbox['next-turn'], inbox['next-step']];
        for (const list of lists) {
            if (!Array.isArray(list))
                continue;
            for (const message of list) {
                if (String(message?.source?.rpcId ?? '') === requestId && message?.id) {
                    return { id: String(message.id), text: extractText(message.content) };
                }
            }
        }
        return undefined;
    }
    async removeQueued(sessionId, itemId) {
        try {
            await this.ctx.sessionController.updateQueue({
                sessionId,
                itemId,
                action: { kind: 'remove' },
            });
            return true;
        }
        catch {
            return false;
        }
    }
    async findDelivered(sessionId, requestId) {
        const events = await this.readEvents(sessionId);
        return events.some((event) => event.type === 'user/message' &&
            String(event.data?.source?.rpcId ?? '') === requestId);
    }
    newRequestId() {
        return randomUUID();
    }
}
export function digestText(digest, max = 1200) {
    if (!digest)
        return '';
    const lines = [];
    lines.push(`标题：${digest.title}`);
    const events = digest.events ?? [];
    const relevant = events
        .filter((event) => event.type === 'user/message' || event.type === 'assistant/message')
        .slice(-8);
    for (const event of relevant) {
        const text = event.type === 'user/message'
            ? extractText(event.data?.content)
            : extractText(event.data?.message?.content);
        if (!text)
            continue;
        lines.push(`${event.type === 'user/message' ? '用户' : '助手'}：${firstLine(text, 200)}`);
    }
    return truncate(lines.join('\n'), max);
}
