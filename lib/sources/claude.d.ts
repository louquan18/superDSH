import type { HardStatus } from '../types.js';
import { type SessionSource, type SourceCapabilities, type SourceDigest, type SourceKind, type SourceSessionLite } from './types.js';
export interface ClaudeSourceConfig {
    enabled: boolean;
    home?: string;
    scanDays: number;
    maxSessions: number;
    tailBytes: number;
    includeSubagents: boolean;
    watch: boolean;
}
export interface ClaudeSourceOptions {
    config: ClaudeSourceConfig;
    /** 缓存失效时回调（service 用它清 session 缓存 + 广播面板）。 */
    onChange?: () => void;
    now?: () => number;
    /** 注入用（测试）；默认读 `<home>/projects`。 */
    projectsDir?: string;
}
interface SessionMeta {
    sessionId: string;
    title: string;
    cwd?: string;
    parentSessionId?: string;
    isSubagent: boolean;
    agentType?: string;
    spawnDepth?: number;
    lastKind?: string;
    lastText?: string;
    errorText?: string;
    /** 最近事件的毫秒时间。 */
    lastEventAt?: number;
    updatedAt: number;
    /** 尾部解析出来的事件（dsh 形状，供 digest 用）。 */
    events: any[];
    bad: number;
}
export declare class ClaudeSource implements SessionSource {
    readonly kind: SourceKind;
    readonly capabilities: SourceCapabilities;
    private readonly config;
    private readonly home;
    private readonly projectsDir;
    private readonly sessionsDir;
    private readonly historyPath;
    private readonly now;
    private readonly onChange?;
    private readonly cache;
    private historyCache;
    private liveCache;
    private watchers;
    private debounce;
    private lastScan;
    constructor(options: ClaudeSourceOptions);
    /** 启动 fs.watch；失败（目录不存在/不支持）时静默降级到定时扫描。 */
    start(): void;
    dispose(): void;
    /** 清缓存并（去抖后）通知上层刷新。 */
    private invalidate;
    list(): Promise<SourceSessionLite[]>;
    /** 最近一次扫描结果（readDigest/readEvents 复用，避免重复读盘）。 */
    private snapshotItems;
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
    /** 每个 session 的第一条用户提示（goal），来自 history.jsonl，一次读入按 mtime 缓存。 */
    private goals;
    /** 活进程表：`~/.claude/sessions/<pid>.json`（按 5s 缓存，目录很小）。 */
    private liveSessions;
    private softStatusFor;
}
interface LiveEntry {
    pid: number;
    alive: boolean;
    status: string;
    waitingFor?: string;
    cwd?: string;
    kind?: string;
    updatedAt: number;
    name?: string;
}
export declare function inferStatus(input: {
    meta: SessionMeta;
    live?: LiveEntry;
    now: number;
}): {
    hardStatus: HardStatus;
    running: boolean;
    live: boolean;
};
export {};
