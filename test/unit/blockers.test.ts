import { test } from 'node:test'
import assert from 'node:assert/strict'

import { detectBlockers, interruptedQuestion, type BlockerContext } from '../../src/blockers.js'
import { createRuntime } from '../../src/status.js'
import { DEFAULT_CONFIG, type Approval, type Config, type Dispatch, type Plan } from '../../src/types.js'
import { hash } from '../../src/util.js'

const NOW = 1_700_000_000_000

const CONFIG: Config = {
  ...DEFAULT_CONFIG,
  repeatWindowMs: 600_000,
  repeatFailureThreshold: 3,
  repeatToolCallThreshold: 3,
  editThrashThreshold: 3,
  runningStallMs: 600_000,
  idleStallMs: 3_600_000,
}

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'plan_1',
    sessionId: 's1',
    dispatchId: 'd1',
    title: 'Refactor the parser',
    markdown: '# plan',
    scope: { items: [] },
    status: 'pending_review',
    submittedAt: NOW - 1_000,
    source: 'butler_submit_plan',
    ...overrides,
  }
}

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: 'ap1',
    sessionId: 's1',
    toolName: 'bash',
    argsSummary: 'rm -rf build',
    risk: 'high',
    status: 'pending',
    createdAt: NOW - 1_000,
    ...overrides,
  }
}

function context(overrides: Partial<BlockerContext> = {}): BlockerContext {
  return {
    sessionId: 's1',
    sessionTitle: 'Worker',
    runtime: createRuntime('s1'),
    live: { available: true, running: false },
    hardStatus: 'idle',
    pendingApprovals: [],
    config: CONFIG,
    now: NOW,
    lastActivityAt: NOW - 1_000,
    ...overrides,
  }
}

function failureRuntime(at: number[]) {
  const runtime = createRuntime('s1')
  for (const time of at) {
    runtime.failureRing.push({
      signature: 'bash:abc:1:def',
      at: time,
      toolName: 'bash',
      subkind: 'test',
      summary: 'npm test -> exit 1',
    })
  }
  return runtime
}

test('pending approvals become approval blockers with risk-derived severity', () => {
  const blockers = detectBlockers(
    context({ pendingApprovals: [makeApproval()] }),
  )
  assert.equal(blockers.length, 1)
  const [blocker] = blockers
  assert.equal(blocker.kind, 'approval')
  assert.equal(blocker.severity, 'critical')
  assert.equal(blocker.signature, 'approval:ap1')
  assert.equal(blocker.relatedApprovalId, 'ap1')
  assert.match(blocker.summary, /在等审批：bash/)
  assert.equal((blocker.evidence as any).toolName, 'bash')

  const [low] = detectBlockers(
    context({ pendingApprovals: [makeApproval({ id: 'ap2', risk: 'low' })] }),
  )
  assert.equal(low.severity, 'warning')
})

test('open questions become question blockers', () => {
  const runtime = createRuntime('s1')
  runtime.questions.set('q1', {
    callId: 'q1',
    questions: [{ header: '选择', question: 'A 还是 B？' }],
    at: NOW - 1_000,
    state: 'open',
  })
  const blockers = detectBlockers(context({ runtime }))
  assert.equal(blockers.length, 1)
  assert.equal(blockers[0].kind, 'question')
  assert.equal(blockers[0].severity, 'warning')
  assert.equal(blockers[0].signature, 'question:q1')
  assert.match(blockers[0].summary, /选择: A 还是 B？/)
  assert.equal(blockers[0].relatedCallId, 'q1')
})

test('a pending plan becomes a plan_review blocker', () => {
  const blockers = detectBlockers(context({ pendingPlan: makePlan() }))
  assert.equal(blockers.length, 1)
  assert.equal(blockers[0].kind, 'plan_review')
  assert.equal(blockers[0].signature, 'plan:plan_1')
  assert.equal(blockers[0].relatedPlanId, 'plan_1')
  assert.match(blockers[0].summary, /提交了计划：Refactor the parser/)
})

