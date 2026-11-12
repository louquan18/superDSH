export interface VersionInfo {
    /** `git describe --tags --always --dirty` 的结果，或 `pkg@x.y.z+unknown` 降级串。 */
    codeVersion: string;
    /** 有效配置的指纹（sha256 前 12 位）。 */
    configHash: string;
    /** 进程启动时间。 */
    startedAt: number;
}
/**
 * 读代码版本。
 *
 * 插件通常以 `link:` 方式安装，目录即 git 仓库，所以 `git describe` 可用；
 * 从别处拷贝安装（没有 .git）或 git 不可用时返回降级串。
 */
export declare function readCodeVersion(): string;
/**
 * 有效配置的指纹，取 sha256 前 12 位（够区分，又短到能塞进面板和审计）。
 *
 * 用 `util.stableStringify` 而不是 `JSON.stringify`：配置键的书写顺序不该改变指纹，
 * 否则在 yaml 里换个键顺序就会让所有历史审计看起来来自不同版本。
 */
export declare function readConfigHash(config: unknown): string;
/**
 * 启动时调一次，之后所有审计、快照、诊断复用同一份。
 * 这样「同一次运行里产生的所有决策」一定带同一个版本戳。
 */
export declare function resolveVersion(config: unknown): VersionInfo;
/** 已算过则返回，否则 null。 */
export declare function currentVersion(): VersionInfo | null;
/** 仅测试用：清掉缓存，让下一次 resolveVersion 重新计算。 */
export declare function resetVersionForTest(): void;
