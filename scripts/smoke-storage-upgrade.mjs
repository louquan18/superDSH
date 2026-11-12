#!/usr/bin/env node
/**
 * 存储升级冒烟（P2 防回归）：v1 数据必须能被 v2 规格完整读出来。
 *
 * 为什么必须有这个脚本：
 * `dsh-storage-json` 的 per-record 布局下，**每条记录自己带一个版本戳**；版本戳不在
 * 接受集合（`[spec.version, ...spec.compatibleVersions]`）内的记录会被**读作不存在**
 * ——不是迁移，是静默消失。也就是说 `STORAGE_SPEC.version` 从 1 改到 2 而忘了写
 * `compatibleVersions: [1]`，用户会看到「所有会话、卡点、审计都没了」，而单测全绿。
 *
 * 做法：把**真实存储目录的一份副本**放进隔离 home，用当前代码冷启动，然后对着
 * `/api/superagent/action {"action":"diagnostics"}` 的 counts 逐表核对。
 *
 * 用法：node scripts/smoke-storage-upgrade.mjs
 * 环境：需要 `dsh` 在 PATH、能读 ~/.dsh/profiles/web 与 ~/.dsh/storages/superagent。
 *       缺依赖或没有历史数据时 SKIP（退出码 0）。
 */
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const HOST_PROFILE = path.join(os.homedir(), '.dsh', 'profiles', 'web')
const LIVE_STORAGE = path.join(os.homedir(), '.dsh', 'storages', 'superagent')

function skip(reason) {
  console.log(`SKIP storage-upgrade smoke: ${reason}`)
  process.exit(0)
}

if (!existsSync(HOST_PROFILE)) skip(`no host profile at ${HOST_PROFILE}`)
if (!existsSync(LIVE_STORAGE)) skip(`no live storage at ${LIVE_STORAGE}`)

const TABLES = ['projects', 'sessions', 'dispatches', 'plans', 'blockers', 'approvals', 'audit', 'threads']

async function countRecords(dir) {
  try {
    const items = await readdir(dir)
    return items.filter((name) => name.endsWith('.json')).length
  } catch {
    return 0
  }
}

const tmp = await mkdtemp(path.join(os.tmpdir(), 'sab-upgrade-'))
const home = path.join(tmp, 'home')
const profile = path.join(home, 'profiles', 'web')
const port = 3581 + Math.floor(Math.random() * 200)
let child

async function main() {
  // 1) 复制 store 数据（**只读用户的，拷一份出来**）
  const seeded = {}
  const target = path.join(home, 'storages', 'superagent')
  await mkdir(path.join(home, 'storages'), { recursive: true })
  await cp(LIVE_STORAGE, target, { recursive: true, dereference: false })
  for (const table of TABLES) seeded[table] = await countRecords(path.join(target, table))

  const total = TABLES.reduce((sum, table) => sum + seeded[table], 0)
  if (total < 20) skip(`live storage too small to be meaningful (${total} records)`)

  // 2) 隔离 profile + 链接本插件
  await mkdir(path.join(home, 'profiles'), { recursive: true })
  await cp(HOST_PROFILE, profile, { recursive: true, dereference: false })
  await rm(path.join(profile, 'node_modules'), { recursive: true, force: true })
  await rm(path.join(profile, '.plugin-manager'), { recursive: true, force: true })
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
  // 来宾源保持关闭：这个冒烟只关心里数据，不需要外部扫描
  await writeFile(
    path.join(profile, 'cordis.patch.yml'),
    `- id: superagent-butler
  name: "@local/dsh-superagent-butler"
  config:
    butler:
      title: SuperAgent 管家
`,
  )

  // 3) 冷启动真实服务
  const log = []
  child = spawn(process.env.DSH_BIN ?? 'dsh', ['--profile', 'web', '--port', String(port), '--no-open'], {
    cwd: tmp,
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => log.push(String(chunk)))
  child.stderr.on('data', (chunk) => log.push(String(chunk)))

  const token = await waitForToken(log, 90_000)
  if (!token) {
    console.error('storage upgrade smoke failed: no token within 90s')
    console.error(log.join(''))
    process.exit(1)
  }

  // 4) 逐表核对
  const diagnostics = await callAction(port, token, 'diagnostics')
  if (!diagnostics?.counts) {
    console.error('storage upgrade smoke failed: diagnostics 不可用')
    console.error(log.join('').slice(-3000))
    process.exit(1)
  }

  const problems = []
  const rows = []
  for (const table of TABLES) {
    const before = seeded[table] ?? 0
    const after = diagnostics.counts[table] ?? 0
    rows.push(`${table}: ${before} → ${after}`)
    // audit 会因为启动写审计而增长；其它表不该变少，也不该凭空多出来
    if (table === 'audit') {
      if (after < before) problems.push(`audit 变少了：${before} → ${after}`)
      continue
    }
    if (table === 'threads') {
      if (before === 0 && after !== 0) problems.push(`threads 本应为新建空表，实际 ${after}`)
      continue
    }
    if (after < before) problems.push(`${table} 变少了：${before} → ${after}（老记录被读作不存在？）`)
  }
  // 最关键的断言：会话不能一条都不剩
  if ((diagnostics.counts.sessions ?? 0) === 0 && (seeded.sessions ?? 0) > 0) {
    problems.push('sessions 全丢 —— compatibleVersions 没写对')
  }

  if (problems.length > 0) {
    console.error('storage upgrade smoke FAILED:')
    for (const row of rows) console.error('  ' + row)
    for (const problem of problems) console.error('  ✗ ' + problem)
    console.error(log.join('').slice(-3000))
    process.exit(1)
  }

  console.log('storage upgrade ok（v1 → v2，老数据完整）:')
  for (const row of rows) console.log('  ' + row)
}

async function waitForToken(log, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const match = /token=([A-Za-z0-9_-]+)/.exec(log.join(''))
    if (match) return match[1]
    if (child?.exitCode != null) return null
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return null
}

async function callAction(port, token, action) {
  const base = `http://127.0.0.1:${port}`
  const page = await fetch(`${base}/?token=${token}`, { redirect: 'manual' })
  const cookie = (page.headers.getSetCookie?.() ?? []).map((item) => item.split(';')[0]).join('; ')
  const response = await fetch(`${base}/api/superagent/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ action }),
  })
  if (!response.ok) {
    console.error(`action ${action} HTTP ${response.status}`)
    return null
  }
  const body = await response.json()
  return body?.value ?? body
}

main()
  .catch((error) => {
    console.error('storage upgrade smoke crashed:', error)
    process.exitCode = 1
  })
  .finally(async () => {
    if (child && child.exitCode == null) child.kill('SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 300))
    if (child && child.exitCode == null) child.kill('SIGKILL')
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })
