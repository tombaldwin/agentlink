// The version and name nattermatic publishes under, kept the same everywhere they're written: the npm
// package, the code, the MCP Registry entry and the Claude Code plugin. A release bumps them together
// (docs/releasing.md); this catches one left behind.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { VERSION } from '../../src/config.js'

const read = (/** @type {string} */ f) => JSON.parse(fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8'))
const pkg = read('package.json')
const server = read('server.json')
const market = read('.claude-plugin/marketplace.json')
const plugin = read('plugins/nattermatic/.claude-plugin/plugin.json')

test('every manifest has the package version', () => {
  assert.equal(VERSION, pkg.version, 'src/config.js VERSION')
  assert.equal(server.version, pkg.version, 'server.json version')
  assert.equal(server.packages[0].version, pkg.version, 'server.json package version')
  assert.equal(plugin.version, pkg.version, 'plugin.json version')
  assert.equal(market.plugins[0].version, pkg.version, 'marketplace.json version')
})

test('the MCP Registry entry matches the npm package', () => {
  assert.equal(server.name, pkg.mcpName, 'the registry checks mcpName in the published package')
  assert.match(server.name, /^io\.github\.tombaldwin\//)
  assert.equal(server.packages[0].identifier, pkg.name)
  assert.ok(server.description.length <= 100, 'the registry allows 100 characters')
})

test('the plugin and its skill are where the marketplace says', () => {
  assert.equal(market.plugins[0].name, plugin.name)
  const skill = fs.readFileSync(new URL(`../../${market.plugins[0].source}/skills/nattermatic/SKILL.md`, import.meta.url), 'utf8')
  assert.match(skill, /^---\nname: nattermatic\ndescription: .+\n---\n/)
})

test('plugins installed as agentlink, before the rename, still find theirs in the marketplace', () => {
  const old = market.plugins.find((/** @type {any} */ p) => p.name === 'agentlink')
  assert.ok(old, 'Claude Code looks a plugin up by the name it was installed under')
  assert.equal(old.source, market.plugins[0].source)
  assert.equal(old.version, pkg.version)
})