test('repeated identical failures become a blocker at the configured threshold', () => {
  const blockers = detectBlockers(
    context({ runtime: failureRuntime([NOW - 3_000, NOW - 2_000, NOW - 1_000]) }),
  )
  const repeated = blockers.filter((blocker) => blocker.kind === 'repeated_failure')
  assert.equal(repeated.length, 1)
  assert.equal(repeated[0].subkind, 'test')
  assert.equal(repeated[0].severity, 'critical')
  assert.equal((repeated[0].evidence as any).count, 3)

  const below = detectBlockers(
    context({ runtime: failureRuntime([NOW - 2_000, NOW - 1_000]) }),
  )
  assert.equal(below.filter((blocker) => blocker.kind === 'repeated_failure').length, 0)
})

test('editing the same file repeatedly becomes an edit_thrash blocker', () => {
  const runtime = createRuntime('s1')
  for (const time of [NOW - 3_000, NOW - 2_000, NOW - 1_000]) {
    runtime.editRing.push({ path: '/proj/src/a.ts', at: time })
  }
  const blockers = detectBlockers(context({ runtime }))
  const thrash = blockers.find((blocker) => blocker.subkind === 'edit_thrash')
  assert.ok(thrash)
  assert.equal(thrash!.kind, 'repeated_failure')
  assert.match(thrash!.signature, /^edit:[0-9a-f]{16}$/)
  assert.match(thrash!.summary, /反复改同一个文件/)
})

test('a passing test after the first edit suppresses edit_thrash', () => {
  const runtime = createRuntime('s1')
  for (const time of [NOW - 3_000, NOW - 2_000, NOW - 1_000]) {
    runtime.editRing.push({ path: '/proj/src/a.ts', at: time })
  }
  runtime.lastTestSuccessAt = NOW - 2_000
  const blockers = detectBlockers(context({ runtime }))
  assert.equal(blockers.filter((blocker) => blocker.subkind === 'edit_thrash').length, 0)
})

test('repeated identical tool calls become a loop blocker', () => {
  const runtime = createRuntime('s1')
  for (const [index, time] of [NOW - 3_000, NOW - 2_000, NOW - 1_000].entries()) {
    const callId = `c${index}`
    runtime.toolCalls.set(callId, {
      callId,
      name: 'read',
      args: { file_path: '/proj/src/a.ts' },
      at: time,
    })
  }
  const blockers = detectBlockers(context({ runtime }))
  const loop = blockers.find((blocker) => blocker.subkind === 'loop')
  assert.ok(loop)
  assert.equal(loop!.kind, 'repeated_failure')
  assert.match(loop!.signature, /^loop:read:[0-9a-f]{16}$/)
  assert.match(loop!.summary, /在重复调用 read（3 次）/)
})

test('an interrupted hard status becomes an interrupted blocker', () => {
  const runtime = createRuntime('s1')
  runtime.openTurnStartSeq = 4
  const blockers = detectBlockers(context({ runtime, hardStatus: 'interrupted' }))
  const interrupted = blockers.find((blocker) => blocker.kind === 'interrupted')
  assert.ok(interrupted)
  assert.equal(interrupted!.severity, 'critical')
  assert.equal(interrupted!.signature, 'interrupted:4')
  assert.equal(interrupted!.relatedTurn, 4)
})

test('soft status decisions become decision blockers', () => {
  const runtime = createRuntime('s1')
  runtime.softStatus = {
    goal: 'ship',
    done: [],
    next: ['next step'],
    blockers: [],
    decisions: ['用 A 还是 B？'],
    reportedAt: NOW - 1_000,
    source: 'tool',
  }
  const blockers = detectBlockers(context({ runtime }))
  const decision = blockers.find((blocker) => blocker.kind === 'decision')
  assert.ok(decision)
  assert.match(decision!.signature, /^decision:[0-9a-f]{16}$/)
  assert.match(decision!.summary, /需要你拍板：用 A 还是 B？/)
})

test('detectBlockers is deterministic and deduplicated for the same state', () => {
  const runtime = failureRuntime([NOW - 3_000, NOW - 2_000, NOW - 1_000])
  runtime.questions.set('q1', {
    callId: 'q1',
    questions: [{ question: '继续吗？' }],
    at: NOW - 1_000,
    state: 'open',
  })
  runtime.openTurnStartSeq = 2
  runtime.softStatus = {
    goal: 'ship',
    done: [],
    next: [],
    blockers: [],
    decisions: ['用 A'],
    reportedAt: NOW - 1_000,
    source: 'tool',
  }
  const ctx = context({
    runtime,
    hardStatus: 'interrupted',
    pendingApprovals: [makeApproval()],
    pendingPlan: makePlan(),
  })
  const first = detectBlockers(ctx)
  const second = detectBlockers(ctx)
  assert.deepEqual(first, second)
  const signatures = first.map((blocker) => blocker.signature)
  assert.equal(new Set(signatures).size, signatures.length)
  assert.deepEqual(
    signatures.sort(),
    [
      'approval:ap1',
      `decision:${hash('用 A')}`,
      'failure:bash:abc:1:def',
      'interrupted:2',
      'plan:plan_1',
      'question:q1',
    ].sort(),
  )
})

