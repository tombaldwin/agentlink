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
  // ps loses the quotes: these are prompts, and Claude treats these sessions as interactive
  assert.ok(interactive('claude run mkdir -p src/foo and add a file', 'ttys003', env))
  assert.ok(interactive('claude --continue why does docker run -p 8080:80 fail', 'ttys003', env))
  assert.ok(interactive('/usr/bin/node /x/claude-code/cli.js fix --print', 'ttys003', env))
  assert.ok(!interactive('/usr/bin/node /x/claude-code/cli.js -p hello', 'ttys003', env))
  // options this doesn't know the values of: Claude Code's own marker catches those
  assert.ok(!interactive('claude --strange value -p hello', 'ttys003', { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }))
  assert.ok(!interactive('claude --model opus -p hello', 'ttys003', env))
  assert.ok(interactive('claude --model opus mkdir -p src', 'ttys003', env))
  assert.ok(!interactive('claude', '??', env), 'no terminal')
  assert.ok(!interactive('claude', '?', env))
  assert.ok(!interactive('claude', '', env))
  assert.ok(!interactive('claude', 'ttys003', { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' }))
  assert.match(wakeText(1, 'bob'), /a new message has/)
  assert.match(wakeText(3, 'bob'), /3 new messages have/)
  assert.match(wakeText(1, 'bob'), /mcp__agentlink__inbox/)
})

test('the installer and the program agree on the oldest Claude Code', () => {
  const sh = fs.readFileSync(new URL('../../install.sh', import.meta.url), 'utf8')
  assert.equal(sh.match(/^MIN_CLAUDE=(\S+)/m)?.[1], c.WAKE_MIN_CLAUDE)
})

test('claude is found where the installer finds it, and the shell block goes where the shell reads it', async () => {
  const bin = path.join(HOME, '.local', 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 })
  const PATH = process.env.PATH
  process.env.PATH = '/usr/bin:/bin'
  try { assert.equal(c.claudeBin(), path.join(bin, 'claude')) } finally { process.env.PATH = PATH; fs.rmSync(path.join(bin, 'claude')) }
  const SHELL = process.env.SHELL
  try {
    process.env.SHELL = '/opt/homebrew/bin/fish'
    assert.equal(c.primaryRc(), path.join(HOME, '.profile'), 'not a stray .zshrc')
    process.env.SHELL = '/bin/zsh'
    assert.equal(c.primaryRc(), path.join(HOME, '.zshrc'))
  } finally { process.env.SHELL = SHELL }
})

test('the account a shell is using is enabled even if nothing else names it', () => {
  const dir = path.join(HOME, 'elsewhere', 'claude-config')
  process.env.CLAUDE_CONFIG_DIR = dir
  try { assert.ok(c.claudeAccounts().some(a => a.dir === dir)) } finally { delete process.env.CLAUDE_CONFIG_DIR }
})

test('a block that lost its END takes none of the user\'s lines with it', () => {
  const rc = path.join(HOME, '.zshrc')
  const saved = fs.readFileSync(rc, 'utf8')
  c.writeShellBlock({ pathDir: '/opt/agentlink/bin' })
  fs.writeFileSync(rc, fs.readFileSync(rc, 'utf8').replace('# <<< agentlink <<<\n', '') + 'export MINE=1\n')
  c.writeShellBlock({ pathDir: '/opt/agentlink/bin' })
  c.writeShellBlock({ pathDir: '/opt/agentlink/bin' })
  const text = fs.readFileSync(rc, 'utf8')
  assert.match(text, /export MINE=1/)
  assert.equal(text.match(/>>> agentlink >>>/g).length, 1, 'and the stray marker goes')
  c.removeShellBlock()
  assert.match(fs.readFileSync(rc, 'utf8'), /export MINE=1/)
  fs.writeFileSync(rc, saved)
})

