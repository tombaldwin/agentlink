// One-shot machine setup: config, background service, Claude Code registration, shell alias.
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import net from 'node:net'
import { writeConfig, readConfigFile, loadConfig, homeDir, ensureHomeDir, normHost, machineName, detectHost, validAddr, readIdentity, writeIdentity, keyPath, certPath, rosterPath, errMsg, sleep, writeAtomic } from './config.js'
import { newIdentity, certDer, shortFp, fingerprint } from './cert.js'
import { Roster } from './roster.js'
import { peerCertificate, pinnedRequest } from './tls.js'
import { Local } from './local.js'
import { openStore } from './store.js'
import { appBundle, SEA } from './self.js'
import { codexPresent, installCodex, removeCodex, codexConfigFile } from './codex.js'
import { claudeAccounts, register, unregister, writeShellBlock, removeShellBlock, primaryRc, claudeBin, selfCmd, checkAdapter, wakeSupport, WAKE_MIN_CLAUDE } from './claude.js'

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
/** The agentlink home if it isn't this user's usual one: the Claude accounts and shell files here aren't its own. */
const homeElsewhere = () => !!process.env.AGENTLINK_HOME && path.resolve(homeDir()) !== path.join(os.homedir(), '.agentlink')
const uid = () => process.getuid?.() ?? 0   // launchd domain (macOS only, where getuid exists)
const sleepSync = (/** @type {number} */ ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const ok = (/** @type {string} */ m) => console.log(`  ✓ ${m}`)
const warn = (/** @type {string} */ m) => console.log(`  ! ${m}`)

/**
 * @param {{ host?: string, peers?: string[], noService?: boolean, noClaude?: boolean, noCodex?: boolean, noAlias?: boolean, newNetwork?: boolean,
 *           join?: string, pin?: string, net?: string, token?: string }} opts
 */
export async function setup({ host, peers = [], noService, noClaude, noCodex, noAlias, newNetwork, join, pin, net: netFp, token }) {
  noService ||= process.env.AGENTLINK_NO_SERVICE === '1'
  // what's registered with Claude Code doesn't carry a home with it: it would be this user's usual one
  if (homeElsewhere() && !(noClaude && noCodex && noAlias)) {
    warn(`AGENTLINK_HOME is ${homeDir()}, so the Claude accounts, Codex and shell files of ${os.homedir()} are left alone`)
    noClaude = noCodex = noAlias = true
  }
  if (host) host = normHost(host)   // throws before anything is written
  delete process.env.AGENTLINK_TOKEN            // spent by the join: not for the processes setup starts
  if (join && (!pin || !token)) throw new Error('--join needs --pin and --token (use the line printed by `agentlink invite`)')
  if (join && !validAddr(join)) throw new Error(`--join: "${join}" is not a host:port address`)
  console.log(`agentlink setup`)
  // an unreadable config.json stops setup: treating it as empty would change this machine's settings
  const existing = readConfigFile() || {}
  /** @type {Roster | null} */
  let roster = null
  try { roster = Roster.load(rosterPath()) } catch {}
  const leaving = newNetwork || !!join        // this machine's key is being replaced or checked by a join
  /** @type {import('./types.js').Identity | null} */
  let identity = null
  /** @type {unknown} */
  let unreadable = null
  try { identity = readIdentity() } catch (e) { unreadable = e }     // a key and certificate that don't match, or a damaged one
  if (!identity && !newNetwork) identity = restoreCert(roster)
  if (!identity && unreadable && !leaving) throw unreadable
  if (!identity && !leaving) {
    // part of a machine's identity is missing: making a new one here would silently abandon the network
    if (roster || fs.existsSync(keyPath()) || fs.existsSync(certPath())) {
      throw new Error(`this machine's key files are incomplete (${keyPath()}, ${certPath()}). Restore them, join again with an invite, or start a new network with --new-network`)
    }
  }
  // the running node (if any) only accepts this machine's current key: stop it with that one
  /** @type {import('./types.js').Config | null} */
  let prev = null
  try { prev = loadConfig() } catch {}
  const member = !!(identity && roster?.members.has(identity.fp))
  const memberName = member && identity ? roster?.members.get(identity.fp)?.host : undefined
  const asked = host || (process.env.AGENTLINK_HOST ? normHost(process.env.AGENTLINK_HOST) : undefined)
  // the name this machine has on its network is fixed by the roster; a new network can pick a new one
  const myHost = asked || memberName || normHost(existing.host || detectHost())
  // wherever it came from: the roster won't take it, and that's no state to find out in
  if (!machineName(myHost)) throw new Error(`"${myHost}" can't identify a machine on the network: run agentlink setup --host <name>`)
  /** @type {string[]} */
  let allPeers = []
  let banner = ''
  // print an invite: only for a new network. A machine that just joined doesn't get one: an open
  // invite makes the machine recognisable on its port for a day, and you add machines when you need them
  let invite = false

  if (join) {
    // 1. the machine at the invite's address must present the key the invite names (its invite key)
    let inviter
    try { inviter = await peerCertificate(join) } catch (e) { throw new Error(`cannot reach ${join}: ${errMsg(e)}`) }
    if (inviter.fp !== pin) throw new Error(`the machine at ${join} is not presenting this invite's key. Either the invite was already used, expired or was revoked (run \`agentlink invite\` on a member for a new one), or something else is answering at that address. Not joining.`)
    // 2. keep this machine's key only if it is already a member of that same network (a key that
    // isn't carried between networks can't be used to link them)
    let same = member && !!netFp && roster?.net === netFp && !!identity
    let id = same && identity ? identity : newIdentity()
    // 3. join: the inviter checks the token and adds our key under our name
    const ask = async () => {
      try {
        return await pinnedRequest({ addr: join, method: 'POST', path: '/join', body: JSON.stringify({ token, host: myHost, cert: certDer(id.cert) }), trust: [{ pem: inviter.pem, fp: pin }], timeout: 20_000 })
      } catch (e) { throw new Error(`could not join via ${join}: ${errMsg(e)}`) }
    }
    let r = await ask()
    // removed while we weren't told: this key is gone for good, so come back with a new one
    if (r.status === 410 && same) {
      same = false
      id = newIdentity()
      r = await ask()
    }
    /** @type {any} */
    let data = {}
    try { data = JSON.parse(r.text) } catch {}
    if (r.status !== 200) throw new Error(`could not join via ${join}: ${data.error || `HTTP ${r.status}`}`)
    const joined = new Roster({ net: String(data.net), records: data.records }, rosterPath())
    if (joined.members.get(id.fp)?.host !== myHost || !joined.byHost.has(String(data.host)) || (netFp && joined.net !== netFp)) throw new Error(`could not join via ${join}: it did not add this machine`)
    await stopRunningNode(prev ? [prev] : [])
    if (!same) leaveNetwork()
    writeIdentity(id)
    if (same) {
      // what we know and the inviter doesn't (a removal it hasn't heard of) must survive this. Read now:
      // the node may have added to it since setup started
      const mine = Roster.load(rosterPath())
      mine.merge(data.records)
      mine.save()
    } else joined.save()
    allPeers = [...new Set([...(same ? existing.peers || [] : []), join, ...peers])]
    banner = same ? `Already a member of this network (via ${data.host}).` : `Joined the network via ${data.host}.`
  } else if (!member || newNetwork) {
    // a key with no readable roster: making a new key here would silently abandon the network
    if (identity && !roster && !newNetwork) {
      throw new Error(`this machine has a key, but its member list (${rosterPath()}) is missing or unreadable. Restore it, join again with an invite, or start a new network with --new-network`)
    }
    if (identity && roster && !member && !newNetwork) {
      throw new Error(roster.removed.has(identity.fp)
        ? 'this machine was removed from its network. Join again with a new invite (`agentlink invite` on a member), or start a new network with --new-network'
        : 'this machine is not a member of its network. Join with an invite (`agentlink invite` on a member), or start a new network with --new-network')
    }
    const id = newIdentity()
    await stopRunningNode(prev ? [prev] : [])
    leaveNetwork()
    writeIdentity(id)
    Roster.genesis(id, myHost, rosterPath()).save()
    allPeers = [...peers]
    banner = 'New network created.'
    invite = true
  } else {
    if (asked && asked !== memberName) {
      throw new Error(`this machine is on its network as ${memberName}. To rename it, run \`agentlink remove ${memberName}\` on a machine that joined before it, then run a new invite line with \`| sh -s -- --host ${asked}\` at the end. Or start a new network with --new-network`)
    }
    ok('keeping this machine\'s existing network (use --new-network to create a new one)')
    await stopRunningNode(prev ? [prev] : [])
    allPeers = [...new Set([...(existing.peers || []), ...peers])]
  }
  // a port asked for here has to last: the background service doesn't get this environment
  writeConfig({ host: myHost, peers: allPeers, ...(process.env.AGENTLINK_PORT ? { port: Number(process.env.AGENTLINK_PORT) } : {}) })
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

  let broken = null
  if (!noClaude) {
    broken = registerClaude() || checkAdapter()
    if (broken) warn(`Claude Code can't start agentlink, so sessions won't have it until this is fixed: ${broken}`)
  }
  let codexNote = ''
  if (!noCodex && codexPresent()) {
    try {
      const c = installCodex()
      ok(`Codex: agentlink added to ${codexConfigFile()}`)
      if (!c.hook) codexNote = '\nCodex sessions read messages with the inbox tool. Update Codex (it needs `codex queue`) and run agentlink setup again, so they\'re woken too.'
      else if (c.approve) codexNote = '\nCodex asks you to trust agentlink\'s hook the next time it starts: trust it, so Codex sessions are woken by messages.'
    } catch (e) { warn(`Codex: ${errMsg(e)}`) }
  }
  const binDir = process.env.AGENTLINK_BIN_DIR
  if (!noAlias) {
    // agentlink works without this: it mustn't stop setup before it prints the invite
    try { writeShellBlock({ pathDir: binDir }) } catch (e) { warn(`could not update ${primaryRc()} (${errMsg(e)})${binDir ? `; add ${binDir} to your PATH yourself` : ''}`) }
    if (binDir && path.basename(process.env.SHELL || '') === 'fish') warn(`fish doesn't read ${primaryRc()}: run  fish_add_path ${binDir}`)
  }
  // moved to the app from an npm install: the old copy still works, but is no longer what runs
  if (SEA) {
    const real = (/** @type {string} */ p) => { try { return fs.realpathSync(p) } catch { return '' } }
    const old = (process.env.AGENTLINK_ORIG_PATH ?? process.env.PATH ?? '').split(':').filter(d => d && d !== binDir)
      .map(d => path.join(d, 'agentlink')).find(f => real(f) && real(f) !== real(process.execPath))
    if (old) console.log(`  (an earlier npm install of agentlink is still at ${old}; new terminals use the app. Remove the old one with: npm uninstall -g @tombaldwin/agentlink)`)
  }
  console.log(`
${broken ? 'Done, but see the warning above.' : 'Done.'} In any Claude Code session that's already running, type /reload-plugins to join
(or start it again: \`claude --continue\` picks up where it left off). New sessions join by themselves.
Agents address each other as name@host, e.g. "send the test results to reviewer@laptop.local".
Name a session with AGENTLINK_NAME=<name> (default: the project folder name).${codexNote}`)
  if (banner) console.log(`\n${banner}`)
  if (running && invite) {
    try { console.log(`\n${invitePrompt(await local.req('POST', '/local/invite'))}`) }
    catch (e) { warn(`could not create an invite (${errMsg(e)}); run \`agentlink invite\` later`) }
  } else console.log(`\nTo add another machine, ask Claude to make an invite (or run \`agentlink invite\`${running ? '' : ' once the node is running'}).`)
}

/**
 * Rebuild a lost certificate from the member list, which holds every member's. Null if it can't be.
 * @param {Roster | null} roster
 */
function restoreCert(roster) {
  try {
    const m = roster?.members.get(fingerprint(fs.readFileSync(keyPath(), 'utf8')))
    if (!m) return null
    writeAtomic(certPath(), m.pem, 0o644)
    ok(`restored ${certPath()} from the member list`)
    return readIdentity()
  } catch { return null }
}

/**
 * What belonged to the network this machine is leaving. Its invites must not let anyone into the new
 * one, and its messages are from and for machines of the old network: another network's machine with
 * the same name must not be handed them, and nobody on the new one should be shown them. This can't
 * be left half done, because setup starts the node next. If the database can't be cleared (someone
 * has it open, say) it goes; and if that can't be done either, setup stops here.
 */
function leaveNetwork() {
  fs.rmSync(path.join(homeDir(), 'invite.key'), { force: true })
  const file = path.join(homeDir(), 'agentlink.db')
  if (!fs.existsSync(file)) return
  try {
    const db = openStore(file)
    try {
      const left = Number(/** @type {any} */ (db.prepare(`SELECT count(*) n FROM messages WHERE state IN ('pending','queued')`).get()).n)
      db.exec('BEGIN IMMEDIATE; DELETE FROM messages; DELETE FROM invites; DELETE FROM peers; COMMIT')
      if (left) warn(`dropped ${left} undelivered message(s) for the old network`)
    } finally { db.close() }
  } catch (e) {
    warn(`could not clear ${file} (${errMsg(e)}): removing it, with its messages`)
    for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true })
  }
}