test('a healthy idle session yields no blockers', () => {
  assert.deepEqual(detectBlockers(context()), [])
})

// ---------------------------------------------------------------- R1/R3/R4

function makeDispatch(overrides: Partial<Dispatch> = {}): Dispatch {
  return {
    id: 'd1',
    text: '改一下扫描',
    targetSessionId: 's1',
    workspaceKey: 'proj',
    mode: 'reuse',
    modeAtDispatch: 'plan_review',
    requestId: 'req',
    status: 'error',
    reason: 'test',
    relatedSessionIds: [],
    createdAt: NOW - 10 * 60_000,
    ...overrides,
  }
}

test('R3 turn 报错生成 error 卡点，错误原文进证据', () => {
  const runtime = createRuntime('s1')
  runtime.lastTurnEnd = {
    kind: 'error',
    at: NOW - 1_000,
    error: 'Tool call "butler_report_status": Unexpected token 已, is not valid JSON',
    errorCode: 'INVALID_TOOL_OUTPUT',
  }
  const blockers = detectBlockers(context({ runtime, hardStatus: 'error' }))
  const error = blockers.find((item) => item.kind === 'error')
  assert.ok(error, 'turn 报错必须有一条 error 卡点')
  assert.equal(error!.signature.startsWith('turn_error:'), true)
  assert.match(error!.summary, /上一轮报错/)
  assert.match(String((error!.evidence as any).error), /Unexpected token/)
  assert.equal((error!.evidence as any).errorCode, 'INVALID_TOOL_OUTPUT')
})

test('R1 派发已中止且没有待审计划：出「中止但没审计划」卡点而不是静默', () => {
  const blockers = detectBlockers(
    context({
      currentDispatch: undefined,
      abortedDispatch: makeDispatch({ status: 'failed', error: 'turn error' }),
    }),
  )
  const aborted = blockers.find((item) => item.signature.startsWith('aborted_plan:'))
  assert.ok(aborted)
  assert.equal(aborted!.kind, 'error')
  assert.match(aborted!.summary, /任务在计划审查前中止/)
  assert.match(String((aborted!.evidence as any).error), /turn error/)
})

test('R4 turn 被中断时，被打断的问题正文留在卡点里', () => {
  const runtime = createRuntime('s1')
  runtime.openTurnStartSeq = 12
  runtime.toolCalls.set('call_q', {
    callId: 'call_q',
    name: 'ask_user_question',
    args: { questions: [{ header: '范围', question: '要改哪几个文件？' }] },
    at: NOW - 1_000,
    result: { isError: true, text: 'TOOL_OUTCOME_UNKNOWN', at: NOW - 500 },
  })
  const blockers = detectBlockers(context({ runtime, hardStatus: 'interrupted' }))
  const interrupted = blockers.find((item) => item.kind === 'interrupted')
  assert.ok(interrupted)
  assert.match(interrupted!.summary, /被打断的问题：范围: 要改哪几个文件？/)
  assert.equal((interrupted!.evidence as any).question, '范围: 要改哪几个文件？')
  assert.equal((interrupted!.evidence as any).callId, 'call_q')
})

test('R4 正常回答过的问题不会被当成「被打断」', () => {
  const runtime = createRuntime('s1')
  runtime.openTurnStartSeq = 12
  runtime.toolCalls.set('call_q', {
    callId: 'call_q',
    name: 'ask_user_question',
    args: { questions: [{ header: '范围', question: '要改哪几个文件？' }] },
    at: NOW - 1_000,
    result: { isError: false, text: 'answers...', at: NOW - 500 },
  })
  const question = interruptedQuestion(runtime, NOW)
  assert.equal(question, undefined)
})
