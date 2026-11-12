import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { CodexSource, inferStatus, isSyntheticUserText } from '../../src/sources/codex.js'
import { digestText } from '../../src/source.js'

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true })
})

const CONFIG = {
  enabled: true,
  scanDays: 14,
  maxSessions: 100,
  tailBytes: 64 * 1024,
  includeSubagents: false,
  watch: false,
}

interface Fixture {
  root: string
  sessions: string
  source: CodexSource
  rollout(day: string, id: string, lines: any[], mtime?: Date): Promise<string>
  index(lines: any[]): Promise<void>
  turns(rows: Array<Partial<{ thread_id: string; status: string; started_at: number; completed_at: number; error_json: string }>>): Promise<void>
}

async function fixture(overrides: Partial<typeof CONFIG> = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-fx-'))
  dirs.push(root)
  const sessions = path.join(root, 'sessions')
  await mkdir(sessions, { recursive: true })
  const source = new CodexSource({
    config: { ...CONFIG, home: root, ...overrides } as any,
    sessionsDir: sessions,
    indexPath: path.join(root, 'session_index.jsonl'),
    stateDbPath: path.join(root, 'thread_history_1.sqlite'),
  })
  return {
    root,
    sessions,
    source,
    async rollout(day, id, lines, mtime) {
      const dir = path.join(sessions, day)
      await mkdir(dir, { recursive: true })
      const file = path.join(dir, `rollout-${day.replace(/\//g, '-')}T10-00-00-${id}.jsonl`)
      await writeFile(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
      if (mtime) await utimes(file, mtime, mtime)
      return file
    },
    async index(lines) {
      await writeFile(
        path.join(root, 'session_index.jsonl'),
        lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
      )
    },
    async turns(rows) {
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(path.join(root, 'thread_history_1.sqlite'))
      db.exec(`CREATE TABLE IF NOT EXISTS thread_turns (
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        rollout_ordinal INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        error_json TEXT,
        started_at INTEGER,
        completed_at INTEGER,
        duration_ms INTEGER
      )`)
      const insert = db.prepare(
        'INSERT INTO thread_turns (thread_id, turn_id, rollout_ordinal, status, error_json, started_at, completed_at) VALUES (?, ?, 0, ?, ?, ?, ?)',
      )
      for (const row of rows) {
        insert.run(
          String(row.thread_id),
          `${row.thread_id}-turn`,
          String(row.status),
          row.error_json ?? null,
          row.started_at ?? Math.floor(Date.now() / 1000),
          row.completed_at ?? null,
        )
      }
      db.close()
    },
  }
}

const nowIso = () => new Date().toISOString()

function userMsg(text: string) {
  return {
    timestamp: nowIso(),
    ordinal: 1,
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  }
}

function assistantMsg(text: string) {
  return {
    timestamp: nowIso(),
    ordinal: 2,
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  }
}

function devMsg(text: string) {
  return {
    timestamp: nowIso(),
    ordinal: 0,
    type: 'response_item',
    payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text }] },
  }
}

function meta(cwd: string) {
  return {
    timestamp: nowIso(),
    ordinal: 0,
    type: 'session_meta',
    payload: { session_id: 'ignored', cwd, cli_version: '0.151.0', source: 'cli', thread_source: 'user' },
  }
}

test('list: cwd 从 session_meta 读、标题为首条 user 消息、developer 指令不算对话', async () => {
  const fx = await fixture()
  const id = '01a07a8f-134f-7322-9a25-61be5e43759a'
  await fx.rollout('2026/11/09', id, [
    meta('/Users/me/proj'),
    devMsg('<skills_instructions>大量注入指令</skills_instructions>'),
    userMsg('帮我优化一下 prompt'),
    assistantMsg('好的'),
  ])
  const items = await fx.source.list()
  assert.equal(items.length, 1)
  const item = items[0]!
  assert.equal(item.sessionId, id)
  assert.equal(item.source, 'codex')
  assert.equal(item.cwd, '/Users/me/proj')
  assert.equal(item.title, '帮我优化一下 prompt')
  assert.equal(item.hardStatus, 'idle')
  assert.equal(item.softStatus?.source, 'log-digest')
  assert.deepEqual(item.softStatus?.done, [])
})

test('标题优先用 session_index.jsonl，缺失时退回首条 user 消息', async () => {
  const fx = await fixture()
  await fx.rollout('2026/11/09', '01a00000-0000-7000-8000-000000000001', [meta('/p'), userMsg('原始问题')])
  await fx.rollout('2026/11/09', '01a00000-0000-7000-8000-000000000002', [meta('/p'), userMsg('没有索引的会话')])
  await fx.index([{ id: '01a00000-0000-7000-8000-000000000001', thread_name: '索引里的标题', updated_at: nowIso() }])
  const byId = new Map((await fx.source.list()).map((item) => [item.sessionId, item]))
  assert.equal(byId.get('01a00000-0000-7000-8000-000000000001')?.title, '索引里的标题')
  assert.equal(byId.get('01a00000-0000-7000-8000-000000000002')?.title, '没有索引的会话')
})

