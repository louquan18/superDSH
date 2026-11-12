#!/usr/bin/env node
/**
 * 提醒卡片 / 待处理条 / 只读面板的渲染自检（不需要浏览器）。
 *
 * `lib/client/index.js` 是纯脚本，React 从平台模块表取。这里给一个最小假 React，
 * 把 `apply()` 注册的组件**真的调用一遍**，序列化成文本后断言：
 * 1. 有按钮的提醒 → 渲染出按钮文案，未处理时可点；
 * 2. 已处理的卡点 → 显示「✓」且不再渲染动作按钮；
 * 3. 待处理条只在管家会话出现，数据来自 snapshot.blockerNotices；
 * 4. 面板是 概览/日志/明细，且面板树里没有任何改变状态的按钮文案；
 * 5. 全流程不抛异常。
 */
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'

const here = path.dirname(fileURLToPath(import.meta.url))
const file = path.resolve(here, '../lib/client/index.js')
const source = readFileSync(file, 'utf8')

function createElement(type, props, ...children) {
  const merged = { ...(props ?? {}) }
  merged.children = children.length > 0 ? children : merged.children
  return { type, props: merged }
}

const fakeReact = {
  createElement,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
  Fragment: 'Fragment',
  Children: { toArray: (value) => (Array.isArray(value) ? value : value == null ? [] : [value]) },
}

const registrations = []
const definitions = []
const style = { setAttribute() {}, textContent: '' }
const document = {
  createElement: () => style,
  head: { appendChild() {}, removeChild() {} },
}
const window = { __ModuleLoader__: { load: (item) => registrations.push(item) } }
const sandbox = {
  window,
  document,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  EventSource: undefined,
  fetch: async () => ({ ok: true, json: async () => ({}) }),
}
sandbox.globalThis = sandbox
createContext(sandbox)
runInContext(source, sandbox, { filename: file })

assert.equal(registrations.length, 1)
const registration = registrations[0]
const exports = registration.factory((specifier) => {
  if (specifier === 'react') return fakeReact
  throw new Error(`unexpected external module: ${specifier}`)
})
assert.equal(typeof exports.apply, 'function')

const slots = []
const ctx = {
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  slots: {
    inject(name, callback) {
      callback()
      return () => {}
    },
    register(definition, component) {
      slots.push({ definition, component })
      return () => {}
    },
  },
  layout: { selectPanel() {} },
  uiWorkspace: { openSession() {} },
  uiConversation: { events: { register: (definition) => definitions.push(definition) } },
}
exports.apply(ctx)

// ---------------------------------------------------------------- 假数据

const NOW = Date.now()
const openBlocker = {
  id: 'bl_open',
  sessionId: 'session-demo',
  kind: 'approval',
  severity: 'critical',
  status: 'notified',
  summary: 'demo worker 在等审批：bash rm -rf build',
  neededAction: '允许或拒绝 bash',
  evidence: { toolName: 'bash', argsSummary: 'rm -rf build' },
  detectedAt: NOW - 30_000,
  lastSeenAt: NOW - 30_000,
  reminderCount: 1,
}

const openNotice = {
  id: 'notice_open',
  at: NOW - 30_000,
  kind: 'blocker',
  category: 'approval',
  severity: 'critical',
  sessionId: 'session-demo',
  sessionTitle: 'demo worker',
  title: 'demo worker · 等审批',
  detail: 'rm -rf build',
  neededAction: '允许或拒绝 bash',
  blockerId: 'bl_open',
  actions: [
    { verb: 'approve', label: '允许一次', style: 'primary' },
    { verb: 'reject', label: '拒绝', style: 'danger' },
    { verb: 'dismiss', label: '忽略' },
  ],
}

const settledNotice = {
  id: 'notice_settled',
  at: NOW - 300_000,
  kind: 'blocker',
  category: 'plan_review',
  severity: 'warning',
  sessionId: 'session-demo',
  sessionTitle: 'demo worker',
  title: 'demo worker · 计划待审',
  blockerId: 'bl_settled',
  actions: [
    { verb: 'approve', label: '批准', style: 'primary' },
    { verb: 'dismiss', label: '忽略' },
  ],
}

