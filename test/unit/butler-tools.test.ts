import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createButlerTools } from '../../src/butler-tools.js'
import { DSH_CAPABILITIES, READ_ONLY_CAPABILITIES } from '../../src/sources/types.js'
import { isLosslessJson, findLossyPath } from '../lossless.js'

/**
 * 缺陷复现（2026-11-06）：`butler_status` / `butler_dispatch` 的输出里带显式 `undefined`，
 * dsh 0.2.2 的 `snapshotJsonValue` 会判 `value is not lossless JSON`，工具调用整体失败。
 *
 * 触发条件：全量枚举里只要有一条 session 没有软状态（管家自己就没有）、没有 projectKey/mode，
 * 或者候选 session 没有进行中的派发（`openDispatch: undefined`）。
 */

/** 管家自己：没有 softStatus、没有 projectKey/mode —— 正是全量枚举必挂的原因。 */
function sessionWithoutSoftStatus(): any {
  return {
    sessionId: 'session-butler',
    title: 'SuperAgent 管家',
    cwd: '/tmp/ws',
    projectKey: undefined,
    mode: undefined,
    hardStatus: 'idle',
    running: false,
    lastActivityAt: 1_700_000_000_000,
    queuedCount: 0,
    softStatus: undefined,
    openBlockerKinds: [],
    openBlockerCount: 0,
    isButler: true,
  }
}

function healthySession(): any {
  return {
    sessionId: 'session-worker',
    title: 'worker',
    cwd: '/tmp/ws',
    projectKey: 'cwd_demo',
    mode: 'plan_review',
    hardStatus: 'idle',
    running: false,
    lastActivityAt: 1_700_000_000_000,
    queuedCount: 0,
    softStatus: { goal: '改 bug', done: ['定位'], next: ['修复'], blockers: [], decisions: [], reportedAt: 1 },
    openBlockerKinds: [],
    openBlockerCount: 0,
    isButler: false,
  }
}

function stubService(overrides: any = {}): any {
  return {
    isButlerAgentSession: () => true,
    snapshot: async () => ({
      generatedAt: 1,
      butler: { sessionId: 'session-butler', title: 'SuperAgent 管家', status: 'idle' },
      projects: [],
      sessions: [sessionWithoutSoftStatus(), healthySession()],
      blockers: [],
      plans: [],
      dispatches: [],
      approvals: [],
      audit: [],
    }),
    ...overrides,
  }
}

const exec: any = { agent: { id: 'session-butler' } }

function tool(service: any, name: string): any {
  const found = createButlerTools(service).find((item: any) => item.name === name)
  assert.ok(found, `${name} must exist`)
  return found
}

test('复现：原始映射形状（带 undefined）本身就不是 lossless JSON', () => {
  const session = sessionWithoutSoftStatus()
  const raw = {
    butler: { sessionId: 'session-butler', title: 'SuperAgent 管家', status: 'idle' },
    sessions: [
      {
        sessionId: session.sessionId,
        title: session.title,
        projectKey: session.projectKey,
        mode: session.mode,
        hardStatus: session.hardStatus,
        running: session.running,
        lastActivityAt: session.lastActivityAt,
        queuedCount: session.queuedCount,
        softStatus: session.softStatus,
        openBlockerKinds: session.openBlockerKinds,
        openBlockerCount: session.openBlockerCount,
        isButler: session.isButler,
      },
    ],
  }
  assert.equal(isLosslessJson(raw), false)
  assert.match(String(findLossyPath(raw)), /projectKey is undefined/)
})

test('butler_status 全量枚举的返回值能过 lossless 校验', async () => {
  const result = await tool(stubService(), 'butler_status').execute({}, exec)
  assert.equal(findLossyPath(result), null)
  assert.equal(isLosslessJson(result), true)
  assert.equal(result.sessions.length, 2)
  // 有值的字段必须原样保留，不能被「清理」掉
  assert.equal(result.sessions[1].softStatus.goal, '改 bug')
  assert.equal(result.sessions[0].isButler, true)
  assert.equal('softStatus' in result.sessions[0], false)
})

