/**
 * R6：卡片上出现的动作，宿主必须真的支持。
 *
 * 这里守的是「客户端按钮 ↔ 宿主能力」这条契约：能回答的卡点才给「回答」按钮，
 * 其余类型只能忽略/重试。actual 宿主的 resolveBlocker 用同一份 ANSWERABLE_KINDS。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ANSWERABLE_KINDS, noticeActionsFor } from '../../src/blockers.js'
import type { Blocker, BlockerKind } from '../../src/types.js'

const NOW = 1_700_000_000_000

const ALL_KINDS: BlockerKind[] = [
  'approval',
  'question',
  'plan_review',
  'repeated_failure',
  'stall',
  'interrupted',
  'decision',
  'error',
]

function makeBlocker(kind: BlockerKind): Blocker {
  return {
    id: 'bl_1',
    sessionId: 'sess-abcdef12',
    kind,
    severity: 'warning',
    status: 'open',
    signature: `${kind}:1`,
    summary: 'summary',
    neededAction: 'action',
    evidence: {},
    detectedAt: NOW,
    lastSeenAt: NOW,
    reminderCount: 0,
    relatedApprovalId: kind === 'approval' ? 'ap1' : undefined,
    relatedPlanId: kind === 'plan_review' ? 'plan_1' : undefined,
    relatedCallId: kind === 'question' ? 'call_1' : undefined,
  }
}

test('R6 决策 / 提问 / 计划三类卡点能回答，其它类型不给「回答」按钮', () => {
  for (const kind of ALL_KINDS) {
    const verbs = noticeActionsFor(makeBlocker(kind)).map((action) => action.verb)
    const hasAnswer = verbs.includes('answer')
    assert.equal(
      hasAnswer,
      ANSWERABLE_KINDS.has(kind),
      `${kind} 的「回答」按钮必须和能力声明一致：${verbs.join(',')}`,
    )
  }
  // 决策必须有回答
  assert.deepEqual(
    noticeActionsFor(makeBlocker('decision')).map((action) => action.verb).sort(),
    ['answer', 'dismiss'],
  )
  // 审批不该出现回答
  assert.equal(
    noticeActionsFor(makeBlocker('approval')).some((action) => action.verb === 'answer'),
    false,
  )
})

test('R6 能回答的卡点，「回答」需要文本输入', () => {
  for (const kind of ['decision', 'question'] as const) {
    const answer = noticeActionsFor(makeBlocker(kind)).find((action) => action.verb === 'answer')
    assert.ok(answer, `${kind} 要有回答`)
    assert.equal(answer!.requiresText, true)
    assert.equal(answer!.style, 'primary')
  }
})

test('R6 所有卡点都至少有一个可用动作（不会出现只能干看的卡片）', () => {
  for (const kind of ALL_KINDS) {
    const verbs = noticeActionsFor(makeBlocker(kind)).map((action) => action.verb)
    assert.ok(verbs.length > 0, `${kind} 必须有动作`)
    assert.ok(
      verbs.some((verb) => verb === 'dismiss' || verb === 'retry' || verb === 'approve'),
      `${kind} 至少要有忽略/重试/批准之一`,
    )
  }
})
