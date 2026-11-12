import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  addFailure,
  applySessionEvent,
  createRuntime,
  deriveHardStatus,
  foldSession,
  parseReportStatus,
  repeatedToolCalls,
} from '../../src/status.js'

function event(type: string, time: number, data: any = {}, seq?: number) {
  return { type, time, data, seq }
}

function toolCall(time: number, callId: string, name: string, args: any, seq?: number) {
  return event('tool/call', time, { callId, name, arguments: JSON.stringify(args) }, seq)
}

function toolResult(
  time: number,
  callId: string,
  text: string,
  options: { isError?: boolean; code?: string; error?: any } = {},
) {
  return event('tool/result', time, {
    message: {
      toolCallId: callId,
      isError: options.isError ?? false,
      content: [{ type: 'text', text }],
    },
    error: options.error ?? (options.code ? { code: options.code } : undefined),
  })
}

test('turn/start records the open turn and activity timestamps', () => {
  const runtime = foldSession('s1', [event('turn/start', 1_000, {}, 7)])
  assert.equal(runtime.openTurnStartSeq, 7)
  assert.equal(runtime.lastActivityAt, 1_000)
  assert.equal(runtime.lastEventAt, 1_000)
  assert.equal(runtime.eventCount, 1)
})

test('turn/end closes the open turn and records completion', () => {
  const runtime = foldSession('s1', [
    event('turn/start', 1_000, {}, 7),
    event('turn/end', 2_000, { reason: { kind: 'completed' } }),
  ])
  assert.equal(runtime.openTurnStartSeq, null)
  assert.deepEqual(runtime.lastTurnEnd, { kind: 'completed', at: 2_000, error: undefined, errorCode: undefined })
})

test('turn/end with an error records an error failure', () => {
  const runtime = foldSession('s1', [
    event('turn/end', 2_000, {
      reason: { kind: 'error', error: { code: 'E_BOOM', message: 'boom' } },
    }),
  ])
  assert.equal(runtime.lastTurnEnd?.kind, 'error')
  assert.equal(runtime.lastTurnEnd?.errorCode, 'E_BOOM')
  const [failure] = runtime.failureRing
  assert.equal(failure.toolName, 'turn')
  assert.equal(failure.subkind, 'error')
  assert.equal(failure.summary, 'boom')
  assert.match(failure.signature, /^turn:[0-9a-f]{16}$/)
})

test('approval/asked adds a pending approval and approval/decided removes it', () => {
  const runtime = foldSession('s1', [
    event('approval/asked', 1_000, { id: 'ap1', toolName: 'bash', callId: 'c1', reason: 'rm' }),
    event('approval/decided', 2_000, { id: 'ap1' }),
  ])
  assert.equal(runtime.approvals.size, 0)
  assert.equal(runtime.lastActivityAt, 2_000)

  const pending = foldSession('s1', [
    event('approval/asked', 1_000, { id: 'ap1', toolName: 'bash', callId: 'c1', reason: 'rm' }),
  ])
  assert.equal(pending.approvals.size, 1)
  assert.equal(pending.approvals.get('ap1')?.toolName, 'bash')
  assert.equal(pending.approvals.get('ap1')?.at, 1_000)
})

test('user/message events only advance activity counters', () => {
  const runtime = foldSession('s1', [
    event('user/message', 5_000, { message: { content: 'hello' } }),
  ])
  assert.equal(runtime.lastActivityAt, 5_000)
  assert.equal(runtime.eventCount, 1)
  assert.equal(runtime.openTurnStartSeq, null)
  assert.equal(runtime.failureRing.length, 0)
})

test('butler_report_status tool calls update the soft status', () => {
  const runtime = foldSession('s1', [
    toolCall(3_000, 'c1', 'butler_report_status', {
      goal: 'ship the feature',
      done: ['step one'],
      next: ['step two'],
      blockers: [],
      decisions: ['use A'],
    }),
  ])
  assert.ok(runtime.softStatus)
  assert.equal(runtime.softStatus!.goal, 'ship the feature')
  assert.deepEqual(runtime.softStatus!.done, ['step one'])
  assert.deepEqual(runtime.softStatus!.next, ['step two'])
  assert.deepEqual(runtime.softStatus!.decisions, ['use A'])
  assert.equal(runtime.softStatus!.reportedAt, 3_000)
  assert.equal(runtime.softStatus!.source, 'tool')
})

test('ask_user_question opens and closes a pending question', () => {
  const questions = [{ header: 'Choose', question: 'A or B?' }]
  const runtime = foldSession('s1', [toolCall(1_000, 'q1', 'ask_user_question', { questions })])
  assert.equal(runtime.questions.size, 1)
  assert.deepEqual(runtime.questions.get('q1')?.questions, questions)

  applySessionEvent(runtime, toolResult(2_000, 'q1', 'A'))
  assert.equal(runtime.questions.size, 0)
})

test('write tool calls append to the edit ring', () => {
  const runtime = foldSession('s1', [
    toolCall(1_000, 'w1', 'write', { file_path: '/proj/src/a.ts', content: 'x' }),
    toolCall(2_000, 'w2', 'edit', { path: '/proj/src/a.ts', new_string: 'y' }),
  ])
  assert.deepEqual(
    runtime.editRing.map((entry) => entry.path),
    ['/proj/src/a.ts', '/proj/src/a.ts'],
  )
})

