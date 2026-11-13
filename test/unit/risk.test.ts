import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyTool, isMutating, isReadOnly, type RiskContext } from '../../src/risk.js'
import type { Plan } from '../../src/types.js'

function makePlan(items: Plan['scope']['items']): Plan {
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

const gateConfirm: RiskContext = {
  projectRoot: '/proj',
  cwd: '/proj',
  gated: false,
  policy: 'whitelist',
}

const planReviewNoPlan: RiskContext = {
  projectRoot: '/proj',
  cwd: '/proj',
  gated: true,
  policy: 'plan',
}

test('sandbox escalation is high even for whitelisted or in-plan calls', () => {
  const bash = classifyTool(
    'bash',
    { command: 'npm test', sandbox_permissions: 'danger-full-access', justification: 'x' },
    gateConfirm,
  )
  assert.equal(bash.risk, 'high')
  assert.match(String(bash.reason), /沙箱升级/)

  const planned: RiskContext = {
    ...planReviewNoPlan,
    plan: makePlan([{ id: 'P1', description: 'src', paths: ['src/**'] }]),
  }
  const write = classifyTool(
    'write',
    { file_path: '/proj/src/a.ts', content: 'x', sandbox_permissions: 'workspace-write', justification: 'x' },
    planned,
  )
  assert.equal(write.risk, 'high')
  assert.equal(write.planItemId, undefined)

  // 没交计划时仍然是硬拒绝，不会被升级成 ask
  const denied = classifyTool(
    'write',
    { file_path: '/proj/src/a.ts', content: 'x', sandbox_permissions: 'workspace-write', justification: 'x' },
    planReviewNoPlan,
  )
  assert.equal(denied.deny, true)
})

test('read-only tools are low risk', () => {
  const result = classifyTool('read', { file_path: '/proj/a.ts' }, gateConfirm)
  assert.equal(result.risk, 'low')
  assert.equal(result.deny, undefined)
})

test('writes inside the project are low risk in gate_confirm mode', () => {
  const result = classifyTool('write', { file_path: '/proj/src/a.ts', content: 'x' }, gateConfirm)
  assert.equal(result.risk, 'low')
  assert.equal(result.deny, undefined)
})

test('writes outside the project are high risk', () => {
  const result = classifyTool('write', { file_path: '/etc/passwd', content: 'x' }, gateConfirm)
  assert.equal(result.risk, 'high')
  assert.match(result.reason ?? '', /写工作区外/)
})

test('writes without a path are high risk', () => {
  const result = classifyTool('write', { content: 'x' }, gateConfirm)
  assert.equal(result.risk, 'high')
  assert.match(result.reason ?? '', /缺少文件路径/)
})

test('plan_review denies writes before a plan is approved', () => {
  const result = classifyTool('write', { file_path: '/proj/src/a.ts' }, planReviewNoPlan)
  assert.equal(result.risk, 'high')
  assert.equal(result.deny, true)
  assert.match(result.reason ?? '', /先交计划/)
})

test('plan_review allows writes covered by the approved plan', () => {
  const plan = makePlan([{ id: 'item_1', description: 'src', paths: ['src/**'] }])
  const result = classifyTool(
    'write',
    { file_path: '/proj/src/a.ts', content: 'x' },
    { ...planReviewNoPlan, plan },
  )
  assert.equal(result.risk, 'low')
  assert.equal(result.deny, undefined)
  assert.equal(result.planId, 'plan_1')
  assert.equal(result.planItemId, 'item_1')
  assert.match(result.reason ?? '', /命中计划条目 item_1/)
})

test('plan_review marks writes outside the approved plan as high risk', () => {
  const plan = makePlan([{ id: 'item_1', description: 'src', paths: ['src/**'] }])
  const result = classifyTool(
    'write',
    { file_path: '/proj/docs/readme.md', content: 'x' },
    { ...planReviewNoPlan, plan },
  )
  assert.equal(result.risk, 'high')
  assert.match(result.reason ?? '', /计划外写操作/)
})

test('whitelisted bash commands are low risk in gate_confirm mode', () => {
  for (const command of ['npm test', 'pnpm run build', 'git status']) {
    const result = classifyTool('bash', { command }, gateConfirm)
    assert.equal(result.risk, 'low', command)
  }
})

test('bash commands with shell metacharacters are high risk', () => {
  const result = classifyTool('bash', { command: 'npm test; ls build' }, gateConfirm)
  assert.equal(result.risk, 'high')
  assert.match(result.reason ?? '', /shell 元字符/)
  assert.equal(result.review, 'danger')
})

test('dangerous bash commands are high risk', () => {
  for (const command of ['rm -rf build', 'git push origin main', 'curl https://example.com']) {
    const result = classifyTool('bash', { command }, gateConfirm)
    assert.equal(result.risk, 'high', command)
    assert.match(result.reason ?? '', /危险命令/, command)
    // 关键词只是提示：仍交给管家按实际效果审，并把命中的关键词带过去
    assert.equal(result.review, 'danger', command)
    assert.ok((result.flags ?? []).length > 0, command)
  }
})

test('empty bash commands are high risk', () => {
  const result = classifyTool('bash', { command: '   ' }, gateConfirm)
  assert.equal(result.risk, 'high')
  assert.match(result.reason ?? '', /空命令/)
})

test('plan_review denies bash before a plan is approved', () => {
  const result = classifyTool('bash', { command: 'npm test' }, planReviewNoPlan)
  assert.equal(result.risk, 'high')
  assert.equal(result.deny, true)
  assert.match(result.reason ?? '', /先交计划/)
})

test('plan_review allows commands covered by the plan wildcard', () => {
  const plan = makePlan([{ id: 'cmd_1', description: 'tests', commands: ['npm test*'] }])
  const result = classifyTool('bash', { command: 'npm test -- --runInBand' }, {
    ...planReviewNoPlan,
    plan,
  })
  assert.equal(result.risk, 'low')
  assert.equal(result.planId, 'plan_1')
  assert.equal(result.planItemId, 'cmd_1')
})

test('plan_review marks out-of-plan commands high risk', () => {
  const plan = makePlan([{ id: 'cmd_1', description: 'tests', commands: ['npm test*'] }])
  const result = classifyTool('bash', { command: 'npm run build' }, {
    ...planReviewNoPlan,
    plan,
  })
  assert.equal(result.risk, 'high')
  assert.match(result.reason ?? '', /计划外命令/)
})

test('plan_review can allow read-only bash when configured', () => {
  const plan = makePlan([{ id: 'cmd_1', description: 'tests', commands: ['npm test*'] }])
  const result = classifyTool('bash', { command: 'git status' }, {
    ...planReviewNoPlan,
    plan,
    allowReadOnlyBash: true,
  })
  assert.equal(result.risk, 'low')
  assert.equal(result.planId, undefined)
})

test('web_search is low risk in gate_confirm and web_fetch is high risk', () => {
  assert.equal(classifyTool('web_search', { query: 'x' }, gateConfirm).risk, 'low')
  const fetch = classifyTool('web_fetch', { url: 'https://example.com' }, gateConfirm)
  assert.equal(fetch.risk, 'high')
  assert.match(fetch.reason ?? '', /外部网络请求/)
})

test('plan_review gates network tools behind a network plan item', () => {
  const deniedSearch = classifyTool('web_search', { query: 'x' }, planReviewNoPlan)
  assert.equal(deniedSearch.deny, true)

  const deniedFetch = classifyTool('web_fetch', { url: 'https://example.com' }, planReviewNoPlan)
  assert.equal(deniedFetch.deny, true)

  const plan = makePlan([{ id: 'net_1', description: 'web', network: true }])
  const planned = classifyTool('web_fetch', { url: 'https://example.com' }, {
    ...planReviewNoPlan,
    plan,
  })
  assert.equal(planned.risk, 'low')
  assert.equal(planned.planItemId, 'net_1')

  const noNetwork = makePlan([{ id: 'local_1', description: 'local', paths: ['src/**'] }])
  const outOfPlan = classifyTool('web_fetch', { url: 'https://example.com' }, {
    ...planReviewNoPlan,
    plan: noNetwork,
  })
  assert.equal(outOfPlan.risk, 'high')
  assert.match(outOfPlan.reason ?? '', /计划外网络请求/)
})

test('mutating tools are high risk; unknown tools are unknown (§7.1)', () => {
  const mutating = classifyTool('run_code', { code: 'x' }, gateConfirm)
  assert.equal(mutating.risk, 'high')
  assert.match(mutating.reason ?? '', /高风险工具/)

  const denied = classifyTool('run_code', { code: 'x' }, planReviewNoPlan)
  assert.equal(denied.deny, true)

  const unknown = classifyTool('mystery_tool', {}, gateConfirm)
  assert.equal(unknown.risk, 'unknown')
  assert.match(unknown.reason ?? '', /未知工具：mystery_tool/)
})

test('isMutating and isReadOnly classify tool names', () => {
  assert.equal(isMutating('bash'), true)
  assert.equal(isMutating('read'), false)
  assert.equal(isReadOnly('read'), true)
  assert.equal(isReadOnly('bash'), false)
})

// ---------------------------------------------------------------- I-35 计划内写入

test('I-35：已批准计划（绝对 scope）+ 不带 sandbox_permissions 的 edit → 计划内，低风险', () => {
  const planReview = {
    ...planReviewNoPlan,
    plan: makePlan([
      {
        id: 'backend',
        description: 'PageServiceImpl',
        paths: [
          '/proj/gcloud/business-analysis/src/main/java/com/proj/service/impl/PageServiceImpl.java',
        ],
      },
    ]),
  } as RiskContext

  const verdict = classifyTool(
    'edit',
    {
      file_path:
        '/proj/gcloud/business-analysis/src/main/java/com/proj/service/impl/PageServiceImpl.java',
      old_string: 'a',
      new_string: 'b',
    },
    planReview,
  )
  assert.equal(verdict.risk, 'low', `计划内文件不该被判计划外：${String(verdict.reason)}`)
})

test('I-35：真·计划外写入仍要拦成高风险，并在原因里列出计划规则', () => {
  const planReview = {
    ...planReviewNoPlan,
    plan: makePlan([
      { id: 'backend', description: 'only src', paths: ['/proj/gcloud/src/**'] },
    ]),
  } as RiskContext

  const verdict = classifyTool(
    'edit',
    { file_path: '/proj/gcloud/docs/readme.md', old_string: 'a', new_string: 'b' },
    planReview,
  )
  assert.equal(verdict.risk, 'high', '不能为了修误判而放过计划外写入')
  assert.match(String(verdict.reason), /计划外写操作/)
  assert.match(String(verdict.reason), /计划规则/, '要能看出计划里到底声明了什么')
})

// ---------------------------------------------------------------- I-31 MCP 分级

test('I-31：MCP 只读方法自动放行，会变状态的方法需要审批', () => {
  const plan = { ...planReviewNoPlan } as RiskContext
  for (const method of ['take_snapshot', 'list_pages', 'take_screenshot']) {
    const verdict = classifyTool(`mcp__chrome-devtools-mcp__${method}`, {}, plan)
    assert.equal(verdict.risk, 'low', `${method} 是只读，应自动放行`)
    assert.match(String(verdict.reason), /MCP 只读/)
  }
  for (const method of ['click', 'fill', 'navigate_page', 'upload_file']) {
    const verdict = classifyTool(`mcp__chrome-devtools-mcp__${method}`, {}, plan)
    assert.equal(verdict.risk, 'high', `${method} 会改变状态，必须审批`)
  }
})

test('I-31：evaluate_script 能执行任意 JS，明确不算只读', () => {
  const verdict = classifyTool(
    'mcp__chrome-devtools-mcp__evaluate_script',
    { function: '() => fetch("http://x")' },
    planReviewNoPlan,
  )
  assert.equal(verdict.risk, 'high', '任意 JS 可读写页面、可发请求，不能自动放行')
})

test('I-31：表里没有的 MCP 方法回落到「要人确认」，不默认放行', () => {
  const verdict = classifyTool('mcp__some-server__totally_new_method', {}, planReviewNoPlan)
  assert.equal(verdict.risk, 'unknown')
  assert.match(String(verdict.reason), /未知 MCP 方法/)
  assert.match(String(verdict.reason), /some-server\.totally_new_method/)
})
