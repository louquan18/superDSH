import type { SuperagentService } from './service.js';
import type { PlanScopeItem } from './types.js';
export declare function createButlerTools(service: SuperagentService): any[];
export declare function butlerToolSchemaSummary(): string;
export declare function planScopeSchema(): any;
export declare function normalizeScopeItems(items: any): PlanScopeItem[];
export declare function shortDigest(events: any[], limit: number): string;