test('failed bash results enter the failure ring with a test subkind when relevant', () => {
  const runtime = foldSession('s1', [
    toolCall(1_000, 'c1', 'bash', { command: 'npm test' }),
    toolResult(2_000, 'c1', 'FAIL src/a.test.ts\n[exit code: 2]'),
  ])
  assert.equal(runtime.failureRing.length, 1)
  const [failure] = runtime.failureRing
  assert.equal(failure.toolName, 'bash')
  assert.equal(failure.subkind, 'test')
  assert.match(failure.summary, /exit 2/)
  assert.match(failure.signature, /^bash:[0-9a-f]{16}:2:[0-9a-f]{16}$/)
})

test('a passing test bash call records success and clears the edit ring', () => {
  const runtime = foldSession('s1', [
    toolCall(1_000, 'w1', 'write', { file_path: '/proj/src/a.ts', content: 'x' }),
    toolCall(2_000, 'c1', 'bash', { command: 'npm test' }),
    toolResult(3_000, 'c1', 'all green [exit code: 0]'),
  ])
  assert.equal(runtime.lastTestSuccessAt, 3_000)
  assert.deepEqual(runtime.editRing, [])
  assert.equal(runtime.failureRing.length, 0)
})

test('errored tool results enter the failure ring', () => {
  const runtime = foldSession('s1', [
    toolCall(1_000, 'r1', 'read', { file_path: '/proj/missing.ts' }),
    toolResult(2_000, 'r1', 'ENOENT: no such file', { isError: true }),
  ])
  assert.equal(runtime.failureRing.length, 1)
  const [failure] = runtime.failureRing
  assert.equal(failure.toolName, 'read')
  assert.equal(failure.subkind, 'error')
  assert.match(failure.signature, /^tool:read:/)
})

test('repeatedToolCalls groups identical unfinished calls and ignores successes', () => {
  const args = { file_path: '/proj/src/a.ts' }
  const runtime = foldSession('s1', [
    toolCall(1_000, 'c1', 'read', args),
    toolCall(2_000, 'c2', 'read', args),
    toolCall(3_000, 'c3', 'read', args),
  ])
  const groups = repeatedToolCalls(runtime, 600_000, 3, 10_000)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].count, 3)
  assert.equal(groups[0].call.callId, 'c3')
  assert.match(groups[0].signature, /^read:[0-9a-f]{16}$/)

  // A successful call is not a loop candidate.
  applySessionEvent(runtime, toolResult(4_000, 'c1', 'ok'))
  assert.equal(repeatedToolCalls(runtime, 600_000, 3, 10_000).length, 0)
  assert.equal(repeatedToolCalls(runtime, 60, 3, 10_000).length, 0)
})

test('addFailure keeps recent failures and prunes entries older than 30 minutes', () => {
  const runtime = createRuntime('s1')
  addFailure(runtime, { signature: 'old', toolName: 'bash', summary: 'old', at: 0 })
  assert.equal(runtime.failureRing.length, 1)
  addFailure(runtime, { signature: 'new', toolName: 'bash', summary: 'new', at: 3_000_000 })
  assert.equal(runtime.failureRing.length, 1)
  assert.equal(runtime.failureRing[0].signature, 'new')
})

test('deriveHardStatus reports waiting, running, interrupted and error states', () => {
  const waiting = createRuntime('s1')
  waiting.approvals.set('a1', { id: 'a1', toolName: 'bash', at: 1 })
  assert.equal(deriveHardStatus(waiting, { available: true, running: true }), 'awaiting_approval')

  const answered = createRuntime('s1')
  answered.questions.set('q1', { callId: 'q1', questions: [], at: 1, state: 'open' })
  assert.equal(deriveHardStatus(answered, { available: true, running: false }), 'awaiting_answer')

  const interrupted = createRuntime('s1')
  interrupted.openTurnStartSeq = 3
  assert.equal(deriveHardStatus(interrupted, { available: false, running: false }), 'interrupted')

  const interruptedEnd = createRuntime('s1')
  interruptedEnd.lastTurnEnd = { kind: 'interrupted', at: 5 }
  assert.equal(deriveHardStatus(interruptedEnd, { available: true, running: false }), 'interrupted')

  const errored = createRuntime('s1')
  errored.lastTurnEnd = { kind: 'error', at: 5, error: 'boom' }
  assert.equal(deriveHardStatus(errored, { available: true, running: false }), 'error')

  assert.equal(deriveHardStatus(createRuntime('s1'), { available: true, running: true }), 'running')
  assert.equal(deriveHardStatus(createRuntime('s1'), { available: true, running: false }), 'idle')
  assert.equal(deriveHardStatus(undefined, { available: true, running: true }), 'running')
  assert.equal(deriveHardStatus(undefined, { available: true, running: false }), 'idle')
})

test('parseReportStatus builds a soft status and rejects empty reports', () => {
  const soft = parseReportStatus(
    {
      goal: 'ship it',
      done: ['a', 1],
      next: ['b'],
      blockers: ['c'],
      decisions: ['d'],
    },
    1_234,
  )
  assert.ok(soft)
  assert.equal(soft!.goal, 'ship it')
  assert.deepEqual(soft!.done, ['a'])
  assert.deepEqual(soft!.next, ['b'])
  assert.deepEqual(soft!.blockers, ['c'])
  assert.deepEqual(soft!.decisions, ['d'])
  assert.equal(soft!.reportedAt, 1_234)
  assert.equal(soft!.source, 'tool')

  assert.equal(parseReportStatus({}, 1), undefined)
  assert.equal(parseReportStatus(null, 1), undefined)
  assert.equal(parseReportStatus({ done: 'not-an-array' }, 1), undefined)

  const capped = parseReportStatus({ done: Array.from({ length: 25 }, (_, i) => `d${i}`) }, 1)
  assert.equal(capped!.done.length, 20)
  const long = parseReportStatus({ goal: 'x'.repeat(2_000) }, 1)
  assert.equal(long!.goal.length, 1_000)
})
