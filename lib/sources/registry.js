/**
 * 来源注册表：把多个 {@link SessionSource} 聚合成一个"会话来源索引"。
 *
 * P0 只注册 dsh，行为与一期完全一致；P1/P2 注册 claude/codex 后，
 * 上层（service/router/UI）通过这里拿"某个 sessionId 属于谁"和"它能做什么"。
 */
import { DSH_CAPABILITIES, SOURCE_KINDS, supports, } from './types.js';
export class SourceRegistry {
    sources = new Map();
    /** sessionId → kind，由 {@link index} 维护。 */
    owners = new Map();
    fallback;
    constructor(options = {}) {
        this.fallback = options.fallback ?? 'dsh';
    }
    /** 注册一个来源；同 kind 覆盖。返回注销函数。 */
    register(source) {
        this.sources.set(source.kind, source);
        return () => {
            if (this.sources.get(source.kind) === source)
                this.sources.delete(source.kind);
        };
    }
    /** 按 kind 取来源；没有注册返回 undefined。 */
    get(kind) {
        return this.sources.get(kind);
    }
    /** 已注册的来源，按 {@link SOURCE_KINDS} 的固定顺序（dsh 永远第一）。 */
    kinds() {
        return SOURCE_KINDS.filter((kind) => this.sources.has(kind));
    }
    /** 已注册来源的能力表；未注册时 dsh 返回全能力、其它返回只读基线。 */
    capabilitiesOf(kind) {
        return this.sources.get(kind)?.capabilities ?? DSH_CAPABILITIES;
    }
    /**
     * 某个会话属于哪个来源。
     *
     * 先查索引，再按 id 形状兜底（`session-*` 是 dsh 的历史形状），最后落到 fallback。
     * 这样旧记录、刚创建还没进索引的会话都不会被误判成外部来源。
     */
    ownerOf(sessionId) {
        const id = String(sessionId ?? '');
        const indexed = this.owners.get(id);
        if (indexed) {
            const source = this.sources.get(indexed);
            if (source)
                return source;
        }
        const dsh = this.sources.get('dsh');
        if (dsh && (id.startsWith('session-') || !id))
            return dsh;
        return dsh ?? this.onlySource();
    }
    /** 能力判断：`supports(registry.for(sessionId), 'send')`。 */
    supports(sessionId, capability) {
        return supports(this.ownerOf(sessionId), capability);
    }
    /** 该来源是否可写（派发/改派的前置条件）。 */
    canSend(sessionId) {
        return this.supports(sessionId, 'send');
    }
    /**
     * 聚合所有已注册来源的会话列表。
     *
     * 顺序：按 {@link kinds}（dsh 在前），来源内保持适配器返回的顺序。
     * 单个来源失败不影响其它来源（记 warn 后跳过），避免一个坏适配器拖垮整个面板。
     */
    async list(options = {}) {
        const wanted = options.kinds ?? this.kinds();
        const out = [];
        for (const kind of SOURCE_KINDS) {
            if (!wanted.includes(kind))
                continue;
            const source = this.sources.get(kind);
            if (!source || source.capabilities.list !== true)
                continue;
            try {
                const items = await source.list();
                for (const item of items) {
                    const normalized = {
                        ...item,
                        source: item.source ?? source.kind,
                    };
                    this.owners.set(normalized.sessionId, normalized.source);
                    out.push(normalized);
                }
            }
            catch (error) {
                options.onError?.(kind, error);
            }
        }
        return out;
    }
    /** 用一次列表结果刷新归属索引（不拉取，只登记）。 */
    index(items) {
        for (const item of items) {
            this.owners.set(item.sessionId, item.source ?? this.fallback);
        }
    }
    /** 清空归属索引（适配器刷新/关闭来源时用）。 */
    clearIndex() {
        this.owners.clear();
    }
    onlySource() {
        const first = this.kinds()[0];
        const source = first ? this.sources.get(first) : undefined;
        if (!source)
            throw new Error('SourceRegistry: no session source registered');
        return source;
    }
}
