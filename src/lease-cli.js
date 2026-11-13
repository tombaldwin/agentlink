// `natter lease ...`: leases from a terminal or a script, and `natter beat`, the heartbeat hook.
// (It doesn't load the MCP adapter: the heartbeat runs after every tool call while a lease is held.)
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { homeDir, loadConfig, sanitizeName } from './config.js'
import { Local } from './local.js'
import { fmtLeft, formatLease, formatLeases } from './leases.js'
import { ancestors } from './wake.js'

// a `lease run` lease: renewed every third of this while its command runs, so a command that's
// killed outright frees the resource within this long
const RUN_TTL_MS = Number(process.env.NATTERMATIC_LEASE_RUN_TTL_MS) || 120_000

/**
 * A terminal's claims are held by a name on this machine (`cli`, or --as), so the same name can
 * release them later from anywhere. (The id is this machine's own: another machine can't make it up.)
 * @param {Local} local @param {string} name
 */
const terminalSid = (local, name) => crypto.createHash('sha256').update(`nattermatic-terminal:${local.cfg.identity.fp}:${name}`).digest('base64url').slice(0, 22)

/**
 * @param {string[]} pos @param {Record<string, any>} flags @param {() => Promise<Local>} client
 * @returns {Promise<number>} the exit code
 */
export async function runLease(pos, flags, client) {
  const [sub, resource, ...cmd] = pos
  const minutes = flags.minutes === undefined ? undefined : Number(flags.minutes)
  if (minutes !== undefined && !(minutes > 0)) throw new Error('--minutes needs a number of minutes, such as 30')
  const ttl = minutes ? { ttl_ms: minutes * 60_000 } : {}
  switch (sub) {
    case 'list': case undefined: {
      if (resource) throw new Error('usage: natter lease list [--host <machine>]')
      console.log(formatLeases(await (await client()).req('POST', '/local/lease', { op: 'list', ...(flags.host ? { host: flags.host } : {}) })))
      return 0
    }
    case 'check': {
      if (!resource || cmd.length) throw new Error('usage: natter lease check <resource>')
      const r = await (await client()).req('POST', '/local/lease', { op: 'check', resource })
      console.log(r.lease ? `${r.resource}: ${formatLease(r.lease)}` : `${r.resource} is free`)
      return r.lease ? 1 : 0
    }
    case 'claim': case 'release': {
      if (!resource || cmd.length) throw new Error(`usage: natter lease ${sub} <resource>${sub === 'claim' ? ' --note <why> [--minutes <n>]' : ''}`)
      const local = await client()
      const name = sanitizeName(flags.as || 'cli')
      const r = await local.req('POST', '/local/lease', { op: sub, kind: 'process', name, sid: terminalSid(local, name), resource, note: flags.note || '', ...ttl })
      if (sub === 'claim') {
        if (r.ok) console.log(`${r.renewed ? 'renewed' : 'claimed'} ${r.resource} as ${name}: ${fmtLeft(r.lease.left_s * 1000)} (claim again to renew, release when done)`)
        else console.log(`not claimed: ${r.resource} is ${formatLease(r.lease)}`)
      } else console.log(r.ok ? (r.released ? `released ${r.resource}` : `${r.resource} wasn't held`) : `not released: ${r.resource} is held by ${r.lease.holder}`)
      return r.ok ? 0 : 1
    }
    case 'break': {
      if (!resource || cmd.length) throw new Error('usage: natter lease break <resource>')
      const r = await (await client()).req('POST', '/local/lease', { op: 'break', resource, by: 'cli' })
      console.log(r.broken ? `broke ${r.resource} (it was ${formatLease(r.lease)})${r.lease.kind === 'session' ? '; its holder has been told' : ''}` : `${r.resource} wasn't held`)
      return 0
    }
    case 'run': {
      if (!resource || !cmd.length) throw new Error('usage: natter lease run <resource> [--note <why>] [--max <minutes>] -- <command...>')
      return run(await client(), resource, cmd, flags)
    }
  }
  throw new Error(`unknown lease command "${sub}": natter lease [list | check | claim | release | break | run]`)
}

/**
 * Hold a lease exactly as long as a command runs: claimed before it starts (or it doesn't start),
 * renewed while it runs, released when it ends. A hard cap (--max) still applies.
 * @param {Local} local @param {string} resource @param {string[]} cmd @param {Record<string, any>} flags
 */
async function run(local, resource, cmd, flags) {
  const name = sanitizeName(flags.as || process.env.NATTERMATIC_NAME || path.basename(process.cwd()))
  const sid = crypto.randomBytes(16).toString('base64url')
  const max = Number(flags.max) > 0 ? { cap_ms: Number(flags.max) * 60_000 } : {}
  // the note is shown to every agent on the network: never the command line, which may hold secrets
  const body = { kind: 'process', name, sid, resource, note: flags.note || `running ${path.basename(cmd[0])}`, ttl_ms: RUN_TTL_MS, ...max }
  const r = await local.req('POST', '/local/lease', { op: 'claim', ...body })
  if (!r.ok) { console.error(`natter: not started: ${r.resource} is ${formatLease(r.lease)}`); return 75 }
  console.error(`natter: holding ${r.resource} while this runs`)
  let done = false, lost = false
  /** @type {Promise<unknown>} */
  let renewing = Promise.resolve()
  const timer = setInterval(() => {
    if (done || lost) return
    renewing = local.req('POST', '/local/lease', { op: 'renew', ...body }).then(x => {
      if (!x.ok && !done) { lost = true; console.error(`natter: the lease on ${r.resource} has ended (it was broken, or reached its limit); the command carries on without it`) }
    }, e => { if (!done) console.error(`natter: couldn't renew the lease on ${r.resource}: ${e instanceof Error ? e.message : e}`) })
  }, Math.max(1000, RUN_TTL_MS / 3))
  // the command is in the terminal's process group, so Ctrl-C reaches it already: don't send it twice
  const ignore = () => {}
  const term = () => child.kill('SIGTERM')
  process.on('SIGINT', ignore); process.on('SIGHUP', ignore); process.on('SIGTERM', term)
  const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit' })
  /** @type {{ code: number | null, sig: NodeJS.Signals | null }} */
  const out = await new Promise(res => {
    child.on('error', e => { console.error(`natter: couldn't run ${cmd[0]}: ${e.message}`); res({ code: 127, sig: null }) })
    child.on('exit', (code, sig) => res({ code, sig }))
  })
  done = true
  clearInterval(timer)
  await renewing
  if (!lost) await local.req('POST', '/local/lease', { op: 'release', ...body }).catch(() => {})
  process.off('SIGINT', ignore); process.off('SIGHUP', ignore); process.off('SIGTERM', term)
  // end the way the command did, so a shell loop sees a Ctrl-C as one
  if (out.sig) { process.kill(process.pid, out.sig); return 128 + (os.constants.signals[out.sig] || 0) }
  return out.code ?? 1
}

/**
 * The heartbeat hook, after each tool call in a Claude Code session that holds a lease: tells the
 * node the session is active, so its leases are renewed. It never reads what the hook is given (the
 * tool call), never starts a node, says nothing, and always exits 0.
 */
export async function runBeat() {
  try {
    if (fs.existsSync(path.join(homeDir(), 'disabled'))) return 0
    const local = new Local(loadConfig())
    const told = Number(process.env.CLAUDE_PID) || 0
    await local.req('POST', '/local/lease', { op: 'beat', pids: told ? [told] : ancestors() }, '', 1500)
  } catch {}
  return 0
}
