// Account detection and shell-alias management, against a throwaway HOME.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlink-home-'))
process.env.HOME = HOME
process.env.SHELL = '/bin/zsh'
let c

before(async () => {
  fs.mkdirSync(path.join(HOME, '.claude'))                       // default account dir: not an extra account
  fs.mkdirSync(path.join(HOME, '.claude-work'))
  fs.writeFileSync(path.join(HOME, '.claude-work', '.claude.json'), '{}')
  fs.mkdirSync(path.join(HOME, '.claude-empty'))                 // no .claude.json: ignored
  fs.writeFileSync(path.join(HOME, '.zshrc'), [
    `export FOO=1`,
    `alias claude2='CLAUDE_CONFIG_DIR="$HOME/.claude2" claude'`,
    `alias cw="CLAUDE_CONFIG_DIR=~/.claude-work claude --verbose"`,
    `alias ll='ls -l'`,
    `alias notclaude='CLAUDE_CONFIG_DIR=$HOME/.x claudette'`,
    '',
  ].join('\n'))
  c = await import('../../src/claude.js')
})

test('finds the default account, ~/.claude* dirs and CLAUDE_CONFIG_DIR aliases', () => {
  const accts = c.claudeAccounts()
  const byAlias = Object.fromEntries(accts.map(a => [a.alias, a.dir]))
  assert.equal(byAlias.claude, '')
  assert.equal(byAlias.claude2, path.join(HOME, '.claude2'))
  assert.equal(byAlias.cw, path.join(HOME, '.claude-work'))   // alias wins over dir name for the same dir
  assert.ok(!('claude-empty' in byAlias))
  assert.ok(!('notclaude' in byAlias))
  assert.equal(accts.length, 3)
})

test('peer aliases reuse each account alias, swapping claude for the launcher', () => {
  const al = Object.fromEntries(c.peerAliases().map(a => [a.name, a.value]))
  assert.deepEqual(Object.keys(al).sort(), ['claude-link', 'claude2-link', 'cw-link'])
  assert.match(al['claude2-link'], /^CLAUDE_CONFIG_DIR="\$HOME\/\.claude2" ".*node.*" --no-warnings ".*agentlink\.js" claude$/)
  assert.match(al['cw-link'], /agentlink\.js" claude --verbose$/)
  assert.doesNotMatch(al['claude-link'], /CLAUDE_CONFIG_DIR/)
})

test('managed shell block is idempotent and removable', () => {
  const rc = path.join(HOME, '.zshrc')
  const original = fs.readFileSync(rc, 'utf8')
  c.writeShellBlock({ pathDir: '/opt/agentlink/bin' })
  const once = fs.readFileSync(rc, 'utf8')
  c.writeShellBlock({ pathDir: '/opt/agentlink/bin' })
  assert.equal(fs.readFileSync(rc, 'utf8'), once)
  assert.equal(once.match(/>>> agentlink >>>/g).length, 1)
  assert.match(once, /export PATH="\/opt\/agentlink\/bin":"\$PATH"/)
  assert.ok(once.startsWith(original.trimEnd()))
  // our own -link aliases must not be detected as accounts
  assert.equal(c.claudeAccounts().length, 3)
  c.removeShellBlock()
  const after = fs.readFileSync(rc, 'utf8')
  assert.doesNotMatch(after, /agentlink/)
  assert.match(after, /alias claude2=/)
})

test('re-running setup from a normal shell keeps the PATH line', () => {
  const rc = path.join(HOME, '.zshrc')
  const saved = fs.readFileSync(rc, 'utf8')
  c.writeShellBlock({ pathDir: '/opt/agent link/bin' })           // installer run
  const PATH0 = process.env.PATH
  process.env.PATH = `/opt/agent link/bin:${PATH0}`               // a later shell, PATH includes it via our block
  delete process.env.AGENTLINK_ORIG_PATH
  c.writeShellBlock()                                              // `agentlink setup` re-run, no bin dir known
  process.env.PATH = PATH0
  assert.match(fs.readFileSync(rc, 'utf8'), /export PATH="\/opt\/agent link\/bin":"\$PATH"/)
  c.removeShellBlock()
  fs.writeFileSync(rc, saved)
})

test('aliases with quotes and odd paths are written safely', () => {
  const rc = path.join(HOME, '.zshrc')
  const saved = fs.readFileSync(rc, 'utf8')
  fs.appendFileSync(rc, `alias cq="CLAUDE_CONFIG_DIR=$HOME/.claude-q claude --append-system-prompt 'be brief'"\n`)
  const { aliases } = c.writeShellBlock()
  const line = fs.readFileSync(rc, 'utf8').split('\n').find(l => l.startsWith('alias cq-link='))
  assert.ok(line, 'cq-link written')
  assert.ok(aliases.some(a => a.name === 'cq-link'))
  // the single quotes inside must be escaped for the single-quoted alias body
  assert.match(line, /'\\''be brief'\\''/)
  c.removeShellBlock()
  fs.writeFileSync(rc, saved)
})

test('isRegistered reads the account config file', () => {
  assert.equal(c.isRegistered(''), false)
  fs.writeFileSync(path.join(HOME, '.claude.json'), JSON.stringify({ mcpServers: { agentlink: { command: c.adapterCmd()[0], args: c.adapterCmd().slice(1) } } }))
  assert.equal(c.isRegistered(''), true)
  fs.writeFileSync(path.join(HOME, '.claude.json'), JSON.stringify({ mcpServers: { agentlink: { command: '/old/node', args: ['x'] } } }))
  assert.equal(c.isRegistered(''), false, 'stale path counts as unregistered')
})
