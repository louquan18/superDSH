#!/usr/bin/env node
/**
 * 冷启动冒烟（防回归）：真实 `dsh web` 进程 + 两个来宾来源都 enabled。
 *
 * 2026-11-09 的 P0：`sources.claude.enabled=true` 时，Claude 子会话 id 里带了冒号，
 * 落到 storage 的 per-record key 上被判「not path-safe」，`create()` 抛错 →
 * `provide('superagent')` 不执行 → 管家 preset 挂不上 → 管家会话全部失去工具。
 * 单元测试全绿也测不出来，只有真正启动一次才看得到。
 *
 * 本脚本断言：
 * 1. 启动日志里**没有** "did not activate" / 插件激活错误；
 * 2. `/api/superagent/state` 返回 200（插件真的加载并提供了服务）；
 * 3. `snapshot.sources` 里 claude / codex 都是 available=true；
 * 4. fixture 里的子会话（id 含分隔符）没有把任何东西弄挂。
 *
 * 用法：node scripts/smoke-cold-start.mjs
 * 环境：需要 `dsh` 在 PATH 上、能读 ~/.dsh/profiles/web。缺依赖时 SKIP（退出码 0）。
 */
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const HOST_PROFILE = path.join(os.homedir(), '.dsh', 'profiles', 'web')

function skip(reason) {
  console.log(`SKIP cold-start smoke: ${reason}`)
  process.exit(0)
}

if (!existsSync(HOST_PROFILE)) skip(`no host profile at ${HOST_PROFILE}`)

const dshBin = process.env.DSH_BIN ?? 'dsh'
const tmp = await mkdtemp(path.join(os.tmpdir(), 'sab-cold-'))
const home = path.join(tmp, 'home')
const profile = path.join(home, 'profiles', 'web')
const port = 3381 + Math.floor(Math.random() * 200)
let child

