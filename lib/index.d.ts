export declare const name = "superagent-butler";
/**
 * 硬依赖：缺任何一个，管家都不能工作。
 * `connection` / `commands` / `workspaceRegistry` / `workingDirectory` 通过 `ctx.get()` 可选读取，
 * 这样同一个插件在 headless profile 里也能加载。
 */
export declare const inject: string[];
export declare function apply(ctx: any, config: any): Promise<() => void>;
