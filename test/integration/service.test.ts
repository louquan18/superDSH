/**
 * Host 侧集成测试：用最小的假 ctx 跑真实的 SuperagentService。
 *
 * 覆盖设计里最硬的三条规则：
 * - §4.4/§7.3 计划门禁只作用于「管家派发中 + 计划审查」的 session；手动 session 不受约束。
 * - 计划审查模式下没批计划 → 写操作被 deny；批了且命中 scope → low。
 * - 卡点确认模式 → 低风险白名单代批，其余转用户（approval answerer 的 allow/deny）。
 * - §4.2 dispatch 完成/失败结束门禁。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { SuperagentService } from '../../src/service.js'
import { createButlerTools } from '../../src/butler-tools.js'
import { apply as applyButlerPreset } from '../../src/butler/index.js'

interface Harness {
  ctx: any
  service: SuperagentService
  agents: Map<string, any>
  sessions: Map<string, any>
  prompts: Array<{ sessionId: string; content: any; requestId: string }>
  emit(event: string, ...args: any[]): void
  addAgent(id: string, cwd: string, preset?: string): any
  gate(agent: any, name: string, args: any, callId?: string): Promise<any>
  approval(agent: any, request: any): Promise<any>
  cleanup(): Promise<void>
}

function createHarness(cwd: string): Harness {
  let spec: any = null
  const storage = new Map<string, Map<string, any>>()
  const domain = {
    table(name: string) {
      let map = storage.get(name)
      if (!map) {
        map = new Map()
        storage.set(name, map)
      }
      const current = map
      const schema = spec?.tables?.[name]?.valueSchema
      const check = (value: any) => {
        // 用 storageDomain 真实的 valueSchema 校验：写坏记录会让测试立刻失败。
        if (schema) schema.parse(value)
      }
      return {
        get: (key: string) => current.get(key),
        entries: () => current.entries(),
        keys: () => current.keys(),
        get size() {
          return current.size
        },
        async put(key: string, value: any) {
          check(value)
          current.set(key, value)
        },
        async delete(key: string) {
          return current.delete(key)
        },
        async update(key: string, fn: (value: any) => any) {
          const next = fn(current.get(key))
          check(next)
          current.set(key, next)
          return next
        },
      }
    },
    async close() {},
  }

  const agents = new Map<string, any>()
  const sessions = new Map<string, any>()
  const prompts: Array<{ sessionId: string; content: any; requestId: string }> = []
  const listeners = new Map<string, Array<(...args: any[]) => any>>()
  let counter = 0

  const ctx: any = {
    storageDomain: {
      async open(next: any) {
        spec = next
        return domain
      },
    },
    workspaceRegistry: { list: () => [] },
    workingDirectory: { defaultDirectory: cwd },
    userQuestions: { async answer() { return {} } },
    tools: { register: () => () => {}, restrict: () => () => {}, guard: () => () => {} },
    systemPrompt: { section: () => () => {} },
  }

  ctx.agents = {
    get: (id: string) => agents.get(id),
    roots: () => [...agents.values()],
  }
  ctx.sessionController = {
    async list() {
      return {
        items: [...sessions.values()].map((session) => ({
          sessionId: session.id,
          running: session.running === true,
          agentAvailable: true,
          updatedAt: session.updatedAt ?? 1,
          blank: false,
          cwd: session.cwd,
        })),
      }
    },
    async create(request: any) {
      const id = request?.sessionId ?? `session-${++counter}`
      sessions.set(id, { id, cwd: request?.cwd, title: '', updatedAt: 1 })
      return { sessionId: id }
    },
    async prompt(request: any) {
      prompts.push({ sessionId: request.sessionId, content: request.content, requestId: request.requestId })
      return { accepted: true }
    },
    async rename(request: any) {
      const session = sessions.get(request.sessionId)
      if (session) session.title = request.title
      return { title: request.title }
    },
    async cancel() {
      return { accepted: true }
    },
    async updateQueue() {
      return { accepted: true }
    },
    async resolveAgent(id: string) {
      const agent = agents.get(id)
      return agent ? { agent } : { error: 'no_agent' }
    },
  }
  ctx.sessionQuery = {
    async listSessions() {
      return [...sessions.values()].map((session) => ({
        header: {
          id: session.id,
          cwd: session.cwd,
          createdAt: session.updatedAt ?? 1,
          agentPreset: session.agentPreset,
        },
        live: Boolean(agents.get(session.id)),
        persisted: true,
      }))
    },
    async readTitleSnapshots(ids: string[]) {
      return ids.map((id) => ({
        sessionId: id,
        status: 'fulfilled',
        value: { title: { title: sessions.get(id)?.title ?? id } },
      }))
    },
    async observeSession(id: string) {
      const session = sessions.get(id)
      return {
        header: { id, cwd: session?.cwd, createdAt: session?.updatedAt ?? 1 },
        events: [],
        projections: { asOfSeq: 0, values: {} },
      }
    },
  }
  ctx.on = (event: string, fn: (...args: any[]) => any) => {
    const list = listeners.get(event) ?? []
    list.push(fn)
    listeners.set(event, list)
    return () => {
      listeners.set(event, (listeners.get(event) ?? []).filter((item) => item !== fn))
    }
  }
  ctx.effect = (fn: () => any) => {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  }
  ctx.get = (name: string) => ctx[name]

  const harness: Partial<Harness> = {
    ctx,
    agents,
    sessions,
    prompts,
    emit(event: string, ...args: any[]) {
      for (const fn of listeners.get(event) ?? []) fn(...args)
    },
    addAgent(id: string, agentCwd: string, preset = 'default') {
      const handlers: Array<{ event: string; fn: any }> = []
      const agent: any = {
        id,
        status: 'idle',
        session: { header: { cwd: agentCwd, agentPreset: preset } },
        ctx: {
          on(event: string, fn: any) {
            handlers.push({ event, fn })
            return () => {}
          },
          tools: { register: () => () => {} },
          systemPrompt: { section: () => () => {} },
        },
        injected: [],
        inject(message: any) {
          agent.injected.push(message)
        },
      }
      agents.set(id, agent)
      sessions.set(id, {
        id,
        cwd: agentCwd,
        title: `title-${id}`,
        updatedAt: Date.now(),
        agentPreset: preset,
      })
      harness.emit!('agent/created', { agent, source: 'startup' })
      ;(agent as any).__handlers = handlers
      return agent
    },
    async gate(agent: any, name: string, args: any, callId?: string) {
      const handler = (agent.__handlers as Array<{ event: string; fn: any }>).find(
        (item) => item.event === 'tools/pre-execute',
      )
      assert.ok(handler, 'worker must install a tools/pre-execute gate')
      const id = callId ?? `call-${++counter}`
      agent.__lastCallId = id
      return await handler.fn(
        {
          callId: id,
          name,
          arguments: args,
          agent,
          signal: new AbortController().signal,
        },
        async () => ({ kind: 'allow' }),
      )
    },
    async approval(agent: any, request: any) {
      const handler = (agent.__handlers as Array<{ event: string; fn: any }>).find(
        (item) => item.event === 'approval/request',
      )
      assert.ok(handler, 'worker must install an approval answerer')
      // 真实顺序：tools/pre-execute 先分类并记下 intent，原生 approval 再问。
      const withCallId = { callId: agent.__lastCallId, ...request }
      return await handler.fn(withCallId, async () => 'unavailable')
    },
    async cleanup() {
      harness.service?.dispose()
      await rm(cwd, { recursive: true, force: true })
    },
  }

  return harness as Harness
}

const active: Harness[] = []
afterEach(async () => {
  while (active.length > 0) await active.pop()!.cleanup()
})

async function boot(config: any = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'sab-it-'))
  const harness = createHarness(cwd)
  harness.service = await SuperagentService.create(harness.ctx, config)
  active.push(harness)
  return { harness, cwd }
}

test('手动 session 的写操作不受计划门禁约束', async () => {
  const { harness, cwd } = await boot()
  const agent = harness.addAgent('manual-1', cwd)
  await harness.service.listSessions(true)

  const decision = await harness.gate(agent, 'write', {
    file_path: path.join(cwd, 'a.txt'),
    content: 'hello',
  })
  assert.deepEqual(decision, { kind: 'allow' })
})

test('计划审查：管家派发的任务没批计划时，写操作被硬拒绝', async () => {
  const { harness, cwd } = await boot()
  const agent = harness.addAgent('worker-1', cwd)
  await harness.service.listSessions(true)
  const dispatch = await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-1', reason: '集成测试' },
    '改一下 a.txt',
  )
  assert.equal(dispatch.kind, 'reuse')
  assert.equal(dispatch.delivery, 'wake')

  const decision = await harness.gate(agent, 'write', {
    file_path: path.join(cwd, 'a.txt'),
    content: 'hello',
  })
  assert.equal(decision.kind, 'deny')
  assert.match(String(decision.reason), /先交计划/)
})

test('计划审查：批了计划且命中 scope 后放行，计划外仍然转用户', async () => {
  const { harness, cwd } = await boot()
  const agent = harness.addAgent('worker-2', cwd)
  await harness.service.listSessions(true)
  const started = await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-2', reason: '集成测试' },
    '重写 src 下的模块',
  )
  assert.equal(started.kind, 'reuse', JSON.stringify(started))

  const submitted = await harness.service.submitPlan(agent, {
    title: '重写模块',
    plan: '1. 改 src/a.ts',
    scope: { items: [{ id: 'P1', description: '改 a.ts', paths: ['src/**'] }] },
  })
  assert.equal(submitted.status, 'pending_review')

  const inScope = await harness.gate(agent, 'write', {
    file_path: path.join(cwd, 'src', 'a.ts'),
    content: 'x',
  })
  // 计划还在待审：仍然拒绝
  assert.equal(inScope.kind, 'deny')

  const reviewed = await harness.service.reviewPlan(submitted.planId, 'approve', undefined)
  assert.equal(reviewed.ok, true)

  const allowed = await harness.gate(agent, 'write', {
    file_path: path.join(cwd, 'src', 'a.ts'),
    content: 'x',
  })
  assert.deepEqual(allowed, { kind: 'allow' })

  const outside = await harness.gate(agent, 'write', {
    file_path: path.join(cwd, 'other', 'b.ts'),
    content: 'x',
  })
  assert.equal(outside.kind, 'ask')
})

test('计划外操作进原生审批：ask 之后由 owner 允许才执行', async () => {
  const { harness, cwd } = await boot()
  const agent = harness.addAgent('worker-3', cwd)
  await harness.service.listSessions(true)
  await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-3', reason: '集成测试' },
    '跑一次部署脚本',
  )
  const plan = await harness.service.submitPlan(agent, {
    title: '计划',
    plan: '1. 只改 README',
    scope: { items: [{ id: 'P1', description: '改 README', paths: ['README.md'] }] },
  })
  await harness.service.reviewPlan(plan.planId, 'approve', undefined)

  // 没有 llm 服务：管家审查不可用，转用户时说明是审查没跑成
  const ask = await harness.gate(agent, 'bash', { command: 'rm -rf build' })
  assert.match(String(ask.reason), /管家没能完成审查/)
  assert.equal(ask.kind, 'ask')

  // 原生 approval 到达：插件挂起等待 owner 决策
  const pending = harness.approval(agent, {
    toolName: 'bash',
    callId: 'call-x',
    reason: '危险命令',
    signal: new AbortController().signal,
  })
  const approval = harness.service.store.listApprovals().find((item) => item.status === 'pending')
  assert.ok(approval, 'held approval must be persisted')
  const outcome = await harness.service.decideApproval(approval!.id, 'allow')
  assert.equal(outcome.ok, true)
  assert.equal(await pending, 'allowed-once')
})

test('卡点确认：低风险命令代批，危险命令转用户并可拒绝', async () => {
  const { harness, cwd } = await boot()
  const agent = harness.addAgent('worker-4', cwd)
  await harness.service.listSessions(true)
  const project = harness.service.ensureProjectForCwd(cwd)
  await harness.service.setMode(project.key, 'gate_confirm')
  await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-4', reason: '集成测试' },
    '跑测试',
  )

  const lowGate = await harness.gate(agent, 'bash', { command: 'npm test' }, 'call-low')
  assert.deepEqual(lowGate, { kind: 'allow' })
  const low = await harness.approval(agent, {
    toolName: 'bash',
    signal: new AbortController().signal,
  })
  assert.equal(low, 'allowed-once')
  assert.ok(
    harness.service.store.listApprovals().some((item) => item.status === 'auto_approved'),
    'low-risk whitelist must be auto approved',
  )
  assert.ok(
    harness.service.store.listAudit().some((item) => item.action === 'auto_approve'),
    'auto approval must be audited',
  )

  const highGate = await harness.gate(agent, 'bash', { command: 'rm -rf build' }, 'call-high')
  assert.equal(highGate.kind, 'ask')
  const held = harness.approval(agent, {
    toolName: 'bash',
    reason: '危险命令',
    signal: new AbortController().signal,
  })
  const pending = harness.service.store
    .listApprovals()
    .filter((item) => item.status === 'pending')
    .pop()
  assert.ok(pending, 'dangerous command must be held for the user')
  await harness.service.decideApproval(pending!.id, 'deny')
  assert.equal(await held, 'rejected')
})

test('dispatch 完成后门禁解除', async () => {
  const { harness, cwd } = await boot()
  const agent = harness.addAgent('worker-5', cwd)
  await harness.service.listSessions(true)
  await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-5', reason: '集成测试' },
    '只改 src',
  )
  const submitted = await harness.service.submitPlan(agent, {
    title: '只改 src',
    plan: '1. 改 src',
    scope: { items: [{ id: 'P1', description: 'src', paths: ['src/**'] }] },
  })
  await harness.service.reviewPlan(submitted.planId, 'approve', undefined)

  const outOfPlan = await harness.gate(agent, 'write', {
    file_path: path.join(cwd, 'a.txt'),
    content: 'x',
  })
  assert.equal(outOfPlan.kind, 'ask')

  await harness.service.noteReport(agent, {
    goal: '只改 src',
    done: ['改完了'],
    next: [],
    blockers: [],
    decisions: [],
  })
  const dispatch = harness.service.store.currentDispatch('worker-5')
  assert.equal(dispatch, undefined, 'a completed dispatch must leave no current task')

  const allowed = await harness.gate(agent, 'write', {
    file_path: path.join(cwd, 'a.txt'),
    content: 'x',
  })
  assert.deepEqual(allowed, { kind: 'allow' })
})

async function withButler(harness: Harness, cwd: string) {
  const butlerId = await harness.service.ensureButler()
  const butler = harness.addAgent(butlerId, cwd, 'superagent-butler')
  return { butlerId, butler }
}

function notices(agent: any): string[] {
  return (agent.injected as any[])
    .map((message) =>
      Array.isArray(message?.content)
        ? message.content.map((block: any) => String(block?.text ?? '')).join('\n')
        : String(message?.content ?? ''),
    )
    .filter((text) => text.includes('【SuperAgent 进度】'))
}

test('§6.4 里程碑：新 done 条目推一次，重复上报不重复推', async () => {
  const { harness, cwd } = await boot()
  const { butler } = await withButler(harness, cwd)
  const worker = harness.addAgent('worker-p1', cwd)
  await harness.service.listSessions(true)
  await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-p1', reason: '集成测试' },
    '跑一下检查',
  )

  await harness.service.noteReport(worker, {
    goal: '检查',
    done: ['读完 util.ts'],
    next: ['再读 risk.ts'],
    blockers: [],
    decisions: [],
  })
  const first = notices(butler)
  assert.equal(first.length, 1)
  assert.match(first[0]!, /完成 1 项/)
  assert.match(first[0]!, /再读 risk\.ts/)

  // 同一 done 再报一次：不重复提醒
  await harness.service.noteReport(worker, {
    goal: '检查',
    done: ['读完 util.ts'],
    next: ['再读 risk.ts'],
    blockers: [],
    decisions: [],
  })
  assert.equal(notices(butler).length, 1)
})

test('§6.4 完成：done 非空且 next 为空 → dispatch completed', async () => {
  const { harness, cwd } = await boot()
  const { butler } = await withButler(harness, cwd)
  const worker = harness.addAgent('worker-p2', cwd)
  await harness.service.listSessions(true)
  await harness.service.setMode(harness.service.ensureProjectForCwd(cwd).key, 'gate_confirm')
  await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-p2', reason: '集成测试' },
    '改一行',
  )

  await harness.service.noteReport(worker, {
    goal: '改一行',
    done: ['改完了'],
    next: [],
    blockers: [],
    decisions: [],
  })
  assert.equal(harness.service.store.currentDispatch('worker-p2'), undefined)
  const dispatch = harness.service.store
    .listDispatches()
    .find((item) => item.targetSessionId === 'worker-p2')
  assert.equal(dispatch?.status, 'completed')
  assert.ok(notices(butler).length >= 1)
})

test('§6.4 手动 session 的软状态只更新面板，不推管家', async () => {
  const { harness, cwd } = await boot()
  const { butler } = await withButler(harness, cwd)
  const manual = harness.addAgent('manual-p3', cwd)
  await harness.service.listSessions(true)

  await harness.service.noteReport(manual, {
    goal: '随手修',
    done: ['修完了'],
    next: [],
    blockers: [],
    decisions: [],
  })
  assert.equal(notices(butler).length, 0)
})

test('新开 session 派活：未进 store 也能交计划，批准后放行', async () => {
  const booted = await boot()
  const harness = booted.harness
  // macOS 的 tmpdir 是软链；dispatchExecute 对 new 的 cwd 取 realpath，这里对齐
  const cwd = await realpath(booted.cwd)
  const started = await harness.service.dispatchExecute(
    {
      kind: 'new',
      projectKey: harness.service.ensureProjectForCwd(cwd).key,
      cwd,
      reason: '集成测试',
      relatedSessionIds: [],
    },
    '新任务：改 src',
  )
  const agent = harness.addAgent(started.sessionId, cwd)

  const submitted = await harness.service.submitPlan(agent, {
    title: '改 src',
    plan: '1. 改 src/a.ts',
    scope: { items: [{ id: 'P1', description: 'src', paths: ['src/**'] }] },
  })
  assert.equal(submitted.status, 'pending_review', JSON.stringify(submitted))
  await harness.service.reviewPlan(submitted.planId, 'approve', undefined)

  const allowed = await harness.gate(agent, 'write', {
    file_path: path.join(cwd, 'src', 'a.ts'),
    content: 'x',
  })
  assert.deepEqual(allowed, { kind: 'allow' })
})

test('卡点确认：低风险命令申请 sandbox 升级 → 转用户，不代批', async () => {
  const { harness, cwd } = await boot()
  const agent = harness.addAgent('worker-sb', cwd)
  await harness.service.listSessions(true)
  await harness.service.setMode(harness.service.ensureProjectForCwd(cwd).key, 'gate_confirm')
  await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-sb', reason: '集成测试' },
    '跑测试',
  )

  const gate = await harness.gate(agent, 'bash', {
    command: 'npm test',
    sandbox_permissions: 'danger-full-access',
    justification: 'need network',
  })
  assert.equal(gate.kind, 'ask')
  const held = harness.approval(agent, {
    toolName: 'bash',
    reason: 'escalation',
    signal: new AbortController().signal,
  })
  const pending = harness.service.store.listApprovals().find((item) => item.status === 'pending')
  assert.ok(pending, 'sandbox escalation must be held for the user')
  assert.equal(pending!.risk, 'high')
  await harness.service.decideApproval(pending!.id, 'deny')
  assert.equal(await held, 'rejected')
})

test('手动 session：不升级 ask、不接管审批，全部交给原生流程', async () => {
  const { harness, cwd } = await boot()
  const agent = harness.addAgent('manual-n', cwd)
  await harness.service.listSessions(true)

  for (const [name, args] of [
    ['bash', { command: 'ls -la' }],
    ['bash', { command: 'git commit -m x' }],
    ['skill', { name: 'x' }],
  ] as const) {
    assert.deepEqual(await harness.gate(agent, name, args), { kind: 'allow' }, name)
  }
  // 原生审批到达：插件调用 next()，交给原生 answerer（harness 的 next 返回 unavailable）
  const outcome = await harness.approval(agent, {
    toolName: 'bash',
    signal: new AbortController().signal,
  })
  assert.equal(outcome, 'unavailable')
  assert.equal(harness.service.store.listApprovals().length, 0)
})

test('计划待审时上报 done 且 next 为空：不判完成，门禁仍在', async () => {
  const { harness, cwd } = await boot()
  const agent = harness.addAgent('worker-pp', cwd)
  await harness.service.listSessions(true)
  await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-pp', reason: '集成测试' },
    '改 src',
  )
  await harness.service.submitPlan(agent, {
    title: '改 src',
    plan: '1. 改 src',
    scope: { items: [{ id: 'P1', description: 'src', paths: ['src/**'] }] },
  })
  await harness.service.noteReport(agent, {
    goal: '改 src',
    done: ['已提交计划'],
    next: [],
    blockers: [],
    decisions: [],
  })
  assert.ok(harness.service.store.currentDispatch('worker-pp'), 'dispatch must stay open')
  const blocked = await harness.gate(agent, 'write', {
    file_path: path.join(cwd, 'src', 'a.ts'),
    content: 'x',
  })
  assert.equal(blocked.kind, 'deny')
})

test('没交过计划的只读派发任务：报完成就收尾，门禁解除', async () => {
  const { harness, cwd } = await boot()
  const worker = harness.addAgent('worker-ro', cwd)
  await harness.service.listSessions(true)
  await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-ro', reason: '集成测试' },
    '只读看一遍代码',
  )

  await harness.service.noteReport(worker, {
    goal: '只读看一遍代码',
    done: ['看完了，没问题'],
    next: [],
    blockers: [],
    decisions: [],
  })

  assert.equal(harness.service.store.currentDispatch('worker-ro'), undefined)
  const gate = await harness.gate(worker, 'write', {
    file_path: path.join(cwd, 'a.txt'),
    content: 'x',
  })
  assert.deepEqual(gate, { kind: 'allow' })
})

/** 假 llm：记录每次请求，按 reply(command) 返回一段 text。 */
function fakeLlm(reply: (input: any) => string) {
  const calls: any[] = []
  return {
    calls,
    stream(options: any) {
      const input = JSON.parse(options.messages[0].content[0].text)
      calls.push({ ...input, provider: options.provider, model: options.model })
      const text = reply(input)
      return (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

function withRoute(agent: any) {
  agent.session.requestHeader = () => ({ config: { provider: 'p', model: 'm' } })
  return agent
}

test('bash 审查：计划未批准时，只读组合命令经管家审查放行并写审计', async () => {
  const { harness, cwd } = await boot()
  const llm = fakeLlm(() => '{"decision":"allow","reason":"只读搜索"}')
  harness.ctx.llm = llm
  const agent = withRoute(harness.addAgent('worker-r1', cwd))
  await harness.service.listSessions(true)
  await harness.service.dispatchExecute({ kind: 'reuse', sessionId: 'worker-r1', reason: '集成测试' }, '改 src')

  const gate = await harness.gate(agent, 'bash', { command: 'grep -n foo src/a.ts | head -5' })
  assert.deepEqual(gate, { kind: 'allow' })
  assert.equal(llm.calls.length, 1)
  assert.equal(llm.calls[0].mode, 'readonly')
  assert.equal(llm.calls[0].provider, 'p')
  assert.ok(harness.service.store.listAudit().some((item) => item.action === 'bash_review_allow'))
  assert.ok(harness.service.store.listApprovals().some((item) => item.status === 'auto_approved'))
})

test('bash 审查：计划未批准时，审查认为不是只读 → 仍然拒绝', async () => {
  const { harness, cwd } = await boot()
  harness.ctx.llm = fakeLlm(() => '{"decision":"deny","reason":"会写文件"}')
  const agent = withRoute(harness.addAgent('worker-r2', cwd))
  await harness.service.listSessions(true)
  await harness.service.dispatchExecute({ kind: 'reuse', sessionId: 'worker-r2', reason: '集成测试' }, '改 src')

  const gate = await harness.gate(agent, 'bash', { command: 'npm install && npm run build' })
  assert.equal(gate.kind, 'deny')
  assert.ok(harness.service.store.listAudit().some((item) => item.action === 'bash_review_deny'))
})

test('bash 审查：卡点确认下白名单外命令，安全放行、有风险转用户并带理由', async () => {
  const { harness, cwd } = await boot()
  const llm = fakeLlm((input) =>
    input.command.includes('out.txt')
      ? '{"decision":"deny","reason":"覆盖文件"}'
      : '{"decision":"allow","reason":"本地脚本"}',
  )
  harness.ctx.llm = llm
  const agent = withRoute(harness.addAgent('worker-r3', cwd))
  await harness.service.listSessions(true)
  await harness.service.setMode(harness.service.ensureProjectForCwd(cwd).key, 'gate_confirm')
  await harness.service.dispatchExecute({ kind: 'reuse', sessionId: 'worker-r3', reason: '集成测试' }, '跑脚本')

  assert.deepEqual(await harness.gate(agent, 'bash', { command: 'node scripts/check.js' }), { kind: 'allow' })
  assert.equal(llm.calls[0].mode, 'danger')
  const risky = await harness.gate(agent, 'bash', { command: 'node scripts/gen.js > out.txt' })
  assert.equal(risky.kind, 'ask')
  assert.equal(String(risky.reason), '危险原因：覆盖文件')
})

test('bash 审查：危险关键词交给管家判断，真危险时转用户并写明原因；sandbox 升级与手动 session 不送审', async () => {
  const { harness, cwd } = await boot()
  const llm = fakeLlm((input) =>
    input.command.startsWith('git push')
      ? '{"decision":"deny","reason":"git push origin main 会把改动推到远程仓库"}'
      : '{"decision":"allow","reason":"只是搜索/清理临时文件"}',
  )
  harness.ctx.llm = llm
  const agent = withRoute(harness.addAgent('worker-r4', cwd))
  const manual = withRoute(harness.addAgent('manual-r4', cwd))
  await harness.service.listSessions(true)
  await harness.service.setMode(harness.service.ensureProjectForCwd(cwd).key, 'gate_confirm')
  await harness.service.dispatchExecute({ kind: 'reuse', sessionId: 'worker-r4', reason: '集成测试' }, '跑脚本')

  // 关键词误报：grep 里出现 deploy、清理 /tmp → 放行
  assert.deepEqual(await harness.gate(agent, 'bash', { command: 'grep -rn "deploy" src | head' }), { kind: 'allow' })
  assert.deepEqual(await harness.gate(agent, 'bash', { command: 'rm -rf /tmp/sab-x' }), { kind: 'allow' })
  assert.deepEqual(llm.calls[0].flags, ['deploy'])
  // 真危险：转用户，理由是具体的危险
  const push = await harness.gate(agent, 'bash', { command: 'git push origin main' })
  assert.equal(push.kind, 'ask')
  assert.equal(push.reason, '危险原因：git push origin main 会把改动推到远程仓库')

  const before = llm.calls.length
  const escalate = await harness.gate(agent, 'bash', {
    command: 'node scripts/check.js',
    sandbox_permissions: 'danger-full-access',
    justification: '需要联网',
  })
  assert.equal(escalate.kind, 'ask')
  assert.match(String(escalate.reason), /沙箱升级到 danger-full-access（worker 的理由：需要联网）/)
  assert.deepEqual(await harness.gate(manual, 'bash', { command: 'node scripts/x.js | tee log' }), { kind: 'allow' })
  assert.equal(llm.calls.length, before)
})

test('bash 审查：计划审查且计划已批准时，计划外但不危险的命令放行', async () => {
  const { harness, cwd } = await boot()
  const llm = fakeLlm(() => '{"decision":"allow","reason":"在项目内用脚本改文件"}')
  harness.ctx.llm = llm
  const agent = withRoute(harness.addAgent('worker-r7', cwd))
  await harness.service.listSessions(true)
  await harness.service.dispatchExecute({ kind: 'reuse', sessionId: 'worker-r7', reason: '集成测试' }, '改 src')
  const plan = await harness.service.submitPlan(agent, {
    title: '改 src',
    plan: '1. 改 src',
    scope: { items: [{ id: 'P1', description: 'src', paths: ['src/**'] }] },
  })
  await harness.service.reviewPlan(plan.planId, 'approve', undefined)

  const gate = await harness.gate(agent, 'bash', { command: "python3 - <<'PY'\nopen('src/a.ts','w').write('x')\nPY" })
  assert.deepEqual(gate, { kind: 'allow' })
  assert.equal(llm.calls[0].mode, 'danger')
})

test('审批卡点写明命令和危险原因', async () => {
  const { harness, cwd } = await boot()
  harness.ctx.llm = fakeLlm(() => '{"decision":"deny","reason":"git push 会推到远程仓库"}')
  const agent = withRoute(harness.addAgent('worker-r8', cwd))
  await harness.service.listSessions(true)
  await harness.service.setMode(harness.service.ensureProjectForCwd(cwd).key, 'gate_confirm')
  await harness.service.dispatchExecute({ kind: 'reuse', sessionId: 'worker-r8', reason: '集成测试' }, '发布')

  const gate = await harness.gate(agent, 'bash', { command: 'git push origin main' })
  assert.equal(gate.kind, 'ask')
  void harness.approval(agent, { toolName: 'bash', reason: gate.reason, signal: new AbortController().signal })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const blocker = harness.service.store
    .listBlockers()
    .find((item) => item.kind === 'approval' && item.sessionId === 'worker-r8')
  assert.ok(blocker, 'approval blocker must exist')
  assert.match(blocker!.summary, /git push origin main/)
  assert.match(blocker!.neededAction, /危险原因：git push 会推到远程仓库/)
})

test('bash 审查：输出不合协议或没有模型路由 → 回到原流程', async () => {
  const { harness, cwd } = await boot()
  harness.ctx.llm = fakeLlm(() => '好的，可以执行')
  const agent = withRoute(harness.addAgent('worker-r5', cwd))
  const noRoute = harness.addAgent('worker-r6', cwd)
  await harness.service.listSessions(true)
  await harness.service.setMode(harness.service.ensureProjectForCwd(cwd).key, 'gate_confirm')
  await harness.service.dispatchExecute({ kind: 'reuse', sessionId: 'worker-r5', reason: '集成测试' }, '跑脚本')
  await harness.service.dispatchExecute({ kind: 'reuse', sessionId: 'worker-r6', reason: '集成测试' }, '跑脚本')

  assert.equal((await harness.gate(agent, 'bash', { command: 'node scripts/check.js' })).kind, 'ask')
  assert.equal((await harness.gate(noRoute, 'bash', { command: 'node scripts/check.js' })).kind, 'ask')
})

test('dispatch_mark: 标记完成后门禁立即解除', async () => {
  const { harness, cwd } = await boot()
  const worker = harness.addAgent('worker-m1', cwd)
  await harness.service.listSessions(true)
  const started = await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-m1', reason: '集成测试' },
    '改一下 a.txt',
  )

  const blocked = await harness.gate(worker, 'write', {
    file_path: path.join(cwd, 'a.txt'),
    content: 'x',
  })
  assert.equal(blocked.kind, 'deny')

  const marked = await harness.service.markDispatch(started.dispatchId, 'completed', '我看过了')
  assert.equal(marked.ok, true)
  assert.equal(marked.status, 'completed')

  const allowed = await harness.gate(worker, 'write', {
    file_path: path.join(cwd, 'a.txt'),
    content: 'x',
  })
  assert.deepEqual(allowed, { kind: 'allow' })
  // 完成不给 worker 发「别干了」，只有放弃才发
  assert.equal(harness.prompts.filter((item) => item.sessionId === 'worker-m1').length, 1)
})

test('dispatch_mark: 计划被驳回后放弃 → 关掉待审计划、解除门禁、通知 worker', async () => {
  const { harness, cwd } = await boot()
  const worker = harness.addAgent('worker-m2', cwd)
  await harness.service.listSessions(true)
  const started = await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-m2', reason: '集成测试' },
    '重写模块',
  )
  const submitted = await harness.service.submitPlan(worker, {
    title: '重写模块',
    plan: '1. 改 src/a.ts',
    scope: { items: [{ id: 'P1', description: '改 a.ts', paths: ['src/**'] }] },
  })
  await harness.service.reviewPlan(submitted.planId, 'changes', '范围太大，缩小一点')
  assert.equal(harness.service.store.getPlan(submitted.planId)?.status, 'changes_requested')

  const marked = await harness.service.markDispatch(started.dispatchId, 'failed', '不做了')
  assert.equal(marked.ok, true)
  assert.equal(marked.status, 'failed')
  assert.equal(marked.cancelledPlans, 1)
  assert.equal(harness.service.store.getPlan(submitted.planId)?.status, 'cancelled')

  const allowed = await harness.gate(worker, 'write', {
    file_path: path.join(cwd, 'src', 'a.ts'),
    content: 'x',
  })
  assert.deepEqual(allowed, { kind: 'allow' })

  const notices = harness.prompts.filter((item) => item.sessionId === 'worker-m2')
  // 派发 1 条 + 驳回反馈 1 条 + 结束通知 1 条；最后一条必须是「不用继续」
  assert.equal(notices.length, 3)
  assert.match(JSON.stringify(notices[2]!.content), /已经结束/)
})

test('dispatch_mark: 已经结束的派发再标记会被拒绝', async () => {
  const { harness, cwd } = await boot()
  const worker = harness.addAgent('worker-m3', cwd)
  await harness.service.listSessions(true)
  const started = await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-m3', reason: '集成测试' },
    '改一行',
  )
  await harness.service.markDispatch(started.dispatchId, 'completed')

  const again = await harness.service.markDispatch(started.dispatchId, 'completed')
  assert.equal(again.ok, false)
  assert.match(String(again.message), /已经结束/)

  const missing = await harness.service.markDispatch('dsp_nope', 'completed')
  assert.equal(missing.ok, false)
  assert.match(String(missing.message), /不存在/)

  const bogus = await harness.service.markDispatch(started.dispatchId, 'whatever')
  assert.equal(bogus.ok, false)
  assert.match(String(bogus.message), /outcome/)
})

test('dispatch_mark: 收尾清掉「任务还在跑」才成立的卡点，但不动审批/提问', async () => {
  const { harness, cwd } = await boot()
  harness.addAgent('worker-m6', cwd)
  await harness.service.listSessions(true)
  const started = await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-m6', reason: '集成测试' },
    '改一行',
  )
  const at = Date.now()
  const base = {
    sessionId: 'worker-m6',
    severity: 'warning',
    status: 'notified',
    signature: 'x',
    summary: 'x',
    neededAction: 'x',
    evidence: {},
    detectedAt: at,
    lastSeenAt: at,
    reminderCount: 0,
  }
  await harness.service.store.putBlocker({
    ...base,
    id: 'bl_stall',
    kind: 'stall',
    signature: 'stall:worker-m6',
  } as any)
  await harness.service.store.putBlocker({
    ...base,
    id: 'bl_approval',
    kind: 'approval',
    signature: 'approval:ap-m6',
    relatedApprovalId: 'ap-m6',
  } as any)

  await harness.service.markDispatch(started.dispatchId, 'completed', '做完了')

  const stall = harness.service.store.getBlocker('bl_stall')
  assert.equal(stall?.status, 'auto_resolved', '停滞卡点随派发收尾结束')
  assert.equal(stall?.resolution, '派发已收尾')
  const approval = harness.service.store.getBlocker('bl_approval')
  assert.equal(approval?.status, 'notified', '审批卡点不能被顺手清掉')
  assert.equal(
    (await harness.service.snapshot()).resolvedBlockers.some((item) => item.id === 'bl_stall'),
    true,
    '收尾后的卡点出现在 resolvedBlockers，提醒卡片会显示已处理',
  )
})

