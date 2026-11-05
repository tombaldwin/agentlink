#!/usr/bin/env node
import { loadConfig, VERSION } from '../src/config.js'

// (not --no-warnings on the line above: env -S isn't everywhere.) node:sqlite warns when it's loaded
process.removeAllListeners('warning')

const [cmd, ...rest] = process.argv.slice(2)
// Only these are flags; anything else (a message that happens to start with "--") is an argument,
// and "--" ends the flags.
const VALUE_FLAGS = ['name', 'from', 'host', 'peer', 'join', 'pin', 'net', 'token']
const BOOL_FLAGS = ['yes', 'force', 'no-service', 'no-claude', 'no-alias', 'new-network', 'poll', 'channel', 'on-demand', 'revoke', 'list', 'check']
/** @type {Record<string, any>} */
const flags = {}
/** @type {string[]} */
const pos = []
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]
  if (cmd === 'send' && pos.length) { pos.push(a); continue }    // past the address it's the message, whatever it looks like
  if (a === '--') { pos.push(...rest.slice(i + 1)); break }
  const eq = a.indexOf('=')
  const k = a.startsWith('--') ? a.slice(2, eq < 0 ? undefined : eq) : ''
  if (VALUE_FLAGS.includes(k)) {
    const val = eq >= 0 ? a.slice(eq + 1) : rest[++i]
    if (val === undefined) throw usage(`--${k} needs a value`)
    if (k === 'peer') (flags.peer ||= []).push(val)
    else flags[k] = val
  } else if (BOOL_FLAGS.includes(k) && eq < 0) flags[k] = true
  else pos.push(a)
}
function usage(/** @type {string} */ m) { console.error(`agentlink: ${m}`); process.exit(2) }
// a mistyped option (e.g. \`invite --lsit\`) must not run the command as if it weren't there; send
// takes free text and claude passes everything on to Claude Code
if (!['send', 'claude'].includes(cmd)) { const bad = pos.find(a => a.startsWith('-')); if (bad) usage(`unknown option ${bad} (see agentlink help)`) }

const HELP = `agentlink ${VERSION} — wake-on-message networking for AI agents

  agentlink setup               set up this machine (keeps its network, or creates one if it has
                                none; --new-network to start over). Joining uses the invite line.
  agentlink claude [args...]    start Claude Code with channels instead of the wake hook (optional)
  agentlink send <to> <msg...>  send a message, e.g. agentlink send reviewer@laptop.local "hi"
  agentlink peers               who's online
  agentlink status              node status, queues, known machines
  agentlink invite [--list|--revoke]  print a one-time line to add another machine
                                (--list: show unused ones; --revoke: cancel them)
  agentlink remove <host>       remove a machine from the network (it can no longer send or receive)
  agentlink compact [--yes]     on the founding machine: shrink the member list to current members
                                (--force: go ahead even if machines couldn't be checked in time)
  agentlink uninstall           remove service and Claude Code registration

  agentlink node                run the node (normally run by the background service)
  agentlink mcp [--poll|--channel] [--name N]   MCP adapter (normally run by Claude Code)`

