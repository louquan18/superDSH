import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  matchPlanCommand,
  matchPlanNetwork,
  matchPlanPath,
  planExcerpt,
  planRequiredFor,
  planSummary,
  scopeItems,
} from '../../src/plans.js'
import type { Dispatch, Plan, PlanScopeItem } from '../../src/types.js'

function makePlan(items: PlanScopeItem[]): Plan {
  return {
    id: 'plan_1',
    sessionId: 's1',
    dispatchId: 'd1',
    title: 'test plan',
    markdown: '# plan',
    scope: { items },
    status: 'approved',
    submittedAt: 1000,
    source: 'butler_submit_plan',
  }
}

test('matchPlanPath matches glob patterns under the project root', () => {
  const plan = makePlan([{ id: 'i1', description: 'src', paths: ['src/**'] }])
  const match = matchPlanPath(plan, '/proj', 'src/a/b.ts')
  assert.ok(match)
  assert.equal(match!.item.id, 'i1')
  assert.equal(match!.score, 'src/**'.replace(/\*/g, '').length)

  // absolute targets are accepted too
  assert.equal(matchPlanPath(plan, '/proj', '/proj/src/a.ts')?.item.id, 'i1')
})

test('matchPlanPath rejects paths outside the project root', () => {
  const plan = makePlan([{ id: 'i1', description: 'src', paths: ['src/**'] }])
  assert.equal(matchPlanPath(plan, '/proj', '/other/src/a.ts'), undefined)
  assert.equal(matchPlanPath(plan, '/proj', '../outside.ts'), undefined)
})

test('matchPlanPath picks the most specific matching pattern', () => {
  const plan = makePlan([
    { id: 'wide', description: 'all src', paths: ['src/**'] },
    { id: 'exact', description: 'one file', paths: ['src/a.ts'] },
  ])
  const match = matchPlanPath(plan, '/proj', 'src/a.ts')
  assert.equal(match?.item.id, 'exact')
  assert.ok(match!.score > 'src/**'.replace(/\*/g, '').length)
})

test('matchPlanPath returns undefined without a plan or matching item', () => {
  assert.equal(matchPlanPath(undefined, '/proj', 'src/a.ts'), undefined)
  const plan = makePlan([{ id: 'i1', description: 'docs', paths: ['docs/**'] }])
  assert.equal(matchPlanPath(plan, '/proj', 'src/a.ts'), undefined)
  const noPaths = makePlan([{ id: 'i2', description: 'nothing' }])
  assert.equal(matchPlanPath(noPaths, '/proj', 'src/a.ts'), undefined)
})

test('matchPlanCommand supports exact commands and trailing wildcards', () => {
  const plan = makePlan([
    { id: 'exact', description: 'test', commands: ['npm test'] },
    { id: 'wild', description: 'pnpm', commands: ['pnpm *'] },
  ])
  assert.equal(matchPlanCommand(plan, 'npm test')?.item.id, 'exact')
  assert.equal(matchPlanCommand(plan, 'npm test -- --runInBand'), undefined)
  assert.equal(matchPlanCommand(plan, 'pnpm run build')?.item.id, 'wild')
  assert.equal(matchPlanCommand(plan, 'npm test -- --x'), undefined)
  assert.equal(matchPlanCommand(undefined, 'npm test'), undefined)
})

test('matchPlanCommand prefers the highest scoring pattern', () => {
  const plan = makePlan([
    { id: 'prefix', description: 'npm', commands: ['npm *'] },
    { id: 'exact', description: 'npm test', commands: ['npm test'] },
  ])
  assert.equal(matchPlanCommand(plan, 'npm test')?.item.id, 'exact')
})

test('matchPlanNetwork only matches items explicitly marked network', () => {
  const withNetwork = makePlan([{ id: 'net', description: 'web', network: true }])
  assert.equal(matchPlanNetwork(withNetwork)?.item.id, 'net')
  const withoutNetwork = makePlan([{ id: 'local', description: 'local', paths: ['src/**'] }])
  assert.equal(matchPlanNetwork(withoutNetwork), undefined)
  assert.equal(matchPlanNetwork(undefined), undefined)
})

test('planSummary and scopeItems describe the plan scope', () => {
  const plan = makePlan([
    { id: 'a', description: 'a', paths: ['src/a.ts', 'src/b.ts'] },
    { id: 'b', description: 'b', commands: ['npm test'] },
  ])
  assert.equal(planSummary(plan), '2 个计划条目，2 条路径，1 条命令')
  assert.equal(scopeItems(plan).length, 2)
  assert.deepEqual(scopeItems(undefined), [])
})

// ---------------------------------------------------------------- R1 计划门禁

function makeDispatch(overrides: Partial<Dispatch> = {}): Dispatch {
  return {
    id: 'd1',
    text: '改一下扫描',
    targetSessionId: 's1',
    workspaceKey: 'proj',
    mode: 'reuse',
    modeAtDispatch: 'plan_review',
    requestId: 'req',
    status: 'accepted',
    reason: 'test',
    relatedSessionIds: [],
    createdAt: 1000,
    ...overrides,
  }
}

test('R1 planRequiredFor 不看派发状态：failed / error 仍然要求计划', () => {
  const project = { key: 'proj', cwd: '/tmp', title: 'p', mode: 'plan_review' as const, createdAt: 1, updatedAt: 1 }
  for (const status of ['accepted', 'delivered', 'error', 'failed'] as const) {
    assert.equal(
      planRequiredFor(makeDispatch({ status }), project as any),
      true,
      `${status} 也必须要求计划`,
    )
  }
  // 派发时就是卡点确认模式 → 不要求
  assert.equal(
    planRequiredFor(makeDispatch({ modeAtDispatch: 'gate_confirm' }), project as any),
    false,
  )
  // 项目后来切回卡点确认 → 不要求
  assert.equal(
    planRequiredFor(makeDispatch(), { ...project, mode: 'gate_confirm' } as any),
    false,
  )
})

test('R1 planExcerpt 给出一行正文和范围统计', () => {
  const plan = makePlan([{ id: 'P1', description: 'src', paths: ['src/**'] }])
  plan.markdown = '# 改扫描\n\n细节一\n细节二'
  const excerpt = planExcerpt(plan, 80)
  assert.match(excerpt, /1 个计划条目/)
  assert.match(excerpt, /改扫描/)
  assert.equal(excerpt.includes('细节一'), false, '只取首行')
})
