// What agents read to choose a tool. Each description says when to use it, and the tools that
// overlap (peers and network) point at each other, so an agent picks the right one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TOOLS } from '../../src/mcp.js'

const tool = (/** @type {string} */ name) => {
  const t = TOOLS.find(t => t.name === name)
  assert.ok(t, `no ${name} tool`)
  return t
}

test('the tools are send, peers, network, invite and inbox', () => {
  assert.deepEqual(TOOLS.map(t => t.name).sort(), ['inbox', 'invite', 'network', 'peers', 'send'])
})

test('each tool description says when to use it', () => {
  for (const t of TOOLS) assert.match(t.description, /\b(use this|use peers|only when your user asks)\b/i, t.name)
})

test('peers and network say which is for what', () => {
  assert.match(tool('peers').description, /use network/)
  assert.match(tool('network').description, /use peers/)
})

test('send says what it returns', () => {
  assert.match(tool('send').description, /Returns/)
})

test('every parameter has a description', () => {
  for (const t of TOOLS)
    for (const [k, p] of Object.entries(/** @type {Record<string, any>} */ (t.inputSchema.properties || {})))
      assert.ok(p.description, `${t.name}.${k}`)
})
