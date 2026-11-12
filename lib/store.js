import { now, shortId } from './util.js';
/** per-record 键只允许这些字符（dsh-storage-json 的 assertSafeKey 规则）。 */
const SAFE_KEY = /^[a-zA-Z0-9_-]+$/;
/** 判断一个外部来源的会话 id 能不能安全落库。 */
export function isSafeRecordKey(key) {
    return SAFE_KEY.test(String(key ?? ''));
}
/**
 * storageDomain 的 valueSchema 只要求运行时有一个 parse 方法。
 * 这里不引入 zod，避免插件在 profile 里解析额外依赖。
 */
function schema(check) {
    return {
        parse(value) {
            if (!check(value))
                throw new Error('invalid superagent record');
            return value;
        },
    };
}
const isObject = (value) => value != null && typeof value === 'object' && !Array.isArray(value);
const hasString = (value, key) => isObject(value) && typeof value[key] === 'string';
export const STORAGE_SPEC = {
    name: 'superagent',
    version: 1,
    layout: 'per-record',
    tables: {
        meta: {
            valueSchema: schema((value) => isObject(value) && typeof value.schemaVersion === 'number'),
        },
        projects: {
            valueSchema: schema((value) => hasString(value, 'key') &&
                hasString(value, 'cwd') &&
                (value.mode === 'plan_review' || value.mode === 'gate_confirm')),
        },
        sessions: {
            valueSchema: schema((value) => hasString(value, 'sessionId') && typeof value.isButler === 'boolean'),
        },
        dispatches: {
            valueSchema: schema((value) => hasString(value, 'id') &&
                hasString(value, 'targetSessionId') &&
                typeof value.status === 'string'),
        },
        plans: {
            valueSchema: schema((value) => hasString(value, 'id') &&
                hasString(value, 'sessionId') &&
                hasString(value, 'dispatchId') &&
                typeof value.status === 'string'),
        },
        blockers: {
            valueSchema: schema((value) => hasString(value, 'id') &&
                hasString(value, 'sessionId') &&
                typeof value.kind === 'string' &&
                typeof value.status === 'string'),
        },
        approvals: {
            valueSchema: schema((value) => hasString(value, 'id') &&
                hasString(value, 'sessionId') &&
                typeof value.status === 'string'),
        },
        audit: {
            valueSchema: schema((value) => hasString(value, 'id') && typeof value.at === 'number'),
        },
    },
};
export class Store {
    domain;
    constructor(domain) {
        this.domain = domain;
    }
    /**
     * P0：运行期版本标识。设好之后，`saveMeta()` 与 `appendAudit()` 会自动带上，
     * 调用方（service / 各个写审计的地方）不需要关心。
     */
    versionStamp = null;
    setVersion(stamp) {
        this.versionStamp = stamp;
    }
    static async open(ctx) {
        const domain = await ctx.storageDomain.open(STORAGE_SPEC);
        return new Store(domain);
    }
    close() {
        return this.domain.close();
    }
    table(name) {
        return this.domain.table(name);
    }
    list(name) {
        return [...this.table(name).entries()].map(([, value]) => value);
    }
    async getMeta() {
        const table = this.table('meta');
        const existing = table.get('state');
        if (existing)
            return existing;
        const created = {
            schemaVersion: 1,
            butlerSessionId: null,
            butlerPresetId: 'superagent-butler',
            lastRecoveryAt: null,
            lastReminderAt: null,
            createdAt: now(),
            updatedAt: now(),
        };
        await table.put('state', created);
        return created;
    }
    async saveMeta(meta) {
        meta.updatedAt = now();
        if (this.versionStamp) {
            meta.codeVersion = this.versionStamp.codeVersion;
            meta.configHash = this.versionStamp.configHash;
        }
        await this.table('meta').put('state', meta);
    }
    /**
     * 进度通知的持久化队列。
     *
     * 存在 `meta` 表的 `notices` 键下（而不是新增表）：新增表要动 STORAGE_SPEC 的 version，
     * 而 version 不匹配会让已有用户的 domain 直接打不开（version-mismatch 是 fail-loud 的），
     * 这里用同一张表的不同 key 就能持久化，零迁移风险。
     */
    listProgressNotices() {
        const table = this.table('meta');
        const existing = table.get('notices');
        const items = Array.isArray(existing?.items) ? existing.items : [];
        return items;
    }
    async saveProgressNotices(items) {
        await this.table('meta').put('notices', { schemaVersion: 1, items });
    }
    listProjects() {
        return this.list('projects');
    }
    getProject(key) {
        return this.table('projects').get(key);
    }
    async putProject(project) {
        project.updatedAt = now();
        await this.table('projects').put(project.key, project);
    }
    listSessions() {
        return this.list('sessions');
    }
    getSession(sessionId) {
        return this.table('sessions').get(sessionId);
    }
    async putSession(session) {
        // 外部来源的 id 千奇百怪（冒号、斜杠、空格），落库会直接抛 path-safe 错误，
        // 而这条异常会顺着 init() 把整个插件拖挂。这里静默跳过：会话照常展示，只是不持久化。
        if (!isSafeRecordKey(session?.sessionId))
            return;
        session.lastSeenAt = now();
        await this.table('sessions').put(session.sessionId, session);
    }
    listDispatches() {
        return this.list('dispatches');
    }
    getDispatch(id) {
        return this.table('dispatches').get(id);
    }
    async putDispatch(dispatch) {
        await this.table('dispatches').put(dispatch.id, dispatch);
    }
    findDispatchByRequestId(requestId) {
        return this.listDispatches().find((dispatch) => dispatch.requestId === requestId);
    }
    currentDispatch(sessionId) {
        return this.listDispatches()
            .filter((dispatch) => dispatch.targetSessionId === sessionId &&
            (dispatch.status === 'accepted' ||
                dispatch.status === 'delivered' ||
                // 上一轮报错但任务没结束：门禁、进度、巡检都还要继续。
                dispatch.status === 'error'))
            .sort((a, b) => b.createdAt - a.createdAt)[0];
    }
    /** 这个 session 上最近的一条派发，不管状态（提交方案时用来兜底判定）。 */
    latestDispatch(sessionId) {
        return this.listDispatches()
            .filter((dispatch) => dispatch.targetSessionId === sessionId)
            .sort((a, b) => b.createdAt - a.createdAt)[0];
    }
    listPlans() {
        return this.list('plans');
    }
    getPlan(id) {
        return this.table('plans').get(id);
    }
    async putPlan(plan) {
        await this.table('plans').put(plan.id, plan);
    }
    pendingPlan(sessionId) {
        return this.listPlans()
            .filter((plan) => plan.sessionId === sessionId && plan.status === 'pending_review')
            .sort((a, b) => b.submittedAt - a.submittedAt)[0];
    }
    approvedPlan(dispatchId) {
        return this.listPlans()
            .filter((plan) => plan.dispatchId === dispatchId && plan.status === 'approved')
            .sort((a, b) => (b.reviewedAt ?? b.submittedAt) - (a.reviewedAt ?? a.submittedAt))[0];
    }
    listBlockers() {
        return this.list('blockers');
    }
    getBlocker(id) {
        return this.table('blockers').get(id);
    }
    async putBlocker(blocker) {
        await this.table('blockers').put(blocker.id, blocker);
    }
    findOpenBlocker(sessionId, signature) {
        return this.listBlockers().find((blocker) => blocker.sessionId === sessionId &&
            blocker.signature === signature &&
            (blocker.status === 'open' || blocker.status === 'notified'));
    }
    listApprovals() {
        return this.list('approvals');
    }
    getApproval(id) {
        return this.table('approvals').get(id);
    }
    async putApproval(approval) {
        await this.table('approvals').put(approval.id, approval);
    }
    listAudit() {
        return this.list('audit').sort((a, b) => b.at - a.at);
    }
    /** 事后回填标注结果（P1）：只改 outcome 相关字段，不碰原始决策内容。 */
    async updateAudit(id, patch) {
        const table = this.table('audit');
        const current = table.get(id);
        if (!current)
            return undefined;
        const next = { ...current, ...patch };
        await table.put(id, next);
        return next;
    }
    async appendAudit(entry) {
        const record = {
            id: shortId('audit'),
            at: entry.at ?? now(),
            ...entry,
        };
        // 版本戳是单一事实来源：调用方写了也以 Store 的为准，保证同一次运行内一致。
        if (this.versionStamp) {
            record.codeVersion = this.versionStamp.codeVersion;
            record.configHash = this.versionStamp.configHash;
        }
        await this.table('audit').put(record.id, record);
        return record;
    }
}