test('状态：thread_turns 的 inProgress/interrupted/failed/completed 各自映射', async () => {
  const fx = await fixture()
  const mk = (suffix: string) => `01a00000-0000-7000-8000-00000000000${suffix}`
  for (const suffix of ['1', '2', '3', '4']) {
    await fx.rollout('2026/11/09', mk(suffix), [meta('/p'), userMsg(`会话 ${suffix}`), assistantMsg('好')])
  }
  await fx.turns([
    { thread_id: mk('1'), status: 'inProgress', started_at: Math.floor(Date.now() / 1000) },
    { thread_id: mk('2'), status: 'interrupted', started_at: 1, completed_at: 2 },
    { thread_id: mk('3'), status: 'failed', started_at: 1, completed_at: 2 },
    { thread_id: mk('4'), status: 'completed', started_at: 1, completed_at: 2 },
  ])
  const byId = new Map((await fx.source.list()).map((item) => [item.sessionId, item]))
  assert.equal(byId.get(mk('1'))?.hardStatus, 'running')
  assert.equal(byId.get(mk('1'))?.running, true)
  assert.equal(byId.get(mk('2'))?.hardStatus, 'interrupted')
  assert.equal(byId.get(mk('2'))?.softStatus?.blockers[0], 'Codex 回合被中断')
  assert.equal(byId.get(mk('3'))?.hardStatus, 'error')
  assert.equal(byId.get(mk('4'))?.hardStatus, 'idle')
})

test('WAL 滞后兜底：inProgress 但文件 20 分钟没动 → unknown，不假装在跑', async () => {
  const fx = await fixture()
  const id = '01a00000-0000-7000-8000-000000000010'
  const old = new Date(Date.now() - 20 * 60_000)
  const oldIso = old.toISOString()
  const staleMeta = { ...meta('/p'), timestamp: oldIso }
  const staleUser = { ...userMsg('卡住了'), timestamp: oldIso }
  await fx.rollout('2026/11/09', id, [staleMeta, staleUser], old)
  await fx.turns([{ thread_id: id, status: 'inProgress', started_at: Math.floor(old.getTime() / 1000) }])
  const item = (await fx.source.list())[0]!
  assert.equal(item.hardStatus, 'unknown')
  assert.equal(item.running, false)
})

test('没有 sqlite 时用 rollout 尾部推断：task_started 未闭合 = running，turn_aborted = interrupted', async () => {
  const fx = await fixture()
  const runningId = '01a00000-0000-7000-8000-000000000020'
  const abortedId = '01a00000-0000-7000-8000-000000000021'
  await fx.rollout('2026/11/09', runningId, [
    meta('/p'),
    userMsg('跑起来'),
    { timestamp: nowIso(), ordinal: 3, type: 'event_msg', payload: { type: 'task_started' } },
  ])
  await fx.rollout('2026/11/09', abortedId, [
    meta('/p'),
    userMsg('会被中断'),
    { timestamp: nowIso(), ordinal: 3, type: 'event_msg', payload: { type: 'turn_aborted', reason: 'user interrupt' } },
  ])
  const byId = new Map((await fx.source.list()).map((item) => [item.sessionId, item]))
  assert.equal(byId.get(runningId)?.hardStatus, 'running')
  assert.equal(byId.get(abortedId)?.hardStatus, 'interrupted')
})

test('坏行与未知 type 不影响解析', async () => {
  const fx = await fixture()
  const dir = path.join(fx.sessions, '2026/11/09')
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, 'rollout-2026-11-09T10-00-00-01a00000-0000-7000-8000-000000000030.jsonl')
  await writeFile(
    file,
    [
      JSON.stringify(meta('/p')),
      '{ broken json',
      '[]',
      JSON.stringify({ type: 'mystery', payload: {} }),
      JSON.stringify(userMsg('还能读吗')),
      JSON.stringify(assistantMsg('能')),
    ].join('\n') + '\n',
  )
  const items = await fx.source.list()
  assert.equal(items.length, 1)
  assert.equal(items[0]!.cwd, '/p')
  assert.equal(items[0]!.hardStatus, 'idle')
})

test('scanDays 与 maxSessions 生效', async () => {
  const fx = await fixture({ scanDays: 1 })
  const old = new Date(Date.now() - 10 * 24 * 60 * 60_000)
  await fx.rollout('2026/10/01', '01a00000-0000-7000-8000-000000000040', [meta('/p'), userMsg('旧')], old)
  await fx.rollout('2026/11/09', '01a00000-0000-7000-8000-000000000041', [meta('/p'), userMsg('新')])
  const ids = (await fx.source.list()).map((item) => item.sessionId)
  assert.deepEqual(ids, ['01a00000-0000-7000-8000-000000000041'])
})