/** The port this machine's config says its node is on, if that's known. (A home of its own defaults to nothing: 7777 is another node's.) */
function configuredPort() {
  try { return readConfigFile()?.port || (process.env.AGENTLINK_HOME ? 0 : 7777) } catch { return 0 }
}

/**
 * Stop the node on this machine (it only accepts the key it was started with). It may be on the port
 * in the config while this run has been told another.
 * @param {Pick<import('./types.js').Config, 'identity' | 'port' | 'dir'>[]} cfgs
 */
async function stopRunningNode(cfgs) {
  const list = cfgs.length ? cfgs : keyOnly()
  const port0 = configuredPort()
  let stopped = false
  for (const c of [...list, ...list.filter(x => port0 && x.port !== port0).map(x => ({ ...x, port: port0 }))]) {
    const l = new Local(c)
    const h = await l.health()
    if (!h || 'foreign' in h) continue
    try { await l.req('POST', '/local/shutdown') } catch (e) { warn(`could not stop the running node: ${errMsg(e)}`); continue }
    for (let i = 0; i < 30 && await l.health(); i++) await sleep(100)
    stopped = true
  }
  if (stopped) return
  const port = cfgs[0]?.port || Number(process.env.AGENTLINK_PORT || readConfigFile()?.port || 7777)
  if (await portInUse(port)) warn(`something else is using port ${port} (another network's node, or another program); stop it so this machine's node can start`)
}
/** What it takes to reach the node when the rest of the config won't load: only the key matters. */
function keyOnly() {
  try {
    const key = fs.readFileSync(keyPath(), 'utf8')
    return [{ identity: { key, cert: '', fp: fingerprint(key) }, port: Number(process.env.AGENTLINK_PORT || readConfigFile()?.port || 7777), dir: homeDir() }]
  } catch { return [] }
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

/** Unused invites, for people. @param {{ created_at: number, expires_at: number }[]} invites */
export function formatInvites(invites) {
  if (!invites.length) return 'No unused invites.'
  const t = (/** @type {number} */ ms) => new Date(ms).toLocaleString()
  return [`${invites.length} unused invite(s) (\`agentlink invite --revoke\` cancels them):`,
    ...invites.map(i => `  made ${t(i.created_at)}, expires ${t(i.expires_at)}`)].join('\n')
}

/** Ready-to-paste instructions (for a person, or for Claude) to add another machine. @param {{ token: string, fp: string, host: string, port: number, tailscale?: string | null, ip?: string }} inv */
export function invitePrompt(inv) {
  let prompt = `Join my agentlink network: run  ${installLine(inv, inv.host)}`
  if (inv.tailscale) prompt += `  — if ${inv.host} can't be reached, run  ${installLine(inv, inv.tailscale)}  instead`
  // not every machine can look up .local names (many Linux installs can't); the pinned key makes an IP just as safe
  else if (inv.ip) prompt += `  — if ${inv.host} can't be found, run  ${installLine(inv, inv.ip)}  instead`
  prompt += ` — then tell me to type /reload-plugins. (The -k is safe here: --pinnedpubkey makes curl accept only the key this invite names. If curl fails (a key mismatch or a 404), this invite was already used, expired or was revoked: ask me for a new one.)`
  return `To add another machine, paste this into Claude Code on it (or just run the command):

  ${prompt}

It lets one machine join and expires in 24 hours (\`agentlink invite --revoke\` cancels unused invites).
Once it's used, expired or revoked, curl rejects the line (a key mismatch or a 404): ask Claude for a new invite, or run \`agentlink invite\`.${inv.tailscale ? '' : `
(For machines off this LAN: install Tailscale on both, then run \`agentlink invite\` again.)`}
`
}

/** Enable agentlink for every Claude account here. Returns what's wrong, if it couldn't be done at all. */
function registerClaude() {
  if (!claudeBin()) return 'claude was not found on PATH, in ~/.local/bin or in ~/.claude/local. Run `agentlink setup` from a terminal where `claude` works'
  /** @type {string | null} */
  let failed = null
  for (const acct of claudeAccounts()) {
    const label = acct.dir ? `${acct.alias} (${acct.dir})` : 'default account'
    try { register(acct.dir); ok(`enabled for Claude account: ${label}`) }
    catch (e) { warn(`could not enable for ${label}: ${errMsg(e)}`); failed ||= `could not enable for ${label}` }
  }
  const { ok: wakes, version } = wakeSupport()
  const then = `so sessions won't wake by themselves; they read messages with the inbox tool`
  if (!wakes) warn(version ? `Claude Code ${version} is older than ${WAKE_MIN_CLAUDE}, ${then}. Update Claude Code, then run agentlink setup again` : `couldn't tell which version of Claude Code this is (it needs ${WAKE_MIN_CLAUDE}), ${then}`)
  return failed
}

// ---------- services ----------
function installService() {
  const cfgDir = ensureHomeDir()
  const { label: LABEL, unit: UNIT } = serviceNames()
  const logFile = path.join(cfgDir, 'node.log')
  // the service starts with this user's real home, whatever this run's is
  const env = { PATH: process.env.PATH, ...(path.resolve(cfgDir) !== path.join(os.userInfo().homedir, '.agentlink') ? { AGENTLINK_HOME: cfgDir } : {}) }
  if (process.platform === 'darwin') {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
    const args = [...selfCmd(), 'node']
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
    // bootout returns before launchd has finished removing the job, and loading it again meanwhile
    // fails ("Bootstrap failed: 5: Input/output error"): wait for it to go, then retry the load
    spawnSync('launchctl', ['bootout', `${dom}/${LABEL}`], { stdio: 'ignore' })
    for (let i = 0; i < 50 && spawnSync('launchctl', ['print', `${dom}/${LABEL}`], { stdio: 'ignore' }).status === 0; i++) sleepSync(100)
    for (let i = 0; ; i++) {
      try { execFileSync('launchctl', ['bootstrap', dom, plist], { stdio: 'pipe' }); return } catch (e) {
        if (i >= 9) throw e
        sleepSync(500)
      }
    }
  }
  if (process.platform === 'linux') {
    const unit = path.join(os.homedir(), '.config', 'systemd', 'user', `${UNIT}.service`)
    fs.mkdirSync(path.dirname(unit), { recursive: true })
    fs.writeFileSync(unit, `[Unit]
Description=agentlink agent messaging node

[Service]
ExecStart=${[...selfCmd(), 'node'].map(sdQuote).join(' ')}
${Object.entries(env).map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`).join('\n')}
Restart=always
RestartSec=5
StandardOutput=append:${logFile.replace(/%/g, '%%')}
StandardError=append:${logFile.replace(/%/g, '%%')}

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
  if (homeElsewhere()) warn(`AGENTLINK_HOME is ${homeDir()}, so the Claude accounts and shell files of ${os.homedir()} were left alone`)
  else {
    for (const acct of claudeAccounts()) {
      try { unregister(acct.dir) } catch (e) { warn(errMsg(e)) }     // one account's settings mustn't stop the rest
    }
    removeShellBlock().forEach(warn)
    try { removeCodex() } catch (e) { warn(`Codex: ${errMsg(e)}`) }
  }
  let host = ''
  try { host = loadConfig().host } catch {}
  console.log(`Stopped agentlink and removed its service, its Claude Code registrations and its Codex settings.
Its key, messages and settings remain in ${homeDir()}: \`agentlink setup\` turns it back on as before.
To remove it completely:
  - take this machine off the network: on another member, run  agentlink remove ${host || '<this machine>'}
  - delete ${homeDir()}
  - uninstall the program: ${appBundle() ? `delete ${appBundle()}` : `npm uninstall -g @tombaldwin/agentlink  (not needed if agentlink brought its own Node.js: that lives in ${homeDir()})`}`)
}

/** systemd unit quoting: double quotes, escaped \\ and ", and % doubled (specifier escape). */
const sdQuote = (/** @type {unknown} */ v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`
const esc = (/** @type {unknown} */ s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
