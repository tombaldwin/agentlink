// Claude Code integration for machines with several Claude accounts (CLAUDE_CONFIG_DIR).
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { errMsg, homeDir } from './config.js'

import { SEA, BIN } from './self.js'
export { BIN }
const HOME = os.homedir()
const BEGIN = '# >>> agentlink >>> (managed by `agentlink setup`; re-run it to refresh)'
const END = '# <<< agentlink <<<'
// one token: the option is variadic, so a separate value would also swallow a following prompt
const CHANNEL_FLAGS = ['--dangerously-load-development-channels=server:agentlink']
// claude subcommands that must not get the channel flags
const SUBCOMMANDS = new Set(['mcp', 'config', 'doctor', 'update', 'upgrade', 'install', 'migrate-installer',
  'setup-token', 'plugin', 'plugins', 'agents', 'auth', 'login', 'logout', '-v', '--version', '-h', '--help'])

/** A node path that survives upgrades (e.g. /opt/homebrew/bin/node rather than .../Cellar/node/23.6.0/bin/node). */
export function nodePath() {
  const real = (/** @type {string} */ p) => { try { return fs.realpathSync(p) } catch { return null } }
  const me = real(process.execPath)
  for (const cand of [which('node'), '/opt/homebrew/bin/node', '/usr/local/bin/node'].filter(c => c !== null)) {
    if (real(cand) === me) return cand
  }
  return process.execPath
}
/** The command that runs agentlink: node and bin/agentlink.js, or the single executable. */
export const selfCmd = () => SEA ? [process.execPath] : [nodePath(), '--no-warnings', BIN]
export const adapterCmd = () => [...selfCmd(), 'mcp']

/**
 * Can Claude Code actually start the adapter it is registered with? Runs the registered command
 * with --check (which loads the adapter and its dependencies, then exits). Without this, a broken
 * install (say, a git clone without \`npm install\`) only shows up as a session that silently has
 * no agentlink. Returns null if it starts, otherwise why not.
 * @returns {string | null}
 */
export function checkAdapter() {
  const [cmd, ...args] = adapterCmd()
  const r = spawnSync(cmd, [...args, '--check'], { encoding: 'utf8', timeout: 20_000 })
  if (r.status === 0) return null
  const why = (r.error ? errMsg(r.error) : (r.stderr || r.stdout || `exit ${r.status}`)).trim().split('\n').filter(Boolean).slice(-2).join(' ')
  const root = path.dirname(path.dirname(BIN))
  const clone = !SEA && fs.existsSync(path.join(root, '.git')) && !fs.existsSync(path.join(root, 'node_modules'))
  return clone ? `${why} — this is a git clone without its dependencies: run \`npm install\` in ${root}, then \`agentlink setup\` again` : why
}
/** Double-quote for sh, escaping the characters that stay special inside double quotes. */
const dq = (/** @type {unknown} */ v) => `"${String(v).replace(/[\\"$`]/g, '\\$&')}"`
/** Single-quote for sh. */
const sq = (/** @type {unknown} */ v) => `'${String(v).replace(/'/g, `'\\''`)}'`

/** Full path of `cmd` on PATH, or null. @param {string} cmd */
export function which(cmd) {
  const r = spawnSync('which', [cmd], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim().split('\n')[0] : null
}

/** The claude executable: on PATH, or in one of Claude Code's per-user installs, which a shell that
 * didn't load the user's profile can't see (install.sh checks the same places). */
export function claudeBin() {
  const onPath = which('claude')
  if (onPath) return onPath
  for (const f of [path.join(HOME, '.local', 'bin', 'claude'), path.join(HOME, '.claude', 'local', 'claude')]) {
    try { fs.accessSync(f, fs.constants.X_OK); return f } catch {}
  }
  return null
}

export function rcFiles() {
  return ['.zshrc', '.zprofile', '.bashrc', '.bash_profile', '.profile'].map(f => path.join(HOME, f)).filter(f => fs.existsSync(f))
}
export function primaryRc() {
  const shell = path.basename(process.env.SHELL || '')
  if (shell === 'zsh') return path.join(HOME, '.zshrc')
  if (shell === 'bash') return path.join(HOME, process.platform === 'darwin' ? '.bash_profile' : '.bashrc')
  return path.join(HOME, '.profile')
}

const expand = (/** @type {string} */ p) => p.replace(/^~(?=\/|$)/, HOME).replace(/\$\{?HOME\}?/g, HOME)
const stripBlock = (/** @type {string} */ s) => s.replace(new RegExp(`\\n?${escRe(BEGIN)}[\\s\\S]*?${escRe(END)}\\n?`, 'g'), '\n')
const escRe = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Shell aliases that run claude with a CLAUDE_CONFIG_DIR, e.g. alias claude2='CLAUDE_CONFIG_DIR="$HOME/.claude2" claude' */
function accountAliases() {
  const out = []
  for (const rc of rcFiles()) {
    const text = stripBlock(fs.readFileSync(rc, 'utf8'))
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*alias\s+([\w.-]+)=(['"])(.*)\2\s*$/)
      if (!m) continue
      // the alias's value as the shell sees it: undo the quoting it was written with
      const value = m[2] === "'" ? m[3].replace(/'\\''/g, "'") : m[3].replace(/\\([\\"$`])/g, '$1')
      if (!/(^|\s)claude(\s|$)/.test(value)) continue
      const d = value.match(/CLAUDE_CONFIG_DIR=(?:"([^"]+)"|'([^']+)'|([^\s"']+))/)
      const dir = d && (d[1] || d[2] || d[3])
      if (dir && !/\\/.test(dir)) out.push({ name: m[1], value, dir: path.resolve(expand(dir)) })
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
  /** @type {Map<string, import('./types.js').ClaudeAccount>} */
  const byDir = new Map([['', { dir: '', alias: 'claude' }]])
  for (const e of fs.readdirSync(HOME)) {
    if (!e.startsWith('.claude') || e === '.claude') continue
    const d = path.join(HOME, e)
    try { if (fs.statSync(d).isDirectory() && fs.existsSync(path.join(d, '.claude.json'))) byDir.set(d, { dir: d, alias: e.slice(1) }) } catch {}
  }
  for (const a of accountAliases()) byDir.set(a.dir, { dir: a.dir, alias: a.name, aliasValue: a.value })
  // the account this shell is using, wherever it lives
  if (process.env.CLAUDE_CONFIG_DIR) {
    const d = path.resolve(expand(process.env.CLAUDE_CONFIG_DIR))
    if (!byDir.has(d)) byDir.set(d, { dir: d, alias: `claude-${path.basename(d).replace(/^\./, '')}` })
  }
  // accounts enabled by `agentlink claude` under a CLAUDE_CONFIG_DIR found nowhere above
  for (const d of registeredDirs()) if (!byDir.has(d) && fs.existsSync(d)) byDir.set(d, { dir: d, alias: `claude-${path.basename(d).replace(/^\./, '')}` })
  return [...byDir.values()]
}

