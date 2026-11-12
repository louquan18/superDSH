/**
 * 进度事件检测（A）+ 按复杂度巡检（B）的纯逻辑。
 *
 * 这里不碰 ctx / store / inject：输入是「一次扫描看到的事实 + 持久化游标」，
 * 输出是「该推哪些 progress」。service.ts 只负责把结果接进现有提醒链路，
 * 所以去重、节流、阈值判定都能直接单测。
 */
import { hash, truncate } from './util.js';
/** 游标里最多保留多少条已推签名。 */
export const NOTIFIED_LIMIT = 50;
export function milestoneSignature(item) {
    return `milestone:${hash(item.trim())}`;
}
export function blockerResolvedSignature(signature) {
    return `blocker_resolved:${hash(signature)}`;
}
export function stageEndSignature(cursor) {
    return `stage_end:${cursor.stageEnds ?? 0}`;
}
/**
 * watchdog 签名带上「安静期的起点」，这样：
 * - 同一个安静期只问一次（15s 扫描不会刷屏）；
 * - 中间有了真实进展或会话活动，起点变化，下一段安静期可以再问；
 * - 一直没动静拖到 3 倍 poll 时，再问最后一次。
 *
 * `anchor` 是 `lastProgressAt` 与 `lastActivityAt` 的较新者（见 detectProgress 的 B 段）。
 */
export function watchdogSignature(anchor, elapsedMs, pollMs) {
    const tier = elapsedMs >= pollMs * 3 ? '3x' : '1x';
    return `watchdog:${tier}:${anchor}`;
}
export function isNotified(cursor, signature) {
    return Boolean(cursor?.notified?.includes(signature));
}
export function isOpenDispatch(dispatch) {
    // error 是「上一轮出错但派发没结束」，仍然要推进度、也仍然要巡检。
    return (dispatch.status === 'accepted' ||
        dispatch.status === 'delivered' ||
        dispatch.status === 'error');
}
/** 新建派发时的初始游标：lastRunning 先记成 false，「第一次 running」不会被当成阶段结束。 */
export function initialCursor(now) {
    return {
        notified: [],
        lastProgressAt: now,
        lastRunning: false,
        lastDoneCount: 0,
        lastTurnEndAt: now,
    };
}
/**
 * 算这次扫描该推哪些 progress。
 *
 * 没有任何事件时返回空数组；调用方仍要推进游标（lastRunning / lastDoneCount），
 * 否则「一次都没 running 过就 idle」和「running → idle」分不开。
 */
