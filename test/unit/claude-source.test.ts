import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { ClaudeSource } from '../../src/sources/claude.js'
import { digestText } from '../../src/source.js'
import { parseLines, readTail, toMillis } from '../../src/sources/jsonl.js'
import type { SourceSessionLite } from '../../src/sources/types.js'

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop()!
    await chmod(dir, 0o755).catch(() => undefined)
    await rm(dir, { recursive: true, force: true })
  }
})

const CONFIG = {
  enabled: true,
  scanDays: 14,
  maxSessions: 100,
  tailBytes: 64 * 1024,
  includeSubagents: true,
  watch: false,
}

interface Fixture {
  root: string
  projects: string
  sessions: string
  source: ClaudeSource
  write(rel: string, lines: Array<any | string>): Promise<string>
  live(pid: number, payload: any): Promise<void>
}

async function fixture(overrides: Partial<typeof CONFIG> = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-fx-'))
  dirs.push(root)
  const projects = path.join(root, 'projects')
  const sessions = path.join(root, 'sessions')
  await mkdir(projects, { recursive: true })
  await mkdir(sessions, { recursive: true })
  const source = new ClaudeSource({
    config: { ...CONFIG, home: root, ...overrides } as any,
    projectsDir: projects,
  })
  return {
    root,
    projects,
    sessions,
    source,
    async write(rel, lines) {
      const file = path.join(root, rel)
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(
        file,
        lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n',
      )
      return file
    },
    async live(pid, payload) {
      // 真实文件名是 <pid>.json；测试里允许同一 pid 多条，用 sessionId 区分内容
      await writeFile(
        path.join(sessions, `${pid}-${payload.sessionId}.json`),
        JSON.stringify(payload),
      )
    },
  }
}

function userEvent(text: string, cwd: string, at = '2026-11-09T10:00:00.000Z') {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    uuid: `u-${Math.random().toString(36).slice(2)}`,
    timestamp: at,
    cwd,
    sessionId: 's',
  }
}

function assistantEvent(text: string, cwd: string, at = '2026-11-09T10:00:05.000Z') {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    timestamp: at,
    cwd,
    sessionId: 's',
  }
}

test('list: cwd 从事件读、标题取 ai-title、软状态来自 log digest', async () => {
  const fx = await fixture()
  await fx.write('projects/-Users-me-proj/aaaa-1111.jsonl', [
    userEvent('帮我把这个仓库整理一下', '/Users/me/proj'),
    assistantEvent('好的，我先看看目录结构', '/Users/me/proj'),
    { type: 'ai-title', aiTitle: '整理仓库结构' },
  ])
  await fx.write('history.jsonl', [
    { display: '帮我把这个仓库整理一下', sessionId: 'aaaa-1111', project: '/Users/me/proj' },
  ])
  const items = await fx.source.list()
  assert.equal(items.length, 1)
  const item = items[0]!
  assert.equal(item.sessionId, 'aaaa-1111')
  assert.equal(item.source, 'claude')
  assert.equal(item.cwd, '/Users/me/proj', 'cwd 必须来自事件而不是目录名反解')
  assert.equal(item.title, '整理仓库结构')
  assert.equal(item.hardStatus, 'idle')
  assert.equal(item.softStatus?.source, 'log-digest')
  assert.equal(item.softStatus?.goal, '帮我把这个仓库整理一下')
  assert.deepEqual(item.softStatus?.done, [], '只读来源不臆造 done')
  assert.deepEqual(item.softStatus?.next, [])
  assert.equal(item.parentSessionId, undefined)
})

test('list: 坏行与未知 type 被忽略，不影响其它事件', async () => {
  const fx = await fixture()
  await fx.write('projects/-p/sess-bad.jsonl', [
    '{"type":"user","message":{"content":"测试坏行"},"cwd":"/p","timestamp":"2026-11-09T10:00:00.000Z"}',
    '{ this is not json',
    '[]',
    '{"type":"mystery-future-event","payload":{"x":1}}',
    JSON.stringify(assistantEvent('收到', '/p')),
  ])
  const items = await fx.source.list()
  assert.equal(items.length, 1)
  assert.equal(items[0]!.cwd, '/p')
  assert.equal(items[0]!.hardStatus, 'idle')
})

