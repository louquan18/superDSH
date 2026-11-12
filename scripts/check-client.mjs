#!/usr/bin/env node
/**
 * Client 构建产物的装载自检：
 * - `lib/client/index.js` 必须是一个能直接求值的脚本（不是 ESM）
 * - 求值时只调用一次 `window.__ModuleLoader__.load({ id, factory })`
 * - `factory(require)` 必须返回带 `apply` 和 `inject` 的模块对象
 * - `apply(ctx)` 必须注册 sidebar.panellist / main / session.row.leading / session.row.hover
 *
 * 这里不渲染 React 组件（宿主浏览器才有 React），只验证装载协议和挂载点声明。
 */
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'

const here = path.dirname(fileURLToPath(import.meta.url))
const file = path.resolve(here, '../lib/client/index.js')
const source = readFileSync(file, 'utf8')

const registrations = []
const style = { setAttribute() {}, textContent: '' }
const document = {
  createElement: (tag) => {
    assert.equal(tag, 'style')
    return style
  },
  head: { appendChild() {}, removeChild() {} },
}
const window = {
  __ModuleLoader__: {
    load(registration) {
      registrations.push(registration)
    },
  },
  confirm: () => false,
}
const sandbox = { window, document, console, setTimeout, clearTimeout, setInterval, clearInterval, EventSource: undefined, fetch: async () => ({ ok: true, json: async () => ({}) }) }
sandbox.globalThis = sandbox
createContext(sandbox)
runInContext(source, sandbox, { filename: file })

assert.equal(registrations.length, 1, 'client script must register exactly one module')
const registration = registrations[0]
assert.equal(registration.id, '@local/dsh-superagent-butler')

const fakeReact = {
  createElement: () => null,
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
}
const exports = registration.factory((specifier) => {
  if (specifier === 'react') return fakeReact
  throw new Error(`unexpected external module: ${specifier}`)
})
assert.equal(typeof exports.apply, 'function', 'client module must export apply')
assert.ok(Array.isArray(exports.inject), 'client module must export inject')
for (const service of ['slots', 'layout', 'uiWorkspace']) {
  assert.ok(exports.inject.includes(service), `client inject must name ${service}`)
}

const registered = []
const definitions = []
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
      registered.push({ definition, component })
      return () => {}
    },
  },
  layout: { selectPanel() {} },
  uiWorkspace: { openSession() {} },
  uiConversation: {
    events: {
      register(definition) {
        definitions.push(definition)
        return () => {}
      },
    },
  },
}

exports.apply(ctx)

const slots = new Map(
  registered.map((item) => [`${item.definition.name}#${item.definition.key ?? item.definition.id ?? ''}`, item]),
)
assert.deepEqual(
  [...slots.keys()].sort(),
  [
    'conversation.chat.node#superagent-notice',
    'conversation.input.dock#superagent-notices',
    'main#superagent',
    'sidebar.panellist#superagent',
    'sidebar.session.row.hover#superagent-soft-status',
    'sidebar.session.row.leading#superagent-mark',
  ],
  'client must register the panel, the sidebar decorations and the in-chat notice seats',
)
assert.equal(slots.get('main#superagent').definition.key, 'superagent')
assert.equal(slots.get('sidebar.panellist#superagent').definition.id, 'superagent')
assert.equal(typeof slots.get('sidebar.panellist#superagent').definition.label, 'function')
assert.equal(slots.get('sidebar.panellist#superagent').definition.label(), '管家')

// 提醒消息的抢注 Definition：只吃带 superagent-notice source 的 append user/message。
const noticeDefinition = definitions.find((item) => item.kind === 'superagent-notice')
assert.ok(noticeDefinition, 'must register the superagent-notice conversation definition')
assert.equal(noticeDefinition.target, 'chat')
const noticeEvent = (source, extra = {}) => ({
  type: 'user/message',
  surfaceOp: 'append',
  seq: 12,
  time: 1_700_000_000_000,
  data: { id: 'msg-1', content: [{ type: 'text', text: 'hi' }], source },
  ...extra,
})
const matched = noticeDefinition.match(noticeEvent({ kind: 'superagent-notice' }))
assert.equal(matched?.id, 'msg-1')
assert.equal(matched?.role, 'start')
assert.equal(matched?.exclusive, true)
assert.equal(noticeDefinition.match(noticeEvent({ kind: 'user' })), null, 'user messages stay native')
assert.equal(
  noticeDefinition.match(noticeEvent({ kind: 'superagent-notice' }, { surfaceOp: 'replace' })),
  null,
  'replacement surface events are not claimed',
)
assert.equal(
  noticeDefinition.match({ ...noticeEvent({ kind: 'superagent-notice' }), type: 'assistant/message' }),
  null,
  'other event types are not claimed',
)

// 渲染出的节点：kind 必须是注册过的 key，位置沿用原生 context 行的定位方式。
const state = noticeDefinition.start(
  {},
  { event: noticeEvent({ kind: 'superagent-notice', notice: { id: 'n1', actions: [] } }) },
)
const node = noticeDefinition.buildViewNode({ key: 'ctx-1', id: 'msg-1', state, start: { location: { kind: 'unresolved' } } })
assert.equal(node.kind, 'superagent-notice')
assert.equal(node.target, 'chat')
assert.equal(node.visibility, 'visible')
assert.equal(node.groupTree, undefined, 'a notice sits in the surrounding run like a native context row')

// 管家会话的待处理条：只有管家会话才渲染。
const dock = slots.get('conversation.input.dock#superagent-notices').definition
assert.equal(typeof dock.inject, 'function')
const dockProps = dock.inject('session-1')
assert.equal(dockProps.sessionId, 'session-1')
assert.ok(dockProps.store, 'dock needs the shared store')
assert.ok(dockProps.api, 'dock needs the action api')

console.log(`client smoke ok: ${registered.length} slots, ${definitions.length} definitions, ${source.length} bytes`)
