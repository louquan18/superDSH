#!/usr/bin/env node
/**
 * P3 UI 验证：用假快照让面板同时出现 dsh / claude / codex 三种来源，检查
 *   1. 来源徽标渲染且 data-src 区分（不只靠文字）
 *   2. 来源筛选条可用，点 claude 后只剩 claude 行
 *   3. 只读来源的「打开」渲成 disabled + 「该来源不支持」
 *   4. Codex 已知限制文案出现
 *   5. 卡点卡片与派发卡片上也带来源徽标
 *
 * 需要：一个跑着本插件的 dsh web（3081）+ 带 --remote-debugging-port=9222 的 Chrome。
 */
// 凭据只从环境变量取，不进命令行（argv 里带 token 会泄漏到进程列表/日志）
const base = process.env.SAB_BASE ?? process.argv[2]
const token = process.env.SAB_TOKEN ?? ''
const CDP = 'http://127.0.0.1:9222'
if (!base || !token) {
  console.error('usage: SAB_BASE=http://127.0.0.1:3081 SAB_TOKEN=<token> node scripts/verify-sources-ui.mjs')
  process.exit(2)
}

const now = Date.now()
const sessions = [
  {
    sessionId: 'session-dsh-1',
    source: 'dsh',
    title: 'dsh 本地会话',
    cwd: '/tmp/ws',
    projectKey: 'cwd_demo',
    mode: 'plan_review',
    hardStatus: 'idle',
    running: false,
    lastActivityAt: now,
    queuedCount: 0,
    openBlockerKinds: [],
    openBlockerCount: 0,
    isButler: false,
    capabilities: { list: true, readEvents: true, readDigest: true, subscribe: true, create: true, resume: true, queue: true, cancel: true, approvals: true, questions: true, plans: true, hardStatus: true, softStatusTool: true, reassign: true, send: true },
  },
  {
    sessionId: 'claude-1',
    source: 'claude',
    title: 'Claude 里的会话',
    cwd: '/tmp/claude-ws',
    hardStatus: 'awaiting_approval',
    running: false,
    lastActivityAt: now - 1000,
    queuedCount: 0,
    openBlockerKinds: ['approval'],
    openBlockerCount: 1,
    isButler: false,
    capabilities: { list: true, readEvents: true, readDigest: true, subscribe: true, create: false, resume: false, queue: false, cancel: false, approvals: false, questions: false, plans: false, hardStatus: true, softStatusTool: false, reassign: false, send: false },
  },
  {
    sessionId: 'codex-1',
    source: 'codex',
    title: 'Codex 里的会话',
    cwd: '/tmp/codex-ws',
    hardStatus: 'idle',
    running: false,
    lastActivityAt: now - 2000,
    queuedCount: 0,
    openBlockerKinds: [],
    openBlockerCount: 0,
    isButler: false,
    capabilities: { list: true, readEvents: true, readDigest: true, subscribe: false, create: false, resume: false, queue: false, cancel: false, approvals: false, questions: false, plans: false, hardStatus: true, softStatusTool: false, reassign: false, send: false },
  },
]

const snapshot = {
  generatedAt: now,
  butler: { sessionId: 'session-dsh-1', title: 'SuperAgent 管家', status: 'idle' },
  projects: [{ key: 'cwd_demo', cwd: '/tmp/ws', title: 'ws', mode: 'plan_review', createdAt: 1, updatedAt: 1 }],
  sessions,
  blockers: [
    {
      id: 'blk-1',
      sessionId: 'claude-1',
      source: 'claude',
      kind: 'approval',
      severity: 'warning',
      status: 'open',
      signature: 'sig-1',
      summary: 'Claude 在等权限确认',
      neededAction: '去 Claude Code 里确认',
      evidence: { toolName: 'Bash' },
      detectedAt: now,
      lastSeenAt: now,
      reminderCount: 1,
    },
  ],
  plans: [],
  approvals: [],
  audit: [],
  dispatches: [
    {
      id: 'dsp-1',
      text: '一个历史派发',
      targetSessionId: 'session-dsh-1',
      targetTitle: 'dsh 本地会话',
      workspaceKey: 'cwd_demo',
      mode: 'reuse',
      modeAtDispatch: 'plan_review',
      requestId: 'r1',
      status: 'accepted',
      reason: '演示',
      relatedSessionIds: [],
      createdAt: now,
      source: 'dsh',
    },
  ],
}

const list = await (await fetch(`${CDP}/json/list`)).json()
const page = list.find((item) => item.type === 'page')
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
let id = 1
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)
  }
})
const send = (method, params = {}) => {
  const current = id++
  socket.send(JSON.stringify({ id: current, method, params }))
  return new Promise((resolve, reject) => pending.set(current, { resolve, reject }))
}
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result.value
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

