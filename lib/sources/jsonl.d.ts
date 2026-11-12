export interface TailResult {
    /** 读到的完整行（已去掉因为截断而不完整的首行）。 */
    lines: string[];
    /** 文件字节数。 */
    size: number;
    /** 修改时间（毫秒）。 */
    mtimeMs: number;
    /** 是否只读了尾部（文件比预算大）。 */
    truncated: boolean;
}
/** 读文件尾部若干字节，按行切开；读不到（权限/不存在）时返回 undefined。 */
export declare function readTail(path: string, maxBytes?: number): Promise<TailResult | undefined>;
/** 读文件头部若干字节，按行切开（拿 session_meta / 首条事件用）。 */
export declare function readHead(path: string, maxBytes?: number): Promise<TailResult | undefined>;
export interface ParsedLines<T> {
    values: T[];
    /** JSON 解析失败的行数（格式漂移的早期信号）。 */
    bad: number;
    /** 解析成功但不是对象的行数。 */
    skipped: number;
}
/** 逐行 JSON 解析；坏行跳过并计数，绝不因为一行坏掉整个文件。 */
export declare function parseLines<T = any>(lines: readonly string[]): ParsedLines<T>;
/** 把 ISO 时间 / 秒级时间戳 / 毫秒时间戳统一成毫秒；无法识别返回 undefined。 */
export declare function toMillis(value: unknown): number | undefined;
/** 限制并发地跑一组异步任务（避免一次打开几百个文件句柄）。 */
export declare function mapLimit<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]>;