export function detectProgress(input) {
    const { dispatch, soft, config, now } = input;
    const cursor = dispatch.progress;
    // 老记录（升级前创建的派发）没有游标：首次扫描只播种，不把历史 done 全报一遍。
    if (!cursor)
        return [];
    const events = [];
    const title = input.title;
    // A1 里程碑：done 里出现游标里没有的条目。
    const done = soft?.done ?? [];
    const fresh = [];
    for (const item of done) {
        const text = String(item ?? '').trim();
        if (!text)
            continue;
        if (fresh.includes(text))
            continue;
        if (isNotified(cursor, milestoneSignature(text)))
            continue;
        fresh.push(text);
    }
    if (fresh.length > 0 && config.progress.notifyMilestones) {
        // 节流：同一 dispatch 的里程碑两次之间不低于 minGapMs。
        // 被压住的条目不写游标，等间隔过去后的下一次扫描再发，不丢。
        const last = cursor.lastMilestoneAt ?? 0;
        if (last === 0 || now - last >= config.progress.minGapMs) {
            const next = soft?.next?.[0];
            events.push({
                kind: 'milestone',
                signatures: fresh.slice(0, NOTIFIED_LIMIT).map(milestoneSignature),
                category: 'milestone',
                title: `${title}：完成 ${fresh.length} 项`,
                detail: [
                    ...fresh.slice(-3).map((item) => truncate(item, 100)),
                    ...(next ? [`下一步：${truncate(next, 100)}`] : []),
                ].join('；'),
                real: true,
            });
        }
    }
    // A2 阶段结束：这一轮跑完了，而且任务还没收尾。
    //
    // 两种信号取其一：
    // - 扫描看到 running → idle 的跃迁（长 turn 靠这个）；
    // - runtime 里出现了新的 turn 结束（turn 比扫描间隔还短时，只有这个看得到）。
    // 只按「边沿」判定，所以不参与 minGap 节流：压住就等于丢（下次扫描边沿已经过去了）。
    const stageEnd = isOpenDispatch(dispatch) &&
        ((cursor.lastRunning === true && input.running === false) ||
            (input.lastTurnEnd != null &&
                input.lastTurnEnd.kind === 'completed' &&
                input.lastTurnEnd.at > (cursor.lastTurnEndAt ?? 0)));
    if (config.progress.notifyStageEnd && stageEnd) {
        const next = soft?.next?.[0];
        events.push({
            kind: 'stage_end',
            signatures: [stageEndSignature(cursor)],
            category: 'dispatch',
            title: `${title}：阶段结束`,
            detail: next ? `下一步：${truncate(next, 120)}` : '这一轮跑完了，任务还没收尾',
            real: true,
        });
    }
    // A3 卡点消失（新增仍走现有 blocker 提醒，不重复报）。
    if (config.progress.notifyBlockerResolved) {
        for (const item of input.resolved ?? []) {
            const signature = blockerResolvedSignature(item.signature);
            if (isNotified(cursor, signature))
                continue;
            events.push({
                kind: 'blocker_resolved',
                signatures: [signature],
                category: 'dispatch',
                title: `${title}：卡点已解除`,
                detail: truncate(item.summary, 160),
                real: true,
            });
        }
    }
    // B watchdog：按这条派发自己的期望时长问一句，不升级成 stall。
    //
    // 「无进展」取「上报」与「会话活动」中较新的那个：worker 闷头做真机验证、
    // 一直有事件但没调 report_status 时不算停滞；彻底不动（既无活动也无上报）才报。
    const watchdog = dispatch.watchdog;
    // I-19：等审批 / 等回答期间会话静止是正常的，不产生停滞提醒。
    const waitingHuman = input.hardStatus === 'awaiting_approval' || input.hardStatus === 'awaiting_answer';
    if (config.watchdog.enabled &&
        watchdog &&
        !watchdog.quiet &&
        !waitingHuman &&
        isOpenDispatch(dispatch)) {
        const anchor = Math.max(cursor.lastProgressAt ?? 0, input.lastActivityAt ?? 0, dispatch.acceptedAt ?? dispatch.createdAt);
        // I-20：已经报过一次「阶段结束」的派发，说明它大概率干完了，只是没人收尾。
        // 这种情况下把巡检间隔退避到 2 倍，降低「没进展」的噪音频率。
        const backoff = (cursor.stageEnds ?? 0) >= 1 ? 2 : 1;
        const pollMs = Math.max(1, Math.round(watchdog.pollMinutes)) * 60_000 * backoff;
        const elapsed = now - anchor;
        if (elapsed >= pollMs) {
            const signature = watchdogSignature(anchor, elapsed, pollMs);
            if (!isNotified(cursor, signature)) {
                const minutes = Math.max(1, Math.round(elapsed / 60_000));
                const suspect = Boolean(dispatch.suspectDoneAt) || (cursor.stageEnds ?? 0) >= 1;
                events.push({
                    kind: 'watchdog',
                    signatures: [signature],
                    category: 'dispatch',
                    // I-20：疑似完成时别再问「做到哪了」，直接问要不要销账。
                    title: suspect
                        ? `${title}：看起来已经干完了，要不要销账`
                        : `${title}：${minutes} 分钟没有进展`,
                    detail: suspect
                        ? 'worker 报过完成或阶段已结束；确认无误就点「标记完成」，还在干活就忽略。'
                        : '要不要问一下它现在做到哪了？',
                    real: false,
                });
            }
        }
    }
    return events;
}
/** 推进游标（纯函数，返回新对象）。service 只负责把它写回 dispatch。 */
export function advanceCursor(input) {
    const base = input.cursor ?? { notified: [] };
    const notified = [...(base.notified ?? [])];
    let stageEnds = base.stageEnds ?? 0;
    let lastProgressAt = base.lastProgressAt;
    let lastMilestoneAt = base.lastMilestoneAt;
    let lastWatchdogAt = base.lastWatchdogAt;
    let real = Boolean(input.activity);
    for (const event of input.events) {
        for (const signature of event.signatures) {
            if (!signature)
                continue;
            if (!notified.includes(signature))
                notified.push(signature);
        }
        if (event.real)
            real = true;
        if (event.kind === 'milestone')
            lastMilestoneAt = input.now;
        if (event.kind === 'stage_end')
            stageEnds += 1;
        if (event.kind === 'watchdog')
            lastWatchdogAt = input.now;
    }
    if (real)
        lastProgressAt = input.now;
    return {
        ...base,
        notified: notified.slice(-NOTIFIED_LIMIT),
        lastProgressAt,
        lastMilestoneAt,
        lastRunning: input.running,
        lastDoneCount: input.doneCount,
        lastTurnEndAt: Math.max(base.lastTurnEndAt ?? 0, input.lastTurnEndAt ?? 0) || undefined,
        lastWatchdogAt,
        stageEnds,
    };
}
/** 把 done 列表映射成去重后的里程碑签名（空条目丢弃）。 */
function doneSignatures(done) {
    const notified = [];
    for (const item of done ?? []) {
        const text = String(item ?? '').trim();
        if (!text)
            continue;
        const signature = milestoneSignature(text);
        if (!notified.includes(signature))
            notified.push(signature);
    }
    return notified;
}
/** 老派发第一次被扫描时播种：把当前已有的 done 记成已报，避免升级后补报历史。 */
export function seedCursor(now, soft, running) {
    return {
        notified: doneSignatures(soft?.done).slice(-NOTIFIED_LIMIT),
        lastProgressAt: now,
        lastRunning: running,
        lastDoneCount: soft?.done?.length ?? 0,
        lastTurnEndAt: now,
    };
}
/**
 * 新派发创建时的游标种子：把目标会话**当前已有**的 done 记成「已通知」。
 *
 * 派发记录新建时游标是空的，而目标会话常常还带着上一轮任务的 softStatus.done；
 * 不播种的话，第一次扫描会把历史里程碑当成这次任务的新进展补报一遍
 * （2026-11-09 的真实事故：新派发 dsp_b32e20ef848049d0 立刻补报上一轮的 5 项）。
 * 播种之后新增的 done 不在 notified 里，仍然照常推送。
 *
 * lastRunning / lastTurnEndAt 沿用 {@link initialCursor} 的语义：
 * 第一次 running 不算阶段结束，创建之前的 turn 结束也不算。
 */
