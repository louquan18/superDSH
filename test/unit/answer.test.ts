/**
 * I-36：把管家的一句话回答，装成宿主 `ask_user_question` 认识的结构化应答。
 *
 * 重点是 `id` 必须等于**问题自己的 id**——以前写死成 `'answer'`，模型拿到的答复
 * 对不上任何问题，看起来像「答了但没用」。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { answerForQuestions } from '../../src/service.js'

const questions = [
  {
    id: 'q1',
    question: '后端 .gitignore 有已跟踪修改，要不要一起提交？',
    options: [{ label: '不提交' }, { label: '一起提交' }],
  },
]

test('I-36：文本命中选项标签 → 放进 selected，id 用问题自己的 id', () => {
  const answer = answerForQuestions(questions, '一起提交')
  assert.equal(answer.answers.length, 1)
  assert.equal(answer.answers[0].id, 'q1')
  assert.deepEqual(answer.answers[0].selected, ['一起提交'])
  assert.equal(answer.answers[0].custom, undefined)
})

test('I-36：文本不是选项（自由回答）→ 放进 custom', () => {
  const answer = answerForQuestions(questions, '先只提交 src 目录')
  assert.equal(answer.answers[0].id, 'q1')
  assert.deepEqual(answer.answers[0].selected, [])
  assert.equal(answer.answers[0].custom, '先只提交 src 目录')
})

test('I-36：多问题只答第一个，其余显式留空（宿主语义 = 跳过）', () => {
  const answer = answerForQuestions(
    [{ id: 'q1', options: [{ label: 'A' }] }, { id: 'q2', options: [{ label: 'B' }] }],
    'A',
  )
  assert.deepEqual(answer.answers.map((item: any) => item.id), ['q1', 'q2'])
  assert.deepEqual(answer.answers[0].selected, ['A'])
  assert.deepEqual(answer.answers[1].selected, [])
  assert.equal(answer.answers[1].custom, undefined)
})

test('I-36：没有问题时退化成兼容形状，不会抛错', () => {
  const answer = answerForQuestions(undefined, '随便答一句')
  assert.equal(answer.answers.length, 1)
  assert.equal(answer.answers[0].custom, '随便答一句')
})
