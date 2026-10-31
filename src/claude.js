// Claude Code integration for machines with several Claude accounts (CLAUDE_CONFIG_DIR).
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agentlink.js')
const HOME = os.homedir()
const BEGIN = '# >>> agentlink >>> (managed by `agentlink setup`; re-run it to refresh)'
const END = '# <<< agentlink <<<'
const CHANNEL_FLAGS = ['--dangerously-load-development-channels', 'server:agentlink']
// claude subcommands that must not get the channel flags
const SUBCOMMANDS = new Set(['mcp', 'config', 'doctor', 'update', 'upgrade', 'install', 'migrate-installer',
  'setup-token', 'plugin', 'plugins', 'agents', 'auth', 'login', 'logout', '-v', '--version', '-h', '--help'])

/** A node path that survives upgrades (e.g. /opt/homebrew/bin/node rather than .../Cellar/node/23.6.0/bin/node). */
export function nodePath() {
  const real = p => { try { return fs.realpathSync(p) } catch { return null } }
  const me = real(process.execPath)
  for (const cand of [which('node'), '/opt/homebrew/bin/node', '/usr/local/bin/node'].filter(Boolean)) {
    if (real(cand) === me) return cand
  }
  return process.execPath
}
export const adapterCmd = () => [nodePath(), '--no-warnings', BIN, 'mcp']
/** Double-quote for sh, escaping the characters that stay special inside double quotes. */
const dq = v => `"${String(v).replace(/[\\"$`]/g, '\\$&')}"`
/** Single-quote for sh. */
const sq = v => `'${String(v).replace(/'/g, `'\\''`)}'`
const launcher = () => `${dq(nodePath())} --no-warnings ${dq(BIN)} claude`

export function which(cmd) {
  const r = spawnSync('which', [cmd], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim().split('\n')[0] : null
}

export function rcFiles() {
  return ['.zshrc', '.zprofile', '.bashrc', '.bash_profile', '.profile'].map(f => path.join(HOME, f)).filter(f => fs.existsSync(f))
}
export function primaryRc() {
  const shell = path.basename(process.env.SHELL || '')
  return path.join(HOME, shell === 'bash' ? (process.platform === 'darwin' ? '.bash_profile' : '.bashrc') : '.zshrc')
}

const expand = p => p.replace(/^~(?=\/|$)/, HOME).replace(/\$\{?HOME\}?/g, HOME)
const stripBlock = s => s.replace(new RegExp(`\\n?${escRe(BEGIN)}[\\s\\S]*?${escRe(END)}\\n?`, 'g'), '\n')
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Shell aliases that run claude with a CLAUDE_CONFIG_DIR, e.g. alias claude2='CLAUDE_CONFIG_DIR="$HOME/.claude2" claude' */
function accountAliases() {
  const out = []
  for (const rc of rcFiles()) {
    const text = stripBlock(fs.readFileSync(rc, 'utf8'))
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*alias\s+([\w.-]+)=(['"])(.*)\2\s*$/)
      if (!m || !/(^|\s)claude(\s|$)/.test(m[3])) continue
      const d = m[3].match(/CLAUDE_CONFIG_DIR=(["']?)([^"'\s]+)\1/)
      if (d) out.push({ name: m[1], value: m[3], dir: path.resolve(expand(d[2])) })
    }
  }
  return out
}

/**
 * All Claude accounts on this machine: the default one plus every CLAUDE_CONFIG_DIR we can find
 * (directories ~/.claude* holding a .claude.json, and dirs named in shell aliases).
 * Returns [{ dir: ''|absPath, alias: 'claude'|'claude2'|..., aliasValue? }]
 */
export function claudeAccounts() {
  const byDir = new Map([['', { dir: '', alias: 'claude' }]])
  for (const e of fs.readdirSync(HOME)) {
    if (!e.startsWith('.claude') || e === '.claude') continue
    const d = path.join(HOME, e)
    try { if (fs.statSync(d).isDirectory() && fs.existsSync(path.join(d, '.claude.json'))) byDir.set(d, { dir: d, alias: e.slice(1) }) } catch {}
  }
  for (const a of accountAliases()) byDir.set(a.dir, { dir: a.dir, alias: a.name, aliasValue: a.value })
  return [...byDir.values()]
}

const configFile = dir => dir ? path.join(dir, '.claude.json') : path.join(HOME, '.claude.json')

export function isRegistered(dir) {
  try {
    const s = JSON.parse(fs.readFileSync(configFile(dir), 'utf8')).mcpServers?.agentlink
    return !!s && JSON.stringify([s.command, ...(s.args || [])]) === JSON.stringify(adapterCmd())
  } catch { return false }
}

const envFor = dir => {
  const env = { ...process.env }
  if (dir) env.CLAUDE_CONFIG_DIR = dir
  else delete env.CLAUDE_CONFIG_DIR
  return env
}

/** Register the agentlink MCP server (user scope) in one account. */
export function register(dir) {
  const claude = which('claude')
  if (!claude) throw new Error('claude not found on PATH')
  const env = envFor(dir)
  spawnSync(claude, ['mcp', 'remove', '-s', 'user', 'agentlink'], { stdio: 'ignore', env })
  const r = spawnSync(claude, ['mcp', 'add', '-s', 'user', 'agentlink', '--', ...adapterCmd()], { encoding: 'utf8', env })
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || `exit ${r.status}`).trim())
}

export function unregister(dir) {
  const claude = which('claude')
  if (claude) spawnSync(claude, ['mcp', 'remove', '-s', 'user', 'agentlink'], { stdio: 'ignore', env: envFor(dir) })
}

/** The `<alias>-link` aliases: each account's own launch command with agentlink + channels enabled. */
export function peerAliases(accounts = claudeAccounts()) {
  return accounts.map(a => {
    let value
    if (a.aliasValue) value = a.aliasValue.replace(/(^|\s)claude(?=\s|$)/, `$1${launcher()}`)
    else if (a.dir) value = `CLAUDE_CONFIG_DIR=${dq(a.dir)} ${launcher()}`
    else value = launcher()
    return { name: `${a.alias}-link`, value }
  })
}

/** Rewrite the managed block in the shell rc (aliases + optional PATH entry). */
export function writeShellBlock({ pathDir } = {}) {
  const rc = primaryRc()
  let cur = ''
  try { cur = fs.readFileSync(rc, 'utf8') } catch {}
  // a re-run from a normal shell doesn't know the installer's bin dir: keep the one we wrote before
  if (!pathDir) {
    const block = cur.match(new RegExp(`${escRe(BEGIN)}[\\s\\S]*?${escRe(END)}`))?.[0] || ''
    const m = block.match(/^export PATH="((?:[^"\\]|\\.)*)":"\$PATH"$/m)
    if (m) return writeBlock(rc, cur, m[1].replace(/\\(.)/g, '$1'), true)
  }
  return writeBlock(rc, cur, pathDir, false)
}

function writeBlock(rc, cur, pathDir, force) {
  const aliases = peerAliases()
  const lines = [BEGIN]
  // compare with the PATH the user's shell had before the installer touched it
  const userPath = (process.env.AGENTLINK_ORIG_PATH || process.env.PATH || '').split(':')
  if (pathDir && (force || !userPath.includes(pathDir))) lines.push(`export PATH=${dq(pathDir)}:"$PATH"`)
  for (const a of aliases) lines.push(`alias ${a.name}=${sq(a.value)}`)
  lines.push(END)
  fs.writeFileSync(rc, stripBlock(cur).replace(/\n*$/, '\n') + '\n' + lines.join('\n') + '\n')
  return { rc, aliases }
}

export function removeShellBlock() {
  for (const rc of rcFiles()) {
    const cur = fs.readFileSync(rc, 'utf8')
    if (cur.includes(BEGIN)) fs.writeFileSync(rc, stripBlock(cur))
  }
}

/** `agentlink claude [args]`: run claude for the current account with agentlink enabled. */
export async function launchClaude(args, ensureNode) {
  const claude = which('claude')
  if (!claude) { console.error('agentlink: claude not found on PATH'); process.exit(127) }
  const dir = process.env.CLAUDE_CONFIG_DIR ? path.resolve(expand(process.env.CLAUDE_CONFIG_DIR)) : ''
  const passthrough = args[0] && SUBCOMMANDS.has(args[0])
  if (!passthrough) {
    if (!isRegistered(dir)) {
      try { register(dir); console.error(`agentlink: enabled for this Claude account (${dir || 'default'})`) }
      catch (e) { console.error(`agentlink: could not register with this account: ${e.message}`) }
    }
    await ensureNode().catch(e => console.error(`agentlink: ${e.message}`))
  }
  const child = spawn(claude, passthrough ? args : [...CHANNEL_FLAGS, ...args], { stdio: 'inherit' })
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => {})  // the child owns the terminal
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 + (os.constants.signals[signal] || 0) : 1)))
}
