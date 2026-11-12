import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  advanceCursor,
  detectProgress,
  estimateWatchdog,
  initialCursor,
  milestoneSignature,
  resolveWatchdog,
  seedCursor,
  seedDispatchCursor,
} from '../../src/progress.js'
import { DEFAULT_CONFIG, type Config, type Dispatch, type SoftStatus } from '../../src/types.js'

const NOW = 1_700_000_000_000
const MINUTE = 60_000

const CONFIG: Config = {
  ...DEFAULT_CONFIG,
  progress: {
    ...DEFAULT_CONFIG.progress,
    minGapMs: 3 * MINUTE,
  },
  watchdog: { enabled: true, defaultPollMinutes: 10, minMinutes: 3, maxMinutes: 60 },
}

function makeSoft(overrides: Partial<SoftStatus> = {}): SoftStatus {
  return {
    goal: '检查',
    done: [],
    next: [],
    blockers: [],
    decisions: [],
    reportedAt: NOW,
    source: 'tool',
    ...overrides,
  }
}

function makeDispatch(overrides: Partial<Dispatch> = {}): Dispatch {
  return {
    id: 'dsp_1',
    text: '跑一下检查',
    targetSessionId: 'worker-1',
    workspaceKey: 'repo-a',
    mode: 'reuse',
    modeAtDispatch: 'plan_review',
    requestId: 'req_1',
    status: 'accepted',
    reason: '测试',
    relatedSessionIds: [],
    createdAt: NOW - 30 * MINUTE,
    progress: {
      notified: [],
      lastProgressAt: NOW - 30 * MINUTE,
      lastRunning: true,
      lastDoneCount: 0,
    },
    ...overrides,
  }
}

function detect(
  dispatch: Dispatch,
  options: {
    soft?: SoftStatus
    running?: boolean
    lastActivityAt?: number
    resolved?: Array<{ signature: string; summary: string }>
    now?: number
    config?: Config
  } = {},
) {
  return detectProgress({
    title: 'repo-a',
    dispatch,
    soft: options.soft ?? makeSoft(),
    running: options.running ?? true,
    lastActivityAt: options.lastActivityAt,
    resolved: options.resolved,
    config: options.config ?? CONFIG,
    now: options.now ?? NOW,
  })
}

// ---------------------------------------------------------------- A1 里程碑

test('A1 done 变长报一条里程碑，带下一步', () => {
  const dispatch = makeDispatch()
  const events = detect(dispatch, {
    soft: makeSoft({ done: ['读完 util.ts'], next: ['再读 risk.ts'] }),
  })
  assert.equal(events.length, 1)
  assert.equal(events[0]!.kind, 'milestone')
  assert.equal(events[0]!.title, 'repo-a：完成 1 项')
  assert.match(String(events[0]!.detail), /读完 util\.ts/)
  assert.match(String(events[0]!.detail), /下一步：再读 risk\.ts/)
})

test('A1 同一批 done 只推一次：推进游标后再扫不重复', () => {
  const dispatch = makeDispatch()
  const soft = makeSoft({ done: ['读完 util.ts'], next: ['再读 risk.ts'] })
  const first = detect(dispatch, { soft })
  assert.equal(first.length, 1)
  dispatch.progress = advanceCursor({
    cursor: dispatch.progress,
    events: first,
    running: true,
    doneCount: 1,
    now: NOW,
  })
  const second = detect(dispatch, { soft, now: NOW + 10_000 })
  assert.equal(second.length, 0)
})

test('A1 新增条目只报新增的那条', () => {
  const dispatch = makeDispatch({
    progress: {
      notified: [milestoneSignature('读完 util.ts')],
      lastProgressAt: NOW - 30 * MINUTE,
      lastRunning: true,
      lastDoneCount: 1,
      lastMilestoneAt: NOW - 30 * MINUTE,
    },
  })
  const events = detect(dispatch, {
    soft: makeSoft({ done: ['读完 util.ts', '读完 risk.ts'] }),
  })
  assert.equal(events.length, 1)
  assert.equal(events[0]!.signatures.length, 1)
  assert.equal(events[0]!.signatures[0], milestoneSignature('读完 risk.ts'))
})

test('A1 升级前的老派发没有游标：首扫不补报历史 done', () => {
  const dispatch = makeDispatch({ progress: undefined })
  const events = detect(dispatch, { soft: makeSoft({ done: ['旧条目 A', '旧条目 B'] }) })
  assert.deepEqual(events, [])
  const seeded = seedCursor(NOW, makeSoft({ done: ['旧条目 A', '旧条目 B'] }), true)
  assert.equal(seeded.notified.length, 2)
})

