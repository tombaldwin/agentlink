#!/usr/bin/env -S node --no-warnings
import { loadConfig, VERSION } from '../src/config.js'

const [cmd, ...rest] = process.argv.slice(2)
const flags = {}, pos = []
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=')
    let val = v
    if (val === undefined) val = rest[i + 1] && !rest[i + 1].startsWith('--') && ['name', 'from', 'host', 'peer'].includes(k) ? rest[++i] : true
    if (k === 'peer') (flags.peer ||= []).push(val)
    else flags[k] = val
  } else pos.push(a)
}

const HELP = `agentlink ${VERSION} — wake-on-message networking for AI agents

  agentlink setup [secret]      set up this machine (no secret = keep this machine's network,
                                or create one if it has none; --new-network to start over)
  agentlink claude [args...]    start Claude Code (current account) with agentlink enabled
  agentlink send <to> <msg...>  send a message, e.g. agentlink send buffy@anya.local "hi"
  agentlink peers               who's online
  agentlink status              node status, queues, known machines
  agentlink invite              print the prompt/command to add another machine
  agentlink uninstall           remove service and Claude Code registration

  agentlink node                run the node (normally run by the background service)
  agentlink mcp [--poll|--channel] [--name N]   MCP adapter (normally run by Claude Code)`

async function main() {
  switch (cmd) {
    case 'setup': {
      const { setup } = await import('../src/setup.js')
      return setup({ secret: pos[0], host: flags.host, peers: flags.peer || [], noService: flags['no-service'], noClaude: flags['no-claude'], noAlias: flags['no-alias'], newNetwork: flags['new-network'] })
    }
    case 'node': {
      const { runNode } = await import('../src/node.js')
      const { Local } = await import('../src/local.js')
      const fs = await import('node:fs')
      const path = await import('node:path')
      const { homeDir } = await import('../src/config.js')
      // If another agentlink node already serves this port (e.g. one a session started), wait
      // quietly and take over when it exits, instead of crash-looping under launchd/systemd.
      // Every attempt re-reads the config and honours `agentlink uninstall`, so a long-waiting
      // standby never revives an uninstalled node or serves a config that setup has since replaced.
      for (let waited = false; ;) {
        if (fs.existsSync(path.join(homeDir(), 'disabled'))) { console.error('agentlink is uninstalled on this machine; not starting the node'); return }
        const cfg = loadConfig()
        try { await runNode(cfg); return } catch (e) {
          if (e.code !== 'EADDRINUSE') throw e
          const h = await new Local(cfg).health()
          if (!h || h.net !== cfg.net) { console.error(`port ${cfg.port} is in use by something else`); process.exit(1) }
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
      return launchClaude(process.argv.slice(3), () => new Local(loadConfig()).ensureNode())
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
      const { invitePrompt } = await import('../src/setup.js')
      return console.log(invitePrompt(loadConfig()))
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

main().catch(e => { console.error(`agentlink: ${e.message}`); process.exit(1) })