test('shell files: bytes are kept, nothing is made for nothing, and one we can\'t read is left alone', () => {
  const rc = path.join(HOME, '.zshrc')
  const saved = fs.readFileSync(rc)
  fs.rmSync(path.join(HOME, '.agentlink', 'bin-dir'), { force: true })
  const latin = Buffer.concat([Buffer.from('export X=caf'), Buffer.from([0xe9]), Buffer.from('\n')])
  fs.writeFileSync(rc, latin)
  c.writeShellBlock({})
  assert.deepEqual(fs.readFileSync(rc), latin, 'nothing to add: not touched')
  c.writeShellBlock({ pathDir: '/opt/caf\u00e9/bin' })
  const bytes = fs.readFileSync(rc)
  assert.ok(bytes.includes(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])), 'their byte is as it was')
  assert.ok(bytes.includes(Buffer.from('/opt/caf\u00e9/bin')), 'and ours is UTF-8')
  c.removeShellBlock()
  fs.writeFileSync(rc, saved)
  const shell = process.env.SHELL, gone = path.join(HOME, '.not-there')
  process.env.SHELL = '/bin/sh'
  const profile = path.join(HOME, '.profile')
  fs.rmSync(profile, { force: true })
  fs.rmSync(path.join(HOME, '.agentlink', 'bin-dir'), { force: true })
  c.writeShellBlock({})
  assert.ok(!fs.existsSync(profile), 'no file for an empty block')
  c.writeShellBlock({ pathDir: '/opt/x/bin' })
  assert.ok(fs.existsSync(profile))
  c.removeShellBlock()
  assert.equal(fs.readFileSync(profile, 'utf8').trim(), '', 'and it\'s left empty')
  fs.rmSync(profile)
  if (process.platform === 'darwin') {
    process.env.SHELL = '/bin/bash'
    c.writeShellBlock({ pathDir: '/opt/x/bin' })
    c.removeShellBlock()
    assert.ok(!fs.existsSync(path.join(HOME, '.bash_profile')), 'but an empty .bash_profile would hide .profile')
    process.env.SHELL = '/bin/sh'
  }
  fs.symlinkSync(gone, profile)
  assert.throws(() => c.writeShellBlock({ pathDir: '/opt/x/bin' }), 'a link to nothing is not an empty file')
  fs.rmSync(profile)
  process.env.SHELL = shell
})

test('uninstalling and setting up again puts the PATH line back', () => {
  const rc = path.join(HOME, '.zshrc')
  const saved = fs.readFileSync(rc, 'utf8')
  const shell = process.env.SHELL
  process.env.SHELL = '/bin/zsh'
  c.writeShellBlock({ pathDir: '/opt/agentlink/bin' })
  c.removeShellBlock()
  assert.doesNotMatch(fs.readFileSync(rc, 'utf8'), /opt\/agentlink/)
  c.writeShellBlock()
  assert.match(fs.readFileSync(rc, 'utf8'), /export PATH="\/opt\/agentlink\/bin":"\$PATH"/)
  c.removeShellBlock()
  fs.writeFileSync(rc, saved)
  process.env.SHELL = shell
})

test('the right shell file: what bash and zsh really read', () => {
  const shell = process.env.SHELL, zdot = process.env.ZDOTDIR
  process.env.SHELL = '/bin/zsh'
  process.env.ZDOTDIR = path.join(HOME, 'zdot')
  assert.equal(c.primaryRc(), path.join(HOME, 'zdot', '.zshrc'))
  fs.mkdirSync(path.join(HOME, 'zdot'), { recursive: true })
  fs.writeFileSync(path.join(HOME, 'zdot', '.zshrc'), `alias cz='CLAUDE_CONFIG_DIR=/tmp/cz claude'\n`)
  assert.ok(c.claudeAccounts().some(a => a.alias === 'cz'), 'its aliases are read too')
  fs.rmSync(path.join(HOME, 'zdot'), { recursive: true })
  if (zdot === undefined) delete process.env.ZDOTDIR; else process.env.ZDOTDIR = zdot
  if (process.platform === 'darwin') {
    process.env.SHELL = '/bin/bash'
    assert.equal(c.primaryRc(), path.join(HOME, '.bash_profile'), 'nothing there yet')
    fs.writeFileSync(path.join(HOME, '.profile'), 'export FROM_PROFILE=1\n')
    assert.equal(c.primaryRc(), path.join(HOME, '.profile'), 'a new .bash_profile would hide it')
    fs.rmSync(path.join(HOME, '.profile'))
  }
  process.env.SHELL = shell
})

test('an alias with a variable we don\'t have isn\'t turned into a path under the current folder', () => {
  const rc = path.join(HOME, '.zshrc')
  const saved = fs.readFileSync(rc, 'utf8')
  fs.writeFileSync(rc, saved + `alias cx='CLAUDE_CONFIG_DIR=$NOT_SET_HERE/x claude'\nalias cy='CLAUDE_CONFIG_DIR=$AL_TEST_DIR/y claude'\n`)
  process.env.AL_TEST_DIR = '/tmp/al-test'
  const accts = c.claudeAccounts()
  assert.ok(!accts.some(a => a.alias === 'cx'))
  assert.equal(accts.find(a => a.alias === 'cy')?.dir, '/tmp/al-test/y')
  delete process.env.AL_TEST_DIR
  fs.writeFileSync(rc, saved)
})