const accountsFile = () => path.join(homeDir(), 'accounts.json')
/** Account dirs agentlink has registered with (so uninstall can find them all). @returns {string[]} */
function registeredDirs() {
  try { const v = JSON.parse(fs.readFileSync(accountsFile(), 'utf8')); return Array.isArray(v) ? v.filter(d => typeof d === 'string' && d) : [] } catch { return [] }
}
/** @param {string} dir */
function rememberDir(dir) {
  if (!dir) return
  const dirs = registeredDirs()
  if (dirs.includes(dir)) return
  try { fs.writeFileSync(accountsFile(), JSON.stringify([...dirs, dir]) + '\n', { mode: 0o600 }) } catch {}
}

/** Claude's per-account config file ('' = default account). @param {string} dir */
const configFile = dir => dir ? path.join(dir, '.claude.json') : path.join(HOME, '.claude.json')

/** @param {string} dir */
export function isRegistered(dir) {
  try {
    const s = JSON.parse(fs.readFileSync(configFile(dir), 'utf8')).mcpServers?.agentlink
    if (!s || JSON.stringify([s.command, ...(s.args || [])]) !== JSON.stringify(adapterCmd())) return false
    return WAKE_EVENTS.every(ev => readSettings(settingsFile(dir)).hooks?.[ev]?.some((/** @type {any} */ g) => g.hooks?.some((/** @type {any} */ h) => isWakeHook(h) && h.command === wakeCmd())))
  } catch { return false }
}

/** @param {string} dir */
const envFor = dir => {
  const env = { ...process.env }
  if (dir) env.CLAUDE_CONFIG_DIR = dir
  else delete env.CLAUDE_CONFIG_DIR
  return env
}

/** Register the agentlink MCP server (user scope) in one account. @param {string} dir */
export function register(dir) {
  const claude = claudeBin()
  if (!claude) throw new Error('claude not found on PATH')
  const env = envFor(dir)
  spawnSync(claude, ['mcp', 'remove', '-s', 'user', 'agentlink'], { stdio: 'ignore', env })
  const r = spawnSync(claude, ['mcp', 'add', '-s', 'user', 'agentlink', '--', ...adapterCmd()], { encoding: 'utf8', env })
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || `exit ${r.status}`).trim())
  rememberDir(dir)
  if (wakeSupport().ok) installHook(dir)
}

/** @param {string} dir */
export function unregister(dir) {
  const claude = claudeBin()
  if (claude) spawnSync(claude, ['mcp', 'remove', '-s', 'user', 'agentlink'], { stdio: 'ignore', env: envFor(dir) })
  removeHook(dir)
}

