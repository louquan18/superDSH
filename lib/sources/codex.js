/**
 * Codex 只读来源（二期 P2）。
 *
 * 只读三样东西：
 * - `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`：会话事件流（只读尾部）
 * - `~/.codex/session_index.jsonl`：`{id, thread_name, updated_at}`（**不全**，只当兜底标题）
 * - `~/.codex/thread_history_1.sqlite` 的 `thread_turns`：唯一可靠的状态来源
 *
 * 已知限制（用户已确认）：Codex 没有 root / 子会话标记，本期一律按 root 处理；
 * UI 标注为已知限制，并允许用户本地把它们手动标成非 root。
 *
 * 绝不写 `~/.codex`，不碰 `ipc/ipc.sock`（app-server 私有协议）。
 */
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { READ_ONLY_CAPABILITIES, withCapabilities, } from './types.js';
import { mapLimit, parseLines, readHead, readTail, toMillis } from './jsonl.js';
import { extractText, firstLine, truncate } from '../util.js';
/**
 * 从 Codex 的 content 数组里取文本。
 *
 * Codex 的 message 块类型是 `input_text` / `output_text`，而共享的 `extractText`
 * 只认 `text`（那是 dsh/Claude 的形状）。这里做一次本地归一，不改共享函数的行为。
 */
function codexText(content) {
    if (typeof content === 'string')
        return content.trim();
    if (!Array.isArray(content))
        return '';
    return content
        .map((block) => {
        if (!block || typeof block !== 'object')
            return '';
        const type = String(block.type ?? '');
        if (type === 'input_text' || type === 'output_text' || type === 'text') {
            return String(block.text ?? '');
        }
        // reasoning / summary 之类不进正文
        return '';
    })
        .filter(Boolean)
        .join('\n')
        .trim();
}
/**
 * Codex 会把注入的上下文写成 user 消息（`<environment_context>`、`<user_instructions>`…）。
 * 这些不是用户真的说的话，不能拿来当标题或对话内容。
 */