test('butler_status 带 includeSoft/includeBlockers 也不产生 undefined', async () => {
  const service = stubService()
  for (const args of [{}, { includeSoft: true }, { includeBlockers: true }, { projectKey: 'cwd_demo' }]) {
    const result = await tool(service, 'butler_status').execute(args, exec)
    assert.equal(findLossyPath(result), null, JSON.stringify(args))
  }
  // includeSoft:false 时字段应当整键消失，而不是变成 undefined
  const without = await tool(service, 'butler_status').execute({ includeSoft: false }, exec)
  assert.equal('softStatus' in without.sessions[1], false)
  assert.equal('openBlockerKinds' in without.sessions[1], true)
})

test('butler_dispatch 候选输出的 undefined 也被清掉', async () => {
  const service = stubService({
    dispatchCandidates: async () => ({
      kind: 'candidates',
      project: { key: 'cwd_demo', cwd: '/tmp/ws', title: 'ws', mode: 'plan_review', createdAt: 1, updatedAt: 1 },
      workspace: '/tmp/ws',
      explicitTargetId: undefined,
      candidates: [
        {
          sessionId: 'session-worker',
          title: 'worker',
          projectKey: 'cwd_demo',
          hardStatus: 'idle',
          lastActivityAt: 1,
          queuedCount: 0,
          softStatus: undefined,
          recentUserMessages: [],
          openDispatch: undefined,
          openBlockerKinds: [],
        },
      ],
    }),
  })
  const result = await tool(service, 'butler_dispatch').execute({ text: '继续改 bug' }, exec)
  assert.equal(findLossyPath(result), null)
  assert.equal(isLosslessJson(result), true)
  assert.equal(result.candidates[0].sessionId, 'session-worker')
  assert.equal('openDispatch' in result.candidates[0], false)
})

test('错误分支返回的普通对象同样没有 undefined', async () => {
  const result = await tool(stubService(), 'butler_dispatch').execute({ text: '   ' }, exec)
  assert.equal(isLosslessJson(result), true)
  assert.deepEqual(result, { error: 'text is required' })
})

// ---------------------------------------------------------------- butler_send 校验

function sessionLite(sessionId: string, source = 'dsh'): any {
  return {
    sessionId,
    source,
    title: `title-${sessionId}`,
    cwd: '/tmp/ws',
    live: true,
    persisted: true,
    blank: false,
    running: false,
    agentAvailable: true,
    updatedAt: 1,
  }
}

function sendService(overrides: any = {}): any {
  const sent: Array<{ sessionId: string; text: string }> = []
  return {
    isButlerAgentSession: () => true,
    listSessions: async () => [],
    capabilitiesOf: () => DSH_CAPABILITIES,
    async sendToSession(sessionId: string, text: string) {
      sent.push({ sessionId, text })
    },
    sent,
    ...overrides,
  }
}

test('butler_send 不存在的会话：返回 session_not_found，不投递', async () => {
  const service = sendService()
  const badId = 'session-98da5e2e-39fa-4b46-a2cd-36e8664e064e'
  const result = await tool(service, 'butler_send').execute({ sessionId: badId, text: '你好' }, exec)
  assert.deepEqual(result, { ok: false, error: 'session_not_found', sessionId: badId })
  assert.equal(service.sent.length, 0, '校验失败不能投递')
})

test('butler_send 只读来源：返回 target_read_only，不投递', async () => {
  const service = sendService({
    listSessions: async () => [sessionLite('claude-1', 'claude')],
    capabilitiesOf: () => READ_ONLY_CAPABILITIES,
  })
  const result = await tool(service, 'butler_send').execute(
    { sessionId: 'claude-1', text: '你好' },
    exec,
  )
  assert.deepEqual(result, { ok: false, error: 'target_read_only', sessionId: 'claude-1' })
  assert.equal(service.sent.length, 0, '只读来源不能投递')
})

test('butler_send 存在的可写会话照常投递', async () => {
  const service = sendService({
    listSessions: async () => [sessionLite('worker-1')],
    capabilitiesOf: () => DSH_CAPABILITIES,
  })
  const result = await tool(service, 'butler_send').execute(
    { sessionId: 'worker-1', text: '继续' },
    exec,
  )
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(service.sent, [{ sessionId: 'worker-1', text: '继续' }])
})
