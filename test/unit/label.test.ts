/**
 * 决策标注单元测试（P1）。
 *
 * 每条标注规则都要有「正例（判得出来）」和「反例（判不出来时保持 unknown）」，
 * 因为**判不了就不判**是这套东西的信誉来源：宁可少一条样本，也不要推断凑数。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { labelDecisions, type LabelContext } from '../../src/label.js'
import type {
  AuditEntry,
  Blocker,
  Dispatch,
  ProgressNoticeRecord,
} from '../../src/types.js'

const T = 1_700_000_000_000
const MIN = 60_000

function audit(patch: Partial<AuditEntry> & { id: string; at: number }): AuditEntry {
  return {
    kind: 'dispatch',
    action: 'watchdog_remind',
    sessionId: 's1',
    ...patch,
  } as AuditEntry
}

function notice(patch: Partial<ProgressNoticeRecord> & { id: string; at: number }): ProgressNoticeRecord {
  return {
    sessionId: 's1',
    kind: 'notification',
    category: 'milestone',
    severity: 'info',
    title: '进度',
    signatures: [],
    status: 'open',
    expiresAt: T + 24 * 60 * MIN,
    ...patch,
  } as ProgressNoticeRecord
}

function blocker(patch: Partial<Blocker> & { id: string }): Blocker {
  return {
    sessionId: 's1',
    kind: 'repeated_failure',
    severity: 'warning',
    status: 'auto_resolved',
    signature: 'sig',
    summary: '卡住了',
    neededAction: '看一眼',
    evidence: {},
    detectedAt: T,
    lastSeenAt: T,
    reminderCount: 1,
    ...patch,
  } as Blocker
}

function dispatch(id: string, status: string): Dispatch {
  return { id, status } as Dispatch
}

function ctx(patch: Partial<LabelContext> = {}): LabelContext {
  return {
    audits: [],
    blockers: [],
    dispatches: [],
    notices: [],
    now: T + 60 * MIN,
    standard: 'self_heal',
    ...patch,
  }
}

// ---------------------------------------------------------------- L1 watchdog

test('L1：提醒后 worker 自己又产出真实进度 → 记误报', () => {
  const reminder = audit({ id: 'w1', at: T, ruleId: 'watchdog_stall', dispatchId: 'd1' })
  const updates = labelDecisions(
    ctx({
      audits: [reminder],
      notices: [notice({ id: 'n1', at: T + 5 * MIN, dispatchId: 'd1', kind: 'milestone' })],
    }),
  )
  assert.equal(updates.length, 1)
  assert.equal(updates[0]!.outcome, 'fp')
  assert.equal(updates[0]!.outcomeRule, 'L1-watchdog-self-heal')
})

test('L1：期间有人工动作 → 是被人推醒的，不算误报', () => {
  const reminder = audit({ id: 'w1', at: T, ruleId: 'watchdog_stall', dispatchId: 'd1' })
  const human = audit({ id: 'h1', at: T + 2 * MIN, sessionId: 's1', kind: 'approval', action: 'approve', by: 'user' })
  const updates = labelDecisions(
    ctx({
      audits: [reminder, human],
      notices: [notice({ id: 'n1', at: T + 5 * MIN, dispatchId: 'd1', kind: 'milestone' })],
    }),
  )
  assert.equal(updates.length, 0)
})

test('L1：恢复超过 15 分钟窗口，或者只是另一条 watchdog → 都不判', () => {
  const reminder = audit({ id: 'w1', at: T, ruleId: 'watchdog_stall', dispatchId: 'd1' })
  assert.equal(
    labelDecisions(
      ctx({
        audits: [reminder],
        notices: [notice({ id: 'n1', at: T + 30 * MIN, dispatchId: 'd1', kind: 'milestone' })],
      }),
    ).length,
    0,
    '超出窗口不判',
  )
  assert.equal(
    labelDecisions(
      ctx({
        audits: [reminder],
        notices: [notice({ id: 'n2', at: T + 5 * MIN, dispatchId: 'd1', kind: 'watchdog' })],
      }),
    ).length,
    0,
    'watchdog 自己不算真实进度',
  )
})

test('L1：严格口径下不做自愈推断', () => {
  const reminder = audit({ id: 'w1', at: T, ruleId: 'watchdog_stall', dispatchId: 'd1' })
  const updates = labelDecisions(
    ctx({
      audits: [reminder],
      notices: [notice({ id: 'n1', at: T + 5 * MIN, dispatchId: 'd1', kind: 'milestone' })],
      standard: 'strict',
    }),
  )
  assert.equal(updates.length, 0)
})

// ---------------------------------------------------------------- L2 卡点

test('L2：卡点在提醒后 15 分钟内自行消失 → 记误报', () => {
  const reminder = audit({ id: 'b1', at: T, kind: 'blocker', action: 'remind', ruleId: 'blocker_repeat_failure', blockerId: 'bl1' })
  const updates = labelDecisions(
    ctx({
      audits: [reminder],
      blockers: [blocker({ id: 'bl1', resolvedAt: T + 3 * MIN })],
    }),
  )
  assert.equal(updates.length, 1)
  assert.equal(updates[0]!.outcome, 'fp')
  assert.equal(updates[0]!.outcomeRule, 'L2-blocker-self-heal')
})

test('L2：卡点被人处理掉 → 说明这条提醒有用，记判对', () => {
  const reminder = audit({ id: 'b1', at: T, kind: 'blocker', action: 'remind', ruleId: 'blocker_repeat_failure', blockerId: 'bl1' })
  const updates = labelDecisions(
    ctx({
      audits: [reminder],
      blockers: [blocker({ id: 'bl1', status: 'resolved', resolution: '用户处理', resolvedAt: T + 3 * MIN })],
    }),
  )
  assert.equal(updates.length, 1)
  assert.equal(updates[0]!.outcome, 'tp')
  assert.equal(updates[0]!.outcomeRule, 'L2-human-resolved')
})

test('L2：卡点还开着 / 严格口径 → 都不判', () => {
  const reminder = audit({ id: 'b1', at: T, kind: 'blocker', action: 'remind', ruleId: 'blocker_repeat_failure', blockerId: 'bl1' })
  assert.equal(
    labelDecisions(ctx({ audits: [reminder], blockers: [blocker({ id: 'bl1', status: 'notified' })] })).length,
    0,
    '还开着就没有结论',
  )
  assert.equal(
    labelDecisions(
      ctx({
        audits: [reminder],
        blockers: [blocker({ id: 'bl1', resolvedAt: T + MIN })],
        standard: 'strict',
      }),
    ).length,
    0,
    '严格口径不认自动消失',
  )
})

// ---------------------------------------------------------------- L3 / L4

test('L3：被拒的命令 10 分钟内被人工批准 → 记漏报（判太严）', () => {
  const deny = audit({
    id: 'x1',
    at: T,
    kind: 'approval',
    action: 'bash_review_deny',
    ruleId: 'bash_deny',
    argsSummary: 'rm  -rf /tmp/x',
  })
  const approved = audit({
    id: 'x2',
    at: T + 2 * MIN,
    kind: 'approval',
    action: 'user_approved',
    by: 'user',
    argsSummary: 'rm -rf /tmp/x', // 空白差异要能匹配上
  })
  const updates = labelDecisions(ctx({ audits: [deny, approved] }))
  assert.equal(updates.length, 1)
  assert.equal(updates[0]!.outcome, 'fn')
  assert.equal(updates[0]!.outcomeRule, 'L3-deny-then-approved')
})

test('L3：批准的是另一条命令 → 不判', () => {
  const deny = audit({ id: 'x1', at: T, kind: 'approval', action: 'bash_review_deny', ruleId: 'bash_deny', argsSummary: 'rm -rf a' })
  const approved = audit({ id: 'x2', at: T + MIN, kind: 'approval', action: 'user_approved', by: 'user', argsSummary: 'rm -rf b' })
  assert.equal(labelDecisions(ctx({ audits: [deny, approved] })).length, 0)
})

test('L4：派发被 superseded → 误报；completed → 判对；还在跑 → 不判', () => {
  const route = (id: string, dispatchId: string) =>
    audit({ id, at: T, kind: 'dispatch', action: 'dispatch', ruleId: 'dispatch_route', dispatchId })

  const superseded = labelDecisions(ctx({ audits: [route('r1', 'd1')], dispatches: [dispatch('d1', 'superseded')] }))
  assert.equal(superseded[0]!.outcome, 'fp')

  const completed = labelDecisions(ctx({ audits: [route('r2', 'd2')], dispatches: [dispatch('d2', 'completed')] }))
  assert.equal(completed[0]!.outcome, 'tp')

  const running = labelDecisions(ctx({ audits: [route('r3', 'd3')], dispatches: [dispatch('d3', 'delivered')] }))
  assert.equal(running.length, 0)
})

test('幂等：已经判过的决策不重复判；没有 ruleId 的审计不参与', () => {
  const decided = audit({ id: 'w1', at: T, ruleId: 'watchdog_stall', dispatchId: 'd1', outcome: 'fp', outcomeRule: 'L1-watchdog-self-heal' })
  const plain = audit({ id: 'p1', at: T, action: 'dispatch' })
  const updates = labelDecisions(
    ctx({
      audits: [decided, plain],
      notices: [notice({ id: 'n1', at: T + MIN, dispatchId: 'd1', kind: 'milestone' })],
    }),
  )
  assert.equal(updates.length, 0)
})
