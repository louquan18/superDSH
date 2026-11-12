import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildCandidates,
  deliveryFor,
  validateDecision,
  type RouterSession,
} from '../../src/router.js'

const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60_000

function session(overrides: Partial<RouterSession> = {}): RouterSession {
  return {
    sessionId: 's1',
    title: 'Session 1',
    cwd: '/proj',
    projectKey: 'p1',
    isButler: false,
    isRoot: true,
    archived: false,
    blank: false,
    running: false,
    hardStatus: 'idle',
    lastActivityAt: NOW - 1_000,
    queueCount: 0,
    recentUserMessages: [],
    openBlockerKinds: [],
    ...overrides,
  }
}

function candidatesFor(sessions: RouterSession[], maxCandidates = 10, now = NOW) {
  return buildCandidates({
    projectKey: 'p1',
    sessions,
    windowDays: 14,
    maxCandidates,
    now,
    topicRecentMessages: 20,
  })
}

test('buildCandidates keeps only root, non-butler, non-archived, non-blank sessions of the project', () => {
  const sessions = [
    session({ sessionId: 'ok' }),
    session({ sessionId: 'other_project', projectKey: 'p2' }),
    session({ sessionId: 'butler', isButler: true }),
    session({ sessionId: 'child', isRoot: false }),
    session({ sessionId: 'archived', archived: true }),
    session({ sessionId: 'blank', blank: true }),
  ]
  assert.deepEqual(
    candidatesFor(sessions).map((candidate) => candidate.sessionId),
    ['ok'],
  )
})

test('buildCandidates drops sessions outside the activity window', () => {
  const stale = NOW - 14 * DAY - 1
  assert.deepEqual(candidatesFor([session({ sessionId: 'stale', lastActivityAt: stale })]), [])
})

test('buildCandidates keeps stale sessions that are running or have an open dispatch', () => {
  const stale = NOW - 14 * DAY - 1
  const sessions = [
    session({ sessionId: 'stale', lastActivityAt: stale }),
    session({ sessionId: 'running', lastActivityAt: stale, running: true }),
    session({
      sessionId: 'dispatched',
      lastActivityAt: stale,
      openDispatch: { id: 'd1', text: 'do it' },
    }),
  ]
  assert.deepEqual(
    candidatesFor(sessions).map((candidate) => candidate.sessionId).sort(),
    ['dispatched', 'running'],
  )
})

test('buildCandidates sorts newest first and caps the result', () => {
  const sessions = [
    session({ sessionId: 'old', lastActivityAt: NOW - 9_000 }),
    session({ sessionId: 'new', lastActivityAt: NOW - 1_000 }),
    session({ sessionId: 'mid', lastActivityAt: NOW - 5_000 }),
  ]
  assert.deepEqual(
    candidatesFor(sessions, 2).map((candidate) => candidate.sessionId),
    ['new', 'mid'],
  )
})

test('buildCandidates trims recent user messages to the topic window', () => {
  const [candidate] = buildCandidates({
    projectKey: 'p1',
    sessions: [session({ recentUserMessages: ['a', 'b', 'c'] })],
    windowDays: 14,
    maxCandidates: 10,
    now: NOW,
    topicRecentMessages: 2,
  })
  assert.deepEqual(candidate.recentUserMessages, ['b', 'c'])
  assert.equal(candidate.projectKey, 'p1')
  assert.equal(candidate.queuedCount, 0)
})

test('validateDecision accepts status_query and clarify decisions', () => {
  const base = { candidates: [], sessions: [] as RouterSession[], projectKey: 'p1' }
  assert.equal(validateDecision({ ...base, decision: { kind: 'status_query' } }).ok, true)
  assert.equal(
    validateDecision({ ...base, decision: { kind: 'clarify', reason: 'target_ambiguous' } }).ok,
    true,
  )
})

test('validateDecision accepts reuse of a candidate and returns the target', () => {
  const sessions = [session({ sessionId: 's1' })]
  const candidates = candidatesFor(sessions)
  const result = validateDecision({
    decision: { kind: 'reuse', sessionId: 's1', reason: 'same task' },
    candidates,
    sessions,
    projectKey: 'p1',
  })
  assert.equal(result.ok, true)
  assert.equal(result.target?.sessionId, 's1')
})

test('validateDecision rejects reuse of missing, butler, non-root, archived or foreign sessions', () => {
  const base = { candidates: [] as ReturnType<typeof candidatesFor>, projectKey: 'p1' }
  const decision = { kind: 'reuse' as const, sessionId: 's1', reason: 'x' }

  assert.match(validateDecision({ ...base, decision, sessions: [] }).reason ?? '', /不存在/)

  const butler = validateDecision({
    ...base,
    decision,
    sessions: [session({ isButler: true })],
  })
  assert.match(butler.reason ?? '', /管家/)

  const nonRoot = validateDecision({
    ...base,
    decision,
    sessions: [session({ isRoot: false })],
  })
  assert.match(nonRoot.reason ?? '', /root/)

  const archived = validateDecision({
    ...base,
    decision,
    sessions: [session({ archived: true })],
  })
  assert.match(archived.reason ?? '', /归档/)

  const foreign = validateDecision({
    ...base,
    decision,
    sessions: [session({ projectKey: 'p2' })],
  })
  assert.match(foreign.reason ?? '', /不属于当前项目/)
})

test('validateDecision rejects reuse targets outside the candidate set unless explicit', () => {
  const sessions = [session({ sessionId: 's1' })]
  const base = { sessions, projectKey: 'p1', decision: { kind: 'reuse' as const, sessionId: 's1', reason: 'x' } }

  const missing = validateDecision({ ...base, candidates: [] })
  assert.equal(missing.ok, false)
  assert.match(missing.reason ?? '', /候选/)

  const explicit = validateDecision({ ...base, candidates: [], explicitTargets: ['s1'] })
  assert.equal(explicit.ok, true)
})

test('validateDecision validates new decisions', () => {
  const base = { candidates: [], sessions: [] as RouterSession[], projectKey: 'p1' }
  assert.equal(
    validateDecision({
      ...base,
      decision: { kind: 'new', projectKey: 'p1', cwd: '/proj', reason: 'fresh start' },
    }).ok,
    true,
  )
  assert.match(
    validateDecision({
      ...base,
      decision: { kind: 'new', projectKey: 'p1', cwd: '', reason: 'x' },
    }).reason ?? '',
    /cwd/,
  )
  assert.match(
    validateDecision({
      ...base,
      decision: { kind: 'new', projectKey: 'p1', cwd: 42 as any, reason: 'x' },
    }).reason ?? '',
    /cwd/,
  )
  assert.match(
    validateDecision({
      ...base,
      decision: { kind: 'new', projectKey: 'p2', cwd: '/proj', reason: 'x' },
    }).reason ?? '',
    /projectKey/,
  )
})

test('deliveryFor queues for busy or waiting sessions and wakes idle ones', () => {
  assert.equal(deliveryFor('running'), 'queue')
  assert.equal(deliveryFor('awaiting_approval'), 'queue')
  assert.equal(deliveryFor('awaiting_answer'), 'queue')
  for (const status of ['idle', 'error', 'interrupted', 'unknown'] as const) {
    assert.equal(deliveryFor(status), 'wake', status)
  }
})