await send('Runtime.enable')
await send('Page.enable')
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    (() => {
      const real = window.fetch
      const fake = ${JSON.stringify(snapshot)}
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : (input && input.url) || ''
        if (url.includes('/api/superagent/state')) {
          return new Response(JSON.stringify(fake), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        if (url.includes('/api/superagent/action')) {
          return new Response(JSON.stringify({ ok: true, value: { ok: true } }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return real ? real(input, init) : Promise.reject(new Error('no fetch'))
      }
    })()
  `,
})
await send('Page.navigate', { url: `${base}/?token=${token}` })
await wait(6000)

// 打开管家面板
const opened = await evaluate(`(() => {
  for (const el of document.querySelectorAll('button,[role=button]')) {
    const label = el.getAttribute('aria-label') || el.textContent || ''
    if (label.includes('管家')) { el.click(); return true }
  }
  return false
})()`)
await wait(2500)

const badges = await evaluate("[...document.querySelectorAll('.sab-src')].map((el) => el.getAttribute('data-src'))")
const filters = await evaluate("[...document.querySelectorAll('.sab-filter')].map((el) => el.textContent)")
const limitation = await evaluate(
  "[...document.querySelectorAll('.sab-limit')].map((el) => el.textContent).join(' | ')",
)
// 徽标必须有真实视觉差异（颜色/边框），不能只是类名
const badgeColors = await evaluate(`(() => {
  const out = {}
  for (const el of document.querySelectorAll('.sab-src')) {
    const src = el.getAttribute('data-src')
    if (out[src]) continue
    const cs = getComputedStyle(el)
    out[src] = { color: cs.color, border: cs.borderColor, radius: cs.borderRadius, dot: !!el.querySelector('.sab-src-dot'), display: cs.display }
  }
  return out
})()`)

const disabledOpen = await evaluate(`(() => {
  const out = []
  for (const row of document.querySelectorAll('.sab-table tbody tr')) {
    const cells = [...row.querySelectorAll('td')]
    const src = cells[0]?.querySelector('.sab-src')?.getAttribute('data-src')
    const btn = row.querySelector('button')
    if (btn) out.push({ src, text: btn.textContent, disabled: btn.disabled, title: btn.title || '' })
  }
  return out
})()`)

// 点 claude 筛选
const filtered = await evaluate(`(() => {
  const target = [...document.querySelectorAll('.sab-filter')].find((el) => el.textContent.includes('Claude'))
  if (!target) return null
  target.click()
  return true
})()`)
await wait(900)
const rowsAfter = await evaluate(
  "[...document.querySelectorAll('.sab-table tbody tr')].map((row) => row.querySelector('.sab-src')?.getAttribute('data-src'))",
)
// 卡点/派发/计划卡片在「明细」tab 里
const toDetails = await evaluate(`(() => {
  const tab = [...document.querySelectorAll('.sab-tab')].find((el) => el.textContent.includes('明细'))
  if (!tab) return false
  tab.click()
  return true
})()`)
await wait(1200)
const blockerBadges = await evaluate(
  "[...document.querySelectorAll('.sab-card .sab-src')].map((el) => el.getAttribute('data-src'))",
)

socket.close()

const report = { opened, badges, badgeColors, filters, limitation, disabledOpen, filtered, rowsAfter, toDetails, blockerBadges }
console.log(JSON.stringify(report, null, 2))

const problems = []
if (!opened) problems.push('面板打不开')
for (const source of ['dsh', 'claude', 'codex']) {
  if (!badges.includes(source)) problems.push(`缺 ${source} 徽标`)
}
const colorKeys = new Set(
  Object.values(badgeColors ?? {}).map((item) => `${item.color}|${item.border}`),
)
if (colorKeys.size < 3) problems.push(`来源徽标颜色不够区分：${JSON.stringify(badgeColors)}`)
for (const [src, style] of Object.entries(badgeColors ?? {})) {
  if (!style.dot) problems.push(`${src} 徽标缺少彩色圆点`)
  if (!String(style.display).includes('flex')) problems.push(`${src} 徽标没应用样式（CSS 丢了？）`)
}
if (!filters.some((text) => text.includes('Claude'))) problems.push('缺来源筛选条')
if (!limitation.includes('Codex')) problems.push('缺 Codex 已知限制说明')
const claudeRow = disabledOpen.find((row) => row.src === 'claude')
if (!claudeRow) problems.push('找不到 claude 行')
else if (!claudeRow.disabled || !claudeRow.title.includes('该来源不支持')) {
  problems.push(`claude 的「打开」没有置灰/说明：${JSON.stringify(claudeRow)}`)
}
const dshRow = disabledOpen.find((row) => row.src === 'dsh')
if (dshRow && dshRow.disabled) problems.push('dsh 的「打开」不该被禁用')
if (!filtered) problems.push('点不到 Claude 筛选')
else if (rowsAfter.some((src) => src && src !== 'claude')) {
  problems.push(`筛选后仍出现非 claude 行：${JSON.stringify(rowsAfter)}`)
}
if (!toDetails) problems.push('切不到「明细」tab')
if (!blockerBadges.includes('claude')) problems.push('卡点/派发卡片上没有来源徽标')

if (problems.length > 0) {
  console.error('\nFAILED:\n- ' + problems.join('\n- '))
  process.exit(1)
}
console.log('\nsources UI ok')
