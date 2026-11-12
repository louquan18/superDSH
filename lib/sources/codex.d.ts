import type { HardStatus } from '../types.js';
import { type SessionSource, type SourceCapabilities, type SourceDigest, type SourceKind, type SourceSessionLite } from './types.js';
export interface CodexSourceConfig {
    enabled: boolean;
    home?: string;
    scanDays: number;
    maxSessions: number;
    tailBytes: number;
    includeSubagents: boolean;
    watch: boolean;
}
export interface CodexSourceOptions {
    config: CodexSourceConfig;
    onChange?: () => void;
    now?: () => number;
    /** 注入用（测试）：覆盖 `~/.codex/sessions` 与索引/db 位置。 */
    sessionsDir?: string;
    indexPath?: string;
    stateDbPath?: string;
}
interface TurnState {
    status: string;
    startedAt?: number;
    completedAt?: number;
    error?: string;
}
interface SessionMeta {
    sessionId: string;
    title: string;
    cwd?: string;
    lastKind?: string;
    lastText?: string;
    errorText?: string;
    lastEventAt?: number;
    updatedAt: number;
    events: any[];
    bad: number;
    /** 打开中的回合（task_started 之后没有 task_complete/turn_aborted）。 */
    openTurn?: boolean;
    /** 最近一次 turn_aborted。 */
    aborted?: boolean;
}
export declare function isSyntheticUserText(text: string): boolean;
export declare class CodexSource implements SessionSource {
    readonly kind: SourceKind;
    readonly capabilities: SourceCapabilities;
    private readonly config;
    private readonly home;
    private readonly sessionsDir;
    private readonly indexPath;
    private readonly stateDbPath;
    private readonly historyPath;
    private readonly now;
    private readonly onChange?;
    private readonly cache;
    private indexCache;
    private turnsCache;
    private historyCache;
    private lastScan;
    /** node:sqlite 不可用时只提示一次。 */
    private sqliteWarned;
    constructor(options: CodexSourceOptions);
    /** Codex 没有可监听的进程表；watch 关闭，靠上层 15s 定时扫描。 */
    start(): void;
    dispose(): void;
    list(): Promise<SourceSessionLite[]>;
    readDigest(sessionId: string, limit?: number): Promise<SourceDigest | undefined>;
    readEvents(sessionId: string): Promise<any[]>;
    observe(sessionId: string): Promise<any>;
    readUserMessages(sessionId: string, limit: number): Promise<string[]>;
    newRequestId(): string;
    prompt(): Promise<never>;
    create(): Promise<never>;
    rename(): Promise<void>;
    cancel(): Promise<void>;
    findQueuedMessage(): Promise<undefined>;
    removeQueued(): Promise<boolean>;
    findDelivered(): Promise<boolean>;
    private collectFiles;
    private readMeta;
    private metaFor;
    /** `session_index.jsonl` 的 id → thread_name（**不全**，只当兜底）。 */
    private indexTitles;
    /** `history.jsonl`：session_id → 用户真实首条 prompt（文件很小，按 mtime 缓存）。 */
    private historyPrompts;
    /**
     * `thread_turns` 里每个 thread 的最新状态。
     *
     * 用 `?immutable=1` 只读打开：不会写 `~/.codex`，也不会和正在跑的 Codex 抢锁。
     * 代价是会忽略 WAL 里尚未 checkpoint 的写入 —— 由 {@link inferStatus} 用
     * rollout 的 mtime 兜底（文件很久没动就不再认为在跑）。
     */
    private turnStates;
}
/** Codex 状态判定：sqlite 优先，rollout 尾部兜底。 */
export declare function inferStatus(input: {
    meta: SessionMeta;
    turn?: TurnState;
    now: number;
}): {
    hardStatus: HardStatus;
    running: boolean;
};
export {};
