#!/usr/bin/env node
/**
 * 用 Chrome DevTools Protocol 验证真实的 Web 页面：
 * 1. 页面能加载（无未捕获异常）
 * 2. 侧栏出现「管家」全局面板按钮（sidebar.panellist 注册成功）
 * 3. 点开后主区渲染管家面板（main 注册成功）
 * 4. 概览/日志/明细 tab 可切换，不抛异常
 *
 * 用法：node scripts/verify-web.mjs <baseUrl> <token>
 * 需要先启动一个带 --remote-debugging-port=9222 的 Chrome。
 */
const base = process.argv[2] ?? 'http://127.0.0.1:3081'
const token = process.argv[3]
if (!token) {
  console.error('usage: node scripts/verify-web.mjs <baseUrl> <token>')
  process.exit(2)
}

const CDP = 'http://127.0.0.1:9222'

async function target() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const list = await (await fetch(`${CDP}/json/list`)).json()
      const page = list.find((item) => item.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {
      // chrome not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('no CDP page target')
}

const wsUrl = await target()
const socket = new WebSocket(wsUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let nextId = 1
const pending = new Map()
const consoleErrors = []
const exceptions = []

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(JSON.stringify(message.error)))
    else resolve(message.result)
    return
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const detail = message.params?.exceptionDetails
    exceptions.push(detail?.exception?.description ?? detail?.text ?? 'unknown exception')
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
    consoleErrors.push(
      (message.params.args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' '),
    )
  }
  if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
    consoleErrors.push(message.params.entry.text ?? '')
  }
})

function send(method, params = {}) {
  const id = nextId++
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? 'evaluate failed')
  }
  return result.result.value
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')
await send('Page.navigate', { url: `${base}/?token=${token}` })
await wait(6000)

const report = {}
report.title = await evaluate('document.title')
report.composerReady = await evaluate(
  "!!document.querySelector('textarea, [contenteditable=true]')",
)

// 侧栏全局面板按钮：aria-label 由 panellist 的 label 提供。
report.panelButtons = await evaluate(`(() => {
  const out = []
  for (const el of document.querySelectorAll('button,[role=button]')) {
    const label = el.getAttribute('aria-label') || el.textContent || ''
    if (label.includes('管家')) out.push(label.trim().slice(0, 40))
  }
  return out
})()`)

// 侧栏 session 行徽标（只有存在卡点/派发的 session 才会出现）
report.badges = await evaluate("document.querySelectorAll('.sab-badge').length")

// 点击管家按钮，打开 main 面板
report.clicked = await evaluate(`(() => {
  for (const el of document.querySelectorAll('button,[role=button]')) {
    const label = el.getAttribute('aria-label') || el.textContent || ''
    if (label.includes('管家')) { el.click(); return true }
  }
  return false
})()`)
await wait(2500)

report.panelMounted = await evaluate("!!document.querySelector('.sab-root')")
report.panelTitle = await evaluate(
  "document.querySelector('.sab-title')?.textContent ?? null",
)
report.tabs = await evaluate(
  "[...document.querySelectorAll('.sab-tab')].map((el) => el.textContent)",
)
report.emptyOrContent = await evaluate(
  "document.querySelector('.sab-body')?.innerText?.slice(0, 200) ?? null",
)
report.errorText = await evaluate(
  "document.querySelector('.sab-error')?.textContent ?? null",
)

// 切到「日志」和「明细」两个 tab，确认不抛异常
report.tabSwitch = await evaluate(`(() => {
  const tabs = [...document.querySelectorAll('.sab-tab')]
  const log = tabs.find((el) => el.textContent.includes('日志'))
  if (!log) return false
  log.click()
  return true
})()`)
await wait(800)
report.auditRows = await evaluate("document.querySelectorAll('.sab-table tbody tr').length")
report.detailsTab = await evaluate(`(() => {
  const tabs = [...document.querySelectorAll('.sab-tab')]
  const details = tabs.find((el) => el.textContent.includes('明细'))
  if (!details) return false
  details.click()
  return true
})()`)
await wait(800)

socket.close()

const problems = []
if (!report.panelMounted) problems.push('管家面板没有挂载到 main slot')
if (report.panelTitle !== 'SuperAgent 管家') problems.push('面板标题不对')
const TABS = ['概览', '日志', '明细']
const tabLabels = (report.tabs ?? []).map((text) => String(text).replace(/\s*\d+$/, '').trim())
if (
  tabLabels.length !== TABS.length ||
  !TABS.every((label) => tabLabels.includes(label))
) {
  problems.push(`tab 不是 概览/日志/明细：${JSON.stringify(report.tabs)}`)
}
if (report.detailsTab === false) problems.push('切不到「明细」tab')
if (exceptions.length > 0) problems.push(`未捕获异常 ${exceptions.length} 个`)
if (report.panelButtons.length === 0) problems.push('侧栏没有「管家」面板按钮')
if (report.errorText) problems.push(`面板显示连接错误：${report.errorText}`)

console.log(JSON.stringify({ report, exceptions: exceptions.slice(0, 5), consoleErrors: consoleErrors.slice(0, 5) }, null, 2))
if (problems.length > 0) {
  console.error('\nFAILED:\n- ' + problems.join('\n- '))
  process.exit(1)
}
console.log('\nweb verification ok')
