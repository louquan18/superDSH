export declare function now(): number;
export declare function uuid(): string;
export declare function shortId(prefix: string): string;
export declare function hash(input: string): string;
export declare function stableStringify(value: any): string;
/**
 * 工具返回值必须能无损通过 JSON 往返：dsh 0.2.2 起在 `snapshotJsonValue` 里硬校验，
 * 只要结果里出现显式 `undefined`（或 NaN/Infinity/Date 之类）整个工具调用就会被判
 * `INVALID_TOOL_OUTPUT: value is not lossless JSON`。
 *
 * 这里只做最小归一：深度去掉值为 `undefined` 的对象键（数组元素按 JSON 语义补 null）。
 * 其它类型原样保留——真出现 NaN/Date 属于新缺陷，宁可继续报错也不要静默改数据。
 */
export declare function stripUndefined<T>(value: T): T;
export declare function truncate(text: string, max: number): string;
export declare function asText(value: any): string;
export declare function extractText(content: any): string;
export declare function safeJson(text: string): any;
export declare function normalizeError(error: any): string;
/**
 * 这条 turn 错误是不是「工具参数/输出格式」类的可恢复错误。
 *
 * 实例：worker 把 `done` 传成裸字符串，`butler_report_status` 的参数不是合法 JSON，
 * 整个 turn 报错。这种错误改一下参数就能继续，不该把派发判成终态 failed。
 */
export declare function isRecoverableTurnError(text: string, code?: string): boolean;
export declare function canonicalPath(input: string, cwd?: string): Promise<string>;
export declare function isDirectory(input: string): Promise<boolean>;
export declare function isInside(parent: string, child: string): boolean;
export declare function toRelative(parent: string, child: string): string;
export declare function matchGlob(pattern: string, relPath: string): boolean;
export declare function deepMerge<T>(base: T, patch: any): T;
export declare function redact(value: any, depth?: number): any;
export declare function summarizeArgs(toolName: string, args: any): string;
export declare function hasShellMeta(command: string): boolean;
export declare function firstLine(text: string, max?: number): string;
export declare function sleep(ms: number): Promise<void>;
export declare function unique<T>(items: T[]): T[];
export declare function clamp(value: number, min: number, max: number): number;
