// One-shot machine setup: config, background service, Claude Code registration, shell alias.
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { writeConfig, loadConfig, newSecret, homeDir, tailscaleName } from './config.js'
import { Local } from './local.js'
import { claudeAccounts, register, unregister, writeShellBlock, removeShellBlock, which, nodePath } from './claude.js'

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agentlink.js')
const LABEL = 'com.agentlink.node'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const ok = m => console.log(`  ✓ ${m}`)
const warn = m => console.log(`  ! ${m}`)

export async function setup({ secret, host, peers = [], noService, noClaude, noAlias }) {
  const fresh = !secret
  noService ||= process.env.AGENTLINK_NO_SERVICE === '1'
  if (secret && String(secret).length < 24) throw new Error('network secret must be at least 24 characters (omit it to generate one)')
  secret ||= newSecret()
  console.log(`agentlink setup`)
  let existing = {}
  try { existing = JSON.parse(fs.readFileSync(path.join(homeDir(), 'config.json'), 'utf8')) } catch {}
  const allPeers = [...new Set([...(existing.secret === secret ? existing.peers || [] : []), ...peers])]
  writeConfig({ secret, peers: allPeers, ...(host ? { host } : {}) })
  fs.rmSync(path.join(homeDir(), 'disabled'), { force: true })
  const cfg = loadConfig()
  ok(`config written to ${path.join(homeDir(), 'config.json')} — this machine is ${cfg.host}`)

  // stop any node already running (e.g. an older version or one started by a session)
  const local = new Local(cfg)
  if (await local.health()) { await local.req('POST', '/local/shutdown').catch(() => {}); await sleep(800) }

  if (!noService) {
    try { installService(); ok('background node installed (starts at login, restarts if it dies)') }
    catch (e) { warn(`could not install background service (${e.message}); sessions will start the node on demand`) }
  }
  try { const h = await local.ensureNode(); ok(`node running on port ${cfg.port} (pid ${h.pid})`) }
  catch (e) { warn(e.message) }

  if (!noClaude) registerClaude()
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

/** The one line to paste on another machine: fetches the installer from this machine's node. */
export const installLine = (cfg, host = cfg.host) => `curl -fsSL "http://${host}:${cfg.port}/install?k=${cfg.secret}" | sh`

/** Ready-to-paste instructions (for a person, or for Claude) to add another machine. */
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
  if (!which('claude')) return warn('claude not found on PATH — sessions started with `agentlink claude` will register automatically once it is installed')
  for (const acct of claudeAccounts()) {
    const label = acct.dir ? `${acct.alias} (${acct.dir})` : 'default account'
    try { register(acct.dir); ok(`enabled for Claude account: ${label}`) }
    catch (e) { warn(`could not enable for ${label}: ${e.message}`) }
  }
}

// ---------- services ----------
export function installService() {
  const cfgDir = homeDir()
  fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 })
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
    const dom = `gui/${process.getuid()}`
    spawnSync('launchctl', ['bootout', `${dom}/${LABEL}`], { stdio: 'ignore' })
    execFileSync('launchctl', ['bootstrap', dom, plist], { stdio: 'pipe' })
    return
  }
  if (process.platform === 'linux') {
    const unit = path.join(os.homedir(), '.config', 'systemd', 'user', 'agentlink.service')
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
    execFileSync('systemctl', ['--user', 'enable', '--now', 'agentlink'])
    spawnSync('loginctl', ['enable-linger', os.userInfo().username], { stdio: 'ignore' }) // keep running when logged out
    return
  }
  throw new Error(`unsupported platform ${process.platform}`)
}

export async function uninstall() {
  // stops open sessions from restarting the node
  try { fs.mkdirSync(homeDir(), { recursive: true }); fs.writeFileSync(path.join(homeDir(), 'disabled'), '') } catch {}
  try {
    const local = new Local(loadConfig())
    if (await local.health()) await local.req('POST', '/local/shutdown')
  } catch {}
  if (process.platform === 'darwin') {
    spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], { stdio: 'ignore' })
    fs.rmSync(path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`), { force: true })
  } else if (process.platform === 'linux') {
    spawnSync('systemctl', ['--user', 'disable', '--now', 'agentlink'], { stdio: 'ignore' })
    fs.rmSync(path.join(os.homedir(), '.config', 'systemd', 'user', 'agentlink.service'), { force: true })
  }
  for (const acct of claudeAccounts()) unregister(acct.dir)
  removeShellBlock()
  console.log(`Removed service, Claude Code registrations and shell aliases. Config/messages remain in ${homeDir()} (delete it to wipe).`)
}

/** systemd unit quoting: double quotes, escaped \\ and ", and % doubled (specifier escape). */
const sdQuote = v => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