test('dispatch_mark: 两种标记都写审计，by=user', async () => {
  const { harness, cwd } = await boot()
  harness.addAgent('worker-m4', cwd)
  harness.addAgent('worker-m5', cwd)
  await harness.service.listSessions(true)
  const first = await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-m4', reason: '集成测试' },
    '任务一',
  )
  const second = await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-m5', reason: '集成测试' },
    '任务二',
  )
  await harness.service.markDispatch(first.dispatchId, 'completed', '做完了')
  await harness.service.markDispatch(second.dispatchId, 'failed', '不做了')

  const entries = harness.service.store
    .listAudit()
    .filter((entry) => entry.kind === 'dispatch' && entry.action.startsWith('mark_'))
  assert.equal(entries.length, 2)
  const completed = entries.find((entry) => entry.action === 'mark_completed')
  const abandoned = entries.find((entry) => entry.action === 'mark_abandoned')
  assert.equal(completed?.by, 'user')
  assert.equal(completed?.decision, 'completed')
  assert.equal(completed?.note, '做完了')
  assert.equal(abandoned?.by, 'user')
  assert.equal(abandoned?.decision, 'failed')
  assert.equal(abandoned?.sessionId, second.sessionId)
})

test('管家判定按 preset：非默认 id 的管家会话也能用 butler_* 工具、受只读护栏、不进派发候选', async () => {
  const booted = await boot()
  const harness = booted.harness
  const cwd = await realpath(booted.cwd)
  const primaryId = await harness.service.ensureButler()
  harness.addAgent(primaryId, cwd, 'superagent-butler')
  const second = harness.addAgent('butler-2', cwd, 'superagent-butler')
  const worker = harness.addAgent('worker-b', cwd)
  await harness.service.listSessions(true)

  const status = createButlerTools(harness.service).find((tool: any) => tool.name === 'butler_status')!
  const fromSecond = await status.execute({}, { agent: second })
  assert.equal((fromSecond as any)?.error, undefined, JSON.stringify(fromSecond))
  const fromWorker = await status.execute({}, { agent: worker })
  assert.match(String((fromWorker as any)?.error), /only available to the SuperAgent butler/)

  // 只读护栏：管家 preset 的会话不能写/执行；worker 不受这个护栏影响
  let guard: any
  applyButlerPreset({
    get: (name: string) => (name === 'superagent' ? harness.service : undefined),
    effect: (fn: () => any) => fn(),
    tools: { guard: (fn: any) => ((guard = fn), () => {}), register: () => () => {} },
    systemPrompt: { section: () => () => {} },
  })
  assert.match(String(guard({ agent: second, name: 'bash' })), /只读/)
  assert.equal(guard({ agent: second, name: 'read' }), undefined)
  assert.equal(guard({ agent: second, name: 'butler_status' }), undefined)
  assert.equal(guard({ agent: worker, name: 'bash' }), undefined)

  // 派发候选里不出现任何管家会话
  const result = await harness.service.dispatchCandidates('看一下代码', undefined, cwd)
  const ids = (result.candidates ?? []).map((candidate: any) => candidate.sessionId)
  assert.ok(ids.includes('worker-b'), JSON.stringify(ids))
  assert.ok(!ids.includes('butler-2') && !ids.includes(primaryId), JSON.stringify(ids))
})

