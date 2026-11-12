import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defineTool } from '../../src/tools.js'
import { isLosslessJson, findLossyPath } from '../lossless.js'

test('defineTool strips undefined from tool results', async () => {
  const tool = defineTool({
    name: 'demo',
    description: 'demo',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      return { ok: true, missing: undefined, nested: { deeper: undefined, kept: 1 } }
    },
  })
  const value = await tool.execute({}, {})
  assert.deepEqual(value, { ok: true, nested: { kept: 1 } })
  assert.equal(isLosslessJson(value), true)
})

test('defineTool keeps arrays dense and undefined-free', async () => {
  const tool = defineTool({
    name: 'demo2',
    description: 'demo',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      return { items: [{ a: undefined, b: 1 }, undefined] }
    },
  })
  const value = await tool.execute({}, {})
  assert.equal(findLossyPath(value), null)
  assert.deepEqual(value, { items: [{ b: 1 }, null] })
})
