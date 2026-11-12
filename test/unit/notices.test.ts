import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildBlockerNotice,
  noticeActionsFor,
  noticeSource,
  questionOptionLabels,
} from '../../src/blockers.js'
import type { Blocker } from '../../src/types.js'

const NOW = 1_700_000_000_000

function makeBlocker(overrides: Partial<Blocker> = {}): Blocker {
  return {
    id: 'bl_1',
    sessionId: 'sess-abcdef12',
    kind: 'approval',
    severity: 'warning',
    status: 'open',
    signature: 'approval:ap1',
    summary: 'repo-a 在等审批：bash rm -rf build',
    neededAction: '允许或拒绝 bash',
    evidence: {
      toolName: 'bash',
      callId: 'call_1',
      risk: 'high',
      argsSummary: 'rm -rf build',
    },
    detectedAt: NOW - 1_000,
    lastSeenAt: NOW - 1_000,
    reminderCount: 0,
    relatedApprovalId: 'ap1',
    relatedCallId: 'call_1',
    ...overrides,
  }
}

function verbs(actions: Array<{ verb: string }>): string[] {
  return actions.map((action) => action.verb)
}

test('approval 卡点给「允许 / 拒绝 / 忽略」三个动作', () => {
  const actions = noticeActionsFor(makeBlocker())
  assert.deepEqual(verbs(actions), ['approve', 'reject', 'dismiss'])
  assert.equal(actions[0]!.style, 'primary')
  assert.equal(actions[1]!.style, 'danger')
})

test('plan_review 卡点给「批准 / 提修改意见 / 驳回 / 忽略」，且两个需要文本', () => {
  const actions = noticeActionsFor(makeBlocker({ kind: 'plan_review', relatedPlanId: 'plan_1' }))
  assert.deepEqual(verbs(actions), ['approve', 'answer', 'reject', 'dismiss'])
  const answer = actions.find((action) => action.verb === 'answer')
  const reject = actions.find((action) => action.verb === 'reject')
  assert.equal(answer?.requiresText, true)
  assert.equal(reject?.requiresText, true)
  assert.match(String(answer?.placeholder), /要改/)
})

test('question / decision 只给「回答 + 忽略」，回答需要文本', () => {
  for (const kind of ['question', 'decision'] as const) {
    const actions = noticeActionsFor(makeBlocker({ kind }))
    assert.deepEqual(verbs(actions), ['answer', 'dismiss'])
    assert.equal(actions[0]!.requiresText, true)
  }
})

test('stall / interrupted / repeated_failure 给「重试 + 忽略」', () => {
  for (const kind of ['stall', 'interrupted', 'repeated_failure'] as const) {
    const actions = noticeActionsFor(makeBlocker({ kind }))
    assert.deepEqual(verbs(actions), ['retry', 'dismiss'])
  }
  // 停滞用「催办」措辞，中断用「重试」
  assert.equal(noticeActionsFor(makeBlocker({ kind: 'stall' }))[0]!.label, '催办')
  assert.equal(noticeActionsFor(makeBlocker({ kind: 'interrupted' }))[0]!.label, '重试')
})

test('有进行中的派发时追加「标记完成 / 放弃任务」', () => {
  const actions = noticeActionsFor(makeBlocker(), { dispatchInProgress: true })
  assert.deepEqual(verbs(actions), ['approve', 'reject', 'dispatch_completed', 'dispatch_failed', 'dismiss'])
})

test('questionOptionLabels 从 evidence 取候选标签，去重并限 6 个', () => {
  const blocker = makeBlocker({
    kind: 'question',
    evidence: {
      callId: 'call_1',
      questions: [
        {
          id: 'q1',
          question: '选哪个？',
          options: [{ label: '方案 A' }, { label: '方案 B' }, { label: '方案 A' }],
        },
        { id: 'q2', question: '呢？', options: [{ label: '方案 C' }] },
      ],
    },
  })
  assert.deepEqual(questionOptionLabels(blocker), ['方案 A', '方案 B', '方案 C'])

  const many = makeBlocker({
    kind: 'question',
    evidence: {
      questions: [{ id: 'q', question: '?', options: Array.from({ length: 9 }, (_, index) => ({ label: `选项 ${index}` })) }],
    },
  })
  assert.equal(questionOptionLabels(many)?.length, 6)
})