test('多个管家：派发任务的进度只发给派出它的管家，手动 session 的卡点广播给所有管家，离线管家上线后补发', async () => {
  const booted = await boot()
  const harness = booted.harness
  const cwd = await realpath(booted.cwd)
  const primaryId = await harness.service.ensureButler()
  const primary = harness.addAgent(primaryId, cwd, 'superagent-butler')
  const second = harness.addAgent('butler-2', cwd, 'superagent-butler')
  harness.addAgent('worker-m1', cwd)
  harness.addAgent('worker-m2', cwd)
  harness.addAgent('manual-m3', cwd)
  await harness.service.listSessions(true)
  await harness.service.setMode(harness.service.ensureProjectForCwd(cwd).key, 'gate_confirm')

  const dispatch = createButlerTools(harness.service).find((tool: any) => tool.name === 'butler_dispatch')!
  await dispatch.execute(
    { text: '任务一', decision: { kind: 'reuse', sessionId: 'worker-m1', reason: 't' } },
    { agent: primary },
  )
  await dispatch.execute(
    { text: '任务二', decision: { kind: 'reuse', sessionId: 'worker-m2', reason: 't' } },
    { agent: second },
  )
  assert.equal(
    harness.service.store.listDispatches().find((item) => item.targetSessionId === 'worker-m2')
      ?.fromButlerSessionId,
    'butler-2',
  )

  const report = { goal: 'g', done: ['做完了'], next: [], blockers: [], decisions: [] }
  await harness.service.noteReport(harness.agents.get('worker-m1'), report)
  await harness.service.noteReport(harness.agents.get('worker-m2'), report)
  const primaryText = notices(primary).join('\n')
  const secondText = notices(second).join('\n')
  assert.match(primaryText, /title-worker-m1/)
  assert.doesNotMatch(primaryText, /title-worker-m2/)
  assert.match(secondText, /title-worker-m2/)
  assert.doesNotMatch(secondText, /title-worker-m1/)

  // 手动 session 的卡点不属于任何管家：两个管家都收到；第二个管家离线时先排队，上线后补发
  harness.agents.delete('butler-2')
  await (harness.service as any).injectButlerNotice('【SuperAgent 提醒】\n- manual-m3 卡住了')
  const reminders = (agent: any) =>
    (agent.injected as any[])
      .map((message) => message.content.map((block: any) => block.text).join('\n'))
      .filter((text) => text.includes('manual-m3') || text.includes('离线期间'))
  assert.equal(reminders(primary).length, 1)
  assert.equal(reminders(second).length, 0)
  harness.agents.set('butler-2', second)
  harness.emit('agent/created', { agent: second, source: 'resume' })
  assert.equal(reminders(second).length, 1)
  assert.match(reminders(second)[0]!, /离线期间新增 1 条/)
})

test('卡点提醒带结构化 source：客户端据此渲染可点按钮', async () => {
  // I-32 部分起 approval 默认走「真唤醒」，这条测的是**注入通道**的结构化协议，
  // 所以显式关掉真唤醒，让它走 inject。
  const { harness, cwd } = await boot({ blockerWake: { enabled: false } })
  const { butler } = await withButler(harness, cwd)
  const at = Date.now()
  const blocker: any = {
    id: 'bl_notice1',
    sessionId: 'worker-n1',
    kind: 'approval',
    severity: 'warning',
    status: 'open',
    signature: 'approval:ap-n1',
    summary: 'repo-a 在等审批：bash rm -rf build',
    neededAction: '允许或拒绝 bash',
    evidence: { toolName: 'bash', callId: 'call-n1', risk: 'high', argsSummary: 'rm -rf build' },
    detectedAt: at,
    lastSeenAt: at,
    reminderCount: 0,
    relatedApprovalId: 'ap-n1',
    relatedCallId: 'call-n1',
  }
  await harness.service.store.putBlocker(blocker)
  await (harness.service as any).maybeRemind(blocker)

  const message = (butler.injected as any[]).at(-1)
  assert.equal(message.source.kind, 'superagent-notice', 'source 不再是 user')
  assert.equal(message.source.form, 'notice')
  assert.equal(message.source.notice.blockerId, 'bl_notice1')
  assert.equal(message.source.notice.approvalId, 'ap-n1')
  assert.deepEqual(
    message.source.notice.actions.map((action: any) => action.verb),
    ['approve', 'reject', 'dismiss'],
  )
  const text = message.content.map((block: any) => block.text).join('\n')
  assert.match(text, /【SuperAgent 提醒】/, '模型可见文本前缀保持不变')
  assert.match(text, /不是你的指令/)
})

test('处理过的卡点出现在 resolvedBlockers，提醒卡片据此回显「已处理」', async () => {
  const { harness, cwd } = await boot()
  await withButler(harness, cwd)
  const at = Date.now()
  const blocker: any = {
    id: 'bl_notice2',
    sessionId: 'worker-n2',
    kind: 'stall',
    severity: 'warning',
    status: 'open',
    signature: 'stall:bl_notice2',
    summary: 'worker-n2 停滞',
    neededAction: '催办或忽略',
    evidence: {},
    detectedAt: at,
    lastSeenAt: at,
    reminderCount: 0,
  }
  await harness.service.store.putBlocker(blocker)
  assert.equal(
    (await harness.service.snapshot()).resolvedBlockers.some((item) => item.id === 'bl_notice2'),
    false,
  )

  const result = await harness.service.resolveBlocker('bl_notice2', 'dismiss', undefined, 'user')
  assert.equal(result.ok, true)

  const snapshot = await harness.service.snapshot()
  const resolved = snapshot.resolvedBlockers.find((item) => item.id === 'bl_notice2')
  assert.ok(resolved, 'resolvedBlockers 里要能看到这条')
  assert.equal(resolved!.status, 'dismissed')
  assert.equal(resolved!.kind, 'stall')
  assert.ok((resolved!.resolvedAt ?? 0) > 0)
  assert.equal(snapshot.blockers.some((item) => item.id === 'bl_notice2'), false)
})

test('先按 standard 建会话、第一轮前切到管家 preset：卸掉 worker 注入，按管家对待', async () => {
  const booted = await boot()
  const harness = booted.harness
  const cwd = await realpath(booted.cwd)
  // 模拟 preset 注册表：header 仍是 standard，最新选择记在 registry 里
  harness.ctx.agentPresets = { presetForSession: (session: any) => session.selected ?? null }
  const switched = harness.addAgent('switched-1', cwd, 'standard')
  harness.addAgent('worker-s', cwd)
  await harness.service.listSessions(true)
  assert.ok((harness.service as any).installed.has('switched-1'), 'starts as a worker')

  switched.session.selected = 'superagent-butler'
  harness.emit(
    'session/event',
    { id: 'switched-1' },
    { type: 'agent-preset/selected', data: { agentPreset: 'superagent-butler' } },
  )
  assert.equal((harness.service as any).installed.has('switched-1'), false, 'worker injection removed')

  const status = createButlerTools(harness.service).find((tool: any) => tool.name === 'butler_status')!
  const result = await status.execute({}, { agent: switched })
  assert.equal((result as any)?.error, undefined, JSON.stringify(result))

  let guard: any
  applyButlerPreset({
    get: (name: string) => (name === 'superagent' ? harness.service : undefined),
    effect: (fn: () => any) => fn(),
    tools: { guard: (fn: any) => ((guard = fn), () => {}), register: () => () => {} },
    systemPrompt: { section: () => () => {} },
  })
  assert.match(String(guard({ agent: switched, name: 'bash' })), /只读/)

  await harness.service.listSessions(true)
  assert.equal(harness.service.store.getSession('switched-1')?.isButler, true)
  const candidates = await harness.service.dispatchCandidates('看一下代码', undefined, cwd)
  const ids = (candidates.candidates ?? []).map((candidate: any) => candidate.sessionId)
  assert.ok(ids.includes('worker-s') && !ids.includes('switched-1'), JSON.stringify(ids))

  // 切回 standard：重新按 worker 安装
  switched.session.selected = 'standard'
  harness.emit(
    'session/event',
    { id: 'switched-1' },
    { type: 'agent-preset/selected', data: { agentPreset: 'standard' } },
  )
  assert.ok((harness.service as any).installed.has('switched-1'), 'reinstalled as a worker')
})

test('P0 来源抽象：snapshot 带 source=dsh，旧记录缺字段按 dsh 解释', async () => {
  const { harness, cwd } = await boot()
  harness.addAgent('worker-src', cwd)
  await harness.service.listSessions(true)
  const butlerId = await harness.service.ensureButler()
  harness.addAgent(butlerId, cwd, 'superagent-butler')
  await harness.service.listSessions(true)

  const snapshot = await harness.service.snapshot()
  assert.ok(snapshot.sessions.length >= 2)
  for (const session of snapshot.sessions) {
    assert.equal(session.source, 'dsh', session.sessionId)
  }
  assert.equal(snapshot.butler.sessionId, butlerId)

  // 新记录显式写 source
  assert.equal(harness.service.store.getSession('worker-src')?.source, 'dsh')

  // 旧记录：手工模拟一条没有 source 的 managed 记录
  const legacy: any = { ...harness.service.store.getSession('worker-src') }
  delete legacy.source
  legacy.sessionId = 'session-legacy'
  await harness.service.store.putSession(legacy)
  assert.equal(harness.service.sourceKindOf('session-legacy'), 'dsh')

  // 完全不认识的 id 也兜底 dsh（不能用异常打断面板）
  assert.equal(harness.service.sourceKindOf('nonexistent-id'), 'dsh')
  assert.equal(harness.service.capabilitiesOf('nonexistent-id').send, true)
})

test('P1 Claude 只读来源：进列表、进 snapshot、不进派发候选', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-home-'))
  const claudeHome = path.join(cwd, '.claude')
  const projectDir = path.join(claudeHome, 'projects', '-tmp-ws')
  await mkdir(projectDir, { recursive: true })
  await mkdir(path.join(claudeHome, 'sessions'), { recursive: true })
  // claude 会话的 cwd 指向 harness 的工作目录，便于观察它会不会混进候选
  const sessionFile = path.join(projectDir, 'aaaa-bbbb-cccc.jsonl')
  await writeFile(
    sessionFile,
    [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '把 Claude 里的这个任务做一下' },
        timestamp: new Date().toISOString(),
        cwd,
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] },
        timestamp: new Date().toISOString(),
        cwd,
      }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Claude 侧任务' }),
    ].join('\n') + '\n',
  )

  const { harness } = await boot({
    sources: {
      claude: { enabled: true, home: claudeHome, scanDays: 365, maxSessions: 50, tailBytes: 65536, includeSubagents: false, watch: false },
    },
  })

  const sessions = await harness.service.listSessions(true)
  const claude = sessions.find((item) => item.source === 'claude')
  assert.ok(claude, 'claude 会话应该出现在列表里')
  assert.equal(claude!.sessionId, 'aaaa-bbbb-cccc')
  assert.equal(claude!.title, 'Claude 侧任务')
  assert.equal(claude!.cwd, cwd)
  assert.equal(claude!.hardStatus, 'idle')

  const snapshot = await harness.service.snapshot()
  assert.equal(snapshot.sessions.find((item) => item.sessionId === 'aaaa-bbbb-cccc')?.source, 'claude')

  // 来源与能力查询
  assert.equal(harness.service.sourceKindOf('aaaa-bbbb-cccc'), 'claude')
  assert.equal(harness.service.capabilitiesOf('aaaa-bbbb-cccc').send, false)

  // 不参与派发候选
  const candidates = await harness.service.dispatchCandidates('做一下这个任务')
  assert.equal(candidates.kind, 'candidates')
  assert.equal(
    candidates.candidates.some((item: any) => item.sessionId === 'aaaa-bbbb-cccc'),
    false,
    '只读来源不能进候选',
  )

  // 显式指定只读目标 → clarify 而不是创建注定失败的 dispatch
  const executed = await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'aaaa-bbbb-cccc', reason: '测试' },
    '做一下',
  )
  assert.equal(executed.kind, 'clarify')
  assert.equal(executed.reason, 'target_read_only')
  assert.equal(harness.service.store.listDispatches().length, 0)

  // 扫描不会给只读来源造出卡点
  const blockers = harness.service.store.listBlockers().filter((item) => item.sessionId === 'aaaa-bbbb-cccc')
  assert.deepEqual(blockers, [])
  await rm(cwd, { recursive: true, force: true })
})

test('P1 Claude 默认关闭：不配置就不扫描、不注册', async () => {
  const { harness } = await boot()
  assert.equal(harness.service.sources.get('claude'), undefined)
  assert.deepEqual(harness.service.sources.kinds(), ['dsh'])
})

// ---------------------------------------------------------------- A/B 进度与巡检

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function promptTexts(harness: Harness, sessionId: string): string[] {
  return harness.prompts
    .filter((item) => item.sessionId === sessionId)
    .map((item) =>
      Array.isArray(item.content)
        ? item.content.map((block: any) => String(block?.text ?? '')).join('\n')
        : String(item.content ?? ''),
    )
}

