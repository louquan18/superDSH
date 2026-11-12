import { type SessionSource, type SourceCapabilities, type SourceDigest, type SourceKind, type SourceSessionLite } from './sources/types.js';
export type { SourceDigest, SourceSessionLite };
export interface DshSourceOptions {
    ctx: any;
}
/**
 * dsh 本机 session 的 SessionSource 实现。
 * 这一层只做「读/建/发/队列」的薄封装；状态推导在 status.ts，业务在 service.ts。
 */
export declare class DshSource implements SessionSource {
    private readonly options;
    readonly kind: SourceKind;
    readonly capabilities: SourceCapabilities;
    constructor(options: DshSourceOptions);
    private get ctx();
    private signal;
    list(): Promise<SourceSessionLite[]>;
    observe(sessionId: string): Promise<any>;
    readEvents(sessionId: string): Promise<any[]>;
    readDigest(sessionId: string, limit?: number): Promise<SourceDigest | undefined>;
    readUserMessages(sessionId: string, limit: number): Promise<string[]>;
    create(cwd: string, agentPreset?: string): Promise<string>;
    prompt(sessionId: string, text: string, requestId: string): Promise<void>;
    rename(sessionId: string, title: string): Promise<void>;
    cancel(sessionId: string): Promise<void>;
    findQueuedMessage(sessionId: string, requestId: string): Promise<{
        id: string;
        text: string;
    } | undefined>;
    removeQueued(sessionId: string, itemId: string): Promise<boolean>;
    findDelivered(sessionId: string, requestId: string): Promise<boolean>;
    newRequestId(): string;
}
export declare function digestText(digest: SourceDigest | undefined, max?: number): string;
