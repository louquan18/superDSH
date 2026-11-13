import type {
  Approval,
  Blocker,
  BlockerKind,
  ButlerNotice,
  ButlerNoticeAction,
  ButlerNoticeSource,
  Config,
  Dispatch,
  HardStatus,
  Plan,
} from './types.js'
import type { SessionRuntime } from './status.js'
import { recentFailureGroups, repeatedToolCalls } from './status.js'
import { planExcerpt, planSummary } from './plans.js'
import { firstLine, hash, truncate, uuid } from './util.js'

export interface DetectedBlocker {
  kind: BlockerKind
  subkind?: 'test' | 'error' | 'edit_thrash' | 'running_stall' | 'idle_stall' | 'loop'
  severity: 'info' | 'warning' | 'critical'
  signature: string
  summary: string
  neededAction: string
  evidence: any
  relatedPlanId?: string
  relatedApprovalId?: string
  relatedCallId?: string
  relatedTurn?: number
}

export interface BlockerContext {
  sessionId: string
  sessionTitle: string
  runtime: SessionRuntime
  live: { available: boolean; running: boolean }
  hardStatus: HardStatus
  currentDispatch?: Dispatch
  /** 最近一条派发已中止（failed），用来补「任务中止但计划没审」的卡点。 */
  abortedDispatch?: Dispatch
  pendingPlan?: Plan
  pendingApprovals?: Approval[]
  config: Config
  now: number
  lastActivityAt: number
}

function firstQuestion(runtime: SessionRuntime): any[] {
  const question = [...runtime.questions.values()].sort((a, b) => a.at - b.at)[0]
  return question?.questions ?? []
}

function questionText(questions: any[]): string {
  const first = questions[0]
  if (!first) return '有一个问题等你回答'
  const header = first.header ? `${first.header}: ` : ''
  return `${header}${truncate(String(first.question ?? ''), 200)}`
}

/**
 * 最近一个「被打断的 ask_user_question」。
 *
 * 正常回答完会落一条成功结果；结果缺失或结果本身是错误（`TOOL_OUTCOME_UNKNOWN`、
 * turn 被重启）时问题正文就没人记得了，卡点必须把它带上，否则用户只看到「turn 被中断」。
 */
export function interruptedQuestion(
  runtime: SessionRuntime,
  at: number,
): { callId: string; questions: any[] } | undefined {
  const calls = [...runtime.toolCalls.values()]
    .filter((call) => call.name === 'ask_user_question')
    .sort((a, b) => b.at - a.at)
  for (const call of calls) {
    const questions = Array.isArray(call.args?.questions) ? call.args.questions : []
    if (questions.length === 0) continue
    if (call.result && !call.result.isError) continue
    if (at - call.at > 6 * 60 * 60_000) continue
    return { callId: call.callId, questions }
  }
  return undefined
}