function progressCards(agent: any): any[] {
  return (agent.injected as any[])
    .map((message) => message?.source?.notice)
    .filter((notice) => notice && notice.kind === 'progress')
}

test('A 任务完成后有进度提醒，但不进待办条', async () => {
  const { harness, cwd } = await boot()
  const { butler } = await withButler(harness, cwd)
  const worker = harness.addAgent('worker-done', cwd)
  await harness.service.listSessions(true)
  await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-done', reason: '集成测试' },
    '跑一下检查',
  )
  await harness.service.noteReport(worker, {
    goal: '检查',
    done: ['读完 util.ts'],
    next: [],
    blockers: [],
    decisions: [],
  })
  // completeDispatch 是异步收尾（审计 + 提醒），等它落地。
  await tick()

  const texts = notices(butler)
  assert.ok(
    texts.some((text) => /任务完成/.test(text)),
    '完成必须有一条进度提醒',
  )

  const snapshot = await harness.service.snapshot()
  assert.equal(
    snapshot.dispatches.find((item) => item.targetSessionId === 'worker-done')?.status,
    'completed',
  )
  // progress 是通知：不进待办条、不产生 blocker。
  assert.equal(snapshot.blockerNotices.length, 0)
  assert.deepEqual(
    snapshot.blockers.filter((item) => item.sessionId === 'worker-done'),
    [],
  )

  const card = progressCards(butler).find((notice) => /任务完成/.test(notice.title))
  assert.ok(card, '完成要有一张 progress 卡')
  assert.deepEqual(
    card.actions.map((action: any) => action.verb),
    ['open_session'],
    'progress 只能有「打开会话」，不能有待办按钮',
  )
  assert.equal(card.blockerId, undefined)
  assert.equal(card.neededAction, undefined)
})

test('A2 running → idle 报「阶段结束」并带下一步', async () => {
  const { harness, cwd } = await boot({ progress: { minGapMs: 0 } })
  const { butler } = await withButler(harness, cwd)
  const worker = harness.addAgent('worker-stage', cwd)
  await harness.service.listSessions(true)
  await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-stage', reason: '集成测试' },
    '跟一下这个任务',
  )

  // 先让扫描看到 running，否则分不清「从来没跑」和「跑完停了」。
  worker.status = 'running'
  await (harness.service as any).evaluateSession('worker-stage')
  assert.equal(notices(butler).length, 0, '刚开始跑不该有进度')

  // 一轮跑完（idle），但任务还没收尾。
  worker.status = 'idle'
  await harness.service.noteReport(worker, {
    goal: '跟一下',
    done: ['改完 A'],
    next: ['跑测试'],
    blockers: [],
    decisions: [],
  })
  await tick()
  await (harness.service as any).evaluateSession('worker-stage')
  ;(harness.service as any).flushProgress('worker-stage')

  const texts = notices(butler)
  const stage = texts.find((text) => /阶段结束/.test(text))
  assert.ok(stage, '跑完一轮必须报阶段结束')
  assert.match(stage!, /下一步：跑测试/)
})

test('B 老派发（没有 watchdog / 游标）不产生 watchdog，也不补报历史', async () => {
  const { harness, cwd } = await boot({ progress: { minGapMs: 0 } })
  const { butler } = await withButler(harness, cwd)
  harness.addAgent('worker-legacy', cwd)
  await harness.service.listSessions(true)
  await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-legacy', reason: '集成测试' },
    '看一下现状',
  )

  // 模拟升级前创建的老记录：没有 watchdog、没有游标，已经放了 90 分钟。
  const dispatch = harness.service.store.currentDispatch('worker-legacy')!
  dispatch.watchdog = undefined
  dispatch.progress = undefined
  dispatch.createdAt = Date.now() - 90 * 60_000
  await harness.service.store.putDispatch(dispatch)

  const managed = harness.service.store.getSession('worker-legacy')!
  managed.softStatus = {
    goal: '看一下',
    done: ['老条目 A'],
    next: ['老下一步'],
    blockers: [],
    decisions: [],
    reportedAt: Date.now() - 90 * 60_000,
    source: 'log-digest',
  }
  await harness.service.store.putSession(managed)

  // 首次扫描只播种游标：不补报历史 done，也不问 watchdog。
  await (harness.service as any).evaluateSession('worker-legacy')
  ;(harness.service as any).flushProgress('worker-legacy')
  assert.equal(notices(butler).length, 0)

  const seeded = harness.service.store.currentDispatch('worker-legacy')!
  assert.ok(seeded.progress, '老记录首扫要播种游标')
  assert.equal(seeded.progress!.notified.length, 1)
  assert.equal(seeded.watchdog, undefined)

  // 再扫一次也不该冒出来。
  await (harness.service as any).evaluateSession('worker-legacy')
  ;(harness.service as any).flushProgress('worker-legacy')
  assert.equal(notices(butler).length, 0)
})

test('A1 新派发播种：目标会话已有 done 历史时首扫不补报，新增里程碑照常推', async () => {
  const { harness, cwd } = await boot({ progress: { minGapMs: 0 } })
  const { butler } = await withButler(harness, cwd)
  harness.addAgent('worker-seed', cwd)
  await harness.service.listSessions(true)

  // 上一轮任务留在会话上的历史成果（手动 session，没有派发，不产生提醒）。
  const managed = harness.service.store.getSession('worker-seed')!
  managed.softStatus = {
    goal: '上一轮任务',
    done: ['旧成果 A', '旧成果 B', '旧成果 C'],
    next: ['等新任务'],
    blockers: [],
    decisions: [],
    reportedAt: Date.now(),
    source: 'tool',
  }
  await harness.service.store.putSession(managed)

  // 新派发到一条已有 done 历史的会话：创建时就要用当前 done 播种。
  await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-seed', reason: '集成测试' },
    '新任务：接着干',
  )
  const dispatch = harness.service.store.currentDispatch('worker-seed')!
  assert.equal(dispatch.progress?.lastDoneCount, 3, '种子要记下创建时的 done 条数')
  assert.equal(dispatch.progress?.notified.length, 3)

  // 首扫：上一轮的 3 项不能当成这次的新进展补报。
  await (harness.service as any).evaluateSession('worker-seed')
  ;(harness.service as any).flushProgress('worker-seed')
  assert.equal(notices(butler).length, 0, '首扫不许补报上一轮的里程碑')

  // 之后新增一条：扫描路径照常推一条。
  managed.softStatus = {
    ...managed.softStatus,
    done: [...(managed.softStatus!.done ?? []), '这轮新成果 D'],
  }
  await harness.service.store.putSession(managed)
  await (harness.service as any).evaluateSession('worker-seed')
  ;(harness.service as any).flushProgress('worker-seed')
  const texts = notices(butler)
  assert.equal(texts.length, 1, '播种之后的新里程碑不能被吞掉')
  assert.match(texts[0]!, /完成 1 项/)
  assert.match(texts[0]!, /这轮新成果 D/)
})

test('A1 noteReport 同样跳过种子里的历史 done，只报新增，且不覆盖种子', async () => {
  const { harness, cwd } = await boot({ progress: { minGapMs: 0 } })
  const { butler } = await withButler(harness, cwd)
  const worker = harness.addAgent('worker-seed-report', cwd)
  await harness.service.listSessions(true)

  const managed = harness.service.store.getSession('worker-seed-report')!
  managed.softStatus = {
    goal: '上一轮任务',
    done: ['旧成果 A', '旧成果 B'],
    next: ['等新任务'],
    blockers: [],
    decisions: [],
    reportedAt: Date.now(),
    source: 'tool',
  }
  await harness.service.store.putSession(managed)
  await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-seed-report', reason: '集成测试' },
    '新任务：接着干',
  )

  // worker 第一次上报把上一轮的 done 一起带上：报告路径不能把历史再报一遍。
  await harness.service.noteReport(worker, {
    goal: '新任务',
    done: ['旧成果 A', '旧成果 B', '这轮新成果 C'],
    next: ['继续'],
    blockers: [],
    decisions: [],
  })
  const texts = notices(butler)
  assert.equal(texts.length, 1)
  assert.match(texts[0]!, /完成 1 项/)
  assert.match(texts[0]!, /这轮新成果 C/)

  // markReported 是合并写入：种子（2 条历史）不能被上报覆盖掉。
  const dispatch = harness.service.store.currentDispatch('worker-seed-report')!
  assert.equal(dispatch.progress?.lastDoneCount, 2)
  assert.equal(dispatch.progress?.notified.length, 3)
})

test('B butler_send 传坏 sessionId：返回 session_not_found，不投递、不写审计', async () => {
  const { harness, cwd } = await boot()
  const { butlerId } = await withButler(harness, cwd)
  const butler = harness.agents.get(butlerId)!
  const send = createButlerTools(harness.service).find(
    (item: any) => item.name === 'butler_send',
  )!
  const badId = 'session-98da5e2e-39fa-4b46-a2cd-36e8664e064e'
  const beforeAudit = harness.service.store.listAudit().length
  const beforePrompts = harness.prompts.length

  const result = await send.execute({ sessionId: badId, text: '你好' }, { agent: butler })
  assert.deepEqual(result, { ok: false, error: 'session_not_found', sessionId: badId })
  assert.equal(harness.prompts.length, beforePrompts, '校验失败不能投递')
  assert.equal(harness.service.store.listAudit().length, beforeAudit, '校验失败不能写审计')

  // 存在的可写会话不受影响。
  harness.addAgent('worker-send', cwd)
  await harness.service.listSessions(true)
  const sent = await send.execute({ sessionId: 'worker-send', text: '继续' }, { agent: butler })
  assert.deepEqual(sent, { ok: true })
  assert.equal(harness.prompts.length, beforePrompts + 1)
  assert.equal(harness.prompts[harness.prompts.length - 1]!.sessionId, 'worker-send')
})

test('B butler_reassign 到只读来源：返回 target_read_only，旧派发与审计不受影响', async () => {
  const claudeRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-reassign-'))
  const claudeHome = path.join(claudeRoot, '.claude')
  const { harness, cwd } = await boot({
    sources: {
      claude: { enabled: true, home: claudeHome, scanDays: 365, maxSessions: 50, tailBytes: 65536, includeSubagents: false, watch: false },
    },
  })
  const claudeId = 'cccc-dddd-eeee'
  const projectDir = path.join(claudeHome, 'projects', '-tmp-ws')
  await mkdir(projectDir, { recursive: true })
  await mkdir(path.join(claudeHome, 'sessions'), { recursive: true })
  await writeFile(
    path.join(projectDir, `${claudeId}.jsonl`),
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: '只读任务' },
      timestamp: new Date().toISOString(),
      cwd,
    }) + '\n',
  )
  harness.addAgent('worker-reassign', cwd)
  await harness.service.listSessions(true)
  assert.equal(harness.service.capabilitiesOf(claudeId).send, false)

  const started = await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-reassign', reason: '集成测试' },
    '改一下 a.txt',
  )
  assert.equal(started.kind, 'reuse', JSON.stringify(started))
  const dispatchId = started.dispatchId
  const beforeAudit = harness.service.store.listAudit().length
  const beforePrompts = harness.prompts.length

  const result = await harness.service.reassign(dispatchId, claudeId)
  assert.equal(result.ok, false)
  assert.equal(result.error, 'target_read_only')
  // 校验失败不能产生任何副作用。
  assert.equal(harness.service.store.getDispatch(dispatchId)!.status, 'accepted')
  assert.equal(harness.service.store.getDispatch(dispatchId)!.targetSessionId, 'worker-reassign')
  assert.equal(harness.service.store.listDispatches().length, 1, '失败不能新建派发')
  assert.equal(harness.service.store.listAudit().length, beforeAudit, '失败不能写审计')
  assert.equal(harness.prompts.length, beforePrompts, '失败不能投递')
  await rm(claudeRoot, { recursive: true, force: true })
})

test('job_kill 白名单：本会话启动的 job 直接放行，别人的 job 要求审批', async () => {
  const { harness, cwd } = await boot()
  const agent = harness.addAgent('worker-job', cwd)
  const jobs = new Map<string, any>([
    ['job-own', { id: 'job-own', owner: 'worker-job', status: 'running' }],
    ['job-foreign', { id: 'job-foreign', owner: 'worker-other', status: 'running' }],
  ])
  harness.ctx.jobs = {
    get(id: string, caller?: string) {
      const job = jobs.get(id)
      if (!job || job.owner !== caller) throw new Error('foreign or unknown job')
      return job
    },
    list(caller?: string) {
      return [...jobs.values()].filter((job) => job.owner === caller || !job.owner)
    },
  }
  await harness.service.listSessions(true)
  await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-job', reason: '集成测试' },
    '跑测试',
  )

  // 自己会话的 job：免审批，直接放行。
  assert.deepEqual(await harness.gate(agent, 'job_kill', { job_id: 'job-own' }), {
    kind: 'allow',
  })

  // 别人的 job / 不存在的 job：仍然要求审批，理由写明归属。
  for (const jobId of ['job-foreign', 'job-missing']) {
    const decision = await harness.gate(agent, 'job_kill', { job_id: jobId })
    assert.equal(decision.kind, 'ask', jobId)
    assert.match(String(decision.reason), /不属于本会话/, jobId)
  }

  // 读不到 job registry：失败关闭，不能默认放行。
  delete harness.ctx.jobs
  const unknown = await harness.gate(agent, 'job_kill', { job_id: 'job-own' })
  assert.equal(unknown.kind, 'ask')
  assert.match(String(unknown.reason), /job registry/)
})

test('B watchdog 口径：有会话活动不算停滞，彻底不动才报一次', async () => {
  // P1 起 watchdog 默认进 shadow（只记录不提醒），这条测的是 watchdog 机制本身，
  // 所以显式清空 shadow 名单，让它走真实的 act 路径。shadow 行为由下一条用例覆盖。
  const { harness, cwd } = await boot({ progress: { minGapMs: 0 }, policy: { shadowRules: [] } })
  const { butler } = await withButler(harness, cwd)
  harness.addAgent('worker-watchdog', cwd)
  await harness.service.listSessions(true)
  await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-watchdog', reason: '集成测试' },
    '跟一下这个任务',
  )
  const dispatch = harness.service.store.currentDispatch('worker-watchdog')!
  dispatch.watchdog = { expectedMinutes: 20, pollMinutes: 10 }
  // 模拟这条派发已经跑了 45 分钟：createdAt / acceptedAt / lastProgressAt 都要回拨，
  // 否则 watchdog 的 anchor 会被「刚刚接受」抬到现在。
  dispatch.createdAt = Date.now() - 60 * 60_000
  dispatch.acceptedAt = Date.now() - 45 * 60_000
  dispatch.progress = {
    ...dispatch.progress!,
    lastProgressAt: Date.now() - 45 * 60_000,
    lastTurnEndAt: Date.now(),
  }
  await harness.service.store.putDispatch(dispatch)
  const runtime =
    (harness.service as any).runtimes.get('worker-watchdog') ??
    (await (harness.service as any).ensureRuntime('worker-watchdog'))

  // 45 分钟没上报，但 1 分钟前还有会话活动：不算停滞。
  runtime.lastActivityAt = Date.now() - 60_000
  await (harness.service as any).evaluateSession('worker-watchdog')
  ;(harness.service as any).flushProgress('worker-watchdog')
  assert.equal(
    notices(butler).filter((text) => /没有进展/.test(text)).length,
    0,
    '有活动时不能报停滞',
  )

  // 彻底不动：活动也停在 45 分钟前 → 照常报一次。
  runtime.lastActivityAt = Date.now() - 45 * 60_000
  await (harness.service as any).evaluateSession('worker-watchdog')
  ;(harness.service as any).flushProgress('worker-watchdog')
  const stalled = notices(butler).filter((text) => /没有进展/.test(text))
  assert.equal(stalled.length, 1, '真停滞必须报')
  assert.match(stalled[0]!, /分钟没有进展/)

  // 同一安静期重复扫描不刷屏。
  await (harness.service as any).evaluateSession('worker-watchdog')
  ;(harness.service as any).flushProgress('worker-watchdog')
  assert.equal(notices(butler).filter((text) => /没有进展/.test(text)).length, 1)
})


// ---------------------------------------------------------------- R1-R5 计划门禁

/** 轮询等待某个条件成立（默认最多 500ms）：用于 `void` 触发的异步收尾。 */
// 默认 2s：这些等待点等的是「异步收尾」（void 触发的 completeDispatch / waiter 登记），
// 500ms 在机器忙时不够，曾出现偶发红。放宽等待窗口，但**断言本身不放宽**。
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return predicate()
}

function turnError(harness: Harness, sessionId: string, message: string, code?: string) {
  harness.emit('session/event', { id: sessionId }, {
    type: 'turn/end',
    seq: 3,
    time: Date.now(),
    data: { reason: { kind: 'error', error: { message, code } } },
  })
}

function planArgs() {
  return {
    title: '改扫描',
    plan: '# 改扫描\n\n只动 progress.ts',
    scope: { items: [{ id: 'P1', description: 'progress.ts', paths: ['src/progress.ts'] }] },
  }
}

