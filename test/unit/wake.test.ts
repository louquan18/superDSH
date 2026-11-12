import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decideWake, type ProgressEvent, type WakeInput } from '../../src/progress.js'

const NOW = 1_700_000_000_000

function event(kind: string, signature: string, category: 'milestone' | 'dispatch' = 'dispatch'): ProgressEvent {
  return { kind: kind as any, signatures: [signature], category, title: `t-${signature}`, real: kind !== 'watchdog' }
}

function input(overrides: Partial<WakeInput> = {}): WakeInput {
  return {
    enabled: true,
    kinds: ['stage_end', 'watchdog'],
    maxPerDispatch: 2,
    minGapMs: 120_000,
    events: [event('stage_end', 'stage_end:1')],
    woke: [],
    wakeCount: 0,
    lastWakeAt: 0,
    butlerRunning: false,
    now: NOW,
    ...overrides,
  }
}

test('decideWake: 关闭时完全静默', () => {
  const decision = decideWake(input({ enabled: false }))
  assert.equal(decision.wake, false)
  assert.equal((decision as any).reason, 'disabled')
})

test('decideWake: 纯里程碑不唤醒（只认 stage_end / watchdog）', () => {
  const decision = decideWake(input({ events: [event('milestone', 'milestone:a', 'milestone')] }))
  assert.equal(decision.wake, false)
  assert.equal((decision as any).reason, 'no_eligible_event')
})

test('decideWake: 管家正在跑的时候不唤醒（避免排队烧 token）', () => {
  const decision = decideWake(input({ butlerRunning: true }))
  assert.equal(decision.wake, false)
  assert.equal((decision as any).reason, 'butler_running')
})

test('decideWake: 同签名只唤醒一次', () => {
  const decision = decideWake(input({ woke: ['stage_end:1'] }))
  assert.equal(decision.wake, false)
  assert.equal((decision as any).reason, 'no_eligible_event')
})

test('decideWake: 每 dispatch 配额用尽后不再唤醒', () => {
  const decision = decideWake(input({ wakeCount: 2 }))
  assert.equal(decision.wake, false)
  assert.equal((decision as any).reason, 'dispatch_capped')
})

test('decideWake: 全局节流（minGapMs 内不再唤醒）', () => {
  const decision = decideWake(input({ lastWakeAt: NOW - 60_000 }))
  assert.equal(decision.wake, false)
  assert.equal((decision as any).reason, 'throttled')
  // 超过间隔就放行
  const allowed = decideWake(input({ lastWakeAt: NOW - 180_000 }))
  assert.equal(allowed.wake, true)
})

test('decideWake: 放行时返回主签名与事件类型', () => {
  const decision = decideWake(input())
  assert.equal(decision.wake, true)
  assert.equal((decision as any).signature, 'stage_end:1')
  assert.equal((decision as any).kind, 'stage_end')
  assert.equal((decision as any).title, 't-stage_end:1')
})

test('decideWake: 连续 10 次事件最多唤醒 maxPerDispatch 次（有界性）', () => {
  let woke: string[] = []
  let wakeCount = 0
  let lastWakeAt = 0
  let wakes = 0
  for (let index = 0; index < 10; index += 1) {
    const decision = decideWake(
      input({
        events: [event('stage_end', `stage_end:${index}`)],
        woke,
        wakeCount,
        lastWakeAt,
        now: NOW + index * 10 * 60_000, // 每次间隔 10 分钟，节流不生效
      }),
    )
    if (decision.wake) {
      wakes += 1
      woke = [...woke, decision.signature]
      wakeCount += 1
      lastWakeAt = NOW + index * 10 * 60_000
    }
  }
  assert.equal(wakes, 2, '配额硬上限')
})
