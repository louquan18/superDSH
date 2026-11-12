/**
 * 规则清单。`id` 是审计记录里的 `ruleId`，一旦发布不要改名（改历史就断代了）。
 */
export const RULES = [
    {
        id: 'watchdog_stall',
        label: 'watchdog 停顿提醒',
        group: 'watchdog',
        defaultShadow: true,
        fpBasis: '提醒后 15 分钟内 worker 自己产出了真实进度，且期间没有人工介入',
    },
    {
        id: 'blocker_repeat_failure',
        label: '重复失败卡点',
        group: 'blocker',
        defaultShadow: true,
        fpBasis: '卡点在 15 分钟内条件自行消失（没人处理就好了）',
    },
    {
        id: 'blocker_edit_thrash',
        label: '编辑打转卡点',
        group: 'blocker',
        defaultShadow: false,
        fpBasis: '卡点在 15 分钟内条件自行消失（没人处理就好了）',
    },
    {
        id: 'bash_deny',
        label: 'bash 审查拒绝',
        group: 'bash',
        defaultShadow: false,
        fpBasis: '—',
    },
    {
        id: 'dispatch_route',
        label: '派发路由',
        group: 'dispatch',
        defaultShadow: false,
        fpBasis: '该派发随后被 superseded（这条活不再需要了）',
    },
];
export const RULE_IDS = RULES.map((rule) => rule.id);
export function ruleMeta(id) {
    return RULES.find((rule) => rule.id === id);
}
/**
 * Wilson score 区间下界。
 *
 * 为什么不用直接命中率：watchdog 到现在只醒过 14 次，3 次误报就是 79% 命中率，
 * 但这在三五个样本上没有统计意义。下界让"样本不足"自然表现为低分，
 * 配合 minSamples 门槛，避免凭感觉撤规则（I-12 就是这么误改的）。
 */
export function wilsonLower(successes, n, z = 1.96) {
    if (!Number.isFinite(n) || n <= 0)
        return 0;
    const p = Math.max(0, Math.min(1, successes / n));
    const z2 = z * z;
    const denom = 1 + z2 / n;
    const center = p + z2 / (2 * n);
    const spread = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
    return Math.max(0, (center - spread) / denom);
}
/** 从审计记录汇总每条规则的准确率。窗口外的、没 ruleId 的、没判定的都不计入 n。 */
export function computeStats(audits, windowDays, at = Date.now()) {
    const from = at - Math.max(1, windowDays) * 24 * 60 * 60_000;
    const acc = new Map();
    for (const id of RULE_IDS) {
        acc.set(id, {
            ruleId: id,
            n: 0,
            tp: 0,
            fp: 0,
            fn: 0,
            unknown: 0,
            precision: 0,
            precisionLB: 0,
            lastAt: 0,
        });
    }
    for (const audit of audits) {
        const ruleId = audit.ruleId;
        if (!ruleId)
            continue;
        const stat = acc.get(ruleId);
        if (!stat)
            continue;
        if (audit.at < from)
            continue;
        stat.lastAt = Math.max(stat.lastAt, audit.at);
        switch (audit.outcome) {
            case 'tp':
                stat.tp += 1;
                break;
            case 'fp':
                stat.fp += 1;
                break;
            case 'fn':
                stat.fn += 1;
                break;
            default:
                stat.unknown += 1;
        }
    }
    for (const stat of acc.values()) {
        stat.n = stat.tp + stat.fp + stat.fn;
        const judged = stat.tp + stat.fp;
        stat.precision = judged > 0 ? stat.tp / judged : 0;
        stat.precisionLB = wilsonLower(stat.tp, judged);
    }
    return [...acc.values()];
}
/**
 * 双向迁移：
 * - 不在 shadow 名单：样本够且下界跌破 `demoteBelow` → 降级为 shadow（自动退休）；
 * - 在 shadow 名单：样本够且下界升破 `promoteAbove` → 晋升为 act（自动放行）；
 * - 样本不足：保持各自默认（名单内的仍 shadow，名单外的照常 act）。
 */
export function decidePolicy(ruleId, stat, config) {
    if (!config.enabled)
        return { mode: 'act', reason: 'policy-disabled' };
    const inShadowList = config.shadowRules.includes(ruleId);
    const n = stat?.n ?? 0;
    const lb = stat?.precisionLB ?? 0;
    if (n < config.minSamples) {
        return inShadowList
            ? { mode: 'shadow', reason: `shadow-listed(样本 ${n}<${config.minSamples})` }
            : { mode: 'act', reason: `default-act(样本 ${n}<${config.minSamples})` };
    }
    if (inShadowList) {
        return lb >= config.promoteAbove
            ? { mode: 'act', reason: `promoted(下界 ${lb.toFixed(2)}≥${config.promoteAbove})` }
            : { mode: 'shadow', reason: `shadow-listed(下界 ${lb.toFixed(2)}<${config.promoteAbove})` };
    }
    return lb < config.demoteBelow
        ? { mode: 'shadow', reason: `demoted(下界 ${lb.toFixed(2)}<${config.demoteBelow})` }
        : { mode: 'act', reason: `healthy(下界 ${lb.toFixed(2)})` };
}