test('R3 工具参数错误导致的 turn 失败：派发标 error（可恢复），卡点带错误原文', async () => {
  const { harness, cwd } = await boot()
  const { butler } = await withButler(harness, cwd)
  harness.addAgent('worker-r3', cwd)
  await harness.service.listSessions(true)
  await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-r3', reason: '集成测试' },
    '改一下扫描',
  )

  turnError(
    harness,
    'worker-r3',
    'Tool call "butler_report_status": Unexpected token 已, ... is not valid JSON',
    'INVALID_TOOL_OUTPUT',
  )
  await tick()

  const dispatch = harness.service.store.currentDispatch('worker-r3')
  assert.ok(dispatch, '可恢复错误之后派发不能被判死')
  assert.equal(dispatch!.status, 'error')

  await (harness.service as any).evaluateSession('worker-r3')
  const snapshot = await harness.service.snapshot()
  const blocker = snapshot.blockers.find(
    (item) => item.sessionId === 'worker-r3' && item.kind === 'error',
  )
  assert.ok(blocker, '要有一条出错卡点')
  assert.match(String((blocker!.evidence as any).error), /Unexpected token/)
  assert.ok(butler, '管家在场')
})

test('R1/R5 派发报错后提交方案：计划进 plans、管家能看到方案摘要', async () => {
  const { harness, cwd } = await boot()
  const { butler } = await withButler(harness, cwd)
  const worker = harness.addAgent('worker-r1', cwd)
  await harness.service.listSessions(true)
  await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-r1', reason: '集成测试' },
    '改一下扫描',
  )
  turnError(harness, 'worker-r1', 'Unexpected token 已, is not valid JSON', 'INVALID_TOOL_OUTPUT')
  await tick()

  const submitted = await harness.service.submitPlan(worker, planArgs())
  assert.equal(submitted.status, 'pending_review', '报错后提交方案必须能进审查')

  const snapshot = await harness.service.snapshot()
  assert.ok(
    snapshot.plans.some((plan) => plan.id === submitted.planId && plan.status === 'pending_review'),
    '快照里必须有待审计划',
  )
  assert.ok(
    snapshot.blockerNotices.some((notice) => notice.planId === submitted.planId),
    '待办里必须有这条计划',
  )
  const card = (butler.injected as any[])
    .map((message) => message?.source?.notice)
    .find((notice) => notice?.planId === submitted.planId)
  assert.ok(card, '管家对话里要看到计划卡')
  assert.match(String(card.detail ?? ''), /改扫描/, '卡片详情要带方案正文摘要')
})

test('R1 派发已中止且没审计划：不静默，出「中止但没审计划」卡点', async () => {
  const { harness, cwd } = await boot()
  await withButler(harness, cwd)
  harness.addAgent('worker-r1b', cwd)
  await harness.service.listSessions(true)
  await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-r1b', reason: '集成测试' },
    '改一下扫描',
  )
  turnError(harness, 'worker-r1b', '模型超时', 'RATE_LIMITED')
  await tick()

  assert.equal(harness.service.store.listDispatches()[0]!.status, 'failed')
  await (harness.service as any).evaluateSession('worker-r1b')
  const snapshot = await harness.service.snapshot()
  const blocker = snapshot.blockers.find((item) =>
    item.signature.startsWith('aborted_plan:'),
  )
  assert.ok(blocker, '中止的派发要有卡点，不能静默')
  assert.match(blocker!.summary, /计划审查前中止/)
})

test('R2 手动 session 提交方案：正文落盘（skipped）并通知管家带 planId', async () => {
  const { harness, cwd } = await boot()
  const { butler } = await withButler(harness, cwd)
  const manual = harness.addAgent('manual-r2', cwd)
  await harness.service.listSessions(true)

  const submitted = await harness.service.submitPlan(manual, planArgs())
  assert.equal(submitted.status, 'not_required')
  assert.equal(submitted.reason, 'manual_session')
  assert.ok(submitted.planId, 'not_required 也要返回 planId')

  const plan = harness.service.store.listPlans().find((item) => item.id === submitted.planId)
  assert.ok(plan, '方案正文必须落盘')
  assert.equal(plan!.status, 'skipped')
  assert.match(plan!.markdown, /只动 progress\.ts/)

  const card = (butler.injected as any[])
    .map((message) => message?.source?.notice)
    .find((notice) => notice?.detail?.includes(submitted.planId))
  assert.ok(card, '管家要收到一条带 planId 的通知')
  assert.match(String(card.title), /提交了方案/)
})

test('A2 短 turn（扫描没看到 running）也报阶段结束', async () => {
  const { harness, cwd } = await boot({ progress: { minGapMs: 0 } })
  const butlerInfo = await withButler(harness, cwd)
  const worker = harness.addAgent('worker-fast', cwd)
  await harness.service.listSessions(true)
  await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-fast', reason: '集成测试' },
    '跑一下检查',
  )
  await harness.service.noteReport(worker, {
    goal: '检查',
    done: ['跑完检查'],
    next: ['等确认'],
    blockers: [],
    decisions: [],
  })
  await tick()
  harness.emit('session/event', { id: 'worker-fast' }, {
    type: 'turn/end',
    seq: 4,
    time: Date.now() + 1,
    data: { reason: { kind: 'completed' } },
  })
  await tick()
  await (harness.service as any).evaluateSession('worker-fast')
  ;(harness.service as any).flushProgress('worker-fast')

  const texts = notices(butlerInfo.butler)
  assert.ok(
    texts.some((text) => /阶段结束/.test(text)),
    '短 turn 结束后也必须有一条阶段结束',
  )
})

// ---------------------------------------------------------------- R6 决策卡点可回答

test('R6 decision 卡点可以被回答：答复转发给 worker，卡点消失且不复现', async () => {
  const { harness, cwd } = await boot()
  await withButler(harness, cwd)
  const worker = harness.addAgent('worker-r6', cwd)
  await harness.service.listSessions(true)
  await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-r6', reason: '集成测试' },
    '改一下扫描',
  )
  await harness.service.noteReport(worker, {
    goal: '改扫描',
    done: ['读完代码'],
    next: ['改代码'],
    blockers: [],
    decisions: ['用 A 方案还是 B 方案？'],
  })
  await tick()
  await (harness.service as any).evaluateSession('worker-r6')

  const blocker = harness.service.store
    .listBlockers()
    .find((item) => item.sessionId === 'worker-r6' && item.kind === 'decision')
  assert.ok(blocker, 'decision 必须变成卡点')

  const result = await harness.service.resolveBlocker(blocker!.id, 'answer', '用 A 方案', 'user')
  assert.equal(result.ok, true, JSON.stringify(result))

  // 转发到位
  const forwarded = promptTexts(harness, 'worker-r6')
  assert.ok(
    forwarded.some((text) => text.includes('【管家】用户答复：用 A 方案')),
    '答复要真的发给 worker',
  )

  // 状态 + 审计
  const after = harness.service.store.getBlocker(blocker!.id)!
  assert.equal(after.status, 'resolved')
  assert.equal(after.resolution, '用 A 方案')
  const audit = harness.service.store
    .listAudit()
    .find((entry) => entry.kind === 'blocker' && entry.action === 'answer')
  assert.ok(audit, '回答要写审计')
  assert.equal(audit!.by, 'user')
  assert.equal(audit!.note, '用 A 方案')

  // 同一条 decisions 不能再长出新的卡点
  await (harness.service as any).evaluateSession('worker-r6')
  assert.equal(
    harness.service.store
      .listBlockers()
      .filter(
        (item) =>
          item.sessionId === 'worker-r6' && item.kind === 'decision' && item.status === 'open',
      ).length,
    0,
    '答过的决策不许立刻又冒出来',
  )
})

test('R6 会话发不出去时，回答要返回明确错误而不是静默失败', async () => {
  const { harness, cwd } = await boot()
  await withButler(harness, cwd)
  const worker = harness.addAgent('worker-r6b', cwd)
  await harness.service.listSessions(true)
  await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-r6b', reason: '集成测试' },
    '改一下扫描',
  )
  await harness.service.noteReport(worker, {
    goal: '改扫描',
    done: ['读完代码'],
    next: ['改代码'],
    blockers: [],
    decisions: ['选哪个方案？'],
  })
  await tick()
  await (harness.service as any).evaluateSession('worker-r6b')
  const blocker = harness.service.store
    .listBlockers()
    .find((item) => item.sessionId === 'worker-r6b' && item.kind === 'decision')!

  harness.ctx.sessionController.prompt = async () => {
    throw new Error('session not found')
  }
  const result = await harness.service.resolveBlocker(blocker.id, 'answer', 'A', 'user')
  assert.equal(result.ok, false)
  assert.match(String(result.message), /会话已不存在|发不出去/)
  assert.ok(
    ['open', 'notified'].includes(harness.service.store.getBlocker(blocker.id)!.status),
    '发不出去就不该把卡点标成已处理',
  )
})

test('R6 不支持回答的卡点给出明确提示，不再是「不支持的操作」', async () => {
  const { harness, cwd } = await boot()
  harness.addAgent('worker-r6c', cwd)
  await harness.service.listSessions(true)
  // 直接造一条 stall 卡点：这条测的是「不支持回答」的提示，不该被扫描时序干扰。
  const blocker: any = {
    id: 'blk_r6_stall',
    sessionId: 'worker-r6c',
    kind: 'stall',
    subkind: 'running_stall',
    severity: 'critical',
    status: 'open',
    signature: 'stall:running:1',
    summary: 'worker 在运行但 20 分钟没有事件',
    neededAction: '检查是否卡住',
    evidence: {},
    detectedAt: Date.now(),
    lastSeenAt: Date.now(),
    reminderCount: 0,
  }
  await harness.service.store.putBlocker(blocker)

  const result = await harness.service.resolveBlocker(blocker.id, 'answer', 'x', 'user')
  assert.equal(result.ok, false)
  assert.match(String(result.message), /不支持回答/)
})
test('P2 Codex 只读来源：进列表与 snapshot，不进派发候选', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-home-'))
  const codexHome = path.join(root, '.codex')
  const id = '01a07a8f-134f-7322-9a25-61be5e43759a'

  const { harness, cwd } = await boot({
    sources: {
      codex: { enabled: true, home: codexHome, scanDays: 365, maxSessions: 50, tailBytes: 65536, includeSubagents: false, watch: false },
    },
  })

  // 先 boot 拿到 cwd，再写 rollout（codex 会话的 cwd 指向它，便于观察候选过滤）
  const day = path.join(codexHome, 'sessions', '2026', '11', '09')
  await mkdir(day, { recursive: true })
  await writeFile(
    path.join(day, `rollout-2026-11-09T10-00-00-${id}.jsonl`),
    [
      JSON.stringify({ timestamp: new Date().toISOString(), ordinal: 0, type: 'session_meta', payload: { session_id: id, cwd } }),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        ordinal: 1,
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Codex 侧的任务' }] },
      }),
    ].join('\n') + '\n',
  )

  const sessions = await harness.service.listSessions(true)
  const codex = sessions.find((item) => item.source === 'codex')
  assert.ok(codex, 'codex 会话应出现在列表里')
  assert.equal(codex!.sessionId, id)
  assert.equal(codex!.cwd, cwd)
  assert.equal(codex!.title, 'Codex 侧的任务')

  const snapshot = await harness.service.snapshot()
  assert.equal(snapshot.sessions.find((item) => item.sessionId === id)?.source, 'codex')
  assert.equal(harness.service.sourceKindOf(id), 'codex')
  assert.equal(harness.service.capabilitiesOf(id).send, false)

  const candidates = await harness.service.dispatchCandidates('把 codex 那个任务接过来')
  assert.equal(
    candidates.candidates.some((item: any) => item.sessionId === id),
    false,
    '只读来源不能进候选',
  )
  const executed = await harness.service.dispatchExecute({ kind: 'reuse', sessionId: id, reason: '测试' }, '做一下')
  assert.equal(executed.kind, 'clarify')
  assert.equal(executed.reason, 'target_read_only')
  await rm(root, { recursive: true, force: true })
})

test('P2 Codex 默认关闭', async () => {
  const { harness } = await boot()
  assert.equal(harness.service.sources.get('codex'), undefined)
})

test('B-1 进度通知：落盘后出现在 snapshot.progressNotices，且不混进 blockerNotices', async () => {
  const { harness, cwd } = await boot()
  const worker = harness.addAgent('worker-b1', cwd)
  await harness.service.listSessions(true)
  const started = await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-b1', reason: 'B-1' },
    '做点事',
  )
  const dispatch = harness.service.store.getDispatch(started.dispatchId)!

  // 直接喂一批进度事件（等价于扫描时 detectProgress 的产出）
  await (harness.service as any).recordProgressNotices('worker-b1', 'worker-b1', dispatch, [
    { kind: 'milestone', signatures: ['milestone:a'], category: 'milestone', title: '完成 1 项', detail: '读了 util.ts', real: true },
    { kind: 'stage_end', signatures: ['stage_end:1'], category: 'dispatch', title: '阶段结束', real: true },
  ])

  const snapshot = await harness.service.snapshot()
  assert.equal(snapshot.progressNotices.length, 2, '两条进度都进快照')
  assert.equal(snapshot.blockerNotices.length, 0, '进度绝不能进 blockerNotices（语义隔离）')
  for (const notice of snapshot.progressNotices) {
    assert.equal(notice.kind, 'progress')
    assert.equal(notice.status, 'open')
    assert.equal(notice.dispatchId, dispatch.id)
    assert.equal(typeof notice.expiresAt, 'number')
    assert.equal(notice.source, 'dsh')
  }
  // dsh 来源保留「打开会话」这一个跳转动作（只读来源才清空）
  assert.equal(snapshot.progressNotices[0]!.actions.length, 1)
  void worker
})

test('B-1 进度通知：同签名去重、超上限裁剪、过期不可见', async () => {
  const { harness, cwd } = await boot({ progress: { queueLimit: 3, ttlMs: 60_000 } })
  harness.addAgent('worker-b2', cwd)
  await harness.service.listSessions(true)
  const started = await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-b2', reason: 'B-1' },
    '做点事',
  )
  const dispatch = harness.service.store.getDispatch(started.dispatchId)!
  const record = (signature: string) =>
    (harness.service as any).recordProgressNotices('worker-b2', 'worker-b2', dispatch, [
      { kind: 'milestone', signatures: [signature], category: 'milestone', title: `t-${signature}`, real: true },
    ])

  await record('milestone:x')
  await record('milestone:x') // 同签名再来一次：不应重复
  let snapshot = await harness.service.snapshot()
  assert.equal(snapshot.progressNotices.length, 1)

  await record('milestone:y')
  await record('milestone:z')
  await record('milestone:w')
  snapshot = await harness.service.snapshot()
  assert.equal(snapshot.progressNotices.length, 3, 'queueLimit=3 裁剪')

  // 手工把一条改成过期，快照里立刻不可见
  const stored = harness.service.store.listProgressNotices()
  await harness.service.store.saveProgressNotices([
    { ...stored[0]!, expiresAt: Date.now() - 1 },
    ...stored.slice(1),
  ])
  snapshot = await harness.service.snapshot()
  assert.equal(snapshot.progressNotices.length, stored.length - 1)
})

test('B-1 唤醒有界：连续 10 次事件不超过 maxPerDispatch；关掉开关完全静默', async () => {
  const { harness, cwd } = await boot()
  const butlerId = await harness.service.ensureButler()
  const butler = harness.addAgent(butlerId, cwd, 'superagent-butler')
  butler.status = 'idle'
  harness.addAgent('worker-b3', cwd)
  await harness.service.listSessions(true)
  const started = await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-b3', reason: 'B-1' },
    '做点事',
  )
  const dispatch = harness.service.store.getDispatch(started.dispatchId)!

  const before = harness.prompts.filter((item) => item.sessionId === butlerId).length
  for (let index = 0; index < 10; index += 1) {
    ;(harness.service as any).lastWakeAt = 0 // 跳过节流，只验证配额与签名
    await (harness.service as any).maybeWakeButler(dispatch, [
      { kind: 'stage_end', signatures: [`stage_end:${index}`], category: 'dispatch', title: `阶段 ${index}`, real: true },
    ])
  }
  const wakes = harness.prompts.filter((item) => item.sessionId === butlerId).length - before
  assert.ok(wakes <= 2, `唤醒次数必须有界，实际 ${wakes}`)
  assert.ok(wakes >= 1, '至少要唤醒一次')

  // 关掉开关：完全静默
  ;(harness.service as any).config.progress.wake.enabled = false
  ;(harness.service as any).lastWakeAt = 0
  ;(harness.service as any).wakeCounts.clear()
  const beforeOff = harness.prompts.filter((item) => item.sessionId === butlerId).length
  await (harness.service as any).maybeWakeButler(dispatch, [
    { kind: 'watchdog', signatures: ['watchdog:off'], category: 'dispatch', title: '停滞', real: false },
  ])
  assert.equal(harness.prompts.filter((item) => item.sessionId === butlerId).length, beforeOff)
})

test('B-1 唤醒：管家 running 时不唤醒', async () => {
  const { harness, cwd } = await boot()
  const butlerId = await harness.service.ensureButler()
  const butler = harness.addAgent(butlerId, cwd, 'superagent-butler')
  harness.addAgent('worker-b4', cwd)
  await harness.service.listSessions(true)
  const started = await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-b4', reason: 'B-1' },
    '做点事',
  )
  const dispatch = harness.service.store.getDispatch(started.dispatchId)!
  butler.status = 'running'
  const before = harness.prompts.filter((item) => item.sessionId === butlerId).length
  await (harness.service as any).maybeWakeButler(dispatch, [
    { kind: 'stage_end', signatures: ['stage_end:busy'], category: 'dispatch', title: '阶段结束', real: true },
  ])
  assert.equal(harness.prompts.filter((item) => item.sessionId === butlerId).length, before)
})

