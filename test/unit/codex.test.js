// What setup writes to Codex's config.toml, and how it leaves the user's own settings.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { configBlock, withBlock, withoutBlock, clashes, hookCmd, codexWakeText } from '../../src/codex.js'

const USER = `model = "gpt-5"

[projects."/home/me/app"]
trust_level = "trusted"
`

test('the block adds the adapter in poll mode, approves the read tools, and the hook', () => {
  const b = configBlock({ hook: true })
  assert.match(b, /^\[mcp_servers\.agentlink\]$/m)
  assert.match(b, /"mcp", "--poll"\]/)
  assert.match(b, /AGENTLINK_NAME = ""/, 'Codex sessions are named after their folder')
  assert.match(b, /\[mcp_servers\.agentlink\.tools\.inbox\]\napproval_mode = "approve"/)
  assert.match(b, /\[mcp_servers\.agentlink\.tools\.peers\]\napproval_mode = "approve"/)
  assert.doesNotMatch(b, /tools\.send/, 'sending still asks')
  assert.match(b, /\[\[hooks\.SessionStart\]\]\n\[\[hooks\.SessionStart\.hooks\]\]\ntype = "command"/)
  assert.ok(b.includes(JSON.stringify(hookCmd())))
  assert.match(hookCmd(), / codex-hook$/)
  assert.doesNotMatch(configBlock({ hook: false }), /hooks/, 'no hook for a Codex that can\'t queue')
})

test('the block goes at the end, replaces itself in place, and comes out cleanly', () => {
  const once = withBlock(USER, configBlock({ hook: true }))
  assert.ok(once.startsWith(USER.trimEnd() + '\n\n'))
  assert.equal(withBlock(once, configBlock({ hook: true })), once, 'running setup again changes nothing')
  // Codex records its trust for the hook after it: a refreshed block stays where it was
  const trusted = once + '\n[hooks.state."x:session_start:0:0"]\ntrusted_hash = "sha256:1"\n'
  const refreshed = withBlock(trusted, configBlock({ hook: false }))
  assert.ok(refreshed.endsWith('[hooks.state."x:session_start:0:0"]\ntrusted_hash = "sha256:1"\n'))
  assert.doesNotMatch(refreshed, /hooks\.SessionStart/)
  assert.equal(withoutBlock(once), USER)
  assert.equal(withBlock('', configBlock({ hook: true })), configBlock({ hook: true }) + '\n')
})

test('settings the block would clash with are found, and nothing else is', () => {
  assert.deepEqual(clashes(USER), [])
  assert.deepEqual(clashes(USER + '[mcp_servers.other]\ncommand = "x"\n[[hooks.SessionStart]]\n'), [], 'other servers and hooks are fine')
  assert.equal(clashes('[mcp_servers.agentlink]\ncommand = "agentlink"\n').length, 1)
  assert.equal(clashes('[mcp_servers."agentlink".env]\nX = "1"\n').length, 1)
  assert.equal(clashes('[hooks]\nSessionStart = []\n').length, 1)
})

test('the wake note is fixed text that points at the inbox tool', () => {
  assert.match(codexWakeText(1, 'api'), /^\[agentlink\] .* as api, and a new message has arrived/)
  assert.match(codexWakeText(3, 'api'), /3 new messages have arrived/)
  assert.match(codexWakeText(1, 'api'), /inbox tool/)
})