export function seedDispatchCursor(now, done) {
    const cursor = initialCursor(now);
    return {
        ...cursor,
        notified: doneSignatures(done).slice(-NOTIFIED_LIMIT),
        lastDoneCount: done?.length ?? 0,
    };
}
// ---------------------------------------------------------------- B 复杂度粗估
const LIGHT_TASK = /只读|看一下|看看|查一下|查查|检查一下|总结|读一下|梳理|清点|probe|digest|review/i;
const HEAVY_TASK = /重构|迁移|实现|开发|新功能|全量|测试全绿|修复|排查|优化|接入|补齐|改造/;
function clampMinutes(value, limits) {
    return Math.min(limits.maxMinutes, Math.max(limits.minMinutes, value));
}
/**
 * 按任务文本粗估巡检频率。
 *
 * 只读/看一下 → 10 分钟就问；重构/实现/全量测试 → 30 分钟再问。
 * poll 取 expected 的一半，夹在 min/max 之间。
 */
export function estimateWatchdog(text, limits) {
    const raw = String(text ?? '');
    let expected = Math.max(10, limits.defaultPollMinutes * 2);
    if (raw.length > 120)
        expected += 10;
    if (raw.length > 400)
        expected += 10;
    if (HEAVY_TASK.test(raw))
        expected += 10;
    if (LIGHT_TASK.test(raw) && raw.length <= 120)
        expected = 10;
    expected = clampMinutes(expected, limits);
    const poll = clampMinutes(Math.round(expected / 2), limits);
    return { expectedMinutes: expected, pollMinutes: poll, source: 'estimate' };
}
/**
 * 合并「管家显式填的 watchdog」和「按文本粗估」。
 *
 * 管家只填 expectedMinutes 时 poll 取一半；什么都没填就整条走粗估。
 */