test('questionOptionLabels 在没有 questions 时返回 undefined', () => {
  assert.equal(questionOptionLabels(makeBlocker({ evidence: {} })), undefined)
  assert.equal(questionOptionLabels(makeBlocker({ evidence: { questions: 'nope' } })), undefined)
})

test('buildBlockerNotice 带上会话标题、类型标签和证据摘要', () => {
  const notice = buildBlockerNotice(makeBlocker(), {
    sessionTitle: 'repo-a',
    dispatchId: 'd_1',
    dispatchInProgress: true,
  })
  assert.equal(notice.kind, 'blocker')
  assert.equal(notice.category, 'approval')
  assert.equal(notice.severity, 'warning')
  assert.equal(notice.title, 'repo-a · 等审批')
  assert.equal(notice.detail, 'rm -rf build')
  assert.equal(notice.sessionId, 'sess-abcdef12')
  assert.equal(notice.sessionTitle, 'repo-a')
  assert.equal(notice.blockerId, 'bl_1')
  assert.equal(notice.approvalId, 'ap1')
  assert.equal(notice.planId, undefined)
  assert.equal(notice.dispatchId, 'd_1')
  assert.equal(notice.callId, 'call_1')
  assert.equal(notice.neededAction, '允许或拒绝 bash')
  assert.deepEqual(verbs(notice.actions), ['approve', 'reject', 'dispatch_completed', 'dispatch_failed', 'dismiss'])
  assert.equal(notice.at, notice.at)
})

test('buildBlockerNotice 没有会话标题时退回 sessionId 前缀', () => {
  const notice = buildBlockerNotice(makeBlocker())
  assert.equal(notice.title, 'sess-abc · 等审批')
})

test('buildBlockerNotice 的 detail 在证据缺失时退回 summary 并截断', () => {
  const longSummary = 'x'.repeat(400)
  const notice = buildBlockerNotice(
    makeBlocker({ evidence: {}, summary: longSummary }),
    { sessionTitle: 'repo-a' },
  )
  assert.equal(notice.detail!.length, 240)
  assert.match(notice.detail!, /…$/)
})

test('noticeSource 给出 form=notice、kind=superagent-notice 和一行摘要', () => {
  const source = noticeSource(buildBlockerNotice(makeBlocker(), { sessionTitle: 'repo-a' }))
  assert.equal(source.kind, 'superagent-notice')
  assert.equal(source.form, 'notice')
  assert.equal(source.notice.blockerId, 'bl_1')
  assert.match(source.summary, /repo-a · 等审批/)
  assert.match(source.summary, /需要你：允许或拒绝 bash/)
  assert.ok(source.summary.length <= 120)
})

// ---------------------------------------------------------------- R5 方案摘要可见

test('R5 计划卡带方案摘要和正文首行，管家不用点进去就能看', () => {
  const blocker = makeBlocker({
    kind: 'plan_review',
    summary: 'worker 提交了计划：改扫描（2 个计划条目，1 条路径，0 条命令）',
    evidence: {
      planId: 'plan_1',
      planSummary: '2 个计划条目，1 条路径，0 条命令',
      planExcerpt: '2 个计划条目，1 条路径，0 条命令｜# 改扫描',
    },
    relatedPlanId: 'plan_1',
  })
  const notice = buildBlockerNotice(blocker, { sessionTitle: 'worker' })
  assert.equal(notice.kind, 'blocker')
  assert.match(notice.title, /计划待审/)
  assert.match(notice.detail!, /改扫描/)
  assert.equal(notice.planId, 'plan_1')
})
