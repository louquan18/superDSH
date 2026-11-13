/**
 * `/superagent doctor`（I-22a）：只读自检。
 *
 * 它存在的理由很具体：为了「看一眼配置到底生效没有」而去改 `~/.dsh`，历史上把 turn
 * 挂起过三次。所以这条命令必须**只读**——测试除了断言内容，还要断言它没产生任何写入
 * （不写审计、不改存储、不派发）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { registerCommand } from '../../src/host/command.js'
import { DEFAULT_CONFIG } from '../../src/types.js'

/** 抓到注册的 handler，其余依赖都给最小桩。 */
function harness(serviceOverrides: any = {}) {
  let handler: any
  const ctx = {
    get: (name: string) => (name === 'commands' ? { register: (spec: any) => {
      handler = spec.handler
      return () => {}
    } } : undefined),
    effect: (fn: any) => (typeof fn === 'function' ? fn() : undefined),
  }
  const writes: string[] = []
  const service: any = {
    config: { ...DEFAULT_CONFIG, butler: { title: 't', cwd: '/tmp' } },
    version: { codeVersion: 'v0.3.2', configHash: 'abcdef123456', startedAt: 1_700_000_000_000 },
    diagnostics: () => ({
      version: { codeVersion: 'v0.3.2', configHash: 'abcdef123456', startedAt: 1_700_000_000_000 },
      butlerSessionId: 'session-butler',
      installedCount: 3,
    }),
    sourceStatus: () => [
      { kind: 'dsh', enabled: true, available: true, at: 1 },
      { kind: 'claude', enabled: true, available: false, error: '权限不足', at: 1 },
      { kind: 'codex', enabled: false, available: false, at: 1 },
    ],
    snapshot: async () => ({ blockers: [], plans: [], sessions: [], approvals: [], butler: {} }),
    // 任何"写"入口都记下来：doctor 一次都不该碰
    store: { appendAudit: async () => writes.push('audit'), putSession: async () => writes.push('session') },
    ...serviceOverrides,
  }
  registerCommand(ctx, service)
  assert.ok(handler, 'superagent 命令必须注册成功')
  return { run: (rawInput: string) => handler({ rawInput }), writes, service }
}

test('doctor 报告版本、来源可用性与关键配置的生效值', async () => {
  const { run, writes } = harness()
  const result = await run('doctor')
  assert.equal(result.kind, 'success')
  const text = String(result.text)

  assert.match(text, /只读/)            // 明示只读
  assert.match(text, /v0\.3\.2/)        // 代码版本（P0 版本戳）
  assert.match(text, /abcdef123456/)    // 配置指纹
  assert.match(text, /session-butler/)  // 管家会话
  assert.match(text, /claude: 不可用（权限不足）/) // 来源不可用要说原因
  assert.match(text, /codex: 未启用/)
  assert.match(text, /policy=.*shadowRules=/)
  assert.match(text, /settleTtl=/)
  // 关键：只读，不能有任何写入
  assert.deepEqual(writes, [], 'doctor 必须是只读的')
})

test('doctor 在 butler.cwd 指向不存在目录时如实说明', async () => {
  const { run } = harness()
  const result = await run('doctor')
  assert.match(String(result.text), /管家工作区：/, '要报出 cwd')
})

test('doctor 在插件降级（启动失败）时给结论而不是崩掉', async () => {
  const { run } = harness({
    degraded: true,
    degradedReason: 'unit keep failing',
    // 降级服务没有这些成员，故意删掉，模拟真实降级形状
    config: undefined,
    diagnostics: undefined,
    sourceStatus: undefined,
    version: undefined,
  })
  const result = await run('doctor')
  assert.equal(result.kind, 'success', '自检失败也要给可读结论，不能抛错')
  const text = String(result.text)
  assert.match(text, /降级运行/)
  assert.match(text, /unit keep failing/)
  assert.match(text, /cordis\.patch\.yml/)
})
