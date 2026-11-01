// One-shot machine setup: config, background service, Claude Code registration, shell alias.
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import net from 'node:net'
import { writeConfig, readConfigFile, loadConfig, homeDir, ensureHomeDir, normHost, detectHost, validAddr, readIdentity, writeIdentity, rosterPath, errMsg } from './config.js'
import { newIdentity, certDer, shortFp } from './cert.js'
import { Roster } from './roster.js'
import { peerCertificate, pinnedRequest } from './tls.js'
import { Local } from './local.js'
import { openStore } from './store.js'
import { claudeAccounts, register, unregister, writeShellBlock, removeShellBlock, claudeBin, nodePath, BIN } from './claude.js'

/**
 * Service names. The usual install (~/.agentlink) gets the plain names; any other agentlink home
 * (AGENTLINK_HOME, or a different $HOME such as a test sandbox) gets its own, so setting one up
 * never boots out and replaces the user's real service.
 */
function serviceNames() {
  const dir = path.resolve(homeDir())
  const usual = path.join(os.userInfo().homedir, '.agentlink')
  const suffix = dir === usual ? '' : '-' + crypto.createHash('sha256').update(dir).digest('hex').slice(0, 8)
  return { label: `com.agentlink.node${suffix}`, unit: `agentlink${suffix}` }
}
const uid = () => process.getuid?.() ?? 0   // launchd domain (macOS only, where getuid exists)
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms))
const ok = (/** @type {string} */ m) => console.log(`  ✓ ${m}`)
const warn = (/** @type {string} */ m) => console.log(`  ! ${m}`)

/**
 * @param {{ host?: string, peers?: string[], noService?: boolean, noClaude?: boolean, noAlias?: boolean, newNetwork?: boolean,
 *           join?: string, pin?: string, net?: string, token?: string }} opts
 */
