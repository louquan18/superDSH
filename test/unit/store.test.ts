import { test } from 'node:test'
import assert from 'node:assert/strict'

import { STORAGE_SPEC } from '../../src/store.js'

const tables = STORAGE_SPEC.tables

test('STORAGE_SPEC declares the documented tables and per-record layout', () => {
  assert.equal(STORAGE_SPEC.name, 'superagent')
  assert.equal(STORAGE_SPEC.version, 2)
  assert.equal(STORAGE_SPEC.layout, 'per-record')
  // P2：升到 v2 必须声明兼容 v1，否则已有 per-record 记录会被读作不存在
  assert.deepEqual(STORAGE_SPEC.compatibleVersions, [1])
  assert.deepEqual(Object.keys(tables).sort(), [
    'approvals',
    'audit',
    'blockers',
    'dispatches',
    'meta',
    'plans',
    'projects',
    'sessions',
    'threads',
  ])
  for (const name of Object.keys(tables)) {
    assert.equal(typeof tables[name].valueSchema.parse, 'function', name)
  }
})

test('meta accepts records with a numeric schemaVersion', () => {
  const value = { schemaVersion: 1 }
  assert.deepEqual(tables.meta.valueSchema.parse(value), value)
  assert.throws(() => tables.meta.valueSchema.parse({}), /invalid superagent record/)
})

test('projects require key, cwd and a valid mode', () => {
  const value = { key: 'p1', cwd: '/proj', mode: 'plan_review' }
  assert.deepEqual(tables.projects.valueSchema.parse(value), value)
  assert.throws(
    () => tables.projects.valueSchema.parse({ key: 'p1', mode: 'gate_confirm' }),
    /invalid superagent record/,
  )
  assert.throws(
    () => tables.projects.valueSchema.parse({ key: 'p1', cwd: '/proj', mode: 'other' }),
    /invalid superagent record/,
  )
})

test('sessions require sessionId and a boolean isButler', () => {
  const value = { sessionId: 's1', isButler: false }
  assert.deepEqual(tables.sessions.valueSchema.parse(value), value)
  assert.throws(
    () => tables.sessions.valueSchema.parse({ sessionId: 's1', isButler: 'no' }),
    /invalid superagent record/,
  )
})

test('dispatches require id, targetSessionId and status', () => {
  const value = { id: 'd1', targetSessionId: 's1', status: 'accepted' }
  assert.deepEqual(tables.dispatches.valueSchema.parse(value), value)
  assert.throws(
    () => tables.dispatches.valueSchema.parse({ id: 'd1', status: 'accepted' }),
    /invalid superagent record/,
  )
})

test('plans require id, sessionId, dispatchId and status', () => {
  const value = { id: 'pl1', sessionId: 's1', dispatchId: 'd1', status: 'approved' }
  assert.deepEqual(tables.plans.valueSchema.parse(value), value)
  assert.throws(
    () => tables.plans.valueSchema.parse({ id: 'pl1', sessionId: 's1', status: 'approved' }),
    /invalid superagent record/,
  )
})

test('blockers require id, sessionId, kind and status', () => {
  const value = { id: 'b1', sessionId: 's1', kind: 'approval', status: 'open' }
  assert.deepEqual(tables.blockers.valueSchema.parse(value), value)
  assert.throws(
    () => tables.blockers.valueSchema.parse({ id: 'b1', sessionId: 's1', status: 'open' }),
    /invalid superagent record/,
  )
})

test('approvals require id, sessionId and status', () => {
  const value = { id: 'a1', sessionId: 's1', status: 'pending' }
  assert.deepEqual(tables.approvals.valueSchema.parse(value), value)
  assert.throws(
    () => tables.approvals.valueSchema.parse({ id: 'a1', status: 'pending' }),
    /invalid superagent record/,
  )
})

test('audit entries require id and a numeric at', () => {
  const value = { id: 'x1', at: 1_700_000_000_000 }
  assert.deepEqual(tables.audit.valueSchema.parse(value), value)
  assert.throws(
    () => tables.audit.valueSchema.parse({ id: 'x1', at: 'now' }),
    /invalid superagent record/,
  )
})

