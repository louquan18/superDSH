/**
 * 来源注册表：把多个 {@link SessionSource} 聚合成一个"会话来源索引"。
 *
 * P0 只注册 dsh，行为与一期完全一致；P1/P2 注册 claude/codex 后，
 * 上层（service/router/UI）通过这里拿"某个 sessionId 属于谁"和"它能做什么"。
 */
import { type SessionSource, type SourceCapabilities, type SourceKind, type SourceSessionLite } from './types.js';
export interface SourceRegistryOptions {
    /** 找不到归属时的兜底来源，默认 dsh（旧记录兼容）。 */
    fallback?: SourceKind;
}
export declare class SourceRegistry {
    private readonly sources;
    /** sessionId → kind，由 {@link index} 维护。 */
    private readonly owners;
    private readonly fallback;
    constructor(options?: SourceRegistryOptions);
    /** 注册一个来源；同 kind 覆盖。返回注销函数。 */
    register(source: SessionSource): () => void;
    /** 按 kind 取来源；没有注册返回 undefined。 */
    get(kind: SourceKind): SessionSource | undefined;
    /** 已注册的来源，按 {@link SOURCE_KINDS} 的固定顺序（dsh 永远第一）。 */
    kinds(): SourceKind[];
    /** 已注册来源的能力表；未注册时 dsh 返回全能力、其它返回只读基线。 */
    capabilitiesOf(kind: SourceKind): SourceCapabilities;
    /**
     * 某个会话属于哪个来源。
     *
     * 先查索引，再按 id 形状兜底（`session-*` 是 dsh 的历史形状），最后落到 fallback。
     * 这样旧记录、刚创建还没进索引的会话都不会被误判成外部来源。
     */
    ownerOf(sessionId: string): SessionSource;
    /** 能力判断：`supports(registry.for(sessionId), 'send')`。 */
    supports(sessionId: string, capability: keyof SourceCapabilities): boolean;
    /** 该来源是否可写（派发/改派的前置条件）。 */
    canSend(sessionId: string): boolean;
    /**
     * 聚合所有已注册来源的会话列表。
     *
     * 顺序：按 {@link kinds}（dsh 在前），来源内保持适配器返回的顺序。
     * 单个来源失败不影响其它来源（记 warn 后跳过），避免一个坏适配器拖垮整个面板。
     */
    list(options?: {
        kinds?: readonly SourceKind[];
        onError?: (kind: SourceKind, error: unknown) => void;
    }): Promise<SourceSessionLite[]>;
    /** 用一次列表结果刷新归属索引（不拉取，只登记）。 */
    index(items: readonly SourceSessionLite[]): void;
    /** 清空归属索引（适配器刷新/关闭来源时用）。 */
    clearIndex(): void;
    private onlySource;
}