test('readDigest 产出 dsh 形状事件，digestText 可直接用', async () => {
  const fx = await fixture()
  await fx.write('projects/-p/sess-digest.jsonl', [
    userEvent('重构 risk.ts', '/p'),
    assistantEvent('先读一遍', '/p'),
  ])
  await fx.source.list()
  const digest = await fx.source.readDigest('sess-digest')
  assert.ok(digest)
  const text = digestText(digest, 600)
  assert.match(text, /标题/)
  assert.match(text, /重构 risk\.ts/)
  assert.equal((await fx.source.readEvents('sess-digest')).length, 2)
  assert.deepEqual(await fx.source.readUserMessages('sess-digest', 5), ['重构 risk.ts'])
})

test('活进程表：shell/waiting 映射成 running/awaiting_approval，死 pid 回落到文件推断', async () => {
  const fx = await fixture()
  await fx.write('projects/-p/sess-live.jsonl', [userEvent('跑个测试', '/p'), assistantEvent('好', '/p')])
  await fx.write('projects/-p/sess-wait.jsonl', [userEvent('改配置', '/p')])
  await fx.write('projects/-p/sess-dead.jsonl', [userEvent('早就退出了', '/p'), assistantEvent('完成', '/p')])

  const me = process.pid // 自己一定活着
  await fx.live(me, { pid: me, sessionId: 'sess-live', status: 'shell', cwd: '/p', updatedAt: Date.now() })
  await fx.live(me, {
    pid: me,
    sessionId: 'sess-wait',
    status: 'waiting',
    waitingFor: 'permission prompt',
    cwd: '/p',
  })
  await fx.live(999_999, { pid: 999_999, sessionId: 'sess-dead', status: 'shell', cwd: '/p' })

  const byId = new Map((await fx.source.list()).map((item) => [item.sessionId, item]))
  assert.equal(byId.get('sess-live')?.hardStatus, 'running')
  assert.equal(byId.get('sess-live')?.running, true)
  assert.equal(byId.get('sess-wait')?.hardStatus, 'awaiting_approval')
  assert.equal(byId.get('sess-wait')?.softStatus?.blockers[0], '在 Claude Code 里等待你确认权限')
  // pid 不存在 → 不看活进程表，按尾部推断成 idle
  assert.equal(byId.get('sess-dead')?.hardStatus, 'idle')
})

test('子会话：<root>/subagents/agent-*.jsonl 标记 parentSessionId 与 origin=subagent', async () => {
  const fx = await fixture()
  await fx.write('projects/-p/root-1.jsonl', [userEvent('做主任务', '/p'), assistantEvent('开始', '/p')])
  await fx.write('projects/-p/root-1/subagents/agent-abc.jsonl', [userEvent('子任务', '/p')])
  await fx.write('projects/-p/root-1/subagents/agent-abc.meta.json', [
    { agentType: 'general-purpose', description: '/code-review high', name: 'code-review', spawnDepth: 1 },
  ])
  const items = await fx.source.list()
  const sub = items.find((item) => item.origin === 'subagent')
  assert.ok(sub, '子会话应被列出')
  assert.equal(sub!.parentSessionId, 'root-1')
  assert.match(sub!.sessionId, /^root-1-agent-abc/)
  // 必须是 storage 的合法 per-record key（冒号会让落库抛 path-safe 错误，2026-11-09 P0）
  assert.match(sub!.sessionId, /^[A-Za-z0-9_-]+$/)
  const root = items.find((item) => item.sessionId === 'root-1')
  assert.equal(root?.parentSessionId, undefined)
  // 关掉 includeSubagents 时只剩 root
  const rootOnly = new ClaudeSource({
    config: { ...CONFIG, home: fx.root, includeSubagents: false } as any,
    projectsDir: fx.projects,
  })
  assert.deepEqual((await rootOnly.list()).map((item) => item.sessionId), ['root-1'])
})

test('大文件只读尾部，行为和耗时都可控', async () => {
  const fx = await fixture()
  const filler: string[] = []
  for (let index = 0; index < 4000; index += 1) {
    filler.push(JSON.stringify({ type: 'attachment', index, blob: 'x'.repeat(400) }))
  }
  await fx.write('projects/-p/sess-big.jsonl', [
    userEvent('大文件的第一条（在尾部窗口之外）', '/p-deep'),
    ...filler,
    assistantEvent('结尾回复', '/p-deep'),
    { type: 'ai-title', aiTitle: '大文件标题' },
  ])
  const started = Date.now()
  const items = await fx.source.list()
  const elapsed = Date.now() - started
  assert.equal(items.length, 1)
  assert.equal(items[0]!.title, '大文件标题', '尾部能读到 ai-title')
  assert.equal(items[0]!.cwd, '/p-deep', '尾部事件带 cwd')
  assert.ok(elapsed < 2000, `大文件扫描应远快于全量读：${elapsed}ms`)
})

