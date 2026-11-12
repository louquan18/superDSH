import type { BlockerKind, HardStatus, ProjectMode, RouteCandidate, RouteDecision, SoftStatus } from './types.js';
export interface RouterSession {
    sessionId: string;
    title: string;
    cwd?: string;
    projectKey?: string;
    isButler: boolean;
    isRoot: boolean;
    archived: boolean;
    blank: boolean;
    running: boolean;
    hardStatus: HardStatus;
    lastActivityAt: number;
    queueCount: number;
    softStatus?: SoftStatus;
    recentUserMessages: string[];
    openDispatch?: {
        id: string;
        text: string;
    };
    openBlockerKinds: BlockerKind[];
}
export interface BuildCandidatesInput {
    projectKey: string;
    sessions: RouterSession[];
    windowDays: number;
    maxCandidates: number;
    now: number;
    topicRecentMessages: number;
}
export declare function buildCandidates(input: BuildCandidatesInput): RouteCandidate[];
export interface ValidateInput {
    decision: RouteDecision;
    candidates: RouteCandidate[];
    sessions: RouterSession[];
    projectKey: string;
    explicitTargets?: string[];
}
export interface ValidateResult {
    ok: boolean;
    reason?: string;
    target?: RouterSession;
}
export declare function validateDecision(input: ValidateInput): ValidateResult;
export declare function deliveryFor(status: HardStatus): 'queue' | 'wake';
export declare function parseExplicitTarget(text: string, sessions: Array<{
    sessionId: string;
    title: string;
}>): string | undefined;
export declare function parseExplicitPath(text: string): string | undefined;
export declare function parseWorkspaceMention(text: string, workspaces: Array<{
    key: string;
    cwd: string;
    title: string;
}>): {
    key: string;
    cwd: string;
} | undefined;
export declare function projectModeAtDispatch(mode: ProjectMode | undefined, fallback?: ProjectMode): ProjectMode;