async function main() {
  switch (cmd) {
    case 'setup': {
      const { setup } = await import('../src/setup.js')
      if (pos.length) throw new Error('agentlink no longer uses a shared network secret: to join a network, run the line printed by `agentlink invite` on a member')
      return setup({ host: flags.host, peers: flags.peer || [], noService: flags['no-service'], noClaude: flags['no-claude'], noAlias: flags['no-alias'], newNetwork: flags['new-network'], join: flags.join, pin: flags.pin, net: flags.net, token: flags.token || process.env.AGENTLINK_TOKEN })
    }
    case 'node': {
      const { runNode } = await import('../src/node.js')
      const { Local } = await import('../src/local.js')
      const fs = await import('node:fs')
      const path = await import('node:path')
      const { homeDir } = await import('../src/config.js')
      // If another agentlink node already serves this port (e.g. one a session started), the service
      // waits quietly and takes over when it exits, instead of crash-looping under launchd/systemd.
      // A node started on demand by a session (--on-demand) just exits: one node is enough.
      // Every attempt re-reads the config and honours `agentlink uninstall`, so a long-waiting
      // standby never revives an uninstalled node or serves a config that setup has since replaced.
      for (let waited = false; ;) {
        if (fs.existsSync(path.join(homeDir(), 'disabled'))) { console.error('agentlink is uninstalled on this machine; not starting the node'); return }
        const cfg = loadConfig()
        try { await runNode(cfg); return } catch (e) {
          if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EADDRINUSE') throw e
          const local = new Local(cfg)
          const h = await local.health()
          if (!h || 'foreign' in h) { console.error(`port ${cfg.port} is in use by something else`); process.exit(1) }
          if (flags['on-demand']) { console.error(`another agentlink node (pid ${h.pid}) is already running`); return }
          if (!waited) { console.error(`another agentlink node (pid ${h.pid}) is running; standing by`); waited = true }
          await new Promise(r => setTimeout(r, 5000))
        }
      }
    }
    case 'mcp': {
      const { runAdapter } = await import('../src/mcp.js')   // --check: loading it (and its dependencies) is the check
      if (flags.check) return console.log('ok')
      return runAdapter(loadConfig(), { name: flags.name, poll: !!flags.poll, channel: flags.channel ? true : undefined })
    }
    case 'wake': {                              // run by the Claude Code hook, not by people
      const { runWake } = await import('../src/wake.js')
      process.exit(await runWake())
    }
    case 'claude': {
      const { launchClaude } = await import('../src/claude.js')
      const { Local } = await import('../src/local.js')
      return launchClaude(process.argv.slice(3), async () => new Local(loadConfig()).ensureNode())
    }
    case 'send': {
      if (pos.length < 2) throw new Error('usage: agentlink send <name@host> <message>')
      const local = await client()
      const r = await local.req('POST', '/local/send', { from: flags.from || 'cli', to: pos[0], body: pos.slice(1).join(' ') })
      return console.log(r.status)
    }
    case 'peers': {
      const p = await (await client()).req('GET', '/local/peers')
      console.log(`${p.self} (this machine): ${p.local.join(', ') || '(no agents)'}`)
      for (const r of p.remote) console.log(`${r.host}: ${r.online ? (r.sessions.join(', ') || '(no agents)') : `offline${r.error ? ` — ${r.error}` : ''}`}`)
      return
    }
    case 'status':
      return console.log(JSON.stringify(await (await client()).req('GET', '/local/status'), null, 2))
    case 'invite': {
      const local = await client()
      if (pos.length) throw new Error('usage: agentlink invite [--list|--revoke]')
      if (flags.revoke) return console.log(`revoked ${(await local.req('POST', '/local/invite/revoke')).revoked} unused invite(s)`)
      if (flags.list) {
        const { invites } = await local.req('GET', '/local/invites')
        const { formatInvites } = await import('../src/setup.js')
        return console.log(formatInvites(invites))
      }
      const { invitePrompt } = await import('../src/setup.js')
      return console.log(invitePrompt(await local.req('POST', '/local/invite')))
    }
    case 'remove': {
      if (pos.length !== 1) throw new Error('usage: agentlink remove <host>')
      const r = await (await client()).req('POST', '/local/remove', { host: pos[0] })
      return console.log(`removed ${r.removed}: it can no longer send to or receive from this network`)
    }
    case 'compact': {
      if (pos.length) throw new Error('usage: agentlink compact [--yes]')
      const r = await (await client()).req('POST', '/local/compact', { confirm: !!flags.yes, force: !!flags.force }, '', 150_000)
      const off = r.offline.length ? [`Not reachable just now, so anything they've heard of is unknown here: ${r.offline.join(', ')}`] : []
      if (flags.yes) return console.log([`member list compacted: ${r.before} bytes to ${r.bytes}. Members: ${r.members.join(', ')}`, ...off].join('\n'))
      return console.log([
        `A snapshot would keep these machines: ${r.members.join(', ')}`,
        ...off,
        ...(r.caughtUp ? [] : ['Not every machine could be checked in time: run this again before going ahead.']),
        `The member list is ${r.bytes} bytes (limit ${r.limit}). A machine added that isn't listed above will need a new invite, and removed machines are forgotten.`,
        'A removal this machine has not heard of can be undone by this, if the machine that made it is removed too: check any machine you removed from elsewhere is gone from the list above.',
        'Run `agentlink compact --yes` to go ahead.',
      ].join('\n'))
    }
    case 'uninstall': {
      const { uninstall } = await import('../src/setup.js')
      return await uninstall()
    }
    case '--version': case 'version': return console.log(VERSION)
    default: console.log(HELP)
  }
}

async function client() {
  const { Local } = await import('../src/local.js')
  const local = new Local(loadConfig())
  await local.ensureNode()
  return local
}

main().catch(e => { console.error(`agentlink: ${e instanceof Error ? e.message : e}`); process.exit(1) })