test('A1 新建派发用目标会话当前 done 播种：历史里程碑不算这次的新进展', () => {
  const history = ['上一轮成果 A', '上一轮成果 B', '上一轮成果 C']
  const seeded = seedDispatchCursor(NOW, history)
  // 种子要覆盖当前每一条 done，并记下条数；first-running 语义与 initialCursor 一致。
  assert.equal(seeded.lastDoneCount, 3)
  assert.equal(seeded.notified.length, 3)
  assert.equal(seeded.lastRunning, false)
  for (const item of history) {
    assert.ok(seeded.notified.includes(milestoneSignature(item)), item)
  }

  // 第一次扫描看到同一批 done：一条进度都不该推。
  const dispatch = makeDispatch({ createdAt: NOW, progress: seeded })
  const events = detect(dispatch, { soft: makeSoft({ done: history }), running: true })
  assert.equal(events.filter((event) => event.kind === 'milestone').length, 0)
})

test('A1 播种之后新增的里程碑照常推送，只报新增那条', () => {
  const history = ['上一轮成果 A', '上一轮成果 B', '上一轮成果 C']
  const dispatch = makeDispatch({
    createdAt: NOW,
    progress: seedDispatchCursor(NOW, history),
  })
  const events = detect(dispatch, {
    soft: makeSoft({ done: [...history, '这轮新成果 D'], next: ['继续'] }),
    running: true,
  })
  const milestones = events.filter((event) => event.kind === 'milestone')
  assert.equal(milestones.length, 1)
  assert.deepEqual(milestones[0]!.signatures, [milestoneSignature('这轮新成果 D')])
  assert.match(String(milestones[0]!.detail), /这轮新成果 D/)
})

test('A1 没有历史 done 时，种子与初始游标等价', () => {
  const seeded = seedDispatchCursor(NOW, [])
  assert.deepEqual(seeded.notified, [])
  assert.equal(seeded.lastDoneCount, 0)
  assert.deepEqual(seeded, initialCursor(NOW))
})

// ---------------------------------------------------------------- A2 阶段结束

test('A2 running → idle 且仍有 open dispatch 时报阶段结束', () => {
  const dispatch = makeDispatch()
  const events = detect(dispatch, {
    soft: makeSoft({ done: ['改完 A'], next: ['跑测试'] }),
    running: false,
  })
  const stage = events.find((event) => event.kind === 'stage_end')
  assert.ok(stage, 'must report stage end')
  assert.equal(stage!.title, 'repo-a：阶段结束')
  assert.match(String(stage!.detail), /下一步：跑测试/)
})

test('A2 一直是 idle 不会反复报阶段结束', () => {
  const dispatch = makeDispatch()
  const events = detect(dispatch, { running: false })
  const stage = events.find((event) => event.kind === 'stage_end')
  assert.ok(stage)
  const cursor = advanceCursor({
    cursor: dispatch.progress,
    events: [stage!],
    running: false,
    doneCount: 0,
    now: NOW,
  })
  assert.equal(cursor.stageEnds, 1)
  const next = detectProgress({
    title: 'repo-a',
    dispatch: { ...dispatch, progress: cursor },
    soft: makeSoft(),
    running: false,
    config: CONFIG,
    now: NOW + 15_000,
  })
  assert.equal(next.filter((event) => event.kind === 'stage_end').length, 0)
})

test('A2 running 抖动（idle → running → idle）再报一次，不刷屏', () => {
  const dispatch = makeDispatch({
    progress: {
      notified: ['stage_end:0'],
      lastProgressAt: NOW - 10 * MINUTE,
      lastRunning: true,
      lastDoneCount: 0,
      stageEnds: 1,
    },
  })
  const events = detect(dispatch, { running: false })
  const stage = events.find((event) => event.kind === 'stage_end')
  assert.ok(stage)
  assert.equal(stage!.signatures[0], 'stage_end:1')
})

