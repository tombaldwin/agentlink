// The command line's help, suggestions and completion scripts. Runs bin/natter.js against a
// throwaway home and port, and never with a command that starts a node.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { COMMANDS, suggest, resolve, commandHelp, mainHelp, completionScript } from '../../src/cli.js'

const BIN = fileURLToPath(new URL('../../bin/natter.js', import.meta.url))
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'nattermatic-cli-'))
const env = { ...process.env, NATTERMATIC_HOME: HOME, NATTERMATIC_PORT: '34999', NATTERMATIC_DISCOVERY: '0' }
const run = (/** @type {string[]} */ ...args) => spawnSync(process.execPath, ['--no-warnings', BIN, ...args], { env, encoding: 'utf8', timeout: 10_000 })
const has = (/** @type {string} */ sh) => spawnSync('sh', ['-c', `command -v ${sh}`]).status === 0

test('mistyped commands get the nearest command, and nothing for nonsense', () => {
  assert.equal(suggest('stauts'), 'status')
  assert.equal(suggest('sned'), 'send')
  assert.equal(suggest('compct'), 'compact')
  assert.equal(suggest('inv'), 'invite')                  // a prefix
  assert.equal(suggest('uninstal'), 'uninstall')
  assert.equal(suggest('frobnicate'), undefined)
  assert.equal(suggest('wak'), undefined)                 // hidden commands aren't suggested
})

test('aliases resolve to their commands', () => {
  assert.equal(resolve(undefined), 'help')
  assert.equal(resolve('-h'), 'help')
  assert.equal(resolve('--help'), 'help')
  assert.equal(resolve('--version'), 'version')
  assert.equal(resolve('to'), 'to')
  // agentlink's names for them, before the rename
  assert.equal(resolve('send'), 'to')
  assert.equal(resolve('peers'), 'who')
})

test('every command has help, and the main help lists the visible ones', () => {
  const main = mainHelp('9.9.9')
  for (const c of COMMANDS) {
    assert.match(commandHelp(c), new RegExp(`^Usage: natter ${c.name}`))
    assert.equal(main.includes(`natter ${c.name}`), !c.hidden, c.name)
  }
})

test('--help shows a command\'s help without running it', () => {
  for (const args of [['invite', '--help'], ['setup', '-h'], ['uninstall', '--help'], ['remove', '--help'], ['to', '--help'], ['help', 'compact']]) {
    const r = run(...args)
    assert.equal(r.status, 0, args.join(' '))
    assert.match(r.stdout, new RegExp(`^Usage: natter ${args[0] === 'help' ? args[1] : args[0]}`))
  }
  // the old names show the new ones' help
  assert.match(run('send', '--help').stdout, /^Usage: natter to /)
  assert.match(run('help', 'peers').stdout, /^Usage: natter who/)
  // setup and uninstall would have written to the home folder
  assert.deepEqual(fs.readdirSync(HOME), [])
})

test('after the address, --help is message text', () => {
  // no node runs on the test port, so this fails trying to send rather than printing help
  for (const cmd of ['to', 'send']) assert.doesNotMatch(run(cmd, 'bob@x.local', '--help').stdout, /Usage:/)
})

test('unknown commands and options fail, with a suggestion', () => {
  let r = run('stauts')
  assert.equal(r.status, 2)
  assert.match(r.stderr, /unknown command 'stauts' \(did you mean status\?\)/)
  r = run('frobnicate', '--yes')
  assert.equal(r.status, 2)
  assert.match(r.stderr, /unknown command 'frobnicate'/)
  r = run('invite', '--lsit')
  assert.equal(r.status, 2)
  assert.match(r.stderr, /unknown option --lsit \(see natter invite --help\)/)
  r = run('help', 'nope')
  assert.equal(r.status, 2)
})

test('no arguments, help and version succeed', () => {
  for (const args of [[], ['help'], ['--help'], ['-h']]) {
    const r = run(...args)
    assert.equal(r.status, 0)
    assert.match(r.stdout, /^nattermatic .* — /)
  }
  assert.match(run('version').stdout, /^\d+\.\d+\.\d+/)
})

test('completion addresses are empty, and no node is started, when none is running', () => {
  const r = run('__complete', 'addresses')
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
  assert.ok(!fs.existsSync(path.join(HOME, 'node.log')))
})

test('the completion scripts are valid shell, and other shells are refused', { skip: !has('bash') && 'no bash' }, () => {
  assert.equal(spawnSync('bash', ['-n'], { input: completionScript('bash') }).status, 0)
  if (has('zsh')) assert.equal(spawnSync('zsh', ['-n'], { input: completionScript('zsh') }).status, 0)
  assert.throws(() => completionScript('fish'), /usage/)
})

test('bash completion offers commands, options and help topics', { skip: !has('bash') && 'no bash' }, () => {
  const script = completionScript('bash').replace(/natter __complete/g, 'true')
  const out = spawnSync('bash', ['-c', `${script}
t() { COMP_WORDS=("$@"); COMP_CWORD=$(( $# - 1 )); _natter; echo "\${COMPREPLY[*]}"; }
t natter st; t natter invite --; t natter help co; t natter completion ""`], { encoding: 'utf8' }).stdout.split('\n')
  assert.deepEqual(out.slice(0, 4), ['status', '--list --revoke --help', 'compact completion', 'zsh bash'])
})