test('which finds commands without the which program, and node paths are ones that will last', () => {
  assert.equal(c.which('definitely-not-a-command-here'), null)
  const dir = fs.mkdtempSync(path.join(HOME, 'bin-')), f = path.join(dir, 'tool')
  fs.writeFileSync(f, '#!/bin/sh\n', { mode: 0o755 })
  const PATH0 = process.env.PATH
  process.env.PATH = `/nowhere:${dir}`
  assert.equal(c.which('tool'), fs.realpathSync(dir) === dir ? f : c.which('tool'))
  assert.equal(c.which('nope'), null)
  // fnm's name for node, on Linux: a link for one shell, gone after a reboot
  const shellDir = path.join(HOME, 'fnm_multishells', '123_456', 'bin')
  fs.mkdirSync(shellDir, { recursive: true })
  fs.symlinkSync(process.execPath, path.join(shellDir, 'node'))
  process.env.PATH = shellDir
  assert.doesNotMatch(c.nodePath(), /fnm_multishells/)
  process.env.PATH = PATH0
})

test('the hook is only ever agentlink\'s, and a user\'s other hooks stay as they were', () => {
  const dir = path.join(HOME, '.claude-hooks'), file = path.join(dir, 'settings.json')
  fs.mkdirSync(dir, { recursive: true })
  const theirs = { hooks: { Stop: [{ matcher: 'x', hooks: [] }, { hooks: [{ type: 'command', command: '~/bin/notify-agentlink wake' }] }], PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'lint' }] }] } }
  fs.writeFileSync(file, JSON.stringify(theirs))
  c.installHook(dir)
  const on = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(on.hooks.PostToolUse.at(-1).matcher, 'mcp__agentlink__inbox', 'reading the inbox arms it again: an interrupted turn fires nothing else')
  assert.equal(on.hooks.Stop.length, 3)
  c.removeHook(dir)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).hooks, theirs.hooks)
  assert.deepEqual(fs.readdirSync(dir), ['settings.json'], 'and no temporary file is left')
})

test('a Claude Code too old for the hook counts as registered, so `agentlink claude` doesn\'t re-register every time', () => {
  const dir = fs.mkdtempSync(path.join(HOME, 'fake-claude-')), bin = path.join(dir, 'claude')
  fs.writeFileSync(bin, '#!/bin/sh\necho "notice: 9.9.9 is out"\necho "2.1.300 (Claude Code)"\n', { mode: 0o755 })
  const PATH0 = process.env.PATH
  process.env.PATH = `${dir}:${PATH0}`
  assert.deepEqual(c.wakeSupport(), { ok: false, version: '2.1.300' }, 'its version, not a number on another line')
  fs.writeFileSync(path.join(HOME, '.claude.json'), JSON.stringify({ mcpServers: { agentlink: { command: c.adapterCmd()[0], args: c.adapterCmd().slice(1) } } }))
  assert.ok(c.isRegistered(''))
  fs.rmSync(path.join(HOME, '.claude.json'))
  process.env.PATH = PATH0
})

test('print mode and attended sessions, as Claude Code tells its hooks', async () => {
  const { interactive, launchFlags } = await import('../../src/wake.js')
  assert.ok(c.isPrintFlag('-p') && c.isPrintFlag('-cp') && c.isPrintFlag('-pc') && c.isPrintFlag('--print'))
  assert.ok(!c.isPrintFlag('--permission-mode') && !c.isPrintFlag('-c') && !c.isPrintFlag('--plugin-dir'))
  assert.ok(interactive('', '', { CLAUDE_CODE_SESSION_ATTENDED: '1' }), 'an IDE\'s session has no terminal')
  assert.ok(!interactive('claude', 'ttys003', { CLAUDE_CODE_SESSION_ATTENDED: '0' }))
  assert.ok(!interactive('claude -p hi', 'ttys003', { CLAUDE_CODE_SESSION_ATTENDED: '1' }))
  assert.ok(interactive('claude --output-format stream-json', '', { CLAUDE_CODE_SESSION_ATTENDED: '1' }), 'a host that attends its session')
  assert.deepEqual(launchFlags('claude --resume abc --model opus fix it'), ['--resume', '--model'])
  assert.deepEqual(launchFlags('claude --channels server:agentlink server:other -c'), ['--channels', 'server:agentlink', 'server:other', '-c'])
  assert.deepEqual(launchFlags('claude server:agentlink is down'), [])
})