test('P0 回归：来宾源在启动阶段炸掉，也只标记不可用，不拖垮插件', async () => {
  const { harness } = await boot()
  const service: any = harness.service
  // 模拟"来宾源构造/start 直接抛"
  service.registerGuestSource('claude', () => {
    throw new Error('boom: source exploded at startup')
  })
  // 核心仍然可用
  harness.addAgent('worker-p0', (await mkdtemp(path.join(os.tmpdir(), 'p0-'))))
  await service.listSessions(true)
  const snapshot = await service.snapshot()
  const claude = snapshot.sources.find((item: any) => item.kind === 'claude')
  assert.equal(claude?.available, false)
  assert.match(String(claude?.error), /boom: source exploded at startup/)
  // dsh 核心健康
  const dsh = snapshot.sources.find((item: any) => item.kind === 'dsh')
  assert.equal(dsh?.available, true)
  assert.ok(snapshot.sessions.length >= 1)
  // 管家工具仍能工作（快照可读）
  assert.equal(typeof snapshot.progressNotices, 'object')
})

test('P0 回归：list 阶段抛错的来源被标不可用，其它来源照常', async () => {
  const { harness } = await boot()
  const service: any = harness.service
  const before = (await service.snapshot()).sessions.length
  service.markSourceHealth('codex', new Error('list exploded'))
  const snapshot = await service.snapshot()
  const codex = snapshot.sources.find((item: any) => item.kind === 'codex')
  assert.equal(codex?.available, false)
  assert.match(String(codex?.error), /list exploded/)
  assert.equal(snapshot.sessions.length, before, 'dsh 会话不受影响')
})

test('P0 版本戳：快照、审计、meta 三处带同一份 codeVersion / configHash', async () => {
  const { harness } = await boot()
  const snapshot = await harness.service.snapshot()

  assert.ok(snapshot.version, '快照要带版本标识')
  assert.equal(typeof snapshot.version!.codeVersion, 'string')
  assert.ok(snapshot.version!.codeVersion.length > 0)
  assert.match(snapshot.version!.configHash, /^[0-9a-f]{12}$/)
  assert.ok((snapshot.version!.startedAt ?? 0) > 0)

  // 审计：任何一条决策都要能回答「哪版代码、哪版配置」
  const audit = await harness.service.store.appendAudit({ kind: 'command', action: 'version_probe' })
  assert.equal(audit.codeVersion, snapshot.version!.codeVersion)
  assert.equal(audit.configHash, snapshot.version!.configHash)

  // meta：重启后仍能查到上一次跑的是哪版
  const meta = await harness.service.store.getMeta()
  assert.equal(meta.codeVersion, snapshot.version!.codeVersion)
  assert.equal(meta.configHash, snapshot.version!.configHash)

  // diagnostics 也要有（排查「为什么没拦」的第一步）
  const diagnostics = harness.service.diagnostics()
  assert.equal(diagnostics.version.codeVersion, snapshot.version!.codeVersion)
  assert.equal(diagnostics.version.configHash, snapshot.version!.configHash)
})

test('P1 shadow：watchdog 命中 shadow 时只记台账、不发通知、也不唤醒管家', async () => {
  // 默认配置里 watchdog_stall 就在 shadow 名单内（首发只记录，攒证据）
  const { harness, cwd } = await boot({ progress: { minGapMs: 0 } })
  const { butler } = await withButler(harness, cwd)
  harness.addAgent('worker-shadow', cwd)
  await harness.service.listSessions(true)
  await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-shadow', reason: '集成测试' },
    '跟一下这个任务',
  )
  const dispatch = harness.service.store.currentDispatch('worker-shadow')!
  dispatch.watchdog = { expectedMinutes: 20, pollMinutes: 10 }
  dispatch.createdAt = Date.now() - 60 * 60_000
  dispatch.acceptedAt = Date.now() - 45 * 60_000
  dispatch.progress = {
    ...dispatch.progress!,
    lastProgressAt: Date.now() - 45 * 60_000,
    lastTurnEndAt: Date.now(),
  }
  await harness.service.store.putDispatch(dispatch)
  const runtime =
    (harness.service as any).runtimes.get('worker-shadow') ??
    (await (harness.service as any).ensureRuntime('worker-shadow'))
  runtime.lastActivityAt = Date.now() - 45 * 60_000

  await (harness.service as any).evaluateSession('worker-shadow')
  ;(harness.service as any).flushProgress('worker-shadow')

  // 1) 用户侧完全无感：没有「没有进展」的提醒
  assert.equal(
    notices(butler).filter((text) => /没有进展/.test(text)).length,
    0,
    'shadow 期间不能打扰用户',
  )

  // 2) 但台账里有记录，且标明是 shadow
  const records = harness.service.store
    .listAudit()
    .filter((item) => item.action === 'watchdog_remind')
  assert.equal(records.length, 1, 'shadow 也要留证据，且只留一条')
  assert.equal(records[0]!.shadow, true)
  assert.equal(records[0]!.ruleId, 'watchdog_stall')
  assert.equal(records[0]!.dispatchId, dispatch.id)

  // 3) 快照里的报表能看出这条规则当前是「只记录」
  const snapshot = await harness.service.snapshot()
  const stat = (snapshot.policyStats?.rules ?? []).find((item) => item.ruleId === 'watchdog_stall')
  assert.ok(stat, 'policyStats 要包含 watchdog_stall')
  assert.equal(stat!.mode, 'shadow')
  assert.ok((stat!.unknown ?? 0) >= 1, '未判定的决策要计数')
})

// ---------------------------------------------------------------- P2 Thread

test('P2 thread：派发建活、取代时复用同一件活、自报完成只到「等你销账」', async () => {
  const { harness, cwd } = await boot()
  await withButler(harness, cwd)
  harness.addAgent('worker-t1', cwd)
  await harness.service.listSessions(true)
  // 默认项目模式是 plan_review：没批计划时 worker 报完成不会把派发判为完成。
  // 这条用例要验的是活的状态机，所以先切到卡点确认模式。
  await harness.service.setMode(harness.service.ensureProjectForCwd(cwd).key, 'gate_confirm')

  await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-t1', reason: 't' },
    '第一件事',
  )
  const first = harness.service.store.currentDispatch('worker-t1')!
  assert.ok(first.threadId, '派发要挂到一条活上')
  const threadId = first.threadId!
  const thread = harness.service.store.getThread(threadId)!
  assert.equal(thread.state, 'active')
  assert.deepEqual(thread.dispatchIds, [first.id])
  assert.deepEqual(thread.participantSessionIds, ['worker-t1'])

  // 同一 session 再派一条：上一条被 superseded，属于同一件活的延续 → 复用 thread
  await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-t1', reason: 't2' },
    '继续这件事',
  )
  const second = harness.service.store.currentDispatch('worker-t1')!
  assert.equal(second.threadId, threadId, '取代上一条派发必须沿用同一件活')
  assert.equal(harness.service.store.listThreads().length, 1, '不该凭空多出一件活')

  // worker 自报完成只是「疑似完成」：活停在等你销账，绝不自动销账
  await harness.service.noteReport(harness.agents.get('worker-t1'), {
    goal: '继续这件事',
    done: ['做完了'],
    next: [],
    blockers: [],
    decisions: [],
  })
  // completeDispatch 在 noteProgress 里是 `void` 调用的（不阻塞上报），所以这里等一下状态收敛
  const settled = await waitFor(
    () => harness.service.store.getThread(threadId)!.state === 'waiting_human',
  )
  assert.ok(settled, `worker 说完成不等于用户确认，实际 ${harness.service.store.getThread(threadId)!.state}`)
})

test('P2 thread：人工标记完成即销账，并把名下卡点一起归档', async () => {
  const { harness, cwd } = await boot()
  await withButler(harness, cwd)
  harness.addAgent('worker-t2', cwd)
  await harness.service.listSessions(true)
  await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-t2', reason: 't' },
    '干这件事',
  )
  const dispatch = harness.service.store.currentDispatch('worker-t2')!
  const threadId = dispatch.threadId!
  await harness.service.store.putBlocker({
    id: 'blk_t2',
    sessionId: 'worker-t2',
    threadId,
    kind: 'repeated_failure',
    severity: 'warning',
    status: 'notified',
    signature: 'sig-t2',
    summary: '卡住了',
    neededAction: '看一眼',
    evidence: {},
    detectedAt: Date.now(),
    lastSeenAt: Date.now(),
    reminderCount: 1,
  } as any)

  const out = await harness.service.markDispatch(dispatch.id, 'completed', undefined, 'user')
  assert.equal(out.ok, true)

  const thread = harness.service.store.getThread(threadId)!
  assert.equal(thread.state, 'done', '人工收尾就是销账')
  assert.equal(thread.closedBy, 'user')
  assert.ok(thread.closedAt)

  const blocker = harness.service.store.getBlocker('blk_t2')!
  assert.equal(blocker.status, 'auto_resolved', '活销账了，名下卡点不该继续挂着')
  assert.match(String(blocker.resolution), /销账/)
})

test('P2 thread：还有未结束派发时拒绝销账', async () => {
  const { harness, cwd } = await boot()
  await withButler(harness, cwd)
  harness.addAgent('worker-t3', cwd)
  await harness.service.listSessions(true)
  await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-t3', reason: 't' },
    '还没干完的活',
  )
  const dispatch = harness.service.store.currentDispatch('worker-t3')!
  const result = await harness.service.closeThread(dispatch.threadId!, 'done', 'user')
  assert.equal(result.ok, false)
  assert.match(String(result.message), /派发/)
  assert.equal(harness.service.store.getThread(dispatch.threadId!)!.state, 'active')
})

test('P2 thread：关掉开关后不建活，快照与工具都看不到', async () => {
  const { harness, cwd } = await boot({ thread: { enabled: false } })
  await withButler(harness, cwd)
  harness.addAgent('worker-t4', cwd)
  await harness.service.listSessions(true)
  await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-t4', reason: 't' },
    '关掉功能的活',
  )
  const stored = harness.service.store.currentDispatch('worker-t4')!
  assert.equal(stored.threadId, undefined, '关掉开关就不该挂 threadId')
  assert.equal(harness.service.store.listThreads().length, 0)
  const snapshot = await harness.service.snapshot()
  assert.deepEqual(snapshot.threads, [])
  assert.equal(harness.service.listThreadsView().count, 0)
})

test('P2 thread：长期不动的活自动标 abandoned，但绝不标 done', async () => {
  const { harness, cwd } = await boot({ thread: { idleAbandonMs: 0 } })
  await withButler(harness, cwd)
  harness.addAgent('worker-t5', cwd)
  await harness.service.listSessions(true)
  await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-t5', reason: 't' },
    '一条没人管的老活',
  )
  const dispatch = harness.service.store.currentDispatch('worker-t5')!
  const threadId = dispatch.threadId!
  // 先收尾派发（还有未结束派发时不允许放弃）
  await harness.service.markDispatch(dispatch.id, 'failed', '不做了', 'user')
  assert.equal(harness.service.store.getThread(threadId)!.state, 'waiting_human')

  // 回拨最近活动时间，模拟闲置超过阈值
  const thread = harness.service.store.getThread(threadId)!
  thread.lastEventAt = Date.now() - 10 * 24 * 60 * 60_000
  await harness.service.store.putThread(thread)

  await (harness.service as any).scan()
  const after = harness.service.store.getThread(threadId)!
  assert.equal(after.state, 'abandoned', '长期没人管只能判 abandoned')
  assert.equal(after.closedBy, 'auto_ttl')
  assert.notEqual(after.state, 'done', '自动流程永远不许把活标成已完成')
})

// ---------------------------------------------------------------- I-28 建议销账

test('I-28(1)：空闲 + 有完成信号 + next 为空 → 产出建议销账；不满足就不产出', async () => {
  const { harness, cwd } = await boot()
  await withButler(harness, cwd)
  harness.addAgent('worker-s1', cwd)
  await harness.service.listSessions(true)
  await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-s1', reason: 't' },
    '把 util 的 bug 修了',
  )
  const dispatch = harness.service.store.currentDispatch('worker-s1')!
  const service: any = harness.service
  const soft = {
    goal: '修 bug',
    done: ['改完了'],
    next: [],
    blockers: [],
    decisions: [],
    reportedAt: Date.now(),
    source: 'tool',
  }

  // 没有完成信号、没有阶段结束 → 不建议
  assert.equal(
    service.settleSuggestBlocker({
      sessionId: 'worker-s1',
      sessionTitle: 'worker-s1',
      hardStatus: 'idle',
      dispatch,
      soft,
    }),
    undefined,
  )

  // 记上「完成信号」（这是事实，不是推断）
  dispatch.suspectDoneAt = Date.now() - 60_000
  dispatch.suspectDoneReason = 'report'
  await harness.service.store.putDispatch(dispatch)

  const suggested = service.settleSuggestBlocker({
    sessionId: 'worker-s1',
    sessionTitle: 'worker-s1',
    hardStatus: 'idle',
    dispatch,
    soft,
  })
  assert.ok(suggested, '空闲 + 有完成信号就该建议')
  assert.equal(suggested.kind, 'settle_suggest')
  assert.equal((suggested.evidence as any).dispatchId, dispatch.id)

  // 还在跑 → 不打扰
  assert.equal(
    service.settleSuggestBlocker({
      sessionId: 'worker-s1',
      sessionTitle: 'worker-s1',
      hardStatus: 'running',
      dispatch,
      soft,
    }),
    undefined,
  )
  // worker 还有下一步 → 不催销账
  assert.equal(
    service.settleSuggestBlocker({
      sessionId: 'worker-s1',
      sessionTitle: 'worker-s1',
      hardStatus: 'idle',
      dispatch,
      soft: { ...soft, next: ['还要跑测试'] },
    }),
    undefined,
  )
})

test('I-28(1)：建议销账卡片带 dispatchId 和两个按钮；点「确认完成」= 人工销账', async () => {
  const { harness, cwd } = await boot()
  await withButler(harness, cwd)
  harness.addAgent('worker-s2', cwd)
  await harness.service.listSessions(true)
  await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-s2', reason: 't' },
    '干完但没人收尾的活',
  )
  const dispatch = harness.service.store.currentDispatch('worker-s2')!
  const threadId = dispatch.threadId!
  await harness.service.store.putBlocker({
    id: 'blk_suggest',
    sessionId: 'worker-s2',
    threadId,
    kind: 'settle_suggest',
    severity: 'info',
    status: 'notified',
    signature: `settle:${dispatch.id}`,
    summary: '看起来已经干完，要不要销账？',
    neededAction: '确认无误就点「确认完成，销账」',
    evidence: { dispatchId: dispatch.id },
    detectedAt: Date.now(),
    lastSeenAt: Date.now(),
    reminderCount: 1,
  } as any)

  const snapshot = await harness.service.snapshot()
  const notice = (snapshot.blockerNotices ?? []).find(
    (item: any) => item.blockerId === 'blk_suggest',
  ) as any
  assert.ok(notice, '建议销账必须出现在收件箱')
  assert.equal(notice.dispatchId, dispatch.id, '按钮要靠 dispatchId 落到具体派发上')
  assert.ok(
    (notice.actions ?? []).some((action: any) => action.verb === 'dispatch_completed'),
    '要有「确认完成」按钮',
  )

  // 点「确认完成」的服务端等价动作
  const result = await harness.service.resolveBlocker('blk_suggest', 'approve', undefined, 'user')
  assert.notEqual(result?.ok, false, `销账失败：${JSON.stringify(result)}`)
  assert.equal(harness.service.store.getDispatch(dispatch.id)!.status, 'completed')
  assert.equal(harness.service.store.getBlocker('blk_suggest')!.status, 'auto_resolved')
  assert.equal(harness.service.store.getThread(threadId)!.state, 'done', '销账连带到活')
})

test('I-28(1)：点「继续观察」后冷却期内不再建议', async () => {
  const { harness, cwd } = await boot()
  await withButler(harness, cwd)
  harness.addAgent('worker-s3', cwd)
  await harness.service.listSessions(true)
  await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-s3', reason: 't' },
    '再观察一下的活',
  )
  const dispatch = harness.service.store.currentDispatch('worker-s3')!
  dispatch.suspectDoneAt = Date.now()
  dispatch.suspectDoneReason = 'report'
  await harness.service.store.putDispatch(dispatch)
  await harness.service.store.putBlocker({
    id: 'blk_suggest3',
    sessionId: 'worker-s3',
    kind: 'settle_suggest',
    severity: 'info',
    status: 'notified',
    signature: `settle:${dispatch.id}`,
    summary: '要不要销账？',
    neededAction: '确认完成',
    evidence: { dispatchId: dispatch.id },
    detectedAt: Date.now(),
    lastSeenAt: Date.now(),
    reminderCount: 1,
  } as any)

  const dismissed = await harness.service.resolveBlocker('blk_suggest3', 'dismiss', undefined, 'user')
  assert.equal(dismissed.ok, true)

  const again = (harness.service as any).settleSuggestBlocker({
    sessionId: 'worker-s3',
    sessionTitle: 'worker-s3',
    hardStatus: 'idle',
    dispatch,
    soft: {
      goal: 'x',
      done: ['y'],
      next: [],
      blockers: [],
      decisions: [],
      reportedAt: Date.now(),
      source: 'tool',
    },
  })
  assert.equal(again, undefined, '忽略后冷却期内不能反复骚扰')
})