export function resolveWatchdog(raw, text, limits) {
    if (!limits.enabled)
        return undefined;
    const input = raw && typeof raw === 'object' ? raw : {};
    const expectedRaw = Number(input.expectedMinutes);
    const pollRaw = Number(input.pollMinutes);
    const hasExpected = Number.isFinite(expectedRaw) && expectedRaw > 0;
    const hasPoll = Number.isFinite(pollRaw) && pollRaw > 0;
    if (!hasExpected && !hasPoll && input.quiet !== true) {
        return estimateWatchdog(text, limits);
    }
    const expected = hasExpected ? clampMinutes(Math.round(expectedRaw), limits) : undefined;
    const poll = hasPoll
        ? clampMinutes(Math.round(pollRaw), limits)
        : clampMinutes(Math.round((expected ?? limits.defaultPollMinutes * 2) / 2), limits);
    return {
        expectedMinutes: expected,
        pollMinutes: poll,
        quiet: input.quiet === true ? true : undefined,
        source: hasExpected || hasPoll ? 'butler' : 'estimate',
    };
}
/**
 * 要不要因为这次进度事件唤醒管家。
 *
 * 防自激靠四道闸，任何一道不满足都不唤醒：
 * 1. **类型闸**：只有 `kinds` 里的类型（默认 stage_end / watchdog）才唤醒——纯里程碑绝不唤醒；
 * 2. **签名闸**：同一 dispatch 同一签名只唤醒一次（落盘在 `dispatch.progress.woke`）；
 * 3. **配额闸**：同一 dispatch 最多 `maxPerDispatch` 次；
 * 4. **节流闸**：两次唤醒至少间隔 `minGapMs`，且管家正在跑的时候不唤醒。
 *
 * 之所以是**有界**的：唤醒会让管家进入 running，于是闸 4 天然挡住并发唤醒；
 * 每次唤醒都消耗配额，配额用完这条 dispatch 再也不会唤醒；而唤醒后管家要么推动、
 * 要么结束派发，派发一旦收尾就不再产生进度事件（evaluateProgress 里 isOpenDispatch 早退）。
 */
export function decideWake(input) {
    if (!input.enabled)
        return { wake: false, reason: 'disabled' };
    if (input.butlerRunning)
        return { wake: false, reason: 'butler_running' };
    const eligible = input.events.filter((event) => input.kinds.includes(event.kind) &&
        !input.woke.includes(event.signatures[0] ?? ''));
    if (eligible.length === 0)
        return { wake: false, reason: 'no_eligible_event' };
    if (input.wakeCount >= input.maxPerDispatch)
        return { wake: false, reason: 'dispatch_capped' };
    if (input.lastWakeAt > 0 && input.now - input.lastWakeAt < input.minGapMs) {
        return { wake: false, reason: 'throttled' };
    }
    const event = eligible[0];
    return {
        wake: true,
        signature: event.signatures[0] ?? `${event.kind}:${event.title}`,
        kind: event.kind,
        title: event.title,
    };
}