test('readDigest/readEvents/readUserMessages 产出 dsh 形状，digestText 可用', async () => {
  const fx = await fixture()
  const id = '01a00000-0000-7000-8000-000000000050'
  await fx.rollout('2026/11/09', id, [meta('/p'), userMsg('把测试跑一遍'), assistantMsg('好的')])
  await fx.source.list()
  const digest = await fx.source.readDigest(id)
  assert.ok(digest)
  assert.match(digestText(digest, 600), /把测试跑一遍/)
  assert.equal((await fx.source.readEvents(id)).length, 2)
  assert.deepEqual(await fx.source.readUserMessages(id, 5), ['把测试跑一遍'])
})

test('Codex 没有 root/子会话标记：一律按 root 列出（已知限制）', async () => {
  const fx = await fixture()
  await fx.rollout('2026/11/09', '01a00000-0000-7000-8000-000000000060', [meta('/p'), userMsg('a')])
  await fx.rollout('2026/11/09', '01a00000-0000-7000-8000-000000000061', [meta('/p'), userMsg('b')])
  const items = await fx.source.list()
  assert.equal(items.length, 2)
  for (const item of items) assert.equal(item.parentSessionId, undefined)
})

test('capabilities：只读，写方法抛错', async () => {
  const fx = await fixture()
  for (const key of ['send', 'create', 'resume', 'queue', 'cancel', 'approvals', 'questions', 'plans', 'reassign', 'softStatusTool'] as const) {
    assert.equal(fx.source.capabilities[key], false, key)
  }
  assert.equal(fx.source.capabilities.list, true)
  assert.equal(fx.source.capabilities.hardStatus, true)
  await assert.rejects(() => fx.source.prompt(), /只读/)
  await assert.rejects(() => fx.source.create(), /只读/)
})

test('目录/索引/db 都不存在时返回空，不抛错', async () => {
  const source = new CodexSource({
    config: { ...CONFIG, home: '/nonexistent-codex' } as any,
    sessionsDir: '/nonexistent-codex/sessions',
    indexPath: '/nonexistent-codex/session_index.jsonl',
    stateDbPath: '/nonexistent-codex/thread_history_1.sqlite',
  })
  assert.deepEqual(await source.list(), [])
  assert.equal(await source.readDigest('nope'), undefined)
})

test('inferStatus 纯函数边界：completed 有 completed_at 优先于 inProgress 残留', () => {
  const meta: any = { updatedAt: Date.now(), lastKind: 'assistant' }
  assert.deepEqual(inferStatus({ meta, turn: { status: 'inProgress', completedAt: 1 }, now: Date.now() }), {
    hardStatus: 'idle',
    running: false,
  })
  assert.equal(inferStatus({ meta, turn: { status: 'unknown-state' }, now: Date.now() }).hardStatus, 'idle')
})

test('合成注入消息：识别 environment_context 之类，不误伤普通文本/HTML', () => {
  assert.equal(isSyntheticUserText('<environment_context>\n  <cwd>/p</cwd>\n</environment_context>'), true)
  assert.equal(isSyntheticUserText('<user_instructions>按这个来</user_instructions>'), true)
  assert.equal(isSyntheticUserText('</skills_instructions>'), true)
  assert.equal(isSyntheticUserText('帮我看看 <environment_context> 这个标签'), false)
  assert.equal(isSyntheticUserText('<div class="x">普通 HTML</div>'), false)
  assert.equal(isSyntheticUserText('普通的中文消息'), false)
  assert.equal(isSyntheticUserText(''), false)
})

test('标题与对话都跳过合成消息，用 history.jsonl 的真实首条 prompt 兜底', async () => {
  const fx = await fixture()
  const id = '01a00000-0000-7000-8000-000000000070'
  await fx.rollout('2026/11/09', id, [
    meta('/p'),
    {
      timestamp: nowIso(),
      ordinal: 1,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<environment_context>\n<cwd>/p</cwd>\n</environment_context>' }],
      },
    },
    userMsg('真正的问题：优化 prompt'),
    assistantMsg('好的'),
  ])
  await writeFile(
    path.join(fx.root, 'history.jsonl'),
    JSON.stringify({ session_id: id, ts: Math.floor(Date.now() / 1000), text: '历史里的首条真实提问' }) + '\n',
  )
  const item = (await fx.source.list())[0]!
  assert.equal(item.title, '历史里的首条真实提问')
  assert.equal(item.softStatus?.goal, '历史里的首条真实提问')
  const digest = await fx.source.readDigest(id)
  const texts = (digest?.events ?? []).map((event: any) => JSON.stringify(event))
  assert.equal(texts.some((text: string) => text.includes('environment_context')), false, '合成消息不能进对话')
})