// ---------------------------------------------------------------- I-29 决策字段

test('I-29：旧写法 mode / targetSessionId 被兼容，不再报 target_ambiguous', async () => {
  const { harness, cwd } = await boot()
  await withButler(harness, cwd)
  harness.addAgent('worker-d1', cwd)
  await harness.service.listSessions(true)

  // 历史踩坑写法：mode + targetSessionId（真实报错是 target_ambiguous，且没有任何提示）
  const result: any = await harness.service.dispatchExecute(
    { mode: 'reuse', targetSessionId: 'worker-d1', reason: '旧写法' } as any,
    '用旧字段名派活',
  )
  assert.notEqual(result?.kind, 'clarify', `不该再要求澄清：${JSON.stringify(result)}`)
  assert.ok(harness.service.store.currentDispatch('worker-d1'))
})

test('I-29：字段写错时报错要带上实际收到的键名，便于自我纠正', async () => {
  const { harness, cwd } = await boot()
  await withButler(harness, cwd)
  harness.addAgent('worker-d2', cwd)
  await harness.service.listSessions(true)

  const result: any = await harness.service.dispatchExecute(
    { decision: 'new', cwd } as any,
    '字段写错的派发',
  )
  assert.equal(result?.kind, 'clarify')
  assert.equal(result?.reason, 'invalid_decision')
  assert.match(String(result?.message), /kind/)
  assert.match(String(result?.message), /decision/, '要说出实际收到了哪些键')
  assert.match(String(result?.message), /"kind":"new"/, '要给最小可用示例')
})

// ---------------------------------------------------------------- I-34 投递落盘

test('I-34：管家离线时提醒落盘，重启后队列可重建，卡片照样可见', async () => {
  const { harness, cwd } = await boot()
  const { butlerId } = await withButler(harness, cwd)
  const service: any = harness.service

  // 让管家「离线」：session 还在，但注册表里查不到 agent
  harness.agents.delete(butlerId)

  const delivery = await service.injectButlerNotice(
    { text: '【SuperAgent 提醒】离线期间产生的一条提醒' },
    butlerId,
  )
  assert.equal(delivery.delivered, false, '管家不在线，不该算已送达')
  assert.equal(delivery.queued, true, '要进持久化队列')

  // 1) 落盘：存储里必须能看到（原来这里是纯内存，重启即丢）
  const persisted = harness.service.store.listPendingNotices()
  assert.equal(persisted.length, 1, '离线队列必须落盘')
  assert.equal(persisted[0]!.butlerSessionId, butlerId)
  assert.match(String(persisted[0]!.payload?.text), /离线期间产生/)

  // 2) 模拟重启：内存清空，从存储重建
  service.pendingButlerNotices.clear()
  assert.equal(service.pendingButlerNotices.size, 0)
  await service.restorePendingNotices()
  assert.equal(
    service.pendingButlerNotices.get(butlerId)?.length,
    1,
    '重启后必须能从存储把未读队列重建回来',
  )

  // 3) 卡片可重放：blocker 仍是 notified → 快照里照常出现（不受 wake 去重影响）
  await harness.service.store.putBlocker({
    id: 'blk_offline',
    sessionId: 'worker-offline',
    kind: 'settle_suggest',
    severity: 'info',
    status: 'notified',
    signature: 'settle:dsp_offline',
    summary: '看起来已经干完，要不要销账？',
    neededAction: '确认完成',
    evidence: { dispatchId: 'dsp_offline' },
    detectedAt: Date.now(),
    lastSeenAt: Date.now(),
    reminderCount: 1,
  } as any)
  const snapshot = await harness.service.snapshot()
  assert.ok(
    (snapshot.blockerNotices ?? []).some((item: any) => item.blockerId === 'blk_offline'),
    '重启后未读卡片必须还能在快照里渲染出来',
  )
})

// ---------------------------------------------------------------- I-31 MCP 批量放行

test('I-31(c)：同会话同 MCP 方法批过一次后不再逐次问（可关）', async () => {
  const { harness, cwd } = await boot()
  await withButler(harness, cwd)
  harness.addAgent('worker-mcp', cwd)
  await harness.service.listSessions(true)
  await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-mcp', reason: 't' },
    '用 MCP 验一下页面',
  )
  const agent = harness.agents.get('worker-mcp')
  // 用会改变状态的方法：take_snapshot 现在属于只读，会直接放行，验不到审批路径
  const tool = 'mcp__chrome-devtools-mcp__click'

  // 第一次：需要审批
  const first = await harness.gate(agent, tool, {})
  assert.equal(first.kind, 'ask', `第一次应当审批，实际 ${JSON.stringify(first)}`)

  // 用户批过一次（写一条已批准记录）
  await harness.service.store.putApproval({
    id: 'apv_mcp_1',
    sessionId: 'worker-mcp',
    toolName: tool,
    argsSummary: '{}',
    risk: 'high',
    status: 'user_approved',
    decidedBy: 'user',
    createdAt: Date.now(),
    decidedAt: Date.now(),
  } as any)

  // 第二次：同会话同方法 → 不再问
  const second = await harness.gate(agent, tool, {})
  assert.notEqual(second.kind, 'ask', '批过一次后不该再问')
  const audited = harness.service.store
    .listAudit()
    .filter((item) => item.action === 'mcp_batch_allow')
  assert.equal(audited.length, 1, '批量放行要留痕')
  assert.equal(audited[0]!.by, 'butler-auto')
})

// ---------------------------------------------------------------- I-33 计划进对话

test('I-33：待审计划进对话卡片（带 planId 与入口），plan_detail 能取到正文', async () => {
  const { harness, cwd } = await boot()
  await withButler(harness, cwd)
  harness.addAgent('worker-plan', cwd)
  await harness.service.listSessions(true)
  await harness.service.setMode(harness.service.ensureProjectForCwd(cwd).key, 'plan_review')
  await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-plan', reason: 't' },
    '改一下页面查询',
  )

  const submitted: any = await harness.service.submitPlan(harness.agents.get('worker-plan'), {
    title: '改 PageServiceImpl 查询',
    plan: '目标：把查询改成走缓存\n\n步骤：1) 改 service 2) 跑测试',
    scope: { items: [{ id: 'P1', description: 'service', paths: ['src/**'] }] },
  })
  assert.equal(submitted.status, 'pending_review')

  const snapshot = await harness.service.snapshot()
  const card = (snapshot.blockerNotices ?? []).find(
    (item: any) => item.planId === submitted.planId,
  ) as any
  assert.ok(card, '待审计划必须出现在对话卡片里')
  assert.match(String(card.detail), /计划条目/, '卡片要带规模信息')
  assert.ok(
    (card.actions ?? []).some((action: any) => action.verb === 'open_plan'),
    '卡片要有查看完整方案的入口',
  )

  // 「查看完整方案」拉到的正文
  const detail: any = await harness.service.handleAction('plan_detail', {
    planId: submitted.planId,
  })
  assert.match(String(detail.markdown), /走缓存/)
  assert.match(String(detail.summary), /计划条目/)
})

test('I-33(4)：gate_confirm 下方案不阻塞，但对话里要明确说清「本次不阻塞 + 方案在哪」', async () => {
  const { harness, cwd } = await boot()
  const { butler } = await withButler(harness, cwd)
  harness.addAgent('worker-plan2', cwd)
  await harness.service.listSessions(true)
  await harness.service.setMode(harness.service.ensureProjectForCwd(cwd).key, 'gate_confirm')
  await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-plan2', reason: 't' },
    '卡点确认模式下交个方案',
  )

  const submitted: any = await harness.service.submitPlan(harness.agents.get('worker-plan2'), {
    title: '卡点确认模式的方案',
    plan: '这是方案正文',
    scope: { items: [{ id: 'P1', description: 'x', paths: ['src/**'] }] },
  })
  assert.equal(submitted.status, 'not_required')
  assert.equal(submitted.stored, true, '不需要审查也要落盘')

  const texts = (butler.injected as any[])
    .map((message) => JSON.stringify(message?.content ?? ''))
    .join('\n')
  assert.match(texts, /本次不阻塞/, '要说清不阻塞')
  assert.match(texts, new RegExp(String(submitted.planId)), '要给出 planId 便于去找正文')
})

// ---------------------------------------------------------------- I-32 部分：真唤醒

/** prompt 的 content 是 [{type:'text',text}]，取出来做断言。 */
function promptText(item: any): string {
  const content = item?.content
  if (Array.isArray(content)) return content.map((block: any) => String(block?.text ?? '')).join('\n')
  return String(content ?? '')
}

function approvalBlocker(id: string, sessionId: string, extra: any = {}): any {
  const at = Date.now()
  return {
    id,
    sessionId,
    kind: 'approval',
    severity: 'warning',
    status: 'open',
    signature: `approval:${id}`,
    summary: '在等审批：bash rm -rf build',
    neededAction: '允许或拒绝 bash',
    evidence: { toolName: 'bash', callId: `call-${id}`, risk: 'high' },
    detectedAt: at,
    lastSeenAt: at,
    reminderCount: 0,
    relatedApprovalId: `apv-${id}`,
    relatedCallId: `call-${id}`,
    ...extra,
  }
}

test('I-32 部分：审批类卡点会「真唤醒」管家（起 turn），而不是只 inject', async () => {
  const { harness, cwd } = await boot()
  const { butlerId } = await withButler(harness, cwd)
  const blocker = approvalBlocker('bl_w1', 'worker-w1')
  await harness.service.store.putBlocker(blocker)
  await (harness.service as any).maybeRemind(blocker)

  const woke = harness.prompts.filter((item) => item.sessionId === butlerId)
  assert.equal(woke.length, 1, '审批要真的起一次 turn 叫管家')
  assert.match(promptText(woke[0]), /自动唤醒/)
  assert.match(promptText(woke[0]), /审批/)
  // 唤醒之后不再重复注入同一条（避免用户看到两遍）
  assert.equal(
    (harness.agents.get(butlerId)!.injected as any[]).length,
    0,
    '走唤醒就不该同时再 inject',
  )
})

test('I-32 部分：只对 approval / decision / error 唤醒，其它类型仍走注入', async () => {
  const { harness, cwd } = await boot()
  const { butlerId, butler } = await withButler(harness, cwd)

  // 用 stall：它既不在唤醒名单里，也不在 P1 的 shadow 名单里，能干净地验证「注入通道」
  const stalling: any = approvalBlocker('bl_w2', 'worker-w2', {
    kind: 'stall',
    relatedApprovalId: undefined,
  })
  await harness.service.store.putBlocker(stalling)
  await (harness.service as any).maybeRemind(stalling)
  assert.equal(harness.prompts.filter((i) => i.sessionId === butlerId).length, 0, 'stall 不该唤醒')
  assert.ok((butler.injected as any[]).length >= 1, '但仍要进注入通道')

  for (const kind of ['decision', 'error']) {
    const b = approvalBlocker(`bl_w_${kind}`, 'worker-w3', { kind, relatedApprovalId: undefined })
    await harness.service.store.putBlocker(b)
    await (harness.service as any).maybeRemind(b)
  }
  assert.equal(
    harness.prompts.filter((i) => i.sessionId === butlerId).length,
    2,
    'decision / error 各自唤醒一次',
  )
})

test('I-32 部分：同签名只唤醒一次（落盘），重复扫描不再叫醒', async () => {
  const { harness, cwd } = await boot()
  const { butlerId } = await withButler(harness, cwd)
  const blocker = approvalBlocker('bl_w3', 'worker-w4')
  await harness.service.store.putBlocker(blocker)

  await (harness.service as any).maybeRemind(blocker)
  assert.equal(harness.prompts.filter((i) => i.sessionId === butlerId).length, 1)

  // 模拟下一轮扫描重新检测到同一条：清掉节流/计数，让签名闸成为唯一拦截
  const fresh = harness.service.store.getBlocker('bl_w3')!
  fresh.reminderCount = 0
  fresh.lastRemindedAt = undefined
  await harness.service.store.putBlocker(fresh)
  await (harness.service as any).maybeRemind(fresh)
  assert.equal(
    harness.prompts.filter((i) => i.sessionId === butlerId).length,
    1,
    '同签名第二次不该再唤醒',
  )
})

test('I-32 部分：每派发最多唤醒 3 次', async () => {
  const { harness, cwd } = await boot({ blockerWake: { minGapMs: 0 } })
  const { butlerId } = await withButler(harness, cwd)
  harness.addAgent('worker-w5', cwd)
  await harness.service.listSessions(true)
  await harness.service.dispatchExecute(
    { kind: 'reuse', sessionId: 'worker-w5', reason: 't' },
    '跑一下',
  )

  for (let i = 0; i < 5; i++) {
    const blocker = approvalBlocker(`bl_wq${i}`, 'worker-w5')
    await harness.service.store.putBlocker(blocker)
    await (harness.service as any).maybeRemind(blocker)
  }
  assert.equal(
    harness.prompts.filter((item) => item.sessionId === butlerId).length,
    3,
    '同一派发最多唤醒 3 次',
  )
})

test('I-32 部分：管家 running 时绝不打断，只投不叫', async () => {
  const { harness, cwd } = await boot()
  const { butlerId, butler } = await withButler(harness, cwd)
  butler.status = 'running'
  const blocker = approvalBlocker('bl_w6', 'worker-w6')
  await harness.service.store.putBlocker(blocker)
  await (harness.service as any).maybeRemind(blocker)

  assert.equal(harness.prompts.filter((i) => i.sessionId === butlerId).length, 0, '不能打断当前 turn')
  assert.ok((butler.injected as any[]).length >= 1, '但要留下上下文')
})

// ---------------------------------------------------------------- I-34 补：改投规则

/** 造一条「待投递提醒」，让 noticeProjectKey 能取到来源会话。 */
function pendingItem(noticeSessionId: string, text = '【SuperAgent 提醒】测试', butlerSessionId = 'session-dead') {
  return {
    butlerSessionId,
    payload: {
      text,
      source: {
        kind: 'superagent-notice',
        form: 'notice',
        summary: text,
        notice: { id: 'n1', at: 1, kind: 'blocker', category: 'approval', severity: 'warning', sessionId: noticeSessionId },
      },
    },
  }
}

async function seedManagedSession(harness: Harness, id: string, projectKey: string, isButler = false) {
  await harness.service.store.putSession({
    sessionId: id,
    title: id,
    projectKey,
    source: 'dsh',
    isButler,
    firstSeenAt: 1,
    lastSeenAt: 1,
  } as any)
}

test('I-34 补：目标管家不存在 + 同 projectKey → 改投给当前管家', async () => {
  const { harness, cwd } = await boot()
  const { butlerId, butler } = await withButler(harness, cwd)
  const project = harness.service.ensureProjectForCwd(cwd).key
  await seedManagedSession(harness, butlerId, project, true)
  await seedManagedSession(harness, 'worker-same', project)

  // 造一个「目标管家已不存在」的队列条目，来源是同项目的会话
  const service: any = harness.service
  service.pendingButlerNotices.set('session-dead', [pendingItem('worker-same').payload])

  service.flushButlerNotices(butler)
  assert.equal(
    (butler.injected as any[]).length,
    1,
    '同项目应当改投成功（有注入）',
  )
  assert.equal(service.pendingButlerNotices.get('session-dead'), undefined, '改投后原键应清空')
  const snapshot = await harness.service.snapshot()
  assert.equal(snapshot.pendingNotices ?? undefined, undefined, '没有残留就不该有未送达标记')
})

test('I-34 补：不同 projectKey → 不改投、留在队列、快照标未送达', async () => {
  const { harness, cwd } = await boot()
  const { butlerId, butler } = await withButler(harness, cwd)
  const project = harness.service.ensureProjectForCwd(cwd).key
  await seedManagedSession(harness, butlerId, project, true)
  await seedManagedSession(harness, 'worker-other', 'cwd_other_project')

  const service: any = harness.service
  service.pendingButlerNotices.set('session-dead', [pendingItem('worker-other').payload])

  service.flushButlerNotices(butler)
  assert.equal((butler.injected as any[]).length, 0, '不同项目不该改投')
  assert.equal(
    service.pendingButlerNotices.get('session-dead')?.length,
    1,
    '不改投也不能丢，必须留在队列里',
  )
  const snapshot = await harness.service.snapshot()
  const row = (snapshot.pendingNotices ?? [])[0]
  assert.ok(row, '未送达必须在快照里可见')
  assert.equal(row!.count, 1)
  assert.equal(row!.targetAlive, false, '目标管家已不在')
  assert.ok(!row!.projectKey || row!.projectKey === 'cwd_other_project')
})

test('I-34 补：目标管家还活着时按原键投递（不改行为）', async () => {
  const { harness, cwd } = await boot()
  const { butlerId, butler } = await withButler(harness, cwd)
  const project = harness.service.ensureProjectForCwd(cwd).key
  await seedManagedSession(harness, butlerId, project, true)

  const service: any = harness.service
  // 条目原定发给这个管家自己
  service.pendingButlerNotices.set(butlerId, [pendingItem('worker-x', '【SuperAgent 提醒】原键', butlerId).payload])

  service.flushButlerNotices(butler)
  assert.equal((butler.injected as any[]).length, 1, '原键要照常投递')
  assert.equal(service.pendingButlerNotices.get(butlerId), undefined)
})

