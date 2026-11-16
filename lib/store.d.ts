import type { Approval, AuditEntry, Blocker, Dispatch, ManagedSession, Meta, Plan, ProgressNoticeRecord, PendingQuestionRecord, Project, Thread, WakeWatchRecord } from './types.js';
/** 判断一个外部来源的会话 id 能不能安全落库。 */
export declare function isSafeRecordKey(key: string): boolean;
export declare const STORAGE_SPEC: any;
export declare class Store {
    private readonly domain;
    private constructor();
    /**
     * P0：运行期版本标识。设好之后，`saveMeta()` 与 `appendAudit()` 会自动带上，
     * 调用方（service / 各个写审计的地方）不需要关心。
     */
    private versionStamp;
    setVersion(stamp: {
        codeVersion: string;
        configHash: string;
    } | null): void;
    static open(ctx: any): Promise<Store>;
    close(): Promise<void>;
    private table;
    private list;
    getMeta(): Promise<Meta>;
    saveMeta(meta: Meta): Promise<void>;
    /**
     * 进度通知的持久化队列。
     *
     * 存在 `meta` 表的 `notices` 键下（而不是新增表）：新增表要动 STORAGE_SPEC 的 version，
     * 而 version 不匹配会让已有用户的 domain 直接打不开（version-mismatch 是 fail-loud 的），
     * 这里用同一张表的不同 key 就能持久化，零迁移风险。
     */
    listProgressNotices(): ProgressNoticeRecord[];
    saveProgressNotices(items: ProgressNoticeRecord[]): Promise<void>;
    /**
     * 待投递的提醒队列（I-34）。
     *
     * 存在 `meta` 表的 `pendingNotices` 键下（不新增表 = 不动 STORAGE_SPEC 版本）。
     * 管家离线时提醒进这里；进程重启后从存储重建，不再靠内存。
     */
    listPendingNotices(): Array<{
        butlerSessionId: string;
        payload: any;
    }>;
    savePendingNotices(items: Array<{
        butlerSessionId: string;
        payload: any;
    }>): Promise<void>;
    /**
     * 待回答提问落盘（I-36 A）：存在 `meta` 表的 `pendingQuestions` 键下，不新增表。
     * 重启后据此把卡点标成「请到界面回答」。
     */
    listPendingQuestions(): PendingQuestionRecord[];
    savePendingQuestions(items: PendingQuestionRecord[]): Promise<void>;
    /**
     * 唤醒开口监测落盘（I-37 2A）：存在 `meta` 表的 `wakeWatch` 键下，不新增表。
     * 重启后据此补记「唤醒后未开口」，避免进程中途重启就漏账。
     */
    listWakeWatch(): WakeWatchRecord[];
    saveWakeWatch(items: WakeWatchRecord[]): Promise<void>;
    listProjects(): Project[];
    getProject(key: string): Project | undefined;
    putProject(project: Project): Promise<void>;
    listSessions(): ManagedSession[];
    getSession(sessionId: string): ManagedSession | undefined;
    putSession(session: ManagedSession): Promise<void>;
    listDispatches(): Dispatch[];
    getDispatch(id: string): Dispatch | undefined;
    putDispatch(dispatch: Dispatch): Promise<void>;
    findDispatchByRequestId(requestId: string): Dispatch | undefined;
    currentDispatch(sessionId: string): Dispatch | undefined;
    /** 这个 session 上最近的一条派发，不管状态（提交方案时用来兜底判定）。 */
    latestDispatch(sessionId: string): Dispatch | undefined;
    listPlans(): Plan[];
    getPlan(id: string): Plan | undefined;
    putPlan(plan: Plan): Promise<void>;
    pendingPlan(sessionId: string): Plan | undefined;
    approvedPlan(dispatchId: string): Plan | undefined;
    listBlockers(): Blocker[];
    getBlocker(id: string): Blocker | undefined;
    putBlocker(blocker: Blocker): Promise<void>;
    findOpenBlocker(sessionId: string, signature: string): Blocker | undefined;
    listApprovals(): Approval[];
    getApproval(id: string): Approval | undefined;
    putApproval(approval: Approval): Promise<void>;
    listAudit(): AuditEntry[];
    listThreads(): Thread[];
    getThread(id: string): Thread | undefined;
    putThread(thread: Thread): Promise<void>;
    /** 某个会话上还在进行的活（active / waiting_human），按最近活动排序。 */
    activeThreadForSession(sessionId: string): Thread | undefined;
    /** 事后回填标注结果（P1）：只改 outcome 相关字段，不碰原始决策内容。 */
    updateAudit(id: string, patch: Partial<Pick<AuditEntry, 'outcome' | 'outcomeRule' | 'outcomeAt'>>): Promise<AuditEntry | undefined>;
    appendAudit(entry: Omit<AuditEntry, 'id' | 'at'> & {
        at?: number;
    }): Promise<AuditEntry>;
}
