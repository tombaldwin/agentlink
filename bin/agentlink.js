#!/usr/bin/env -S node --no-warnings
import { loadConfig, VERSION } from '../src/config.js'

const [cmd, ...rest] = process.argv.slice(2)
// Only these are flags; anything else (a message that happens to start with "--") is an argument,
// and "--" ends the flags.
const VALUE_FLAGS = ['name', 'from', 'host', 'peer', 'join', 'pin', 'token']
const BOOL_FLAGS = ['no-service', 'no-claude', 'no-alias', 'new-network', 'poll', 'channel', 'on-demand', 'revoke']
/** @type {Record<string, any>} */
const flags = {}
/** @type {string[]} */
const pos = []
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]
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

const HELP = `agentlink ${VERSION} — wake-on-message networking for AI agents

  agentlink setup               set up this machine (keeps its network, or creates one if it has
                                none; --new-network to start over). Joining uses the invite line.
  agentlink claude [args...]    start Claude Code (current account) with agentlink enabled
  agentlink send <to> <msg...>  send a message, e.g. agentlink send buffy@anya.local "hi"
  agentlink peers               who's online
  agentlink status              node status, queues, known machines
  agentlink invite [--revoke]   print a one-time line to add another machine (--revoke: cancel unused ones)
  agentlink remove <host>       remove a machine from the network (it can no longer send or receive)
  agentlink uninstall           remove service and Claude Code registration

  agentlink node                run the node (normally run by the background service)
  agentlink mcp [--poll|--channel] [--name N]   MCP adapter (normally run by Claude Code)`

async function main() {
  switch (cmd) {
    case 'setup': {
      const { setup } = await import('../src/setup.js')
      if (pos.length) throw new Error('agentlink no longer uses a shared network secret: to join a network, run the line printed by `agentlink invite` on a member')
      return setup({ host: flags.host, peers: flags.peer || [], noService: flags['no-service'], noClaude: flags['no-claude'], noAlias: flags['no-alias'], newNetwork: flags['new-network'], join: flags.join, pin: flags.pin, token: flags.token })
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
      const { runAdapter } = await import('../src/mcp.js')
      return runAdapter(loadConfig(), { name: flags.name, poll: !!flags.poll, channel: flags.channel ? true : undefined })
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
      for (const r of p.remote) console.log(`${r.host}: ${r.online ? (r.sessions.join(', ') || '(no agents)') : 'offline'}`)
      return
    }
    case 'status':
      return console.log(JSON.stringify(await (await client()).req('GET', '/local/status'), null, 2))
    case 'invite': {
      const local = await client()
      if (flags.revoke) return console.log(`revoked ${(await local.req('POST', '/local/invite/revoke')).revoked} unused invite(s)`)
      const { invitePrompt } = await import('../src/setup.js')
      return console.log(invitePrompt(await local.req('POST', '/local/invite')))
    }
    case 'remove': {
      if (pos.length !== 1) throw new Error('usage: agentlink remove <host>')
      const r = await (await client()).req('POST', '/local/remove', { host: pos[0] })
      return console.log(`removed ${r.removed}: it can no longer send to or receive from this network`)
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
