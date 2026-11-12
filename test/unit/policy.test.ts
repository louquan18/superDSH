/**
 * 策略引擎单元测试（P1）。
 *
 * 关注点：Wilson 下界在小样本上的行为、统计口径、以及**双向迁移**的每个分支
 * （晋升 / 降级 / 样本不足时保持默认）——这三条决定了规则会不会被误撤或误放行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  RULE_IDS,
  computeStats,
  decidePolicy,
  wilsonLower,
} from '../../src/policy.js'
import type { AuditEntry, Config } from '../../src/types.js'

const policyConfig = (patch: Partial<Config['policy']> = {}): Config['policy'] => ({
  enabled: true,
  shadowRules: ['watchdog_stall'],
  minSamples: 20,
  demoteBelow: 0.7,
  promoteAbove: 0.9,
  windowDays: 7,
  standard: 'self_heal',
  labelIntervalMs: 300_000,
  ...patch,
})

function audit(patch: Partial<AuditEntry> & { id: string; at: number }): AuditEntry {
  return { kind: 'dispatch', action: 'watchdog_remind', ...patch } as AuditEntry
}

test('wilsonLower：样本为 0 时返回 0，小样本被明显压低', () => {
  assert.equal(wilsonLower(0, 0), 0)
  assert.equal(wilsonLower(0, 10), 0)

  // 3 次全对：命中率 100%，但下界远低于 1 —— 这正是不能凭"三次没出错"就下结论的原因
  const tiny = wilsonLower(3, 3)
  assert.ok(tiny > 0, '要有下界')
  assert.ok(tiny < 0.5, `小样本下界必须明显压低，实际 ${tiny}`)

  // 同样 100%，样本一大下界就上去
  assert.ok(wilsonLower(60, 60) > wilsonLower(3, 3))
  // 样本量相同，全对的比一半对的高
  assert.ok(wilsonLower(20, 20) > wilsonLower(10, 20))
})

test('computeStats：按 ruleId 归组、按窗口过滤、无 ruleId 不计入', () => {
  const at = 1_000_000_000
  const day = 24 * 60 * 60_000
  const audits: AuditEntry[] = [
    audit({ id: 'a1', at: at - day, ruleId: 'watchdog_stall', outcome: 'tp' }),
    audit({ id: 'a2', at: at - day, ruleId: 'watchdog_stall', outcome: 'fp' }),
    audit({ id: 'a3', at: at - day, ruleId: 'watchdog_stall' }), // 未判定
    audit({ id: 'a4', at: at - day }), // 不是规则决策
    audit({ id: 'a5', at: at - 30 * day, ruleId: 'watchdog_stall', outcome: 'tp' }), // 窗口外
    audit({ id: 'a6', at: at - day, ruleId: 'dispatch_route', outcome: 'tp' }),
  ]
  const stats = computeStats(audits, 7, at)
  assert.equal(stats.length, RULE_IDS.length, '每条规则都要有行（哪怕是 0）')

  const watchdog = stats.find((item) => item.ruleId === 'watchdog_stall')!
  assert.equal(watchdog.tp, 1)
  assert.equal(watchdog.fp, 1)
  assert.equal(watchdog.unknown, 1)
  assert.equal(watchdog.n, 2, 'n 只算已判定的')
  assert.equal(watchdog.precision, 0.5)
  assert.ok(watchdog.precisionLB > 0 && watchdog.precisionLB < 0.5)

  const route = stats.find((item) => item.ruleId === 'dispatch_route')!
  assert.equal(route.tp, 1)
  assert.equal(route.precision, 1)
})

test('decidePolicy：整段关闭时一律照常执行', () => {
  const decision = decidePolicy('watchdog_stall', undefined, policyConfig({ enabled: false }))
  assert.equal(decision.mode, 'act')
  assert.match(decision.reason, /disabled/)
})

test('decidePolicy：样本不足时，名单内的保持 shadow、名单外的照常执行', () => {
  const few = { ruleId: 'watchdog_stall', n: 3, tp: 3, fp: 0, fn: 0, unknown: 0, precision: 1, precisionLB: 0.4, lastAt: 0 }
  assert.equal(decidePolicy('watchdog_stall', few, policyConfig()).mode, 'shadow')
  assert.equal(decidePolicy('dispatch_route', few, policyConfig()).mode, 'act')
})

test('decidePolicy：名单内的规则准确率够高会被自动晋升', () => {
  const good = { ruleId: 'watchdog_stall', n: 60, tp: 60, fp: 0, fn: 0, unknown: 0, precision: 1, precisionLB: 0.95, lastAt: 0 }
  const decision = decidePolicy('watchdog_stall', good, policyConfig())
  assert.equal(decision.mode, 'act')
  assert.match(decision.reason, /promoted/)
})

test('decidePolicy：名单外的规则准确率跌破阈值会被自动降级', () => {
  const bad = { ruleId: 'dispatch_route', n: 40, tp: 10, fp: 30, fn: 0, unknown: 0, precision: 0.25, precisionLB: 0.14, lastAt: 0 }
  const decision = decidePolicy('dispatch_route', bad, policyConfig())
  assert.equal(decision.mode, 'shadow')
  assert.match(decision.reason, /demoted/)

  const healthy = { ruleId: 'dispatch_route', n: 40, tp: 38, fp: 2, fn: 0, unknown: 0, precision: 0.95, precisionLB: 0.85, lastAt: 0 }
  assert.equal(decidePolicy('dispatch_route', healthy, policyConfig()).mode, 'act')
})