test('权限不足的文件被跳过，不拖垮整次扫描', async () => {
  const fx = await fixture()
  await fx.write('projects/-p/sess-ok.jsonl', [userEvent('正常会话', '/p'), assistantEvent('好', '/p')])
  const locked = await fx.write('projects/-p/sess-locked.jsonl', [userEvent('读不到', '/p')])
  await chmod(locked, 0o000)
  const items = await fx.source.list()
  assert.deepEqual(items.map((item) => item.sessionId), ['sess-ok'])
  await chmod(locked, 0o644)
})

test('scanDays 之外的旧文件不扫', async () => {
  const fx = await fixture({ scanDays: 1 })
  const old = await fx.write('projects/-p/sess-old.jsonl', [userEvent('旧的', '/p')])
  const fresh = await fx.write('projects/-p/sess-new.jsonl', [userEvent('新的', '/p')])
  const past = new Date(Date.now() - 10 * 24 * 60 * 60_000)
  await utimes(old, past, past)
  const ids = (await fx.source.list()).map((item) => item.sessionId)
  assert.deepEqual(ids, ['sess-new'])
  await utimes(fresh, new Date(), new Date())
})

test('capabilities：只读来源如实关闭写能力，调用写方法必须抛错', async () => {
  const fx = await fixture()
  assert.equal(fx.source.capabilities.list, true)
  assert.equal(fx.source.capabilities.readEvents, true)
  assert.equal(fx.source.capabilities.readDigest, true)
  assert.equal(fx.source.capabilities.hardStatus, true)
  for (const key of ['send', 'create', 'resume', 'queue', 'cancel', 'approvals', 'questions', 'plans', 'reassign', 'softStatusTool'] as const) {
    assert.equal(fx.source.capabilities[key], false, key)
  }
  await assert.rejects(() => fx.source.prompt(), /只读/)
  await assert.rejects(() => fx.source.create(), /只读/)
  assert.equal(await fx.source.findDelivered(), false)
  assert.equal(await fx.source.removeQueued(), false)
})

test('目录不存在时 list 返回空数组而不是抛错', async () => {
  const source = new ClaudeSource({
    config: { ...CONFIG, home: '/nonexistent-claude-home' } as any,
    projectsDir: '/nonexistent-claude-home/projects',
  })
  assert.deepEqual(await source.list(), [])
  assert.equal(await source.readDigest('nope'), undefined)
  assert.deepEqual(await source.readEvents('nope'), [])
})

test('jsonl 工具：尾部截断不产生半行、时间戳统一成毫秒', async () => {
  const fx = await fixture()
  const lines = Array.from({ length: 50 }, (_, index) => JSON.stringify({ index, pad: 'y'.repeat(100) }))
  const file = await fx.write('big.jsonl', lines)
  const tail = await readTail(file, 1024)
  assert.ok(tail)
  assert.equal(tail!.truncated, true)
  for (const line of tail!.lines) assert.doesNotThrow(() => JSON.parse(line))

  assert.equal(toMillis('2026-11-09T10:00:00.000Z'), Date.parse('2026-11-09T10:00:00.000Z'))
  assert.equal(toMillis(1_700_000_000), 1_700_000_000_000)
  assert.equal(toMillis(1_700_000_000_000), 1_700_000_000_000)
  assert.equal(toMillis('nonsense'), undefined)
  assert.deepEqual(parseLines(['{"a":1}', 'oops', '[]']), { values: [{ a: 1 }], bad: 1, skipped: 1 })
})

test('同一文件重复扫描走缓存（mtime/size 未变不重复解析）', async () => {
  const fx = await fixture()
  await fx.write('projects/-p/sess-c1.jsonl', [userEvent('缓存', '/p'), assistantEvent('好', '/p')])
  const first = await fx.source.list()
  const second = await fx.source.list()
  assert.deepEqual(
    first.map((item: SourceSessionLite) => [item.sessionId, item.updatedAt]),
    second.map((item) => [item.sessionId, item.updatedAt]),
  )
})