// The hook that wakes idle sessions. It ends when it wakes the session, so each of these arms it
// again: a session starting, each prompt, the end of a turn, and a turn that failed (which isn't a
// Stop). It runs in the background for as long as the session is idle, and Claude Code enforces a
// timeout even so: 20 days, the most a timer can hold with room to spare.
const WAKE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure']
// the oldest Claude Code this has been tested with. Older ones may not know these hook events, and
// settings they can't read would affect far more than agentlink, so they don't get the hook
export const WAKE_MIN_CLAUDE = '2.1.318'
const WAKE_TIMEOUT_S = 20 * 86400
// reading messages and seeing who's online run unattended; sending keeps the session's normal rules
const WAKE_TOOLS = ['mcp__agentlink__inbox', 'mcp__agentlink__peers']

const settingsFile = (/** @type {string} */ dir) => path.join(dir || path.join(HOME, '.claude'), 'settings.json')
const wakeCmd = () => [...selfCmd().map(a => a.startsWith('-') ? a : sq(a)), 'wake'].join(' ')
/** @param {any} h */
const isWakeHook = h => typeof h?.command === 'string' && /agentlink(\.js)?['"]? wake$/.test(h.command)

/** @param {string} file @returns {Record<string, any>} */
function readSettings(file) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch (e) {
    if (/** @type {any} */ (e).code === 'ENOENT' && !isDangling(file)) return {}
    throw new Error(`can't read ${file}, so agentlink left it alone (${errMsg(e)})`)
  }
  // never overwrite settings we can't read: they're the user's
  try { const v = JSON.parse(text); if (v && typeof v === 'object' && !Array.isArray(v)) return v } catch {}
  throw new Error(`${file} isn't valid JSON, so agentlink left it alone. Fix it, then run agentlink setup again`)
}
/** A symlink to nothing: writing through it would quietly replace the link. @param {string} file */
function isDangling(file) { try { return fs.lstatSync(file).isSymbolicLink() } catch { return false } }
/** Write settings in place of the real file (settings are often a symlink into dotfiles), with its mode. @param {string} file @param {Record<string, any>} s */
function writeSettings(file, s) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const real = fs.existsSync(file) ? fs.realpathSync(file) : file
  const mode = fs.existsSync(real) ? fs.statSync(real).mode & 0o777 : 0o600     // they can hold secrets in `env`
  const tmp = `${real}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode })
  fs.chmodSync(tmp, mode)
  fs.renameSync(tmp, real)
}
/** `s` with no agentlink hook left, keeping everything else. @param {Record<string, any>} s */
function withoutHook(s) {
  if (!s.hooks || typeof s.hooks !== 'object') return s
  for (const ev of WAKE_EVENTS) {
    if (!Array.isArray(s.hooks[ev])) continue
    s.hooks[ev] = s.hooks[ev].map((/** @type {any} */ g) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter(isWakeHook).length ? g.hooks.filter((/** @type {any} */ h) => !isWakeHook(h)) : g.hooks } : g)).filter((/** @type {any} */ g) => !Array.isArray(g?.hooks) || g.hooks.length)
    if (!s.hooks[ev].length) delete s.hooks[ev]
  }
  if (!Object.keys(s.hooks).length) delete s.hooks
  return s
}

/** Add the wake hook to one account's settings. @param {string} dir */
export function installHook(dir) {
  const file = settingsFile(dir)
  const s = withoutHook(readSettings(file))
  s.hooks ??= {}
  for (const ev of WAKE_EVENTS) (s.hooks[ev] ??= []).push({ hooks: [{ type: 'command', command: wakeCmd(), async: true, asyncRewake: true, timeout: WAKE_TIMEOUT_S }] })
  s.permissions ??= {}
  if (s.permissions.allow === undefined || Array.isArray(s.permissions.allow)) s.permissions.allow = [...new Set([...(s.permissions.allow || []), ...WAKE_TOOLS])]
  writeSettings(file, s)
}

/** @param {string} dir */
export function removeHook(dir) {
  const file = settingsFile(dir)
  if (!fs.existsSync(file)) return
  const before = JSON.stringify(readSettings(file))
  const s = withoutHook(readSettings(file))
  if (Array.isArray(s.permissions?.allow)) {
    s.permissions.allow = s.permissions.allow.filter((/** @type {string} */ t) => !WAKE_TOOLS.includes(t))
    if (!s.permissions.allow.length) delete s.permissions.allow
    if (!Object.keys(s.permissions).length) delete s.permissions
  }
  if (JSON.stringify(s) !== before) writeSettings(file, s)
}

/** Can the Claude Code here run the wake hook? @returns {{ ok: boolean, version: string }} */
export function wakeSupport() {
  const claude = claudeBin()
  const r = claude ? spawnSync(claude, ['--version'], { encoding: 'utf8', timeout: 15_000 }) : null
  const version = (r?.stdout || '').match(/\d+\.\d+\.\d+/)?.[0] || ''
  const parts = (/** @type {string} */ v) => v.split('.').map(Number)
  const [a, b] = [parts(version || '0.0.0'), parts(WAKE_MIN_CLAUDE)]
  const cmp = a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
  return { ok: cmp >= 0, version }
}

/**
 * Rewrite the managed block in the shell rc (the PATH entry, if one is needed). It used to hold
 * launch aliases too; a re-run clears those.
 * @param {{ pathDir?: string }} [opts]
 */
export function writeShellBlock({ pathDir } = {}) {
  const rc = primaryRc()
  let cur = ''
  try { cur = fs.readFileSync(rc, 'utf8') } catch {}
  const block = cur.match(new RegExp(`${escRe(BEGIN)}[\\s\\S]*?${escRe(END)}`))?.[0] || ''
  const m = block.match(/^export PATH="((?:[^"\\]|\\.)*)":"\$PATH"$/m)
  const prevDir = m ? m[1].replace(/\\(.)/g, '$1') : null
  // a re-run from a normal shell doesn't know the installer's bin dir: keep the one we wrote before.
  // A re-run of the installer from a shell that already has our PATH line keeps it too (the dir is
  // only on that shell's PATH because of the line).
  if (!pathDir && prevDir) return writeBlock(rc, cur, prevDir, true)
  return writeBlock(rc, cur, pathDir, !!pathDir && pathDir === prevDir)
}

/**
 * @param {string} rc
 * @param {string} cur
 * @param {string | undefined} pathDir
 * @param {boolean} force
 */
function writeBlock(rc, cur, pathDir, force) {
  const lines = [BEGIN]
  // compare with the PATH the user's shell had before the installer touched it
  const userPath = (process.env.AGENTLINK_ORIG_PATH || process.env.PATH || '').split(':')
  if (pathDir && (force || !userPath.includes(pathDir))) lines.push(`export PATH=${dq(pathDir)}:"$PATH"`)
  lines.push(END)
  fs.writeFileSync(rc, stripBlock(cur).replace(/\n*$/, '\n') + '\n' + lines.join('\n') + '\n')
  return { rc }
}

export function removeShellBlock() {
  for (const rc of rcFiles()) {
    const cur = fs.readFileSync(rc, 'utf8')
    if (cur.includes(BEGIN)) fs.writeFileSync(rc, stripBlock(cur))
  }
}

/** `agentlink claude [args]`: run claude for the current account with agentlink enabled. */
/**
 * @param {string[]} args
 * @param {() => Promise<unknown>} ensureNode
 */
export async function launchClaude(args, ensureNode) {
  const claude = claudeBin()
  if (!claude) { console.error('agentlink: claude not found on PATH'); process.exit(127) }
  const dir = process.env.CLAUDE_CONFIG_DIR ? path.resolve(expand(process.env.CLAUDE_CONFIG_DIR)) : ''
  // subcommands, print mode (which ignores channels) and an uninstalled agentlink run claude as is
  const disabled = fs.existsSync(path.join(homeDir(), 'disabled'))
  if (disabled) console.error('agentlink: uninstalled on this machine (run `agentlink setup` to re-enable); starting claude without it')
  const passthrough = disabled || (args[0] && SUBCOMMANDS.has(args[0]))
  const print = args.some(a => a === '-p' || a === '--print')
  if (!passthrough) {
    if (!isRegistered(dir)) {
      try { register(dir); console.error(`agentlink: enabled for this Claude account (${dir || 'default'})`) }
      catch (e) { console.error(`agentlink: could not register with this account: ${errMsg(e)}`) }
      const broken = checkAdapter()
      if (broken) console.error(`agentlink: WARNING: Claude Code can't start agentlink, so this session won't have it: ${broken}`)
    }
    await Promise.resolve().then(ensureNode).catch(e => console.error(`agentlink: ${errMsg(e)}`))   // never blocks claude
  }
  // AGENTLINK_CHANNEL tells the adapter that this session really has the channel enabled; without
  // it (a plain `claude`), pushed messages would be ignored, so the adapter keeps them for `inbox`
  const channel = !passthrough && !print
  const env = { ...process.env, AGENTLINK_CHANNEL: channel ? '1' : '' }   // not inherited from an outer session
  const child = spawn(claude, channel ? [...CHANNEL_FLAGS, ...args] : args, { stdio: 'inherit', env })
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => {})  // the child owns the terminal
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 + (os.constants.signals[signal] || 0) : 1)))
}
