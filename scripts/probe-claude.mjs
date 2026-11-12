#!/usr/bin/env node
/**
 * 真实机器冒烟：用 lib/ 里编译后的 ClaudeSource 扫本机 ~/.claude，
 * 报告会话数、耗时、状态分布、标题/cwd 命中率，以及第二次扫描（缓存）耗时。
 *
 * 只读：不会写 ~/.claude，也不会读 sessions/*.key。
 * 用法：node scripts/probe-claude.mjs [scanDays]
 */
import { ClaudeSource } from '../lib/sources/claude.js'

const scanDays = Number(process.argv[2] ?? 14)
const config = {
  enabled: true,
  scanDays,
  maxSessions: 500,
  tailBytes: 65536,
  includeSubagents: true,
  watch: false,
}

const source = new ClaudeSource({ config })

const t0 = Date.now()
const items = await source.list()
const first = Date.now() - t0

const t1 = Date.now()
const again = await source.list()
const second = Date.now() - t1

const bySource = new Map()
const byStatus = new Map()
let withTitle = 0
let withCwd = 0
let subagents = 0
let digestFailures = 0

for (const item of items) {
  byStatus.set(item.hardStatus, (byStatus.get(item.hardStatus) ?? 0) + 1)
  bySource.set(item.source, (bySource.get(item.source) ?? 0) + 1)
  if (item.title && !item.title.startsWith('Claude ')) withTitle += 1
  if (item.cwd) withCwd += 1
  if (item.parentSessionId) subagents += 1
}

// 抽样 3 条验证 digest 可读（真实文件）
for (const item of items.slice(0, 3)) {
  const digest = await source.readDigest(item.sessionId)
  if (!digest || !Array.isArray(digest.events)) digestFailures += 1
}

const sample = items.slice(0, 5).map((item) => ({
  id: item.sessionId.slice(0, 28),
  source: item.source,
  status: item.hardStatus,
  running: item.running,
  live: item.live,
  title: (item.title ?? '').slice(0, 40),
  cwd: (item.cwd ?? '').slice(0, 48),
}))

console.log(
  JSON.stringify(
    {
      scanDays,
      sessions: items.length,
      firstScanMs: first,
      secondScanMs: second,
      cacheSpeedup: `${(first / Math.max(1, second)).toFixed(1)}x`,
      bySource: Object.fromEntries(bySource),
      byStatus: Object.fromEntries(byStatus),
      withTitlePct: `${Math.round((withTitle / Math.max(1, items.length)) * 100)}%`,
      withCwdPct: `${Math.round((withCwd / Math.max(1, items.length)) * 100)}%`,
      subagents,
      digestFailures,
      sample,
    },
    null,
    2,
  ),
)

if (items.length === 0) {
  console.error('没有扫到会话：检查 ~/.claude/projects 是否存在')
  process.exit(1)
}
if (withCwd < items.length) {
  console.error(`有 ${items.length - withCwd} 条会话没读到 cwd（service 会跳过它们）`)
  process.exit(1)
}
if (digestFailures > 0) {
  console.error(`${digestFailures} 条会话 digest 读取失败`)
  process.exit(1)
}
if (first > 15_000) {
  console.error(`首扫 ${first}ms 太慢（预算 15s）`)
  process.exit(1)
}
console.log('probe ok')
