// What agents read to choose a tool. Each description says when to use it, and the tools that
// overlap (peers and network) point at each other, so an agent picks the right one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TOOLS, formatNetwork } from '../../src/mcp.js'

const tool = (/** @type {string} */ name) => {
  const t = TOOLS.find(t => t.name === name)
  assert.ok(t, `no ${name} tool`)
  return t
}

test('the tools are send, peers, network, invite, inbox, claim, release and leases', () => {
  assert.deepEqual(TOOLS.map(t => t.name).sort(), ['claim', 'inbox', 'invite', 'leases', 'network', 'peers', 'release', 'send'])
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

test('the network tool shows each machine\'s version and which are behind', () => {
  const st = {
    host: 'a.local', version: '0.3.0', member: true, pending: [],
    members: [
      { host: 'a.local', self: true, version: '0.3.0', added_by: '(founded the network)' },
      { host: 'b.local', version: '0.3.1', added_by: 'a.local' },
      { host: 'c.local', version: null, added_by: 'a.local' },
    ],
  }
  const pe = { self: 'a.local', local: [], remote: [{ host: 'b.local', online: true, sessions: [] }, { host: 'c.local', online: false, sessions: [] }] }
  const out = formatNetwork(st, pe)
  assert.match(out, /a\.local — this machine; nattermatic 0\.3\.0, behind 0\.3\.1;/)
  assert.match(out, /b\.local — online; nattermatic 0\.3\.1; added by a\.local/)
  assert.match(out, /c\.local — offline; version not known/)
  assert.match(out, /install line/)
  assert.match(out, /never upgraded from another machine/)
  // all on the newest: no upgrade advice
  const same = formatNetwork({ ...st, members: st.members.slice(0, 1) }, pe)
  assert.doesNotMatch(same, /behind|install line/)
})
