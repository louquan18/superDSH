import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SourceRegistry } from '../../src/sources/registry.js'
import {
  DSH_CAPABILITIES,
  READ_ONLY_CAPABILITIES,
  SOURCE_KINDS,
  normalizeSourceKind,
  sourceOf,
  supports,
  withCapabilities,
  type SessionSource,
  type SourceSessionLite,
} from '../../src/sources/types.js'

function lite(sessionId: string, source: any = 'dsh'): SourceSessionLite {
  return {
    sessionId,
    source,
    title: sessionId,
    live: false,
    persisted: true,
    blank: false,
    running: false,
    agentAvailable: false,
    updatedAt: 1,
  }
}

function fakeSource(kind: any, items: SourceSessionLite[], options: any = {}): SessionSource {
  return {
    kind,
    capabilities: options.capabilities ?? DSH_CAPABILITIES,
    async list() {
      if (options.fail) throw new Error(`${kind} exploded`)
      return items
    },
    async observe() {
      return {}
    },
    async readEvents() {
      return []
    },
    async readDigest() {
      return undefined
    },
    async readUserMessages() {
      return []
    },
    async prompt() {
      return undefined
    },
    async create() {
      return 'session-new'
    },
    async rename() {},
    async cancel() {},
    newRequestId() {
      return 'req'
    },
    async findQueuedMessage() {
      return undefined
    },
    async removeQueued() {
      return false
    },
    async findDelivered() {
      return false
    },
  } as SessionSource
}

test('normalizeSourceKind: 文档别名 ducc 归一到 claude', () => {
  assert.equal(normalizeSourceKind('ducc'), 'claude')
  assert.equal(normalizeSourceKind('Claude-Code'), 'claude')
  assert.equal(normalizeSourceKind(' CLAUDE '), 'claude')
  assert.equal(normalizeSourceKind('dsh'), 'dsh')
  assert.equal(normalizeSourceKind('codex'), 'codex')
  assert.equal(normalizeSourceKind('remote'), 'remote')
})

test('normalizeSourceKind: 未知/空值返回 undefined', () => {
  for (const value of [undefined, null, '', '  ', 42, {}, 'cursor', 'ducc2']) {
    assert.equal(normalizeSourceKind(value), undefined, String(value))
  }
})

test('sourceOf: 缺字段一律按 dsh（旧记录不做迁移）', () => {
  assert.equal(sourceOf(undefined), 'dsh')
  assert.equal(sourceOf(null), 'dsh')
  assert.equal(sourceOf({}), 'dsh')
  assert.equal(sourceOf({ source: undefined }), 'dsh')
  assert.equal(sourceOf({ source: 'claude' }), 'claude')
  assert.equal(sourceOf({ source: 'ducc' }), 'claude')
  assert.equal(sourceOf({ source: 'nonsense' }), 'dsh')
})

test('能力表：dsh 全开，只读基线关掉所有写/审批/计划', () => {
  for (const key of Object.keys(DSH_CAPABILITIES) as Array<keyof typeof DSH_CAPABILITIES>) {
    assert.equal(DSH_CAPABILITIES[key], true, `dsh.${key}`)
  }
  for (const key of ['create', 'resume', 'queue', 'cancel', 'approvals', 'questions', 'plans', 'reassign', 'send'] as const) {
    assert.equal(READ_ONLY_CAPABILITIES[key], false, `readonly.${key}`)
  }
  for (const key of ['list', 'readEvents', 'readDigest'] as const) {
    assert.equal(READ_ONLY_CAPABILITIES[key], true, `readonly.${key}`)
  }
  assert.equal(READ_ONLY_CAPABILITIES.softStatusTool, false)
})

test('withCapabilities: 只覆盖指定能力位，其余保持基线', () => {
  const claudeLike = withCapabilities(READ_ONLY_CAPABILITIES, { subscribe: true, hardStatus: true })
  assert.equal(claudeLike.subscribe, true)
  assert.equal(claudeLike.hardStatus, true)
  assert.equal(claudeLike.send, false)
  assert.equal(claudeLike.list, true)
  // 原基线不被改写
  assert.equal(READ_ONLY_CAPABILITIES.subscribe, false)
})

test('registry: 注册/顺序/能力表', () => {
  const registry = new SourceRegistry()
  const dsh = fakeSource('dsh', [lite('session-a')])
  registry.register(dsh)
  assert.deepEqual(registry.kinds(), ['dsh'])
  assert.equal(registry.get('dsh'), dsh)
  assert.equal(registry.capabilitiesOf('dsh').send, true)
  // 未注册来源回落到 dsh 能力表
  assert.equal(registry.capabilitiesOf('claude').send, true)

  const claude = fakeSource('claude', [], { capabilities: READ_ONLY_CAPABILITIES })
  const off = registry.register(claude)
  assert.deepEqual(registry.kinds(), ['dsh', 'claude'])
  assert.equal(registry.capabilitiesOf('claude').send, false)
  off()
  assert.deepEqual(registry.kinds(), ['dsh'])
})