const snapshot = {
  generatedAt: NOW,
  butler: { sessionId: 'session-butler', title: 'SuperAgent 管家', status: 'idle' },
  projects: [{ key: 'cwd_demo', cwd: '/tmp/demo', title: 'demo', mode: 'plan_review' }],
  sessions: [
    {
      sessionId: 'session-demo',
      title: 'demo worker',
      hardStatus: 'awaiting_approval',
      running: false,
      lastActivityAt: NOW - 60_000,
      queuedCount: 0,
      openBlockerKinds: ['approval'],
      openBlockerCount: 1,
      isButler: false,
    },
    {
      sessionId: 'session-butler',
      title: 'SuperAgent 管家',
      hardStatus: 'idle',
      running: false,
      lastActivityAt: NOW - 30_000,
      queuedCount: 0,
      openBlockerKinds: [],
      openBlockerCount: 0,
      isButler: true,
    },
  ],
  blockers: [openBlocker],
  blockerNotices: [openNotice],
  resolvedBlockers: [
    {
      id: 'bl_settled',
      kind: 'plan_review',
      status: 'dismissed',
      sessionId: 'session-demo',
      summary: 'demo worker 提交了计划',
      resolution: '用户忽略',
      resolvedAt: NOW - 100_000,
    },
  ],
  plans: [
    {
      id: 'plan_demo',
      sessionId: 'session-demo',
      dispatchId: 'dsp_demo',
      title: '把测试跑一遍',
      markdown: '# 计划',
      scope: { items: [{ id: 'i1', description: '跑测试', commands: ['npm test'] }] },
      status: 'pending_review',
      submittedAt: NOW - 90_000,
    },
  ],
  dispatches: [
    {
      id: 'dsp_demo',
      text: '演示任务',
      targetSessionId: 'session-demo',
      targetTitle: 'demo worker',
      workspaceKey: 'cwd_demo',
      mode: 'reuse',
      modeAtDispatch: 'plan_review',
      requestId: 'req',
      status: 'accepted',
      reason: '演示',
      relatedSessionIds: [],
      createdAt: NOW - 90_000,
    },
  ],
  approvals: [],
  audit: [
    {
      id: 'audit_1',
      at: NOW - 60_000,
      sessionId: 'session-demo',
      kind: 'blocker',
      action: 'create',
      decision: 'open',
      by: 'system',
      note: '等审批',
    },
  ],
}

const state = { snapshot, error: null, loading: false }
const store = {
  get: () => state,
  subscribe: () => () => {},
  refresh: async () => {},
}
const calls = []
const api = {
  action: async (action, payload) => {
    calls.push({ action, payload })
    return { ok: true }
  },
  getState: async () => snapshot,
}
const nav = { openSession: () => {} }

// ---------------------------------------------------------------- 渲染器

/** 把 createElement 树摊平成文本；遇到组件就直接调用它。 */
function render(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(render).join('')
  if (typeof node !== 'object') return ''
  const { type, props } = node
  if (typeof type === 'function') return render(type(props))
  if (typeof type === 'string') return render(props?.children)
  return ''
}

/** 收集树里所有真正渲染出来的按钮文案（`Button` 组件渲染成 button.sab-btn）。 */
function collectButtons(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') return out
  if (Array.isArray(node)) {
    for (const item of node) collectButtons(item, out)
    return out
  }
  if (typeof node !== 'object') return out
  const { type, props } = node
  if (typeof type === 'function') {
    collectButtons(type(props), out)
    return out
  }
  if (type === 'button' && String(props?.className ?? '').includes('sab-btn')) {
    out.push(render(props?.children))
  }
  collectButtons(props?.children, out)
  return out
}

/** 收集按钮元素本身（保留 onClick），用来真的点一下。 */
function collectButtonNodes(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') {
    if (Array.isArray(node)) for (const item of node) collectButtonNodes(item, out)
    return out
  }
  if (Array.isArray(node)) {
    for (const item of node) collectButtonNodes(item, out)
    return out
  }
  const { type, props } = node
  if (typeof type === 'function') {
    collectButtonNodes(type(props), out)
    return out
  }
  if (type === 'button' && String(props?.className ?? '').includes('sab-btn')) {
    out.push({ text: render(props?.children), onClick: props?.onClick })
  }
  collectButtonNodes(props?.children, out)
  return out
}