// ---------------------------------------------------------------- I-36 提问应答通道

test('I-36：插件持有 waiter 时，管家回答能真正送到提问（按问题 id 组包）', async () => {
  const { harness, cwd } = await boot()
  await withButler(harness, cwd)
  harness.addAgent('worker-q1', cwd)
  const agent = harness.agents.get('worker-q1')
  const callId = 'call_q1'

  // 模拟 worker 的 ask_user_question 落到插件 answerer（插件会持有这个 promise）
  const pending = (harness.service as any).answerQuestion(
    agent,
    {
      wait: { callId },
      questions: [
        {
          id: 'q1',
          question: '后端 .gitignore 有已跟踪修改，要不要一起提交？',
          options: [{ label: '不提交' }, { label: '一起提交' }],
        },
      ],
    },
    () => 'next',
  )

  // answerQuestion 里先 await ensureRuntime 再登记 waiter，这里等一下（线上是秒级之后才回答）
  await waitFor(() => (harness.service as any).questionWaiters.has(callId))

  const result = await harness.service.answerQuestionByCall(callId, '一起提交', 'butler-chat')
  assert.equal(result.ok, true, `应答应成功：${JSON.stringify(result)}`)

  const answer = await pending
  assert.equal(answer.answers[0].id, 'q1', 'id 必须是问题自己的 id，不能是写死的 answer')
  assert.deepEqual(answer.answers[0].selected, ['一起提交'])
})

test('I-36：宿主 answer() 返回 false（不是 continued）时不许报成功，也不许清卡点', async () => {
  const { harness, cwd } = await boot()
  await withButler(harness, cwd)
  harness.addAgent('worker-q2', cwd)
  // 宿主对「仍在 open 的提问」会 return false（不抛错）
  harness.ctx.userQuestions.answer = async () => false
  await harness.service.store.putBlocker({
    id: 'blk_q_fail',
    sessionId: 'worker-q2',
    kind: 'question',
    severity: 'warning',
    status: 'notified',
    signature: 'question:call_fail_1',
    summary: '要不要一起提交？',
    neededAction: '回答这个提问',
    evidence: { questions: [{ id: 'q1', question: '要不要一起提交？', options: [{ label: '一起提交' }] }] },
    detectedAt: Date.now(),
    lastSeenAt: Date.now(),
    reminderCount: 1,
    relatedCallId: 'call_fail_1',
  } as any)

  const out = await harness.service.resolveBlocker(
    'blk_q_fail',
    'answer',
    '一起提交',
    'butler-chat',
  )
  assert.equal(out.ok, false, '不能假成功')
  assert.equal(out.reason, 'question_not_held')
  assert.match(String(out.message), /界面/, '要给可执行的下一步')

  const blocker = harness.service.store.getBlocker('blk_q_fail')!
  assert.equal(blocker.status, 'notified', '卡点不能被标成已处理（那正是旧的假成功）')
  assert.equal((blocker.evidence as any).needsUiAnswer, true, '卡点要标出「只能到界面回答」')
  assert.match(String(blocker.neededAction), /界面/)

  assert.ok(
    harness.service.store.listAudit().some((item) => item.action === 'answer_question_failed'),
    '失败要留审计',
  )
})

test('I-36 A：收到提问就落盘；重启后（waiter 丢失）快照里标「需到界面回答」', async () => {
  const { harness, cwd } = await boot()
  await withButler(harness, cwd)
  harness.addAgent('worker-q3', cwd)
  const agent = harness.agents.get('worker-q3')
  const callId = 'call_q_persist'

  // 模拟 worker 的 ask_user_question 落到插件 answerer
  void (harness.service as any).answerQuestion(
    agent,
    {
      wait: { callId },
      questions: [
        {
          id: 'q1',
          question: '后端 .gitignore 有已跟踪修改，要不要一起提交？',
          options: [{ label: '不提交' }, { label: '一起提交' }],
        },
      ],
    },
    () => 'next',
  )
  await waitFor(() => harness.service.store.listPendingQuestions().some((i) => i.callId === callId))

  const persisted = harness.service.store.listPendingQuestions().find((i) => i.callId === callId)!
  assert.ok(persisted, '提问要落盘')
  assert.equal(persisted.questions[0]!.id, 'q1')
  assert.deepEqual(
    persisted.questions[0]!.options!.map((option) => option.label),
    ['不提交', '一起提交'],
    '选项也要落盘，方便直接照着选',
  )

  // 模拟重启：先确认 waiter 已登记，再清零（进程内状态），落盘记录与卡点还在
  await waitFor(() => (harness.service as any).questionWaiters.has(callId))
  ;(harness.service as any).questionWaiters.clear()
  await harness.service.store.putBlocker({
    id: 'blk_q_persist',
    sessionId: 'worker-q3',
    kind: 'question',
    severity: 'warning',
    status: 'notified',
    signature: 'question:call_q_persist',
    summary: '要不要一起提交？',
    neededAction: '回答这个提问',
    evidence: { questions: [{ id: 'q1', question: '要不要一起提交？' }] },
    detectedAt: Date.now(),
    lastSeenAt: Date.now(),
    reminderCount: 1,
    relatedCallId: callId,
  } as any)

  // 重启后管家再答：必须明确失败并把卡点标成「到界面回答」
  harness.ctx.userQuestions.answer = async () => false
  const out = await harness.service.resolveBlocker('blk_q_persist', 'answer', '一起提交', 'butler-chat')
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'question_not_held')

  const marked = harness.service.store.getBlocker('blk_q_persist')!
  assert.equal((marked.evidence as any).needsUiAnswer, true)
  const snapshot = await harness.service.snapshot()
  const row = (snapshot.pendingQuestions ?? []).find((item) => item.callId === callId)
  assert.ok(row, '快照要能看到这条待答提问')
  assert.equal(row!.needsUiAnswer, true, '快照要标出「需到界面回答」')
  assert.deepEqual(
    row!.questions[0]!.options!.map((option) => option.label),
    ['不提交', '一起提交'],
  )
})

// ---------------------------------------------------------------- I-37 目标选择与必须开口

test('I-37：派发者不在线 → 改投当前活跃管家并留痕', async () => {
  const { harness, cwd } = await boot()
  const { butlerId, butler } = await withButler(harness, cwd)

  // 派发者是一个不存在的管家会话
  const delivery = await harness.service.injectButlerNotice(
    { text: '【SuperAgent 提醒】某个 worker 在等审批' },
    'session-dead-butler',
  )
  assert.equal(delivery.delivered, true, '要改投到在线管家，而不是塞进冷队列')
  assert.ok((butler.injected as any[]).length >= 1, '活跃管家要收到')

  const redirect = harness.service.store
    .listAudit()
    .find((item) => item.action === 'notify_redirect')
  assert.ok(redirect, '改投必须留痕')
  assert.match(String(redirect!.note), /session-dead-butler/)
  assert.match(String(redirect!.note), new RegExp(String(butlerId).slice(0, 12)))
})

test('I-37：唤醒目标也选在线管家（派发者离线时）', async () => {
  const { harness, cwd } = await boot()
  const { butlerId } = await withButler(harness, cwd)
  const decision = (harness.service as any).shouldWakeForBlocker(
    approvalBlocker('blk_target', 'worker-target'),
    {
      id: 'dsp_target',
      fromButlerSessionId: 'session-dead-butler',
      progress: { notified: [], woke: [] },
    },
  )
  assert.equal(decision.wake, true)
  assert.equal(decision.butlerId, butlerId, '要唤醒在线管家，而不是死会话')
})

test('I-37：唤醒后一句话不说 → 记 wake_silent；说了就不记', async () => {
  const { harness, cwd } = await boot()
  const { butlerId } = await withButler(harness, cwd)
  const service: any = harness.service

  // 情形 A：唤醒后直接 turn/end，没有助手消息
  service.wakeWatch.set(butlerId, { at: Date.now(), kind: 'approval', id: 'blk_x', spoke: false })
  harness.emit('session/event', { id: butlerId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await waitFor(() =>
    harness.service.store.listAudit().some((item) => item.action === 'wake_silent'),
  )
  assert.ok(
    harness.service.store.listAudit().some((item) => item.action === 'wake_silent'),
    '只查 inbox 不开口要被抓到',
  )

  // 情形 B：唤醒后先发了一条助手消息，再 turn/end
  const before = harness.service.store
    .listAudit()
    .filter((item) => item.action === 'wake_silent').length
  service.wakeWatch.set(butlerId, { at: Date.now(), kind: 'approval', id: 'blk_y', spoke: false })
  harness.emit(
    'session/event',
    { id: butlerId },
    {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'worker-a 在等审批，已放行' }] } },
    },
  )
  harness.emit('session/event', { id: butlerId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(
    harness.service.store.listAudit().filter((item) => item.action === 'wake_silent').length,
    before,
    '开了口就不该记缺陷',
  )
})

test('I-37：改投优先同 projectKey；没有再跨项目并标记；审计三要素可查', async () => {
  const { harness, cwd } = await boot()
  const { butlerId, butler } = await withButler(harness, cwd)
  const projectA = harness.service.ensureProjectForCwd(cwd).key
  await seedManagedSession(harness, butlerId, projectA, true)

  // 另一个在线管家，属于另一个工作区
  const second = harness.addAgent('butler-other', cwd, 'superagent-butler')
  await seedManagedSession(harness, 'butler-other', 'cwd_other_project', true)
  // 通知来源也在那个工作区
  await seedManagedSession(harness, 'worker-other', 'cwd_other_project')

  const notice = (text: string) =>
    ({
      text,
      source: {
        kind: 'superagent-notice' as const,
        form: 'notice' as const,
      summary: text,
      notice: {
        id: 'n1',
        at: Date.now(),
        kind: 'blocker',
        category: 'approval',
        severity: 'warning',
          sessionId: 'worker-other',
        },
      },
    })

  // ① 同项目优先：派发者不在线 → 应改投 butler-other（同工作区），而不是活跃管家
  await harness.service.injectButlerNotice(notice('【SuperAgent 提醒】同项目改投') as any, 'session-dead')
  assert.ok((second.injected as any[]).length >= 1, '同工作区的在线管家优先')
  assert.equal(
    (butler.injected as any[]).length,
    0,
    '有同工作区候选时不该跨项目投给活跃管家',
  )
  const firstAudit = harness.service.store
    .listAudit()
    .filter((item) => item.action === 'notify_redirect')
    .at(-1)!
  assert.equal(firstAudit.fromButlerId, 'session-dead', '审计要有原目标')
  assert.equal(firstAudit.toButlerId, 'butler-other', '审计要有最终目标')
  assert.equal(firstAudit.redirectReason, 'online-butler(same-project)')
  assert.equal(firstAudit.crossProject, false)

  // ② 没有同项目候选 → 跨项目改投给活跃管家，并标记 crossProject
  harness.agents.delete('butler-other')
  await harness.service.injectButlerNotice(notice('【SuperAgent 提醒】跨项目改投') as any, 'session-dead')
  assert.ok((butler.injected as any[]).length >= 1, '没有同项目候选时要退回活跃管家')
  const secondAudit = harness.service.store
    .listAudit()
    .filter((item) => item.action === 'notify_redirect')
    .at(-1)!
  assert.equal(secondAudit.toButlerId, butlerId)
  assert.equal(secondAudit.crossProject, true, '跨工作区必须标记出来')
  assert.match(String(secondAudit.note), /跨工作区/)
})

// ---------------------------------------------------------------- I-37 2A：开口监测落盘

test('I-37 2A：唤醒即落盘；观察到开口会更新；turn 结束未开口记 wake_silent', async () => {
  const { harness, cwd } = await boot()
  const { butlerId } = await withButler(harness, cwd)
  const service: any = harness.service

  // 唤醒 → 落盘（spoke=false）
  service.wakeWatch.set(butlerId, { at: Date.now(), kind: 'approval', id: 'blk_2a', spoke: false })
  await service.persistWakeWatch()
  await waitFor(() => harness.service.store.listWakeWatch().length === 1)
  const persisted = harness.service.store.listWakeWatch()[0]!
  assert.equal(persisted.butlerSessionId, butlerId)
  assert.equal(persisted.spoke, false, '唤醒时还没开口')
  assert.equal(persisted.blockerId, 'blk_2a')

  // 观察到助手文本 → 落盘更新为 spoke=true
  harness.emit(
    'session/event',
    { id: butlerId },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '已放行' }] } } },
  )
  await waitFor(() => harness.service.store.listWakeWatch()[0]?.spoke === true)
  assert.equal(harness.service.store.listWakeWatch()[0]!.spoke, true)

  // turn 结束（已开口）→ 清空且不记缺陷
  harness.emit('session/event', { id: butlerId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await waitFor(() => harness.service.store.listWakeWatch().length === 0)
  assert.equal(
    harness.service.store.listAudit().filter((item) => item.action === 'wake_silent').length,
    0,
  )

  // 再走一遍：唤醒后直接 turn/end（没开口）→ 记 wake_silent
  service.wakeWatch.set(butlerId, { at: Date.now(), kind: 'decision', id: 'blk_2b', spoke: false })
  await service.persistWakeWatch()
  harness.emit('session/event', { id: butlerId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await waitFor(() =>
    harness.service.store.listAudit().some((item) => item.action === 'wake_silent'),
  )
  assert.ok(
    harness.service.store.listAudit().some((item) => item.action === 'wake_silent'),
    '只查不说要被抓到',
  )
})

test('I-37 2A：进程重启后，未开口的记录会被补记（跨重启不漏账）', async () => {
  const { harness, cwd } = await boot()
  const { butlerId } = await withButler(harness, cwd)
  const service: any = harness.service

  // 模拟「唤醒后进程就重启了」：落盘里有记录，内存里没有
  await harness.service.store.saveWakeWatch([
    { butlerSessionId: butlerId, at: Date.now() - 60_000, kind: 'approval', blockerId: 'blk_restart', spoke: false },
  ])
  service.wakeWatch.clear()

  await service.reconcileWakeWatch()
  const audits = harness.service.store.listAudit().filter((item) => item.action === 'wake_silent')
  assert.equal(audits.length, 1, '重启后必须补记，不能漏')
  assert.match(String(audits[0]!.note), /进程重启补记/)
  assert.equal(audits[0]!.blockerId, 'blk_restart')
  assert.equal(harness.service.store.listWakeWatch().length, 0, '补记后要清掉落盘记录')
})

test('I-37 2A：对账幂等——审计已写、记录未清时重启不重复记；已开口的记录不记缺陷', async () => {
  const { harness, cwd } = await boot()
  const { butlerId } = await withButler(harness, cwd)
  const service: any = harness.service
  const at = Date.now() - 60_000

  // 情形 A：turn/end 的审计已经写成功、但清落盘记录之前进程就重启了
  await harness.service.store.appendAudit({
    sessionId: butlerId,
    kind: 'blocker',
    action: 'wake_silent',
    by: 'butler-auto',
    blockerId: 'blk_dup',
    at: at + 1,
    note: '唤醒后没有任何用户可见消息（approval / blk_dup）——违反「必须开口」',
  })
  // 情形 B：已经观察到开口（spoke:true），但没走完结算就重启了
  await harness.service.store.saveWakeWatch([
    { butlerSessionId: butlerId, at, kind: 'approval', blockerId: 'blk_dup', spoke: false },
    { butlerSessionId: butlerId, at, kind: 'decision', blockerId: 'blk_spoke', spoke: true },
  ])

  await service.reconcileWakeWatch()
  const audits = harness.service.store.listAudit().filter((item) => item.action === 'wake_silent')
  assert.equal(
    audits.filter((item) => item.blockerId === 'blk_dup').length,
    1,
    '同一条静默不能记两次（先审计后清记录，中间重启要幂等）',
  )
  assert.equal(
    audits.filter((item) => item.blockerId === 'blk_spoke').length,
    0,
    '已开口不应记缺陷',
  )
  assert.equal(harness.service.store.listWakeWatch().length, 0, '两条记录都应清掉')
})

test('I-37 2A：turn/end 先写审计、再清落盘记录（结算中途重启才补得回来）', async () => {
  const { harness, cwd } = await boot()
  const { butlerId } = await withButler(harness, cwd)
  const service: any = harness.service
  const store: any = harness.service.store

  service.wakeWatch.set(butlerId, { at: Date.now(), kind: 'approval', id: 'blk_order', spoke: false })
  await service.persistWakeWatch()

  // 在「写审计的那一瞬间」拍下盘上状态：顺序对的实现里，记录必须还在
  const seenAtAudit: any[] = []
  const original = store.appendAudit
  store.appendAudit = async (entry: any) => {
    if (entry?.action === 'wake_silent') seenAtAudit.push(...store.listWakeWatch())
    return original.call(store, entry)
  }

  try {
    harness.emit('session/event', { id: butlerId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await waitFor(() => store.listAudit().some((item: any) => item.action === 'wake_silent'))
  } finally {
    store.appendAudit = original
  }

  assert.equal(seenAtAudit.length, 1, '写审计时落盘记录必须仍存在（先清后写 = 两步之间重启就漏账）')
  assert.equal(seenAtAudit[0].blockerId, 'blk_order', '审计要能对上落盘记录，才可能做补记查重')
  await waitFor(() => store.listWakeWatch().length === 0)
  assert.equal(store.listWakeWatch().length, 0, '审计写完之后才清记录')
})
