// Account detection, the shell block and the wake hook, against a throwaway HOME.
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

test('isRegistered reads the account config file', () => {
  assert.equal(c.isRegistered(''), false)
  fs.writeFileSync(path.join(HOME, '.claude.json'), JSON.stringify({ mcpServers: { agentlink: { command: c.adapterCmd()[0], args: c.adapterCmd().slice(1) } } }))
  assert.equal(c.isRegistered(''), false, 'the adapter without the hook is half a setup')
  c.installHook('')
  assert.equal(c.isRegistered(''), true)
  fs.writeFileSync(path.join(HOME, '.claude.json'), JSON.stringify({ mcpServers: { agentlink: { command: '/old/node', args: ['x'] } } }))
  assert.equal(c.isRegistered(''), false, 'stale path counts as unregistered')
})

test('a re-run clears the old launch aliases and keeps the PATH line', () => {
  const rc = path.join(HOME, '.zshrc')
  c.writeShellBlock({ pathDir: '/opt/agent link/bin' })
  const text = fs.readFileSync(rc, 'utf8')
  assert.ok(!/-link=/.test(text))
  assert.match(text, /alias claude2=/, "the user's own aliases stay")
})

test('the wake hook goes into settings without disturbing them, and comes out cleanly', () => {
  const dir = path.join(HOME, '.claude-hook')
  fs.mkdirSync(dir)
  const file = path.join(dir, 'settings.json')
  const mine = { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'check' }] }] }, permissions: { allow: ['Bash(ls)'] } }
  fs.writeFileSync(file, JSON.stringify(mine))
  c.installHook(dir)
  c.installHook(dir)                                   // twice is the same as once
  const s = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(s.model, 'opus')
  const wakes = ev => s.hooks[ev].flatMap(g => g.hooks).filter(h => / wake$/.test(h.command))
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure']) {
    assert.equal(wakes(ev).length, 1)
    assert.equal(wakes(ev)[0].asyncRewake, true)
    assert.ok(wakes(ev)[0].timeout >= 86400)
  }
  assert.ok(s.hooks.Stop.some(g => g.hooks.some(h => h.command === 'say done')), 'other Stop hooks stay')
  assert.ok(s.permissions.allow.includes('mcp__agentlink__inbox') && s.permissions.allow.includes('Bash(ls)'))
  assert.ok(!s.permissions.allow.includes('mcp__agentlink__send'), 'sending keeps the session\'s normal rules')
  c.removeHook(dir)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), mine)
})

test('settings stay where they are: symlinks are followed, modes kept, unreadable files untouched', () => {
  const dots = path.join(HOME, 'dotfiles'), dir = path.join(HOME, '.claude-linked')
  fs.mkdirSync(dots); fs.mkdirSync(dir)
  const real = path.join(dots, 'settings.json'), link = path.join(dir, 'settings.json')
  fs.writeFileSync(real, '{"env":{"TOKEN":"x"}}', { mode: 0o600 })
  fs.symlinkSync(real, link)
  c.installHook(dir)
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'still a link')
  assert.ok(JSON.parse(fs.readFileSync(real, 'utf8')).hooks.Stop)
  assert.equal(fs.statSync(real).mode & 0o777, 0o600)
  const dangling = path.join(HOME, '.claude-dangling')
  fs.mkdirSync(dangling)
  fs.symlinkSync(path.join(HOME, 'nowhere.json'), path.join(dangling, 'settings.json'))
  assert.throws(() => c.installHook(dangling), /left it alone/)
  assert.ok(fs.lstatSync(path.join(dangling, 'settings.json')).isSymbolicLink())
  // someone else's script that happens to end in " wake" stays
  const other = path.join(HOME, '.claude-other')
  fs.mkdirSync(other)
  fs.writeFileSync(path.join(other, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: '~/bin/agentlink-notify.sh wake' }] }] } }))
  c.installHook(other); c.removeHook(other)
  assert.equal(JSON.parse(fs.readFileSync(path.join(other, 'settings.json'), 'utf8')).hooks.Stop[0].hooks[0].command, '~/bin/agentlink-notify.sh wake')
})

test('settings that cannot be read are left alone', () => {
  const dir = path.join(HOME, '.claude-broken')
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'settings.json'), '{ not json')
  assert.throws(() => c.installHook(dir), /isn't valid JSON/)
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), '{ not json')
})

test('only an interactive session waits: a script must never hang on the hook', async () => {
  const { interactive, wakeText } = await import('../../src/wake.js')
  const env = {}
  assert.ok(interactive('claude', 'ttys003', env))
  assert.ok(interactive('claude --continue --rc', 'pts/2', env))
  assert.ok(!interactive('claude -p hello', 'ttys003', env))
  assert.ok(!interactive('claude --print hello', 'ttys003', env))
  assert.ok(!interactive('claude --output-format=stream-json', 'ttys003', env))
  assert.ok(!interactive('claude --input-format stream-json', 'ttys003', env))
  assert.ok(!interactive('claude', '??', env), 'no terminal')
  assert.ok(!interactive('claude', '?', env))
  assert.ok(!interactive('claude', '', env))
  assert.ok(!interactive('claude', 'ttys003', { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' }))
  assert.match(wakeText(1, 'bob'), /a new message has/)
  assert.match(wakeText(3, 'bob'), /3 new messages have/)
  assert.match(wakeText(1, 'bob'), /mcp__agentlink__inbox/)
})
