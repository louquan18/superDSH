import { test } from 'node:test'
import assert from 'node:assert/strict'

import { BashReviewer, parseVerdict } from '../../src/bash-review.js'

test('parseVerdict accepts the allow/deny JSON protocol, tolerating a json code fence', () => {
  assert.deepEqual(parseVerdict('{"decision":"allow","reason":"只读"}'), { allow: true, reason: '只读' })
  assert.equal(parseVerdict(' {"decision":"deny","reason":"联网"} ')?.allow, false)
  assert.equal(parseVerdict('```json\n{"decision":"allow","reason":"x"}\n```')?.allow, true)
  for (const text of ['allow', '{"decision":"yes"}', '[]', '{"decision":"allow"} 好的', '']) {
    assert.equal(parseVerdict(text), undefined, text)
  }
})

function streamOf(text: string) {
  return (async function* () {
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

const agent = { session: { requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } }
const input = { command: 'ls | head', mode: 'danger' as const, cwd: '/p', projectRoot: '/p' }

test('BashReviewer retries once on malformed output, then reports failure (not danger)', async () => {
  const replies = ['好的', '{"decision":"allow","reason":"只读"}']
  const ok = new BashReviewer({ llm: () => ({ stream: () => streamOf(replies.shift()!) }) })
  assert.deepEqual(await ok.review(agent, input), { allow: true, reason: '只读' })

  const bad = new BashReviewer({ llm: () => ({ stream: () => streamOf('不知道') }) })
  const verdict = await bad.review(agent, input)
  assert.equal(verdict.allow, false)
  assert.equal(verdict.failed, true)
})

test('BashReviewer reports failure when there is no model route or llm service', async () => {
  const noLlm = new BashReviewer({ llm: () => undefined })
  assert.equal((await noLlm.review(agent, input)).failed, true)
  const noRoute = new BashReviewer({ llm: () => ({ stream: () => streamOf('{}') }) })
  assert.match((await noRoute.review({ session: {} }, input)).reason, /模型路由/)
})