test('A2 turn 太短、扫描没看到 running：靠 turn 结束也报阶段结束', () => {
  const dispatch = makeDispatch({
    progress: {
      notified: [],
      lastProgressAt: NOW - 5 * MINUTE,
      lastRunning: false,
      lastDoneCount: 0,
      lastTurnEndAt: NOW - 5 * MINUTE,
    },
  })
  const events = detectProgress({
    title: 'repo-a',
    dispatch,
    soft: makeSoft({ next: ['跑测试'] }),
    running: false,
    lastTurnEnd: { at: NOW - MINUTE, kind: 'completed' },
    config: CONFIG,
    now: NOW,
  })
  const stage = events.find((event) => event.kind === 'stage_end')
  assert.ok(stage, 'turn 结束也要能报阶段结束')
  assert.match(String(stage!.detail), /下一步：跑测试/)

  const cursor = advanceCursor({
    cursor: dispatch.progress,
    events,
    running: false,
    doneCount: 0,
    now: NOW,
    lastTurnEndAt: NOW - MINUTE,
  })
  // 同一次 turn 结束不重复报
  const again = detectProgress({
    title: 'repo-a',
    dispatch: { ...dispatch, progress: cursor },
    soft: makeSoft({ next: ['跑测试'] }),
    running: false,
    lastTurnEnd: { at: NOW - MINUTE, kind: 'completed' },
    config: CONFIG,
    now: NOW + 15_000,
  })
  assert.equal(again.filter((event) => event.kind === 'stage_end').length, 0)
})

test('A2 上一轮是 error 的 turn 结束不当成阶段结束', () => {
  const dispatch = makeDispatch({
    progress: {
      notified: [],
      lastProgressAt: NOW - 5 * MINUTE,
      lastRunning: false,
      lastDoneCount: 0,
      lastTurnEndAt: NOW - 5 * MINUTE,
    },
  })
  const events = detectProgress({
    title: 'repo-a',
    dispatch,
    soft: makeSoft(),
    running: false,
    lastTurnEnd: { at: NOW - MINUTE, kind: 'error' },
    config: CONFIG,
    now: NOW,
  })
  assert.equal(events.filter((event) => event.kind === 'stage_end').length, 0)
})

test('A2 新建派发只看自己创建之后的 turn 结束', () => {
  const dispatch = makeDispatch({
    createdAt: NOW - 2 * MINUTE,
    progress: { ...initialCursor(NOW - 2 * MINUTE) },
  })
  const events = detectProgress({
    title: 'repo-a',
    dispatch,
    soft: makeSoft(),
    running: false,
    // 上一轮是更早的任务，不该报
    lastTurnEnd: { at: NOW - 10 * MINUTE, kind: 'completed' },
    config: CONFIG,
    now: NOW,
  })
  assert.equal(events.filter((event) => event.kind === 'stage_end').length, 0)
})

test('A2 dispatch 已收尾（completed）不再报阶段结束', () => {
  const dispatch = makeDispatch({ status: 'completed' })
  const events = detect(dispatch, { running: false })
  assert.equal(events.filter((event) => event.kind === 'stage_end').length, 0)
})

// ---------------------------------------------------------------- A3 卡点消失

test('A3 卡点消失报一条通知，重复扫描不重复', () => {
  const dispatch = makeDispatch()
  const resolved = [{ signature: 'stall:running:12', summary: 'repo-a 在运行但 12 分钟没有事件' }]
  const first = detect(dispatch, { resolved })
  const event = first.find((item) => item.kind === 'blocker_resolved')
  assert.ok(event)
  assert.equal(event!.title, 'repo-a：卡点已解除')
  assert.match(String(event!.detail), /12 分钟/)
  dispatch.progress = advanceCursor({
    cursor: dispatch.progress,
    events: [event!],
    running: true,
    doneCount: 0,
    now: NOW,
  })
  const second = detect(dispatch, { resolved, now: NOW + 15_000 })
  assert.equal(second.filter((item) => item.kind === 'blocker_resolved').length, 0)
})

test('A3 卡点新增不产生 progress（现有 blocker 提醒已经覆盖）', () => {
  const dispatch = makeDispatch()
  // 新增卡点不经过 detectProgress：它只接收 resolved 列表。
  const events = detect(dispatch)
  assert.deepEqual(events, [])
})

// ---------------------------------------------------------------- 去重与节流

test('节流：minGapMs 内的第二条里程碑被压住，间隔过后补发', () => {
  const dispatch = makeDispatch()
  const first = detect(dispatch, { soft: makeSoft({ done: ['A'] }) })
  assert.equal(first.length, 1)
  dispatch.progress = advanceCursor({
    cursor: dispatch.progress,
    events: first,
    running: true,
    doneCount: 1,
    now: NOW,
  })

  const early = detect(dispatch, {
    soft: makeSoft({ done: ['A', 'B'] }),
    now: NOW + MINUTE,
  })
  assert.equal(early.length, 0, 'within minGapMs it must be throttled')

  const late = detect(dispatch, {
    soft: makeSoft({ done: ['A', 'B'] }),
    now: NOW + 4 * MINUTE,
  })
  assert.equal(late.length, 1)
  assert.match(String(late[0]!.detail), /B/)
})

