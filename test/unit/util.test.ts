import { test } from 'node:test'
import assert from 'node:assert/strict'

import { clamp, deepMerge, extractText, hasShellMeta, hash, isInside, isRecoverableTurnError, matchGlob, redact, stableStringify, stripUndefined, summarizeArgs, toRelative, truncate, unique } from '../../src/util.js'

test('hash is a stable 16-char sha1 prefix', () => {
  assert.equal(hash('abc'), 'a9993e364706816a')
  assert.equal(hash('abc'), hash('abc'))
  assert.match(hash('anything else'), /^[0-9a-f]{16}$/)
})

test('stableStringify sorts keys recursively, including array elements', () => {
  assert.equal(
    stableStringify({ b: 1, a: [2, { d: 4, c: 3 }] }),
    '{"a":[2,{"c":3,"d":4}],"b":1}',
  )
  assert.equal(stableStringify('x'), '"x"')
  assert.equal(stableStringify(null), 'null')
})

test('truncate keeps short text and ellipsizes to exactly max chars', () => {
  assert.equal(truncate('abc', 10), 'abc')
  assert.equal(truncate('abcdefghij', 4), 'abc…')
  assert.equal(truncate('abcdefghij', 4).length, 4)
  assert.equal(truncate(42 as any, 10), '')
})

test('extractText joins text blocks and skips reasoning', () => {
  assert.equal(extractText('plain'), 'plain')
  assert.equal(
    extractText([
      { type: 'text', text: 'a' },
      { type: 'reasoning', text: 'hidden' },
      { type: 'text', text: 'b' },
    ]),
    'a\nb',
  )
  assert.equal(extractText({ a: 1 }), '{"a":1}')
  assert.equal(extractText(null), '')
})

test('isInside accepts the root itself and real children, rejects siblings', () => {
  assert.equal(isInside('/proj', '/proj'), true)
  assert.equal(isInside('/proj', '/proj/src/a.ts'), true)
  assert.equal(isInside('/proj', '/proj2/a.ts'), false)
  assert.equal(isInside('/proj', '/proj/..'), false)
  assert.equal(isInside('/proj', '/'), false)
})

test('toRelative renders posix separators', () => {
  assert.equal(toRelative('/proj', '/proj/src/a.ts'), 'src/a.ts')
  assert.equal(toRelative('/proj', '/proj'), '')
})

test('isInside accepts a child whose name starts with two dots', () => {
  // 回归：旧实现用 rel.startsWith('..') 判断逃逸，会把 `..cache` 这种合法子路径判成外面。
  assert.equal(isInside('/proj', '/proj/..cache'), true)
  assert.equal(isInside('/proj', '/proj/..'), false)
  assert.equal(isInside('/proj', '/proj/../elsewhere'), false)
})

test('matchGlob supports *, ?, and ** across directories', () => {
  assert.equal(matchGlob('*.ts', 'a.ts'), true)
  assert.equal(matchGlob('*.ts', 'src/a.ts'), false)
  assert.equal(matchGlob('src/*.ts', 'src/a.ts'), true)
  assert.equal(matchGlob('src/*.ts', 'src/nested/a.ts'), false)
  assert.equal(matchGlob('src/**', 'src/a/b.ts'), true)
  assert.equal(matchGlob('**/*.ts', 'src/nested/a.ts'), true)
  assert.equal(matchGlob('a?c.ts', 'abc.ts'), true)
})

test('hasShellMeta flags shell metacharacters and newlines', () => {
  assert.equal(hasShellMeta('npm test'), false)
  assert.equal(hasShellMeta('ls -la'), false)
  for (const command of [
    'a;b',
    'a && b',
    'a | b',
    'a > out',
    'a < in',
    'echo `whoami`',
    'echo $HOME',
    'echo $(pwd)',
    'a\nb',
  ]) {
    assert.equal(hasShellMeta(command), true, command)
  }
})

test('summarizeArgs describes write/edit/bash and redacts generic args', () => {
  assert.equal(
    summarizeArgs('write', { file_path: 'a.ts', content: 'abc' }),
    'a.ts (3 chars, sha1=a9993e36)',
  )
  assert.equal(summarizeArgs('bash', { command: 'npm test' }), 'npm test')
  const generic = summarizeArgs('mystery', { apiKey: 'secret-value', ok: 1 })
  assert.match(generic, /\[REDACTED\]/)
  assert.ok(!generic.includes('secret-value'))
})

test('redact masks secret-looking keys and caps depth', () => {
  assert.equal(redact({ token: 'x' }).token, '[REDACTED]')
  assert.equal(redact({ nested: { password: 'p' } }).nested.password, '[REDACTED]')
  const deep = redact({ a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } })
  assert.equal(deep.a.b.c.d.e.f.g, '[deep]')
})

test('deepMerge merges nested objects, overrides scalars, skips undefined', () => {
  assert.deepEqual(deepMerge({ a: { b: 1, c: 2 }, d: 1 }, { a: { b: 3 }, e: 2 }), {
    a: { b: 3, c: 2 },
    d: 1,
    e: 2,
  })
  assert.deepEqual(deepMerge({ a: 1 }, { a: undefined }), { a: 1 })
  assert.deepEqual(deepMerge({ a: [1, 2] }, { a: [3] }), { a: [3] })
})

test('clamp and unique behave as expected', () => {
  assert.equal(clamp(5, 1, 3), 3)
  assert.equal(clamp(-1, 0, 10), 0)
  assert.equal(clamp(2, 1, 3), 2)
  assert.deepEqual(unique([1, 2, 1, 3, 2]), [1, 2, 3])
})

test('stripUndefined drops undefined keys and keeps everything else', async () => {
  const input = {
    a: 1,
    b: undefined,
    c: null,
    d: 'text',
    e: { f: undefined, g: [1, undefined, { h: undefined, i: 2 }] },
    j: false,
    k: 0,
  }
  assert.deepEqual(stripUndefined(input), {
    a: 1,
    c: null,
    d: 'text',
    e: { g: [1, null, { i: 2 }] },
    j: false,
    k: 0,
  })
})

test('stripUndefined leaves non-plain objects and primitives alone', async () => {
  assert.equal(stripUndefined(undefined), undefined)
  assert.equal(stripUndefined(7), 7)
  const date = new Date(0)
  // Date/类实例不在这里静默改写：真出现属于新缺陷，交给 dsh 的输出校验报错
  assert.equal(stripUndefined(date), date)
})

test('isRecoverableTurnError 认工具参数/输出格式类错误', () => {
  assert.equal(
    isRecoverableTurnError(
      'Tool call "butler_report_status": Unexpected token 已, ... is not valid JSON',
    ),
    true,
  )
  assert.equal(isRecoverableTurnError('anything', 'INVALID_TOOL_OUTPUT'), true)
  assert.equal(isRecoverableTurnError('anything', 'TOOL_OUTCOME_UNKNOWN'), true)
  assert.equal(isRecoverableTurnError('模型超时', ''), false)
  assert.equal(isRecoverableTurnError('', 'RATE_LIMITED'), false)
})