test('registry.list: 聚合多家来源、按固定顺序、自动补齐 source', async () => {
  const registry = new SourceRegistry()
  registry.register(fakeSource('dsh', [lite('session-1')]))
  registry.register(fakeSource('claude', [lite('claude-1', 'claude'), { ...lite('claude-2'), source: undefined as any }]))
  const items = await registry.list()
  assert.deepEqual(
    items.map((item) => [item.sessionId, item.source]),
    [
      ['session-1', 'dsh'],
      ['claude-1', 'claude'],
      ['claude-2', 'claude'],
    ],
  )
  // 只有 list 能力为真的来源才被拉取
  registry.register(fakeSource('codex', [lite('codex-1', 'codex')], {
    capabilities: withCapabilities(READ_ONLY_CAPABILITIES, { list: false }),
  }))
  assert.equal((await registry.list()).some((item) => item.source === 'codex'), false)
})

test('registry.list: 单个来源失败不影响其它来源', async () => {
  const registry = new SourceRegistry()
  const errors: string[] = []
  registry.register(fakeSource('dsh', [lite('session-1')]))
  registry.register(fakeSource('claude', [], { fail: true }))
  const items = await registry.list({ onError: (kind) => errors.push(kind) })
  assert.deepEqual(items.map((item) => item.sessionId), ['session-1'])
  assert.deepEqual(errors, ['claude'])
})

test('registry.ownerOf: 索引优先，其次 id 形状，最后兜底', async () => {
  const registry = new SourceRegistry()
  registry.register(fakeSource('dsh', [lite('session-1')]))
  registry.register(fakeSource('claude', [lite('claude-1', 'claude')], {
    capabilities: READ_ONLY_CAPABILITIES,
  }))
  await registry.list()
  assert.equal(registry.ownerOf('claude-1').kind, 'claude')
  assert.equal(registry.ownerOf('session-1').kind, 'dsh')
  // 没见过的 session-* 走 dsh（旧记录/刚创建的会话）
  assert.equal(registry.ownerOf('session-unknown').kind, 'dsh')
  // 完全未知的 id：兜底 dsh
  assert.equal(registry.ownerOf('whatever').kind, 'dsh')
  assert.equal(registry.canSend('claude-1'), false)
  assert.equal(registry.canSend('session-unknown'), true)
})

test('supports: 未注册/缺能力时一律 false', () => {
  assert.equal(supports(undefined, 'send'), false)
  const readOnly = fakeSource('claude', [], { capabilities: READ_ONLY_CAPABILITIES })
  assert.equal(supports(readOnly, 'send'), false)
  assert.equal(supports(readOnly, 'list'), true)
})

test('SOURCE_KINDS 固定顺序，dsh 在第一位', () => {
  assert.equal(SOURCE_KINDS[0], 'dsh')
  assert.deepEqual([...SOURCE_KINDS], ['dsh', 'claude', 'codex', 'remote'])
})

test('配置别名：sessionScanDays / maxFileBytes 归一成 scanDays / tailBytes', async () => {
  const { resolveConfig } = await import('../../src/config.js')
  const resolved = resolveConfig({
    sources: {
      claude: { enabled: true, sessionScanDays: 30, maxFileBytes: 8192 },
      codex: { enabled: true },
    },
  })
  assert.equal(resolved.sources.claude.enabled, true)
  assert.equal(resolved.sources.claude.scanDays, 30)
  assert.equal(resolved.sources.claude.tailBytes, 8192)
  // 未配置的来源保持默认关闭
  assert.equal(resolved.sources.codex.enabled, true)
  assert.equal(resolveConfig({}).sources.claude.enabled, false)
  assert.equal(resolveConfig({}).sources.claude.scanDays, 14)
  assert.equal(resolveConfig({}).sources.claude.tailBytes, 65536)
  assert.equal(resolveConfig({}).sources.codex.enabled, false)
})

test('isSafeRecordKey：只认 storage 的 per-record 键规则', async () => {
  const { isSafeRecordKey } = await import('../../src/store.js')
  for (const key of ['session-abc', 'abc_123', 'ABC-xyz_9', '383818a7-04ee-48bc']) {
    assert.equal(isSafeRecordKey(key), true, key)
  }
  // 冒号正是 2026-11-09 P0 的元凶（Claude 子会话 id 曾拼成 <root>:<agent>）
  for (const key of ['root:agent', 'a/b', 'a b', '', 'a.b', 'a\nb']) {
    assert.equal(isSafeRecordKey(key), false, JSON.stringify(key))
  }
})