export async function setup({ host, peers = [], noService, noClaude, noAlias, newNetwork, join, pin, net: netFp, token }) {
  noService ||= process.env.AGENTLINK_NO_SERVICE === '1'
  if (host) host = normHost(host)   // throws before anything is written
  delete process.env.AGENTLINK_TOKEN            // spent by the join: not for the processes setup starts
  if (join && (!pin || !token)) throw new Error('--join needs --pin and --token (use the line printed by `agentlink invite`)')
  if (join && !validAddr(join)) throw new Error(`--join: "${join}" is not a host:port address`)
  console.log(`agentlink setup`)
  // an unreadable config.json stops setup: treating it as empty would change this machine's settings
  const existing = readConfigFile() || {}
  // the running node (if any) only accepts this machine's current key: stop it with that one
  /** @type {import('./types.js').Config | null} */
  let prev = null
  try { prev = loadConfig() } catch {}
  let identity = readIdentity()
  /** @type {Roster | null} */
  let roster = null
  try { roster = Roster.load(rosterPath()) } catch {}
  const member = !!(identity && roster?.members.has(identity.fp))
  // the name this machine has on its network is fixed by the roster; a new network can pick a new one
  const myHost = host || normHost(process.env.AGENTLINK_HOST || (member && identity ? roster?.members.get(identity.fp)?.host : null) || existing.host || detectHost())
  /** @type {string[]} */
  let allPeers = []
  let banner = ''
  let invite = false              // print an invite: only for a new network or a machine that just joined

  if (join) {
    // 1. the machine at the invite's address must present the key the invite names (its invite key)
    let inviter
    try { inviter = await peerCertificate(join) } catch (e) { throw new Error(`cannot reach ${join}: ${errMsg(e)}`) }
    if (inviter.fp !== pin) throw new Error(`the machine at ${join} is not presenting this invite's key. Either the invite was already used, expired or was revoked (run \`agentlink invite\` on a member for a new one), or something else is answering at that address. Not joining.`)
    // 2. keep this machine's key only if it is already a member of that same network (a key that
    // isn't carried between networks can't be used to link them)
    const same = member && !!netFp && roster?.net === netFp && identity
    const id = same && identity ? identity : newIdentity()
    // 3. join: the inviter checks the token and adds our key under our name
    let r
    try {
      r = await pinnedRequest({ addr: join, method: 'POST', path: '/join', body: JSON.stringify({ token, host: myHost, cert: certDer(id.cert) }), trust: [{ pem: inviter.pem, fp: pin }], timeout: 20_000 })
    } catch (e) { throw new Error(`could not join via ${join}: ${errMsg(e)}`) }
    /** @type {any} */
    let data = {}
    try { data = JSON.parse(r.text) } catch {}
    if (r.status !== 200) throw new Error(`could not join via ${join}: ${data.error || `HTTP ${r.status}`}`)
    const joined = new Roster({ net: String(data.net), records: data.records }, rosterPath())
    if (joined.members.get(id.fp)?.host !== myHost || !joined.byHost.has(String(data.host)) || (netFp && joined.net !== netFp)) throw new Error(`could not join via ${join}: it did not add this machine`)
    await stopRunningNode(prev ? [prev] : [])
    if (!same) dropInvites()
    writeIdentity(id)
    joined.save()
    if (myHost !== joined.members.get(id.fp)?.host) throw new Error('internal: name mismatch')
    allPeers = [...new Set([...(same ? existing.peers || [] : []), join, ...peers])]
    banner = same ? `Already a member of this network (via ${data.host}).` : `Joined the network via ${data.host}.`
    invite = !same
  } else if (!member || newNetwork) {
    if (identity && roster && !member && !newNetwork) {
      throw new Error(roster.removed.has(identity.fp)
        ? 'this machine was removed from its network. Join again with a new invite (`agentlink invite` on a member), or start a new network with --new-network'
        : 'this machine is not a member of its network. Join with an invite (`agentlink invite` on a member), or start a new network with --new-network')
    }
    const id = newIdentity()
    await stopRunningNode(prev ? [prev] : [])
    dropInvites()
    writeIdentity(id)
    Roster.genesis(id, myHost, rosterPath()).save()
    allPeers = [...peers]
    banner = 'New network created.'
    invite = true
  } else {
    if (host && host !== roster?.members.get(identity?.fp || '')?.host) {
      throw new Error(`this machine is on its network as ${roster?.members.get(identity?.fp || '')?.host}; to change its name, join again under the new name (an invite plus --host), or start a new network with --new-network`)
    }
    ok('keeping this machine\'s existing network (use --new-network to create a new one)')
    await stopRunningNode(prev ? [prev] : [])
    allPeers = [...new Set([...(existing.peers || []), ...peers])]
  }
  writeConfig({ host: myHost, peers: allPeers })
  fs.rmSync(path.join(homeDir(), 'disabled'), { force: true })
  const cfg = loadConfig()
  ok(`config written to ${path.join(homeDir(), 'config.json')} — this machine is ${cfg.host} (key ${shortFp(cfg.identity.fp)})`)

  const local = new Local(cfg)
  if (!noService) {
    try {
      installService()
      ok('background node installed (starts at login, restarts if it dies)')
      for (let i = 0; i < 50 && !await local.health(); i++) await sleep(100)   // let the service win the port
    } catch (e) { warn(`could not install background service (${errMsg(e)}); sessions will start the node on demand`) }
  }
  let running = false
  try { const h = await local.ensureNode(); ok(`node running on port ${cfg.port} (pid ${'pid' in h ? h.pid : '?'})`); running = true }
  catch (e) { warn(errMsg(e)) }

  if (!noClaude) registerClaude()
  /** @type {string[]} */
  let aliases = []
  if (!noAlias) {
    const r = writeShellBlock({ pathDir: process.env.AGENTLINK_BIN_DIR })
    aliases = r.aliases.map(a => a.name)
    ok(`shell aliases in ${r.rc}: ${aliases.join(', ')}`)
  }

  console.log(`
Done. Open a new terminal, then start Claude with agentlink enabled using:
  ${aliases.join('   ') || 'agentlink claude'}
(or, for any account: CLAUDE_CONFIG_DIR=<dir> agentlink claude — new accounts are enabled automatically)
Agents address each other as name@host, e.g. "send the test results to reviewer@laptop.local".
Name a session with AGENTLINK_NAME=<name> (default: the project folder name).`)
  if (banner) console.log(`\n${banner}`)
  if (running && invite) {
    try { console.log(`\n${invitePrompt(await local.req('POST', '/local/invite'))}`) }
    catch (e) { warn(`could not create an invite (${errMsg(e)}); run \`agentlink invite\` later`) }
  } else console.log(`\nTo add another machine, ask Claude to make an invite (or run \`agentlink invite\`${running ? '' : ' once the node is running'}).`)
}