async function main() {
  // 1) 拷贝一份 profile（只读用户的，不改它）
  await mkdir(path.join(home, 'profiles'), { recursive: true })
  await cp(HOST_PROFILE, profile, { recursive: true, dereference: false })
  await rm(path.join(profile, 'node_modules'), { recursive: true, force: true })
  await rm(path.join(profile, '.plugin-manager'), { recursive: true, force: true })

  // 2) 链接本插件 + 声明 bundle
  const pkgPath = path.join(profile, 'package.json')
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
  pkg.dependencies = { '@local/dsh-superagent-butler': `link:${ROOT}` }
  pkg.dsh = pkg.dsh ?? {}
  pkg.dsh.profile = pkg.dsh.profile ?? {}
  pkg.dsh.profile.bundles = [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    '@local/dsh-superagent-butler',
  ]
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2))
  const modules = path.join(profile, 'node_modules', '@local')
  await mkdir(modules, { recursive: true })
  await rm(path.join(modules, 'dsh-superagent-butler'), { force: true })
  await cp(ROOT, path.join(modules, 'dsh-superagent-butler'), { recursive: true, dereference: true })

  // 3) fixture：claude 带子会话（回归点）+ codex rollout
  const claudeHome = path.join(tmp, 'claude')
  const projectDir = path.join(claudeHome, 'projects', '-tmp-cold')
  await mkdir(path.join(projectDir, 'root-uuid', 'subagents'), { recursive: true })
  await mkdir(path.join(claudeHome, 'sessions'), { recursive: true })
  const iso = new Date().toISOString()
  await writeFile(
    path.join(projectDir, 'root-uuid.jsonl'),
    [
      { type: 'user', message: { role: 'user', content: '冷启动根会话' }, timestamp: iso, cwd: '/tmp/cold' },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] }, timestamp: iso, cwd: '/tmp/cold' },
      { type: 'ai-title', aiTitle: '冷启动根会话' },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n',
  )
  await writeFile(
    path.join(projectDir, 'root-uuid', 'subagents', 'agent-abc.jsonl'),
    JSON.stringify({ type: 'user', message: { role: 'user', content: '子会话' }, timestamp: iso, cwd: '/tmp/cold' }) + '\n',
  )
  await writeFile(
    path.join(projectDir, 'root-uuid', 'subagents', 'agent-abc.meta.json'),
    JSON.stringify({ agentType: 'general-purpose', description: '子会话', spawnDepth: 1 }) + '\n',
  )

  const codexHome = path.join(tmp, 'codex')
  const codexDay = path.join(codexHome, 'sessions', '2026', '11', '09')
  await mkdir(codexDay, { recursive: true })
  await writeFile(
    path.join(codexDay, 'rollout-2026-11-09T10-00-00-01a00000-0000-7000-8000-000000000099.jsonl'),
    [
      { timestamp: iso, ordinal: 0, type: 'session_meta', payload: { session_id: '01a00000-0000-7000-8000-000000000099', cwd: '/tmp/cold' } },
      { timestamp: iso, ordinal: 1, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '冷启动 codex 会话' }] } },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n',
  )

  // 4) 用户补丁层：两个来宾源都打开
  await writeFile(
    path.join(profile, 'cordis.patch.yml'),
    `- id: superagent-butler
  name: "@local/dsh-superagent-butler"
  config:
    butler:
      title: SuperAgent 管家
    sources:
      claude:
        enabled: true
        home: ${claudeHome}
      codex:
        enabled: true
        home: ${codexHome}
`,
  )

  // 5) 冷启动真实服务
  const log = []
  child = spawn(dshBin, ['--profile', 'web', '--port', String(port), '--no-open'], {
    cwd: tmp,
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => log.push(String(chunk)))
  child.stderr.on('data', (chunk) => log.push(String(chunk)))

  const token = await waitForToken(log, 90_000)
  if (!token) {
    console.error('cold start failed: no "dsh web:" line in log within 90s')
    console.error(log.join(''))
    process.exit(1)
  }

  const text = log.join('')
  const problems = []
  if (/did not activate/i.test(text)) problems.push('启动日志出现 "did not activate"（插件没加载）')
  if (/superagent-butler.*Error:/.test(text)) problems.push(`插件激活报错：${text.match(/superagent-butler.*Error:[^\n]*/)?.[0]}`)

  // 6) 服务真的可用 + 两个来源都健康
  const state = await fetchState(port, token)
  if (!state) problems.push('/api/superagent/state 不可用（服务没提供）')
  const sources = state?.sources ?? []
  for (const kind of ['claude', 'codex']) {
    const health = sources.find((item) => item.kind === kind)
    if (!health) problems.push(`snapshot.sources 缺少 ${kind}`)
    else if (health.available !== true) problems.push(`${kind} 不可用：${health.error ?? 'unknown'}`)
  }
  // 6.5) P0 版本戳：真实进程的 /state 必须带上代码版本与配置指纹
  //      （脱离 git 时允许降级成 pkg@x.y.z+unknown，但不能为空）
  const version = state?.version
  if (!version) problems.push('snapshot 缺少 version（P0 版本戳没生效）')
  else {
    if (!String(version.codeVersion ?? '').trim()) problems.push('version.codeVersion 为空')
    if (!/^[0-9a-f]{12}$/.test(String(version.configHash ?? ''))) {
      problems.push(`version.configHash 不是 12 位 hex：${version.configHash}`)
    }
  }

  const claudeSessions = (state?.sessions ?? []).filter((item) => item.source === 'claude')
  if (claudeSessions.length < 2) {
    problems.push(`claude 会话没扫到（含子会话应为 2 条，实际 ${claudeSessions.length}）`)
  }
  // 回归点：外部来源的 sessionId 必须是 storage 的合法 per-record key，
  // 否则会被静默跳过持久化（不再崩插件，但也不该发生）。
  const unsafe = claudeSessions.filter((item) => !/^[A-Za-z0-9_-]+$/.test(String(item.sessionId)))
  if (unsafe.length > 0) {
    problems.push(`claude 会话 id 不是 path-safe：${unsafe.map((item) => item.sessionId).join(', ')}`)
  }
  if (/skip persisting session/.test(text)) {
    problems.push('有会话因 key 非法被跳过持久化（说明来源 id 仍不合规）')
  }

  if (problems.length > 0) {
    console.error('FAILED cold-start smoke:\n- ' + problems.join('\n- '))
    console.error('\n--- log ---\n' + text.slice(0, 4000))
    process.exit(1)
  }
  console.log(
    `cold start ok: plugin loaded, sources healthy (claude ${claudeSessions.length} sessions), no activation error`,
  )
}

async function waitForToken(log, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const text = log.join('')
    const match = /token=([A-Za-z0-9_-]+)/.exec(text)
    if (match) return match[1]
    if (child?.exitCode != null) return null
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return null
}

async function fetchState(port, token) {
  try {
    const base = `http://127.0.0.1:${port}`
    // 用 token 打开首页拿会话 cookie，再用它访问 API（和浏览器行为一致）
    const page = await fetch(`${base}/?token=${token}`, { redirect: 'manual' })
    const cookie = (page.headers.getSetCookie?.() ?? [])
      .map((item) => item.split(';')[0])
      .join('; ')
    const response = await fetch(`${base}/api/superagent/state`, {
      headers: cookie ? { cookie } : {},
    })
    if (!response.ok) {
      console.error(`state HTTP ${response.status}`)
      return null
    }
    return await response.json()
  } catch (error) {
    console.error('state fetch failed:', error)
    return null
  }
}

try {
  await main()
} finally {
  if (child) {
    try {
      child.kill('SIGTERM')
    } catch {
      // ignore
    }
  }
  await rm(tmp, { recursive: true, force: true })
}
