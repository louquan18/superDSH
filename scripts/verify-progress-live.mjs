#!/usr/bin/env node
/**
 * B-1 真机验收：**不发送任何消息**，只靠 2 秒轮询，确认进度卡片会自己出现、并且刷新后还在。
 *
 * 步骤：
 * 1. 打开面板，记录当前进度卡片数（应为 0）；
 * 2. 用页面内 fetch 触发一次进度事件（progress_probe）；
 * 3. 什么都不做，等 ~3 秒，确认卡片数量变成 1（轮询送达，无消息、无点击）；
 * 4. 刷新页面，确认卡片仍在（持久化，不随"回复"消失）；
 * 5. 断言 blockerNotices 里没有 progress（语义隔离）。
 *
 * 凭据只从环境变量取。
 */
const base = process.env.SAB_BASE
const token = process.env.SAB_TOKEN
if (!base || !token) {
  console.error('usage: SAB_BASE=http://127.0.0.1:3081 SAB_TOKEN=<token> node scripts/verify-progress-live.mjs')
  process.exit(2)
}
const CDP = 'http://127.0.0.1:9222'

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

async function openPanel() {
  await send('Page.navigate', { url: `${base}/?token=${token}` })
  await wait(6000)
  const opened = await evaluate(`(() => {
    for (const el of document.querySelectorAll('button,[role=button]')) {
      const label = el.getAttribute('aria-label') || el.textContent || ''
      if (label.includes('管家')) { el.click(); return true }
    }
    return false
  })()`)
  await wait(2000)
  return opened
}

const opened = await openPanel()
const before = await evaluate("document.querySelectorAll('.sab-tl-item').length")
// 确认面板里没有任何输入框被使用（不发送消息）
const composed = await evaluate("document.querySelectorAll('.sab-textarea, textarea').length")

// 触发一次进度事件（页面内 fetch，不走 UI 输入）
const probe = await evaluate(`fetch('/api/superagent/action', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'progress_probe', payload: { sessionId: 'session-probe', title: '验收：阶段结束' } }),
}).then((r) => r.json())`)

// 什么都不做，只等轮询
const timeline = []
for (const ms of [1500, 1500, 1500]) {
  await wait(ms)
  timeline.push(await evaluate("document.querySelectorAll('.sab-tl-item').length"))
}

const snapshot = await evaluate(`fetch('/api/superagent/state', { credentials: 'same-origin' })
  .then((r) => r.json())
  .then((s) => ({
    progress: (s.progressNotices ?? []).length,
    blockers: (s.blockerNotices ?? []).length,
    firstTitle: (s.progressNotices ?? [])[0]?.title ?? null,
    firstStatus: (s.progressNotices ?? [])[0]?.status ?? null,
    blockerKinds: [...new Set((s.blockerNotices ?? []).map((n) => n.kind))],
  }))`)

// 刷新后仍在（持久化）
await openPanel()
const afterReload = await evaluate("document.querySelectorAll('.sab-tl-item').length")

socket.close()
const report = { opened, before, composed, probe, timeline, snapshot, afterReload }
console.log(JSON.stringify(report, null, 2))

const problems = []
if (!opened) problems.push('面板打不开')
if (before !== 0) problems.push(`初始就有 ${before} 张进度卡（预期 0）`)
if (composed > 0) problems.push('页面里有输入框，无法证明"不发消息"')
if (!timeline.some((count) => count > 0)) problems.push(`等待 4.5 秒后仍未出现进度卡：${JSON.stringify(timeline)}`)
if (snapshot.progress === 0) problems.push('snapshot.progressNotices 为空')
if (snapshot.blockers !== 0) problems.push(`blockerNotices 不该有内容：${snapshot.blockers}`)
if (snapshot.blockerKinds.includes('progress')) problems.push('progress 混进了 blockerNotices')
if (afterReload === 0) problems.push('刷新后进度卡消失（未持久化）')

if (problems.length > 0) {
  console.error('\nFAILED:\n- ' + problems.join('\n- '))
  process.exit(1)
}
console.log('\nprogress live ok：无消息、2 秒轮询送到、刷新后仍在、未污染 blockerNotices')