/** Invites made for the network this machine is leaving must not let anyone into its new one. */
function dropInvites() {
  fs.rmSync(path.join(homeDir(), 'invite.key'), { force: true })
  const file = path.join(homeDir(), 'agentlink.db')
  if (!fs.existsSync(file)) return
  const db = openStore(file)
  try { db.exec('DELETE FROM invites') } finally { db.close() }
}

/** Stop the node on this machine (it only accepts the key it was started with). */
/** @param {import('./types.js').Config[]} cfgs */
async function stopRunningNode(cfgs) {
  for (const c of cfgs) {
    const l = new Local(c)
    const h = await l.health()
    if (!h || 'foreign' in h) continue
    try { await l.req('POST', '/local/shutdown') } catch (e) { warn(`could not stop the running node: ${errMsg(e)}`); continue }
    for (let i = 0; i < 30 && await l.health(); i++) await sleep(100)
    return
  }
  const port = cfgs[0]?.port || Number(process.env.AGENTLINK_PORT || readConfigFile()?.port || 7777)
  if (await portInUse(port)) warn(`something else is using port ${port} (another network's node, or another program); stop it so this machine's node can start`)
}
/** @param {number} port */
function portInUse(port) {
  return new Promise(resolve => {
    const s = net.connect(port, '127.0.0.1', () => { s.destroy(); resolve(true) })
    s.on('error', () => resolve(false))
    s.setTimeout(1000, () => { s.destroy(); resolve(false) })
  })
}

/**
 * The one line to paste on another machine: fetches the installer from this machine's node over
 * TLS pinned to the invite key (curl's -k only skips CA checks; --pinnedpubkey still applies).
 * @param {{ token: string, fp: string, port: number }} inv @param {string} host
 */
export const installLine = (inv, host) =>
  `curl -fsSL -k --pinnedpubkey "sha256//${inv.fp}" "https://${host}:${inv.port}/join/install?t=${inv.token}" | sh`

/** Ready-to-paste instructions (for a person, or for Claude) to add another machine. */
/** @param {{ token: string, fp: string, host: string, port: number, tailscale?: string | null }} inv */
export function invitePrompt(inv) {
  let prompt = `Join my agentlink network: run  ${installLine(inv, inv.host)}`
  if (inv.tailscale) prompt += `  — if ${inv.host} can't be reached, run  ${installLine(inv, inv.tailscale)}  instead`
  prompt += ` — then tell me how to start Claude with agentlink enabled. (The -k is safe here: --pinnedpubkey makes curl accept only the key this invite names. If curl fails (a key mismatch or a 404), this invite was already used, expired or was revoked: ask me for a new one.)`
  return `To add another machine, paste this into Claude Code on it (or just run the command):

  ${prompt}

It lets one machine join and expires in 24 hours (\`agentlink invite --revoke\` cancels unused invites).
Once it's used, expired or revoked, curl rejects the line (a key mismatch or a 404): ask Claude for a new invite, or run \`agentlink invite\`.${inv.tailscale ? '' : `
(For machines off this LAN: install Tailscale on both, then run \`agentlink invite\` again.)`}
`
}

function registerClaude() {
  if (!claudeBin()) return warn('claude not found on PATH — sessions started with `agentlink claude` will register automatically once it is installed')
  for (const acct of claudeAccounts()) {
    const label = acct.dir ? `${acct.alias} (${acct.dir})` : 'default account'
    try { register(acct.dir); ok(`enabled for Claude account: ${label}`) }
    catch (e) { warn(`could not enable for ${label}: ${errMsg(e)}`) }
  }
}

// ---------- services ----------
export function installService() {
  const cfgDir = ensureHomeDir()
  const { label: LABEL, unit: UNIT } = serviceNames()
  const logFile = path.join(cfgDir, 'node.log')
  const env = { PATH: process.env.PATH, ...(process.env.AGENTLINK_HOME ? { AGENTLINK_HOME: cfgDir } : {}) }
  if (process.platform === 'darwin') {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
    const args = [nodePath(), '--no-warnings', BIN, 'node']
    fs.mkdirSync(path.dirname(plist), { recursive: true })
    fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${args.map(a => `<string>${esc(a)}</string>`).join('')}</array>
  <key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${esc(v)}</string>`).join('')}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${esc(logFile)}</string>
  <key>StandardErrorPath</key><string>${esc(logFile)}</string>
