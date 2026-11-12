import type { HardStatus, SoftStatus } from './types.js';
export interface ToolCallRecord {
    callId: string;
    name: string;
    args: any;
    at: number;
    result?: {
        isError: boolean;
        text: string;
        code?: string;
        at: number;
    };
}
export interface FailureEntry {
    signature: string;
    at: number;
    toolName: string;
    subkind?: 'test' | 'error' | 'edit_thrash' | 'loop';
    summary: string;
}
export interface PendingApproval {
    id: string;
    toolName: string;
    callId?: string;
    reason?: string;
    at: number;
}
export interface PendingQuestion {
    callId: string;
    questions: any[];
    at: number;
    state: 'open' | 'continued';
}
export interface EditEntry {
    path: string;
    at: number;
}
export interface LastTurnEnd {
    kind: string;
    at: number;
    error?: string;
    errorCode?: string;
}
export interface SessionRuntime {
    sessionId: string;
    running: boolean;
    lastEventAt: number;
    lastActivityAt: number;
    eventCount: number;
    openTurnStartSeq: number | null;
    lastTurnEnd: LastTurnEnd | null;
    approvals: Map<string, PendingApproval>;
    questions: Map<string, PendingQuestion>;
    failureRing: FailureEntry[];
    editRing: EditEntry[];
    toolCalls: Map<string, ToolCallRecord>;
    softStatus?: SoftStatus;
    lastTestSuccessAt?: number;
}
export declare function createRuntime(sessionId: string): SessionRuntime;
export declare function addFailure(runtime: SessionRuntime, entry: Omit<FailureEntry, 'at'> & {
    at?: number;
}): void;
export declare function applySessionEvent(runtime: SessionRuntime, event: any, options?: {
    now?: number;
}): void;
export declare function foldSession(sessionId: string, events: any[], options?: {
    now?: number;
}): SessionRuntime;
export declare function parseReportStatus(args: any, at?: number): SoftStatus | undefined;
export declare function deriveHardStatus(runtime: SessionRuntime | undefined, live: {
    available: boolean;
    running: boolean;
}): HardStatus;
export declare function recentFailureGroups(runtime: SessionRuntime, windowMs: number, threshold: number, at?: number): Array<{
    signature: string;
    count: number;
    latest: FailureEntry;
}>;
export declare function repeatedToolCalls(runtime: SessionRuntime, windowMs: number, threshold: number, at?: number): Array<{
    signature: string;
    count: number;
    call: ToolCallRecord;
}>;