// ---------------------------------------------------------------- B watchdog

test('B 未到 pollMinutes 不报', () => {
  const dispatch = makeDispatch({
    progress: { ...initialCursor(NOW - 5 * MINUTE) },
    watchdog: { pollMinutes: 10 },
  })
  assert.equal(detect(dispatch).filter((event) => event.kind === 'watchdog').length, 0)
})

test('B 到点报一条低优先级 progress，重复扫描不重复', () => {
  const dispatch = makeDispatch({
    progress: { ...initialCursor(NOW - 20 * MINUTE) },
    watchdog: { pollMinutes: 10 },
  })
  const first = detect(dispatch).filter((event) => event.kind === 'watchdog')
  assert.equal(first.length, 1)
  assert.equal(first[0]!.title, 'repo-a：20 分钟没有进展')
  assert.match(String(first[0]!.detail), /要不要问一下/)
  dispatch.progress = advanceCursor({
    cursor: dispatch.progress,
    events: first,
    running: true,
    doneCount: 0,
    now: NOW,
  })
  const second = detect(dispatch, { now: NOW + 20_000 }).filter(
    (event) => event.kind === 'watchdog',
  )
  assert.equal(second.length, 0)
})

test('B watchdog 不刷新 lastProgressAt（不自己续命）', () => {
  const dispatch = makeDispatch({
    progress: { ...initialCursor(NOW - 20 * MINUTE) },
    watchdog: { pollMinutes: 10 },
  })
  const events = detect(dispatch).filter((event) => event.kind === 'watchdog')
  const cursor = advanceCursor({
    cursor: dispatch.progress,
    events,
    running: true,
    doneCount: 0,
    now: NOW,
  })
  assert.equal(cursor.lastProgressAt, NOW - 20 * MINUTE)
})

test('B 拖到 3 倍 poll 再问最后一次', () => {
  const dispatch = makeDispatch({
    progress: {
      ...initialCursor(NOW - 31 * MINUTE),
      notified: [`watchdog:1x:${NOW - 31 * MINUTE}`],
    },
    watchdog: { pollMinutes: 10 },
  })
  const events = detect(dispatch).filter((event) => event.kind === 'watchdog')
  assert.equal(events.length, 1)
  assert.match(events[0]!.signatures[0]!, /^watchdog:3x:/)
})

test('B quiet 跳过；老派发没有 watchdog 字段也跳过', () => {
  const quiet = makeDispatch({
    progress: { ...initialCursor(NOW - 60 * MINUTE) },
    watchdog: { pollMinutes: 5, quiet: true },
  })
  assert.equal(detect(quiet).filter((event) => event.kind === 'watchdog').length, 0)

  const legacy = makeDispatch({ progress: { ...initialCursor(NOW - 60 * MINUTE) } })
  assert.equal(detect(legacy).filter((event) => event.kind === 'watchdog').length, 0)
})

test('B 有真实进展后重新计时', () => {
  const dispatch = makeDispatch({
    progress: {
      ...initialCursor(NOW - 60 * MINUTE),
      notified: [`watchdog:1x:${NOW - 60 * MINUTE}`],
      lastMilestoneAt: NOW - 60 * MINUTE,
    },
    watchdog: { pollMinutes: 10 },
  })
  const progress = detect(dispatch, { soft: makeSoft({ done: ['A'] }) }).filter(
    (event) => event.kind === 'milestone',
  )
  assert.equal(progress.length, 1)
  dispatch.progress = advanceCursor({
    cursor: dispatch.progress,
    events: progress,
    running: true,
    doneCount: 1,
    now: NOW,
  })
  assert.equal(dispatch.progress!.lastProgressAt, NOW)
  assert.equal(detect(dispatch, { soft: makeSoft({ done: ['A'] }) }).filter((e) => e.kind === 'watchdog').length, 0)
})

test('B 有会话活动但没上报不算停滞（活动和上报取较新者）', () => {
  const dispatch = makeDispatch({
    progress: { ...initialCursor(NOW - 45 * MINUTE) },
    watchdog: { pollMinutes: 10 },
  })
  // 45 分钟没上报，但 1 分钟前还有会话活动。
  const events = detect(dispatch, { lastActivityAt: NOW - MINUTE })
  assert.equal(events.filter((event) => event.kind === 'watchdog').length, 0)
})