const bySlot = (name) => {
  const found = slots.filter((item) => item.definition.name === name)
  assert.ok(found.length > 0, `slot ${name} is registered`)
  return found
}
const nodeSlot = bySlot('conversation.chat.node').find(
  (item) => item.definition.key === 'superagent-notice',
)
const dockSlot = bySlot('conversation.input.dock')[0]
const panelSlot = bySlot('main')[0]

// 生产里 `inject` 面给的是插件自己创建的 store；这里换成测试用的假 store，
// 键名和形状与生产一致（store.get() / store.subscribe / store.refresh）。
const props = (extra = {}) => ({ store, api, nav, ...extra })

// 1) 未处理的提醒：有按钮，能点，点了会打 blocker_action
const openRow = render(
  nodeSlot.component(
    props({ node: { data: { source: { notice: openNotice } } } }),
  ),
)
assert.match(openRow, /demo worker · 等审批/, 'renders the notice title')
assert.match(openRow, /rm -rf build/, 'renders the evidence detail')
assert.match(openRow, /允许一次/, 'renders the approve button')
assert.match(openRow, /拒绝/, 'renders the reject button')
assert.match(openRow, /忽略/, 'renders the dismiss button')
assert.doesNotMatch(openRow, /✓/, 'an open notice shows no settled mark')

// 2) 已处理的提醒：显示 ✓，不再渲染动作按钮
const settledRow = render(
  nodeSlot.component(
    props({ node: { data: { source: { notice: settledNotice } } } }),
  ),
)
assert.match(settledRow, /✓/, 'a settled notice shows the check mark')
assert.match(settledRow, /已忽略/, 'a settled notice explains the resolution')
assert.doesNotMatch(settledRow, /批准/, 'a settled notice renders no action button')

// 3) 待处理条：只在管家会话出现
const dockInButler = render(dockSlot.component(props({ sessionId: 'session-butler' })))
assert.match(dockInButler, /管家待处理 1 条/, 'dock lists pending items')
assert.match(dockInButler, /允许一次/, 'dock reuses the same card')
const dockInWorker = dockSlot.component(props({ sessionId: 'session-demo' }))
assert.equal(dockInWorker, null, 'dock renders nothing outside the butler session')

// 4) 面板：概览 / 日志 / 明细，全只读
const panel = render(panelSlot.component(props()))
assert.match(panel, /SuperAgent 管家/)
assert.match(panel, /概览/)
assert.match(panel, /日志/)
assert.match(panel, /明细/)
assert.match(panel, /这里只读/, 'panel states it is read-only')

const FORBIDDEN = [
  '标记完成',
  '放弃任务',
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
]
const panelButtons = collectButtons(panelSlot.component(props()))
const forbidden = panelButtons.filter((label) =>
  FORBIDDEN.some((word) => String(label).includes(word)),
)
assert.deepEqual(
  forbidden,
  [],
  `panel must not render state-changing buttons: ${forbidden.join(', ')}`,
)
assert.ok(
  panelButtons.some((label) => String(label).includes('刷新')),
  'panel still offers the refresh button',
)
assert.ok(
  panelButtons.some((label) => String(label).includes('打开管家会话')),
  'panel still offers the open-butler button',
)

// 5) 渲染阶段不产生任何动作请求
assert.deepEqual(calls, [], 'rendering must not call the action API')

// 6) 真的点一下「允许一次」：必须发出 blocker_action/approve
const rowForClick = nodeSlot.component(
  props({ node: { data: { source: { notice: openNotice } } } }),
)
const approveButton = collectButtonNodes(rowForClick).find((item) =>
  item.text.includes('允许一次'),
)
assert.ok(approveButton?.onClick, 'the approve button exposes a click handler')
approveButton.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(calls.length, 1, 'clicking sends exactly one action')
assert.equal(calls[0].action, 'blocker_action')
assert.equal(calls[0].payload.blockerId, 'bl_open')
assert.equal(calls[0].payload.action, 'approve')

// 7) 已处理的卡片点不动：没有动作按钮可点
const settledButtons = collectButtonNodes(
  nodeSlot.component(props({ node: { data: { source: { notice: settledNotice } } } })),
)
assert.deepEqual(
  settledButtons.filter((item) => item.text.includes('批准')),
  [],
  'a settled notice has no clickable actions',
)

console.log(
  `notice render ok: ${slots.length} slots, ${definitions.length} definitions, ` +
    `panel buttons ${JSON.stringify(panelButtons)}, one wired action click verified`,
)
