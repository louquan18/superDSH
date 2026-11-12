#!/usr/bin/env node
/**
 * 「管家面板只读」的浏览器自检（需要 Chrome 起在 --remote-debugging-port=9222）。
 *
 * 用一份假快照（有卡点、有在审计划、有进行中派发、有一个项目）打开面板，断言：
 * 1. 面板能打开，tab 只有「概览 / 日志 / 明细」；
 * 2. 三个 tab 都能切、都不抛异常；
 * 3. 面板里**没有任何**会改变状态的动作按钮（批准/驳回/改派/标记完成/切换模式/发消息…）；
 * 4. 仅仅浏览面板不会发出任何 `/api/superagent/action` 请求（只读的硬证据）。
 *
 * 用法：node scripts/verify-panel-readonly.mjs <baseUrl> <token>
 */
// 凭据只从环境变量取，不进命令行
const base = process.env.SAB_BASE ?? process.argv[2]
const token = process.env.SAB_TOKEN ?? ''
if (!base || !token) {
  console.error('usage: SAB_BASE=http://127.0.0.1:3081 SAB_TOKEN=<token> node scripts/verify-panel-readonly.mjs')
  process.exit(2)
}
const CDP = 'http://127.0.0.1:9222'

const NOW = Date.now()
const snapshot = {
  generatedAt: NOW,
  butler: { sessionId: 'session-butler', title: 'SuperAgent 管家', status: 'idle' },
  projects: [
    { key: 'cwd_demo', cwd: '/tmp/demo', title: 'demo', mode: 'plan_review', createdAt: 1, updatedAt: 1 },
  ],
  sessions: [
    {
      sessionId: 'session-demo',
      title: 'demo worker',
      cwd: '/tmp/demo',
      projectKey: 'cwd_demo',
      mode: 'plan_review',
      hardStatus: 'awaiting_approval',
      running: false,
      lastActivityAt: NOW - 60_000,
      queuedCount: 0,
      openBlockerKinds: ['approval', 'plan_review'],
      openBlockerCount: 2,
      isButler: false,
    },
    {
      sessionId: 'session-butler',
      title: 'SuperAgent 管家',
      cwd: '/tmp/demo',
      hardStatus: 'idle',
      running: false,
      lastActivityAt: NOW - 30_000,
      queuedCount: 0,
      openBlockerKinds: [],
      openBlockerCount: 0,
      isButler: true,
    },
  ],
  blockers: [
    {
      id: 'bl_demo',
      sessionId: 'session-demo',
      kind: 'approval',
      severity: 'critical',
      status: 'notified',
      signature: 'approval:ap-demo',
      summary: 'demo worker 在等审批：bash rm -rf build',
      neededAction: '允许或拒绝 bash',
      evidence: { toolName: 'bash', callId: 'call-demo', risk: 'high', argsSummary: 'rm -rf build' },
      detectedAt: NOW - 60_000,
      lastSeenAt: NOW - 60_000,
      reminderCount: 1,
      relatedApprovalId: 'ap-demo',
      relatedCallId: 'call-demo',
    },
  ],
  blockerNotices: [
    {
      id: 'notice_demo',
      at: NOW - 60_000,
      kind: 'blocker',
      category: 'approval',
      severity: 'critical',
      sessionId: 'session-demo',
      sessionTitle: 'demo worker',
      title: 'demo worker · 等审批',
      detail: 'rm -rf build',
      neededAction: '允许或拒绝 bash',
      blockerId: 'bl_demo',
      approvalId: 'ap-demo',
      callId: 'call-demo',
      actions: [
        { verb: 'approve', label: '允许一次', style: 'primary' },
        { verb: 'reject', label: '拒绝', style: 'danger' },
        { verb: 'dismiss', label: '忽略' },
      ],
    },
  ],
  resolvedBlockers: [
    {
      id: 'bl_done',
      kind: 'stall',
      status: 'dismissed',
      sessionId: 'session-demo',
      summary: 'demo worker 停滞',
      resolution: '用户标记处理',
      resolvedAt: NOW - 120_000,
    },
  ],
  plans: [
    {
      id: 'plan_demo',
      sessionId: 'session-demo',
      dispatchId: 'dsp_demo',
      title: '把测试跑一遍',
      markdown: '# 计划\n\n1. 跑测试',
      scope: { items: [{ id: 'i1', description: '跑测试', commands: ['npm test'] }] },
      status: 'pending_review',
      submittedAt: NOW - 90_000,
      source: 'butler_submit_plan',
    },
  ],
  approvals: [
    {
      id: 'ap-demo',
      sessionId: 'session-demo',
      toolName: 'bash',
      callId: 'call-demo',
      argsSummary: 'rm -rf build',
      risk: 'high',
      status: 'pending',
      createdAt: NOW - 60_000,
    },
  ],
  audit: [
    {
      id: 'audit_demo',
      at: NOW - 60_000,
      sessionId: 'session-demo',
      kind: 'blocker',
      action: 'create',
      decision: 'open',
      by: 'system',
      note: '等审批',
    },
  ],
  dispatches: [
    {
      id: 'dsp_demo',
      text: '演示：把测试跑一遍',
      targetSessionId: 'session-demo',
      targetTitle: 'demo worker',
      workspaceKey: 'cwd_demo',
      mode: 'reuse',
      modeAtDispatch: 'plan_review',
      requestId: 'req-demo',
      status: 'accepted',
      reason: '演示',
      relatedSessionIds: [],
      createdAt: NOW - 90_000,
    },
  ],
}

