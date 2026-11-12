#!/usr/bin/env node
/**
 * 真实机器冒烟：用 lib/ 里编译后的 CodexSource 扫本机 ~/.codex。
 * 只读：不写 ~/.codex，不碰 ipc.sock。
 * 用法：node scripts/probe-codex.mjs [scanDays]
 */
import { CodexSource } from '../lib/sources/codex.js'

const scanDays = Number(process.argv[2] ?? 14)
const source = new CodexSource({
  config: {
    enabled: true,
    scanDays,
    maxSessions: 200,
    tailBytes: 65536,
    includeSubagents: false,
    watch: false,
  },
})

const t0 = Date.now()
const items = await source.list()
const first = Date.now() - t0
const t1 = Date.now()
await source.list()
const second = Date.now() - t1

const byStatus = new Map()
let withCwd = 0
let withTitle = 0
let digestFailures = 0
for (const item of items) {
  byStatus.set(item.hardStatus, (byStatus.get(item.hardStatus) ?? 0) + 1)
  if (item.cwd) withCwd += 1
  if (item.title && !item.title.startsWith('Codex ')) withTitle += 1
}
for (const item of items.slice(0, 3)) {
  const digest = await source.readDigest(item.sessionId)
  if (!digest || !Array.isArray(digest.events)) digestFailures += 1
}

console.log(
  JSON.stringify(
    {
      scanDays,
      sessions: items.length,
      firstScanMs: first,
      secondScanMs: second,
      byStatus: Object.fromEntries(byStatus),
      withCwdPct: `${Math.round((withCwd / Math.max(1, items.length)) * 100)}%`,
      withTitlePct: `${Math.round((withTitle / Math.max(1, items.length)) * 100)}%`,
      digestFailures,
      sample: items.slice(0, 4).map((item) => ({
        id: item.sessionId.slice(0, 20),
        status: item.hardStatus,
        title: (item.title ?? '').slice(0, 36),
        cwd: (item.cwd ?? '').slice(0, 44),
      })),
    },
    null,
    2,
  ),
)

if (items.length === 0) {
  console.error('没有扫到 rollout：检查 ~/.codex/sessions')
  process.exit(1)
}
if (withCwd < items.length) {
  console.error(`${items.length - withCwd} 条会话没读到 cwd`)
  process.exit(1)
}
if (digestFailures > 0) {
  console.error(`${digestFailures} 条 digest 读取失败`)
  process.exit(1)
}
console.log('probe ok')