test('B 彻底不动（既无活动也无上报）仍然报停滞', () => {
  const dispatch = makeDispatch({
    createdAt: NOW - 60 * MINUTE,
    progress: { ...initialCursor(NOW - 45 * MINUTE) },
    watchdog: { pollMinutes: 10 },
  })
  const watchdog = detect(dispatch, { lastActivityAt: NOW - 45 * MINUTE }).filter(
    (event) => event.kind === 'watchdog',
  )
  assert.equal(watchdog.length, 1)
  assert.match(watchdog[0]!.title, /45 分钟没有进展/)
  assert.match(watchdog[0]!.signatures[0]!, /^watchdog:3x:/)
})

test('B 上报后静止：按 pollMinutes 报一次，之后不刷屏，拖到 3 倍再报一次', () => {
  const dispatch = makeDispatch({
    progress: { ...initialCursor(NOW - 11 * MINUTE) },
    watchdog: { pollMinutes: 10 },
  })
  const first = detect(dispatch, { lastActivityAt: NOW - 60 * MINUTE }).filter(
    (event) => event.kind === 'watchdog',
  )
  assert.equal(first.length, 1)
  assert.match(first[0]!.signatures[0]!, /^watchdog:1x:/)
  dispatch.progress = advanceCursor({
    cursor: dispatch.progress,
    events: first,
    running: true,
    doneCount: 0,
    now: NOW,
  })
  // 同一安静期重复扫描：不重复报。
  const again = detect(dispatch, { lastActivityAt: NOW - 60 * MINUTE }).filter(
    (event) => event.kind === 'watchdog',
  )
  assert.equal(again.length, 0)
  // 拖到 3 倍 poll：再问最后一次（第 2 桶）。
  const later = detect(dispatch, {
    lastActivityAt: NOW - 60 * MINUTE,
    now: NOW + 20 * MINUTE,
  }).filter((event) => event.kind === 'watchdog')
  assert.equal(later.length, 1)
  assert.match(later[0]!.signatures[0]!, /^watchdog:3x:/)
})

test('B 老 dispatch 没有 watchdog：再久没活动也整段跳过', () => {
  const dispatch = makeDispatch({
    createdAt: NOW - 120 * MINUTE,
    progress: { ...initialCursor(NOW - 90 * MINUTE) },
  })
  const events = detect(dispatch, { lastActivityAt: NOW - 90 * MINUTE })
  assert.equal(events.filter((event) => event.kind === 'watchdog').length, 0)
})

// ---------------------------------------------------------------- 复杂度粗估
test('B 复杂度粗估：只读任务问得早，重构任务问得晚', () => {
  const light = estimateWatchdog('看一下这个模块在干什么', CONFIG.watchdog)
  assert.equal(light.pollMinutes, 5)
  assert.equal(light.expectedMinutes, 10)
  assert.equal(light.source, 'estimate')

  const heavy = estimateWatchdog('重构 src/service.ts 的扫描链路并跑全量测试', CONFIG.watchdog)
  assert.ok(heavy.pollMinutes > light.pollMinutes)
  assert.equal(heavy.expectedMinutes, 30)
})

test('B 复杂度粗估夹在 min/max 之间', () => {
  const long = 'x'.repeat(500) + '重构 迁移 实现 开发 全量测试'
  const result = estimateWatchdog(long, { ...CONFIG.watchdog, maxMinutes: 20 })
  assert.ok((result.expectedMinutes ?? 0) <= 20)
  assert.ok(result.pollMinutes <= 20)
})

test('B resolveWatchdog：管家显式填 expected 时 poll 取一半', () => {
  const watchdog = resolveWatchdog({ expectedMinutes: 40 }, '随便写点什么', CONFIG.watchdog)
  assert.equal(watchdog?.expectedMinutes, 40)
  assert.equal(watchdog?.pollMinutes, 20)
  assert.equal(watchdog?.source, 'butler')
})

test('B resolveWatchdog：什么都不填就按文本粗估，关闭时返回 undefined', () => {
  assert.equal(resolveWatchdog(undefined, '看一下现状', CONFIG.watchdog)?.source, 'estimate')
  assert.equal(resolveWatchdog(undefined, '看一下现状', { ...CONFIG.watchdog, enabled: false }), undefined)
  assert.equal(resolveWatchdog({ quiet: true }, '随便', CONFIG.watchdog)?.quiet, true)
})