/** 面板里不该出现的、会改变状态的按钮文案。 */
const FORBIDDEN = [
  '标记完成',
  '放弃',
  '批准',
  '驳回',
  '提修改意见',
  '允许一次',
  '拒绝',
  '改派',
  '发送',
  '切到卡点确认',
  '切到计划审查',
  '转发回答',
  '忽略',
  '重试',
  '催办',
]

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

const socket = new WebSocket(await target())
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
      window.__actions = []
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : (input && input.url) || ''
        if (url.includes('/api/superagent/state')) {
          return new Response(JSON.stringify(fake), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        if (url.includes('/api/superagent/action')) {
          try { window.__actions.push(JSON.parse(init.body)) } catch {}
          return new Response(JSON.stringify({ ok: true, value: { ok: true } }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return real ? real(input, init) : Promise.reject(new Error('no fetch'))
      }
    })()
  `,
})
await send('Page.navigate', { url: `${base}/?token=${token}` })
await wait(6000)

const openPanel = await evaluate(`(() => {
  for (const el of document.querySelectorAll('button,[role=button]')) {
    const label = el.getAttribute('aria-label') || el.textContent || ''
    if (label.includes('管家')) { el.click(); return true }
  }
  return false
})()`)
await wait(2000)

const tabs = await evaluate(`[...document.querySelectorAll('.sab-tab')].map((el) => el.textContent)`)
const expectedTabs = ['概览', '日志', '明细']
const tabOk =
  tabs.length === expectedTabs.length && expectedTabs.every((label) => tabs.some((text) => text.includes(label)))

const visited = []
const found = []
for (const label of expectedTabs) {
  const clicked = await evaluate(`(() => {
    const tab = [...document.querySelectorAll('.sab-tab')].find((el) => el.textContent.includes(${JSON.stringify(label)}))
    if (!tab) return false
    tab.click()
    return true
  })()`)
  await wait(900)
  visited.push({ label, clicked })
  const labels = await evaluate(`[...document.querySelectorAll('.sab-btn')].map((el) => el.textContent)`)
  for (const text of labels) {
    if (FORBIDDEN.some((word) => String(text).includes(word))) found.push(`${label}: ${text}`)
  }
}

const actions = await evaluate('window.__actions')
socket.close()

const problems = []
if (!openPanel) problems.push('面板打不开')
if (!tabOk) problems.push(`tab 不是 概览/日志/明细：${JSON.stringify(tabs)}`)
for (const item of visited) if (!item.clicked) problems.push(`切不到「${item.label}」tab`)
if (found.length > 0) problems.push(`面板里出现了会改变状态的按钮：${found.join('、')}`)
if (Array.isArray(actions) && actions.length > 0) {
  problems.push(`仅仅浏览面板就发出了动作请求：${JSON.stringify(actions)}`)
}

console.log(JSON.stringify({ openPanel, tabs, visited, found, actions, problems }, null, 2))
if (problems.length > 0) {
  console.error('FAILED:\n- ' + problems.join('\n- '))
  process.exit(1)
}
console.log('panel is read-only: 3 tabs, no state-changing buttons, no action requests')