</dict></plist>
`)
    const dom = `gui/${uid()}`
    spawnSync('launchctl', ['bootout', `${dom}/${LABEL}`], { stdio: 'ignore' })
    execFileSync('launchctl', ['bootstrap', dom, plist], { stdio: 'pipe' })
    return
  }
  if (process.platform === 'linux') {
    const unit = path.join(os.homedir(), '.config', 'systemd', 'user', `${UNIT}.service`)
    fs.mkdirSync(path.dirname(unit), { recursive: true })
    fs.writeFileSync(unit, `[Unit]
Description=agentlink agent messaging node

[Service]
ExecStart=${[nodePath(), '--no-warnings', BIN, 'node'].map(sdQuote).join(' ')}
${Object.entries(env).map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`).join('\n')}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`)
    execFileSync('systemctl', ['--user', 'daemon-reload'])
    execFileSync('systemctl', ['--user', 'enable', '--now', UNIT])
    spawnSync('loginctl', ['enable-linger', os.userInfo().username], { stdio: 'ignore' }) // keep running when logged out
    return
  }
  throw new Error(`unsupported platform ${process.platform}`)
}

export async function uninstall() {
  const { label: LABEL, unit: UNIT } = serviceNames()
  // stops open sessions from restarting the node
  try { ensureHomeDir(); fs.writeFileSync(path.join(homeDir(), 'disabled'), '') } catch {}
  try {
    const local = new Local(loadConfig())
    if (await local.health()) await local.req('POST', '/local/shutdown')
  } catch {}
  if (process.platform === 'darwin') {
    spawnSync('launchctl', ['bootout', `gui/${uid()}/${LABEL}`], { stdio: 'ignore' })
    fs.rmSync(path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`), { force: true })
  } else if (process.platform === 'linux') {
    spawnSync('systemctl', ['--user', 'disable', '--now', UNIT], { stdio: 'ignore' })
    fs.rmSync(path.join(os.homedir(), '.config', 'systemd', 'user', `${UNIT}.service`), { force: true })
  }
  for (const acct of claudeAccounts()) unregister(acct.dir)
  removeShellBlock()
  let host = ''
  try { host = loadConfig().host } catch {}
  console.log(`Stopped agentlink and removed its service, Claude Code registrations and shell aliases.
Its key, messages and settings remain in ${homeDir()}: \`agentlink setup\` turns it back on as before.
To remove it completely:
  - take this machine off the network: on another member, run  agentlink remove ${host || '<this machine>'}
  - delete ${homeDir()}
  - uninstall the program: npm uninstall -g @tombaldwin/agentlink  (not needed if agentlink brought its own Node.js: that lives in ${homeDir()})`)
}

/** systemd unit quoting: double quotes, escaped \\ and ", and % doubled (specifier escape). */
const sdQuote = (/** @type {unknown} */ v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`
const esc = (/** @type {unknown} */ s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
