/**
 * P0 版本戳：配置指纹与代码版本的单元测试。
 *
 * 关注三件事：
 * - 指纹必须对配置的**书写顺序**不敏感、对**值变化**敏感（否则历史审计无法比较）；
 * - 拿不到 git 时要降级而不是抛错（I-15 的教训：启动期不能因为附属信息失败而崩）；
 * - 同一次运行内只算一次，所有审计共用同一份。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  currentVersion,
  readCodeVersion,
  readConfigHash,
  resetVersionForTest,
  resolveVersion,
} from '../../src/version.js'

test('readConfigHash 只依赖配置内容，不依赖键顺序', () => {
  const a = { butler: { title: '管家', cwd: '/tmp/x' }, scanIntervalMs: 5000 }
  const b = { scanIntervalMs: 5000, butler: { cwd: '/tmp/x', title: '管家' } }
  assert.equal(readConfigHash(a), readConfigHash(b))
  assert.match(readConfigHash(a), /^[0-9a-f]{12}$/)
})

test('readConfigHash 对值变化敏感，且数组顺序有意义', () => {
  const base = { policy: { shadowRules: ['a', 'b'] } }
  assert.notEqual(readConfigHash(base), readConfigHash({ policy: { shadowRules: ['b', 'a'] } }))
  assert.notEqual(readConfigHash(base), readConfigHash({ policy: { shadowRules: ['a', 'b'], x: 1 } }))
  // undefined 视为不存在：序列化时被丢弃，不该改变指纹
  assert.equal(
    readConfigHash({ a: 1, b: undefined }),
    readConfigHash({ a: 1 }),
  )
})

test('readCodeVersion 在拿不到 git 时降级而不是抛错', () => {
  const version = readCodeVersion()
  assert.equal(typeof version, 'string')
  assert.ok(version.length > 0)
  // 要么是 git describe 的结果（v0.1.0 / v0.1.0-3-gabcdef / abcdef / 带 -dirty），
  // 要么是 pkg@x.y.z+unknown 降级串
  assert.match(version, /^(pkg@\d+\.\d+\.\d+\+unknown|[\w.\-/]+)$/)
})

test('resolveVersion 同一次运行只算一次，所有审计共用同一份', () => {
  resetVersionForTest()
  assert.equal(currentVersion(), null)

  const config = { a: 1 }
  const first = resolveVersion(config)
  const second = resolveVersion({ a: 2 }) // 缓存生效：配置变了也不重算

  assert.equal(first, second)
  assert.equal(first.configHash, readConfigHash(config))
  assert.equal(typeof first.startedAt, 'number')
  assert.ok(first.startedAt > 0)

  resetVersionForTest()
  const third = resolveVersion({ a: 1 })
  assert.notEqual(third, first) // 重置后是新对象
  assert.equal(currentVersion(), third)
})