const SYNTHETIC_TAGS = new Set([
    'environment_context',
    'user_instructions',
    'skills_instructions',
    'system',
    'developer',
    'app_context',
    'repo_context',
    'local-command-caveat',
]);
export function isSyntheticUserText(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith('<'))
        return false;
    const match = /^<\/?([a-z][a-z0-9_-]*)(\s[^>]*)?>/i.exec(trimmed);
    if (!match)
        return false;
    const tag = match[1].toLowerCase();
    // 已知的注入标签，或带下划线的伪标签（Codex 的注入格式）；
    // 普通 HTML（`<div>`）不算，避免误伤用户真的在说标签
    return SYNTHETIC_TAGS.has(tag) || tag.includes('_');
}
/** 状态里出现这些值代表"跑完了"。 */
const DONE_STATUS = new Set(['completed', 'complete', 'done', 'success']);
/** Codex 判定为"正在跑"但文件很久没动时，认为进程已经没了。 */
const STALE_RUNNING_MS = 10 * 60_000;
export class CodexSource {
    kind = 'codex';
    capabilities = withCapabilities(READ_ONLY_CAPABILITIES, {
        hardStatus: true,
    });
    config;
    home;
    sessionsDir;
    indexPath;
    stateDbPath;
    historyPath;
    now;
    onChange;
    cache = new Map();
    indexCache = null;
    turnsCache = null;
    historyCache = null;
    lastScan = null;
    /** node:sqlite 不可用时只提示一次。 */
    sqliteWarned = false;
    constructor(options) {
        this.config = options.config;
        this.home = options.config.home ?? path.join(homedir(), '.codex');
        this.sessionsDir = options.sessionsDir ?? path.join(this.home, 'sessions');
        this.indexPath = options.indexPath ?? path.join(this.home, 'session_index.jsonl');
        this.stateDbPath = options.stateDbPath ?? path.join(this.home, 'thread_history_1.sqlite');
        this.historyPath = path.join(this.home, 'history.jsonl');
        this.now = options.now ?? (() => Date.now());
        this.onChange = options.onChange;
    }
    /** Codex 没有可监听的进程表；watch 关闭，靠上层 15s 定时扫描。 */
    start() {
        // 有意为空：rollout 目录层级深、文件多，监听收益低于成本
    }
    dispose() {
        this.cache.clear();
        this.lastScan = null;
    }
    async list() {
        const files = await this.collectFiles();
        const titles = await this.indexTitles();
        const prompts = await this.historyPrompts();
        const turns = await this.turnStates();
        const metas = await mapLimit(files, 8, async (file) => this.readMeta(file.path, file.sessionId));
        const items = [];
        for (const meta of metas) {
            if (!meta)
                continue;
            if (!meta.cwd)
                continue;
            const turn = turns.get(meta.sessionId);
            const status = inferStatus({ meta, turn, now: this.now() });
            // 优先级：session_index（用户可见名）→ history.jsonl 的真实首条 prompt
            // → rollout 里首条非合成 user 消息 → 兜底
            const title = titles.get(meta.sessionId) ||
                prompts.get(meta.sessionId) ||
                meta.title ||
                `Codex ${meta.sessionId.slice(0, 8)}`;
            meta.title = title;
            items.push({
                sessionId: meta.sessionId,
                source: 'codex',
                title,
                cwd: meta.cwd,
                origin: 'codex',
                live: false,
                persisted: true,
                blank: false,
                running: status.running,
                agentAvailable: false,
                updatedAt: meta.updatedAt,
                hardStatus: status.hardStatus,
                // goal 用"最像用户第一句话"的文本：history 的真实 prompt 优先于索引里的线程名
                softStatus: softStatusFor(meta, status.hardStatus, prompts.get(meta.sessionId) ?? titles.get(meta.sessionId) ?? title),
            });
        }
        items.sort((a, b) => b.updatedAt - a.updatedAt);
        this.lastScan = { at: this.now(), items };
        return items;
    }
    async readDigest(sessionId, limit = 8) {
        const meta = await this.metaFor(sessionId);
        if (!meta)
            return undefined;
        const items = this.lastScan?.items ?? (await this.list());
        const lite = items.find((item) => item.sessionId === sessionId);
        return {
            sessionId,
            title: meta.title,
            events: meta.events.slice(-Math.max(1, limit)),
            softStatus: lite?.softStatus,
            lastTurnOpen: meta.openTurn === true,
            lastTurnEndKind: meta.lastKind,
            lastActivityAt: meta.updatedAt,
        };
    }
    async readEvents(sessionId) {
        return (await this.metaFor(sessionId))?.events ?? [];
    }
    async observe(sessionId) {
        const meta = await this.metaFor(sessionId);
        if (!meta)
            return undefined;
        const turn = (await this.turnStates()).get(sessionId);
        return {
            header: { id: sessionId, cwd: meta.cwd, createdAt: meta.lastEventAt ?? meta.updatedAt },
            events: meta.events,
            projections: { values: { workingDirectory: meta.cwd ?? null, codexTurn: turn?.status ?? null } },
        };
    }
    async readUserMessages(sessionId, limit) {
        const meta = await this.metaFor(sessionId);
        if (!meta)
            return [];
        return meta.events
            .filter((event) => event.type === 'user/message')
            .map((event) => extractText(event.data?.content))
            .filter(Boolean)
            .slice(-Math.max(1, limit));
    }
    newRequestId() {
        return `codex-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }
    // ---- 只读：写操作显式失败 ----
    async prompt() {
        throw new Error('codex 来源是只读的：不支持投递消息（capabilities.send=false）');
    }
    async create() {
        throw new Error('codex 来源是只读的：不支持新建会话（capabilities.create=false）');
    }
    async rename() { }
    async cancel() { }
    async findQueuedMessage() {
        return undefined;
    }
    async removeQueued() {
        return false;
    }
    async findDelivered() {
        return false;
    }
    // ---------------------------------------------------------------- 扫描实现
    async collectFiles() {
        const cutoff = this.now() - Math.max(1, this.config.scanDays) * 24 * 60 * 60_000;
        const found = [];
        const walk = async (dir, depth) => {
            if (depth > 4 || found.length >= this.config.maxSessions)
                return;
            let entries;
            try {
                entries = await readdir(dir, { withFileTypes: true });
            }
            catch {
                return;
            }
            for (const entry of entries) {
                if (found.length >= this.config.maxSessions)
                    return;
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await walk(full, depth + 1);
                    continue;
                }
                if (!entry.isFile() || !/^rollout-.*\.jsonl$/.test(entry.name))
                    continue;
                // rollout-<iso>-<uuid>.jsonl
                const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(entry.name);
                if (!match)
                    continue;
                found.push({ path: full, sessionId: String(match[1]) });
            }
        };
        await walk(this.sessionsDir, 0);
        const kept = [];
        for (const item of found) {
            const tail = await readTail(item.path, 1024);
            if (!tail)
                continue;
            if (tail.mtimeMs < cutoff)
                continue;
            kept.push(item);
        }
        return kept;
    }
    async readMeta(file, sessionId) {
        const tail = await readTail(file, this.config.tailBytes);
        if (!tail)
            return undefined;
        const cached = this.cache.get(file);
        if (cached && cached.size === tail.size && cached.mtimeMs === tail.mtimeMs)
            return cached.meta;
        const parsed = parseLines(tail.lines);
        let cwd;
        let title = '';
        let lastKind;
        let lastText;
        let errorText;
        let lastEventAt;
        let openTurn;
        let aborted;
        const events = [];
        for (const line of parsed.values) {
            const kind = String(line?.type ?? '');
            const at = toMillis(line?.timestamp);
            if (at !== undefined)
                lastEventAt = Math.max(lastEventAt ?? 0, at);
            const payload = line?.payload ?? {};
            if (kind === 'session_meta') {
                if (typeof payload.cwd === 'string' && payload.cwd)
                    cwd = payload.cwd;
                continue;
            }
            if (kind === 'turn_context') {
                if (typeof payload.cwd === 'string' && payload.cwd)
                    cwd = payload.cwd;
                continue;
            }
            if (kind !== 'event_msg' && kind !== 'response_item')
                continue;
            if (kind === 'event_msg') {
                const type = String(payload.type ?? '');
                if (type === 'task_started') {
                    openTurn = true;
                    aborted = false;
                    lastKind = 'user';
                }
                if (type === 'task_complete' || type === 'turn_completed') {
                    openTurn = false;
                    lastKind = 'assistant';
                }
                if (type === 'turn_aborted') {
                    openTurn = false;
                    aborted = true;
                    lastKind = 'error';
                    errorText = String(payload.reason ?? payload.message ?? 'turn aborted');
                }
                continue;
            }
            // response_item
            const payloadType = String(payload.type ?? '');
            if (payloadType !== 'message')
                continue;
            const role = String(payload.role ?? '');
            // developer/system 是注入的指令，不是对话内容
            if (role !== 'user' && role !== 'assistant')
                continue;
            const text = codexText(payload.content);
            if (!text)
                continue;
            if (role === 'user' && isSyntheticUserText(text))
                continue;
            if (role === 'user') {
                lastKind = 'user';
                lastText = text;
                if (!title)
                    title = truncate(firstLine(text, 60), 60);
                events.push({ type: 'user/message', time: at ?? 0, data: { content: [{ type: 'text', text }] } });
            }
            else {
                lastKind = 'assistant';
                lastText = text;
                events.push({
                    type: 'assistant/message',
                    time: at ?? 0,
                    data: { message: { content: [{ type: 'text', text }] } },
                });
            }
        }
        // 尾部可能没有 session_meta（大文件），读头部补 cwd
        if (!cwd) {
            const head = await readHead(file, 32 * 1024);
            if (head) {
                for (const line of parseLines(head.lines).values) {
                    const payload = line?.payload;
                    if (line?.type === 'session_meta' && typeof payload?.cwd === 'string') {
                        cwd = payload.cwd;
                        break;
                    }
                }
            }
        }
        const meta = {
            sessionId,
            title,
            cwd,
            lastKind,
            lastText,
            errorText,
            lastEventAt,
            updatedAt: Math.max(tail.mtimeMs, lastEventAt ?? 0),
            events: events.slice(-40),
            bad: parsed.bad,
            openTurn,
            aborted,
        };
        this.cache.set(file, { size: tail.size, mtimeMs: tail.mtimeMs, meta });
        return meta;
    }
    async metaFor(sessionId) {
        const files = await this.collectFiles();
        const hit = files.find((item) => item.sessionId === sessionId);
        if (!hit)
            return undefined;
        return this.readMeta(hit.path, hit.sessionId);
    }
    /** `session_index.jsonl` 的 id → thread_name（**不全**，只当兜底）。 */
    async indexTitles() {
        const titles = new Map();
        const head = await readHead(this.indexPath, 2 * 1024 * 1024);
        if (!head)
            return titles;
        if (this.indexCache && this.indexCache.mtimeMs === head.mtimeMs)
            return this.indexCache.titles;
        for (const entry of parseLines(head.lines).values) {
            const id = String(entry?.id ?? '');
            const name = String(entry?.thread_name ?? '').trim();
            if (id && name && !titles.has(id))
                titles.set(id, truncate(firstLine(name, 80), 80));
        }
        this.indexCache = { mtimeMs: head.mtimeMs, titles };
        return titles;
    }
    /** `history.jsonl`：session_id → 用户真实首条 prompt（文件很小，按 mtime 缓存）。 */
    async historyPrompts() {
        const prompts = new Map();
        const head = await readHead(this.historyPath, 2 * 1024 * 1024);
        if (!head)
            return prompts;
        if (this.historyCache && this.historyCache.mtimeMs === head.mtimeMs)
            return this.historyCache.prompts;
        for (const entry of parseLines(head.lines).values) {
            const id = String(entry?.session_id ?? '');
            const text = String(entry?.text ?? '').trim();
            if (!id || !text || prompts.has(id))
                continue;
            if (isSyntheticUserText(text))
                continue;
            prompts.set(id, truncate(firstLine(text, 80), 80));
        }
        this.historyCache = { mtimeMs: head.mtimeMs, prompts };
        return prompts;
    }
    /**
     * `thread_turns` 里每个 thread 的最新状态。
     *
     * 用 `?immutable=1` 只读打开：不会写 `~/.codex`，也不会和正在跑的 Codex 抢锁。
     * 代价是会忽略 WAL 里尚未 checkpoint 的写入 —— 由 {@link inferStatus} 用
     * rollout 的 mtime 兜底（文件很久没动就不再认为在跑）。
     */
    async turnStates() {
        const turns = new Map();
        let mtimeMs = 0;
        try {
            const tail = await readTail(this.stateDbPath, 1024);
            if (!tail)
                return turns;
            mtimeMs = tail.mtimeMs;
        }
        catch {
            return turns;
        }
        if (this.turnsCache && this.turnsCache.mtimeMs === mtimeMs)
            return this.turnsCache.turns;
        try {
            const { DatabaseSync } = await import('node:sqlite');
            const db = new DatabaseSync(`file:${this.stateDbPath}?immutable=1`);
            try {
                const rows = db
                    .prepare(`select thread_id, status, started_at, completed_at, error_json
               from thread_turns
              order by started_at desc`)
                    .all();
                for (const row of rows) {
                    const id = String(row?.thread_id ?? '');
                    if (!id || turns.has(id))
                        continue; // 只留最新一条
                    turns.set(id, {
                        status: String(row?.status ?? ''),
                        startedAt: Number(row?.started_at ?? 0) || undefined,
                        completedAt: Number(row?.completed_at ?? 0) || undefined,
                        error: row?.error_json ? truncate(String(row.error_json), 200) : undefined,
                    });
                }
            }
            finally {
                db.close();
            }
        }
        catch (error) {
            if (!this.sqliteWarned) {
                this.sqliteWarned = true;
                // node:sqlite 不可用（旧 Node）时降级为 rollout 尾部推断，不中断扫描
                void error;
            }
            return turns;
        }
        this.turnsCache = { mtimeMs, turns };
        return turns;
    }
}
/** Codex 状态判定：sqlite 优先，rollout 尾部兜底。 */
export function inferStatus(input) {
    const { meta, turn, now } = input;
    const stale = meta.updatedAt > 0 && now - meta.updatedAt > STALE_RUNNING_MS;
    const status = (turn?.status ?? '').toLowerCase();
    if (status === 'inprogress' || status === 'in_progress' || status === 'running') {
        if (turn?.completedAt)
            return { hardStatus: 'idle', running: false };
        // WAL 可能滞后：文件很久没动就不认为还在跑
        if (stale)
            return { hardStatus: 'unknown', running: false };
        return { hardStatus: 'running', running: true };
    }
    if (status === 'failed' || status === 'error')
        return { hardStatus: 'error', running: false };
    if (status === 'interrupted' || status === 'aborted')
        return { hardStatus: 'interrupted', running: false };
    if (DONE_STATUS.has(status))
        return { hardStatus: 'idle', running: false };
    // 没有 sqlite 记录：用尾部事件推断
    if (meta.aborted)
        return { hardStatus: 'interrupted', running: false };
    if (meta.lastKind === 'error')
        return { hardStatus: 'error', running: false };
    if (meta.openTurn) {
        if (stale)
            return { hardStatus: 'unknown', running: false };
        return { hardStatus: 'running', running: true };
    }
    return { hardStatus: 'idle', running: false };
}
function softStatusFor(meta, hardStatus, fallbackGoal) {
    const blockers = [];
    if (hardStatus === 'interrupted')
        blockers.push('Codex 回合被中断');
    if (hardStatus === 'error' && meta.errorText)
        blockers.push(truncate(meta.errorText, 160));
    const goal = fallbackGoal ?? truncate(firstLine(meta.lastText ?? '', 80), 80);
    if (!goal && blockers.length === 0)
        return undefined;
    return {
        goal,
        done: [],
        next: [],
        blockers,
        decisions: [],
        reportedAt: meta.updatedAt,
        source: 'log-digest',
    };
}