export function detectBlockers(ctx: BlockerContext): DetectedBlocker[] {
  const out: DetectedBlocker[] = []
  const hasHardWait =
    ctx.hardStatus === 'awaiting_approval' ||
    ctx.hardStatus === 'awaiting_answer' ||
    ctx.hardStatus === 'interrupted'
  const hasPlanWait = ctx.pendingPlan != null

  for (const approval of ctx.pendingApprovals ?? []) {
    out.push({
      kind: 'approval',
      severity:
        approval.risk === 'high' || approval.risk === 'unknown' ? 'critical' : 'warning',
      signature: `approval:${approval.id}`,
      // 卡点卡片和提醒都要能直接看出「要跑什么、为什么要你批」，不用再点进去查。
      summary: `${ctx.sessionTitle} 在等审批：${approval.toolName}${
        approval.argsSummary ? ` \`${truncate(approval.argsSummary.replace(/\s+/g, ' '), 120)}\`` : ''
      }`,
      neededAction: approval.reason
        ? `${approval.reason}。允许或拒绝`
        : `允许或拒绝 ${approval.toolName}`,
      evidence: {
        toolName: approval.toolName,
        callId: approval.callId,
        risk: approval.risk,
        planId: approval.planId,
        planItemId: approval.planItemId,
        argsSummary: approval.argsSummary,
      },
      relatedApprovalId: approval.id,
      relatedCallId: approval.callId,
    })
  }

  for (const question of ctx.runtime.questions.values()) {
    out.push({
      kind: 'question',
      severity: 'warning',
      signature: `question:${question.callId}`,
      summary: `${ctx.sessionTitle} 在等你回答：${questionText(question.questions)}`,
      neededAction: '回答问题；答完会转发给该 session',
      evidence: { callId: question.callId, questions: question.questions },
      relatedCallId: question.callId,
    })
  }

  if (ctx.pendingPlan) {
    const plan = ctx.pendingPlan
    out.push({
      kind: 'plan_review',
      severity: 'warning',
      signature: `plan:${plan.id}`,
      // 摘要里就带上范围和正文首行：管家在对话里看到这条就知道方案在讲什么，
      // 不用再点进去翻（「方案只在工具参数里」那次就是这里缺信息）。
      summary: `${ctx.sessionTitle} 提交了计划：${plan.title}（${planSummary(plan)}）${
        ctx.abortedDispatch && ctx.abortedDispatch.id === plan.dispatchId
          ? '｜任务已中止，批准后需要重派'
          : ''
      }`,
      neededAction: '批准、提修改意见或驳回',
      evidence: {
        planId: plan.id,
        planTitle: plan.title,
        // I-33：卡片上一眼可见「几条计划、几条路径」
        planStats: planSummary(plan),
        dispatchId: plan.dispatchId,
        title: plan.title,
        planSummary: planSummary(plan),
        planExcerpt: planExcerpt(plan, 240),
      },
      relatedPlanId: plan.id,
    })
  }

  const failureGroups = recentFailureGroups(
    ctx.runtime,
    ctx.config.repeatWindowMs,
    ctx.config.repeatFailureThreshold,
    ctx.now,
  )
  for (const group of failureGroups) {
    const latest = group.latest
    out.push({
      kind: 'repeated_failure',
      subkind: latest.subkind ?? 'error',
      severity: latest.subkind === 'test' ? 'critical' : 'warning',
      signature: `failure:${group.signature}`,
      summary: `${ctx.sessionTitle} 反复失败 ${group.count} 次：${latest.summary}`,
      neededAction: '查看失败详情，决定重试、改派或停止',
      evidence: {
        count: group.count,
        toolName: latest.toolName,
        latestSummary: latest.summary,
      },
    })
  }

  const editCounts = new Map<string, { count: number; first: number; last: number }>()
  for (const edit of ctx.runtime.editRing) {
    const current = editCounts.get(edit.path)
    if (current) {
      current.count += 1
      current.last = edit.at
    } else {
      editCounts.set(edit.path, { count: 1, first: edit.at, last: edit.at })
    }
  }
  for (const [file, info] of editCounts) {
    if (info.count < ctx.config.editThrashThreshold) continue
    const successAfter =
      ctx.runtime.lastTestSuccessAt != null && ctx.runtime.lastTestSuccessAt >= info.first
    if (successAfter) continue
    out.push({
      kind: 'repeated_failure',
      subkind: 'edit_thrash',
      severity: 'warning',
      signature: `edit:${hash(file)}`,
      summary: `${ctx.sessionTitle} 在反复改同一个文件：${file}（${info.count} 次）`,
      neededAction: '看看是否在原地打转；决定继续、改派或停止',
      evidence: { file, count: info.count, firstAt: info.first, lastAt: info.last },
    })
  }

  const loops = repeatedToolCalls(
    ctx.runtime,
    ctx.config.repeatWindowMs,
    ctx.config.repeatToolCallThreshold,
    ctx.now,
  )
  for (const loop of loops) {
    out.push({
      kind: 'repeated_failure',
      subkind: 'loop',
      severity: 'warning',
      signature: `loop:${loop.signature}`,
      summary: `${ctx.sessionTitle} 在重复调用 ${loop.call.name}（${loop.count} 次）`,
      neededAction: '查看是否卡住；决定继续、改派或停止',
      evidence: { toolName: loop.call.name, args: loop.call.args, count: loop.count },
      relatedCallId: loop.call.callId,
    })
  }

  if (!hasHardWait && !hasPlanWait) {
    if (
      ctx.live.running &&
      ctx.lastActivityAt > 0 &&
      ctx.now - ctx.lastActivityAt > ctx.config.runningStallMs
    ) {
      out.push({
        kind: 'stall',
        subkind: 'running_stall',
        severity: 'critical',
        signature: `stall:running:${ctx.runtime.openTurnStartSeq ?? 'tail'}`,
        summary: `${ctx.sessionTitle} 在运行但 ${Math.round(
          (ctx.now - ctx.lastActivityAt) / 60_000,
        )} 分钟没有事件`,
        neededAction: '检查是否卡住；可以中断、重试或改派',
        evidence: { lastActivityAt: ctx.lastActivityAt, running: true },
      })
    } else if (
      !ctx.live.running &&
      ctx.currentDispatch &&
      ctx.runtime.softStatus?.next?.length &&
      ctx.lastActivityAt > 0 &&
      ctx.now - ctx.lastActivityAt > ctx.config.idleStallMs
    ) {
      out.push({
        kind: 'stall',
        subkind: 'idle_stall',
        severity: 'warning',
        signature: `stall:idle:${ctx.currentDispatch.id}`,
        summary: `${ctx.sessionTitle} 有未完成任务但 ${Math.round(
          (ctx.now - ctx.lastActivityAt) / 60_000,
        )} 分钟没有活动`,
        neededAction: '看看下一步是什么；决定催办、改派或停止',
        evidence: {
          dispatchId: ctx.currentDispatch.id,
          next: ctx.runtime.softStatus.next,
          lastActivityAt: ctx.lastActivityAt,
        },
      })
    }
  }

  // 派发中止了却没人审过计划：不许静默（这次事故的兜底）。
  if (
    !ctx.currentDispatch &&
    ctx.abortedDispatch &&
    ctx.abortedDispatch.status === 'failed' &&
    !ctx.pendingPlan
  ) {
    out.push({
      kind: 'error',
      subkind: 'error',
      severity: 'warning',
      signature: `aborted_plan:${ctx.abortedDispatch.id}`,
      summary: `${ctx.sessionTitle}：任务在计划审查前中止（${truncate(
        ctx.abortedDispatch.error ?? '上一轮报错',
        120,
      )}）`,
      neededAction: '看方案/错误原因，决定重派、补审计划或收尾',
      evidence: {
        dispatchId: ctx.abortedDispatch.id,
        error: ctx.abortedDispatch.error,
        text: truncate(ctx.abortedDispatch.text, 300),
      },
    })
  }

  if (ctx.hardStatus === 'interrupted') {
    // 被打断的提问：问题正文必须留在卡点里，否则用户只看到「turn 被中断」。
    const pending = interruptedQuestion(ctx.runtime, ctx.now)
    const pendingText = pending ? questionText(pending.questions) : ''
    out.push({
      kind: 'interrupted',
      severity: 'critical',
      signature: `interrupted:${ctx.runtime.openTurnStartSeq ?? 'tail'}`,
      summary: pendingText
        ? `${ctx.sessionTitle} 的 turn 被中断，被打断的问题：${pendingText}`
        : `${ctx.sessionTitle} 的 turn 被中断/崩溃${ctx.live.available ? '' : '（session 当前是冷的）'}`,
      neededAction: pendingText
        ? `先回答这个问题（正文见证据），再决定重试或改派：${pendingText}`
        : '重试、改派，或标记已处理',
      evidence: {
        openTurnStartSeq: ctx.runtime.openTurnStartSeq,
        lastTurnEnd: ctx.runtime.lastTurnEnd,
        question: pendingText || undefined,
        questions: pending?.questions?.slice(0, 3),
        callId: pending?.callId,
      },
      relatedCallId: pending?.callId,
      relatedTurn: ctx.runtime.openTurnStartSeq ?? undefined,
    })
  }

  // 上一轮 turn 报错（可恢复）：错误原文必须进证据。
  // 派发已经中止时由上面的 aborted_plan 卡点覆盖，不重复出两张。
  if (ctx.hardStatus === 'error' && !ctx.live.running && !ctx.abortedDispatch) {
    const last = ctx.runtime.lastTurnEnd
    const errorText = truncate(last?.error ?? '上一轮报错', 240)
    out.push({
      kind: 'error',
      subkind: 'error',
      severity: 'critical',
      signature: `turn_error:${hash(`${last?.errorCode ?? ''}:${last?.error ?? ''}`)}`,
      summary: `${ctx.sessionTitle} 上一轮报错：${errorText}`,
      neededAction: '看错误原文，决定重试、让 worker 改参数后继续，或改派',
      evidence: {
        error: last?.error,
        errorCode: last?.errorCode,
        at: last?.at,
        openTurnStartSeq: ctx.runtime.openTurnStartSeq,
      },
      relatedTurn: ctx.runtime.openTurnStartSeq ?? undefined,
    })
  }

  for (const decision of ctx.runtime.softStatus?.decisions ?? []) {
    out.push({
      kind: 'decision',
      severity: 'warning',
      signature: `decision:${hash(decision)}`,
      summary: `${ctx.sessionTitle} 需要你拍板：${truncate(decision, 200)}`,
      neededAction: '回答这个决策；管家会转发',
      evidence: { decision },
    })
  }

  return out
}

// ---------------------------------------------------------------- 提醒卡片

/** 卡片标题里的卡点中文名。 */
export const NOTICE_KIND_LABEL: Record<BlockerKind, string> = {
  approval: '等审批',
  question: '等你回答',
  plan_review: '计划待审',
  repeated_failure: '反复失败',
  stall: '停滞',
  interrupted: '中断',
  decision: '待你拍板',
  error: '出错',
  settle_suggest: '疑似完成',
}

/**
 * 宿主（`service.resolveBlocker`）真正能处理「回答」的卡点类型。
 *
 * 客户端按它渲染「回答」按钮：能回答的类型才给按钮，避免出现「点了没反应」的卡片。
 */
export const ANSWERABLE_KINDS: ReadonlySet<BlockerKind> = new Set<BlockerKind>([
  'question',
  'decision',
  'plan_review',
])

/** 从 ask_user 的 evidence 里取候选项标签，最多 6 个。 */
export function questionOptionLabels(blocker: Blocker): string[] | undefined {
  const questions = blocker.evidence?.questions
  if (!Array.isArray(questions)) return undefined
  const labels: string[] = []
  for (const question of questions) {
    const options = question?.options
    if (!Array.isArray(options)) continue
    for (const option of options) {
      const label = typeof option === 'string' ? option : String(option?.label ?? '')
      if (label && !labels.includes(label)) labels.push(label)
    }
  }
  return labels.length > 0 ? labels.slice(0, 6) : undefined
}

/**
 * 一个卡点该给用户哪些按钮。
 *
 * 只描述「用户能做什么」，不关心界面长什么样；客户端按 verb 落回已有的
 * `blocker_action` / `dispatch_mark` 动作。
 */
export function noticeActionsFor(
  blocker: Blocker,
  options: { dispatchInProgress?: boolean } = {},
): ButlerNoticeAction[] {
  const actions: ButlerNoticeAction[] = []
  switch (blocker.kind) {
    case 'approval':
      actions.push({ verb: 'approve', label: '允许一次', style: 'primary' })
      actions.push({ verb: 'reject', label: '拒绝', style: 'danger' })
      break
    case 'plan_review':
      actions.push({ verb: 'approve', label: '批准', style: 'primary' })
      actions.push({
        verb: 'answer',
        label: '提修改意见',
        requiresText: true,
        placeholder: '哪里要改？会转给该 worker',
      })
      actions.push({
        verb: 'reject',
        label: '驳回',
        style: 'danger',
        requiresText: true,
        placeholder: '驳回原因（必填）',
      })
      // I-33：不新造通道，只加一个只读展开入口；正文按需拉，不塞进每次快照轮询。
      actions.push({ verb: 'open_plan', label: '查看完整方案' })
      break
    case 'question':
    case 'decision':
      if (ANSWERABLE_KINDS.has(blocker.kind)) {
        actions.push({
          verb: 'answer',
          label: '回答',
          style: 'primary',
          requiresText: true,
          placeholder: '输入回答，会转发给该 session',
        })
      }
      break
    case 'stall':
    case 'interrupted':
    case 'repeated_failure':
    case 'error':
      actions.push({ verb: 'retry', label: blocker.kind === 'stall' ? '催办' : '重试', style: 'primary' })
      break
    case 'settle_suggest':
      // 只是建议：点了才销账，绝不自动。按钮复用已有的 dispatch_completed 链路
      // （客户端会带着 notice.dispatchId 调 dispatch_mark）。
      actions.push({ verb: 'dispatch_completed', label: '确认完成，销账', style: 'primary' })
      actions.push({ verb: 'dismiss', label: '还在干，继续观察' })
      return actions
    default:
      break
  }
  if (options.dispatchInProgress) {
    actions.push({ verb: 'dispatch_completed', label: '标记完成' })
    actions.push({ verb: 'dispatch_failed', label: '放弃任务', style: 'danger' })
  }
  actions.push({ verb: 'dismiss', label: '忽略' })
  return actions
}

/** 把一个卡点变成一条可交互提醒。 */
export function buildBlockerNotice(
  blocker: Blocker,
  context: {
    sessionTitle?: string
    dispatchId?: string
    dispatchInProgress?: boolean
    now?: number
  } = {},
): ButlerNotice {
  const sessionTitle =
    context.sessionTitle && context.sessionTitle.length > 0
      ? context.sessionTitle
      : blocker.sessionId.slice(0, 8)
  const label = NOTICE_KIND_LABEL[blocker.kind] ?? blocker.kind
  const evidence = blocker.evidence ?? {}
  // I-33：计划卡片要能一眼看出「几件事、几个文件」，而不是只有一段正文。
  const planStats =
    blocker.kind === 'plan_review' && typeof evidence.planStats === 'string'
      ? String(evidence.planStats)
      : ''
  const detailSource =
    typeof evidence.argsSummary === 'string' && evidence.argsSummary.length > 0
      ? evidence.argsSummary
      : typeof evidence.latestSummary === 'string' && evidence.latestSummary.length > 0
        ? evidence.latestSummary
        : typeof evidence.file === 'string'
          ? evidence.file
          : typeof evidence.planExcerpt === 'string' && evidence.planExcerpt.length > 0
            ? evidence.planExcerpt
            : typeof evidence.decision === 'string'
              ? evidence.decision
              : blocker.summary
  return {
    id: uuid(),
    at: context.now ?? Date.now(),
    kind: 'blocker',
    category: blocker.kind,
    severity: blocker.severity,
    sessionId: blocker.sessionId,
    source: blocker.source,
    sessionTitle,
    title: `${sessionTitle} · ${label}`,
    detail: truncate(planStats ? `${planStats}｜${firstLine(detailSource, 200)}` : firstLine(detailSource, 240), 240),
    neededAction: blocker.neededAction,
    blockerId: blocker.id,
    planId: blocker.relatedPlanId,
    approvalId: blocker.relatedApprovalId,
    dispatchId: context.dispatchId,
    callId: blocker.relatedCallId,
    options: questionOptionLabels(blocker),
    actions: noticeActionsFor(blocker, { dispatchInProgress: context.dispatchInProgress }),
  }
}

/** 包成写进 `user/message.source` 的形状；summary 是折叠行的一行话。 */
export function noticeSource(notice: ButlerNotice): ButlerNoticeSource {
  return {
    kind: 'superagent-notice',
    form: 'notice',
    summary: truncate(
      `${notice.title}${notice.neededAction ? `｜需要你：${notice.neededAction}` : ''}`,
      120,
    ),
    notice,
  }
}
