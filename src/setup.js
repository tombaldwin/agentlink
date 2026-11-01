// One-shot machine setup: config, background service, Claude Code registration, shell alias.
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import { writeConfig, readConfigFile, loadConfig, newSecret, homeDir, ensureHomeDir, normHost, tailscaleName, errMsg } from './config.js'
import { Local } from './local.js'
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
 * @param {{ secret?: string, host?: string, peers?: string[], noService?: boolean, noClaude?: boolean, noAlias?: boolean, newNetwork?: boolean }} opts
 */
export async function setup({ secret, host, peers = [], noService, noClaude, noAlias, newNetwork }) {
  noService ||= process.env.AGENTLINK_NO_SERVICE === '1'
  if (secret && String(secret).length < 24) throw new Error('network secret must be at least 24 characters (omit it to generate one)')
  if (host) host = normHost(host)   // throws before anything is written
  console.log(`agentlink setup`)
  // an unreadable config.json stops setup: treating it as empty would replace the network secret
  const existing = readConfigFile() || {}
  // the running node (if any) only accepts requests signed with the secret it was started with
  /** @type {import('./types.js').Config | null} */
  let prev = null
  try { prev = loadConfig() } catch {}
  // re-running setup without a secret refreshes this machine; it never silently leaves the network
  if (!secret && existing.secret && !newNetwork) {
    secret = existing.secret
    ok('keeping this machine\'s existing network (use --new-network to create a new one)')
  }
  const fresh = !secret
  secret ||= newSecret()
  const allPeers = [...new Set([...(existing.secret === secret ? existing.peers || [] : []), ...peers])]
  writeConfig({ secret, peers: allPeers, ...(host ? { host } : {}) })
  fs.rmSync(path.join(homeDir(), 'disabled'), { force: true })
  const cfg = loadConfig()
  ok(`config written to ${path.join(homeDir(), 'config.json')} — this machine is ${cfg.host}`)

  // stop any node already running (e.g. an older version or one started by a session), so the
  // new config takes effect; sign the request with whichever secret that node may be using
  const local = new Local(cfg)
  await stopRunningNode(prev ? [prev, cfg] : [cfg])

  if (!noService) {
    try {
      installService()
      ok('background node installed (starts at login, restarts if it dies)')
      for (let i = 0; i < 50 && !await local.health(); i++) await sleep(100)   // let the service win the port
    } catch (e) { warn(`could not install background service (${errMsg(e)}); sessions will start the node on demand`) }
  }
  try { const h = await local.ensureNode(); ok(`node running on port ${cfg.port} (pid ${h.pid})`) }
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
  console.log(`\n${fresh ? 'New network created. ' : ''}${invitePrompt(cfg)}`)
}

/** Stop the node on this machine, trying each candidate config's port and secret. */
/** @param {import('./types.js').Config[]} cfgs */
async function stopRunningNode(cfgs) {
  for (const c of cfgs) {
    const l = new Local(c)
    const h = await l.health()
    if (!h || h.net !== c.net) continue
    try { await l.req('POST', '/local/shutdown') } catch (e) { warn(`could not stop the running node: ${errMsg(e)}`); continue }
    for (let i = 0; i < 30 && await l.health(); i++) await sleep(100)
    return
  }
  for (const c of new Map(cfgs.map(c => [c.port, c])).values()) {
    const h = await new Local(c).health()
    if (h) warn(`a node on another network is using port ${c.port} (pid ${h.pid}); stop it so the new config can take effect`)
  }
}

/** Percent-encode so the result is safe both in a URL query and inside a double-quoted shell word. */
const urlSafe = (/** @type {string} */ s) => encodeURIComponent(s).replace(/[!'()*~]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())

/** The one line to paste on another machine: fetches the installer from this machine's node. */
/** @type {(cfg: { secret: string, port: number, host: string }, host?: string) => string} */
export const installLine = (cfg, host = cfg.host) => `curl -fsSL "http://${host}:${cfg.port}/install?k=${urlSafe(cfg.secret)}" | sh`

/** Ready-to-paste instructions (for a person, or for Claude) to add another machine. */
/** @param {import('./types.js').Config} cfg */
export function invitePrompt(cfg) {
  const ts = tailscaleName()
  let prompt = `Join my agentlink network: run  ${installLine(cfg)}`
  if (ts) prompt += `  — if ${cfg.host} can't be reached, run  ${installLine(cfg, ts)}  instead`
  prompt += ` — then tell me how to start Claude with agentlink enabled.`
  return `To add another machine, paste this into Claude Code on it (or just run the command):

  ${prompt}

Keep it private: it contains this network's secret.${ts ? '' : `
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
  console.log(`Removed service, Claude Code registrations and shell aliases. Config/messages remain in ${homeDir()} (delete it to wipe).`)
}

/** systemd unit quoting: double quotes, escaped \\ and ", and % doubled (specifier escape). */
const sdQuote = (/** @type {unknown} */ v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`
const esc = (/** @type {unknown} */ s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
