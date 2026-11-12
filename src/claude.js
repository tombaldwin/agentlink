// Claude Code integration for machines with several Claude accounts (CLAUDE_CONFIG_DIR).
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { cmpVersion, ensureHomeDir, errMsg, homeDir, shQuote as sq, writeAtomic } from './config.js'

import { SEA, BIN } from './self.js'
import { oldHome, renamedRule } from './legacy.js'
export { BIN }
const HOME = os.homedir()
const BEGIN = '# >>> nattermatic >>> (managed by `natter setup`; re-run it to refresh)'
const END = '# <<< nattermatic <<<'
// the block as agentlink wrote it, before the rename: read as this one
const OLD_BEGIN = '# >>> agentlink >>> (managed by `agentlink setup`; re-run it to refresh)', OLD_END = '# <<< agentlink <<<'
const renamedBlock = (/** @type {string} */ s) => s.split('\n').map(l => l === OLD_BEGIN ? BEGIN : l === OLD_END ? END : l).join('\n')
// one token: the option is variadic, so a separate value would also swallow a following prompt
const CHANNEL_FLAGS = ['--dangerously-load-development-channels=server:nattermatic']
// claude subcommands that must not get the channel flags
const SUBCOMMANDS = new Set(['mcp', 'config', 'doctor', 'update', 'upgrade', 'install', 'migrate-installer',
  'setup-token', 'plugin', 'plugins', 'agents', 'auth', 'login', 'logout', '-v', '--version', '-h', '--help'])

/**
 * A node path that survives upgrades (e.g. /opt/homebrew/bin/node rather than .../Cellar/node/23.6.0/bin/node)
 * and reboots: fnm's name for node on Linux is a link made for one shell, in a directory that goes
 * with it. If an upgrade has already deleted the node running this, any that's there will do.
 */
export function nodePath() {
  const real = (/** @type {string} */ p) => { try { return fs.realpathSync(p) } catch { return null } }
  const me = real(process.execPath)
  const cands = /** @type {string[]} */ ([which('node'), '/opt/homebrew/bin/node', '/usr/local/bin/node'].filter(c => c !== null && !/\/fnm_multishells\/|^\/run\//.test(c)))
  return cands.find(c => me ? real(c) === me : real(c)) || process.execPath
}
/** The command that runs nattermatic: node and bin/natter.js, or the single executable. */
export const selfCmd = () => SEA ? [process.execPath] : [nodePath(), '--no-warnings', BIN]
export const adapterCmd = () => [...selfCmd(), 'mcp']

/**
 * Can Claude Code actually start the adapter it is registered with? Runs the registered command
 * with --check (which loads the adapter and its dependencies, then exits). Without this, a broken
 * install (say, a git clone without \`npm install\`) only shows up as a session that silently has
 * no nattermatic. Returns null if it starts, otherwise why not.
 * @returns {string | null}
 */
export function checkAdapter() {
  const [cmd, ...args] = adapterCmd()
  const r = spawnSync(cmd, [...args, '--check'], { encoding: 'utf8', timeout: 20_000 })
  if (r.status === 0) return null
  const why = (r.error ? errMsg(r.error) : (r.stderr || r.stdout || `exit ${r.status}`)).trim().split('\n').filter(Boolean).slice(-2).join(' ')
  const root = path.dirname(path.dirname(BIN))
  const clone = !SEA && fs.existsSync(path.join(root, '.git')) && !fs.existsSync(path.join(root, 'node_modules'))
  return clone ? `${why} — this is a git clone without its dependencies: run \`npm install\` in ${root}, then \`natter setup\` again` : why
}
/** Double-quote for sh, escaping the characters that stay special inside double quotes. */
const dq = (/** @type {unknown} */ v) => `"${String(v).replace(/[\\"$`]/g, '\\$&')}"`

/** Full path of `cmd` on PATH, or null. (Not `which`: some systems don't have it.) @param {string} cmd */
export function which(cmd) {
  for (const dir of (process.env.PATH || '').split(':').filter(Boolean)) {
    const f = path.resolve(dir, cmd)
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f } catch {}
  }
  return null
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

/** Where zsh keeps its files. */
const zshDir = () => process.env.ZDOTDIR || HOME
function rcFiles() {
  const files = ['.zshrc', '.zprofile', '.bashrc', '.bash_profile', '.bash_login', '.profile'].map(f => path.join(HOME, f))
  return [...new Set([path.join(zshDir(), '.zshrc'), path.join(zshDir(), '.zprofile'), ...files])].filter(f => fs.existsSync(f))
}
export function primaryRc() {
  const shell = path.basename(process.env.SHELL || '')
  if (shell === 'zsh') return path.join(zshDir(), '.zshrc')
  if (shell === 'bash' && process.platform !== 'darwin') return path.join(HOME, '.bashrc')
  // bash reads the first of these it finds at login, as Terminal starts it: a new file would hide the others
  if (shell === 'bash') {
    const files = ['.bash_profile', '.bash_login', '.profile'].map(f => path.join(HOME, f))
    return files.find(f => fs.existsSync(f)) || files[0]
  }
  return path.join(HOME, '.profile')
}

/** A path as the shell would see it, or as far as we can tell: a variable we don't have stays as it is. @param {string} p */
const expand = p => p.replace(/^~(?=\/|$)/, HOME).replace(/\$(?:\{(\w+)\}|(\w+))/g, (m, a, b) => (a || b) === 'HOME' ? HOME : process.env[a || b] ?? m)
const escRe = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// never across another BEGIN: a block that lost its END mustn't take the user's lines with it
const BLOCK = `${escRe(BEGIN)}(?:(?!${escRe(BEGIN)})[\\s\\S])*?${escRe(END)}`
const stripBlock = (/** @type {string} */ s) => s.replace(new RegExp(`\\n?${BLOCK}\\n?`, 'g'), '\n').split('\n').filter(l => l !== BEGIN && l !== END).join('\n')

/** Shell aliases that run claude with a CLAUDE_CONFIG_DIR, e.g. alias claude2='CLAUDE_CONFIG_DIR="$HOME/.claude2" claude' */
function accountAliases() {
  const out = []
  for (const rc of rcFiles()) {
    let text
    try { text = stripBlock(fs.readFileSync(rc, 'utf8')) } catch { continue }    // one we can't read has nothing to tell us
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*alias\s+([\w.-]+)=(['"])(.*)\2\s*$/)
      if (!m) continue
      // the alias's value as the shell sees it: undo the quoting it was written with
      const value = m[2] === "'" ? m[3].replace(/'\\''/g, "'") : m[3].replace(/\\([\\"$`])/g, '$1')
      if (!/(^|\s)claude(\s|$)/.test(value)) continue
      const d = value.match(/CLAUDE_CONFIG_DIR=(?:"([^"]+)"|'([^']+)'|([^\s"']+))/)
      const dir = d && (d[1] || d[2] || d[3])
      if (!dir || /\\/.test(dir)) continue
      // a variable this process doesn't have: the path can't be known, and a guess would make one up
      const full = expand(dir)
      if (path.isAbsolute(full) && !full.includes('$')) out.push({ name: m[1], value, dir: path.resolve(full) })
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
  // accounts enabled by `natter claude` under a CLAUDE_CONFIG_DIR found nowhere above
  for (const d of registeredDirs()) if (!byDir.has(d) && fs.existsSync(d)) byDir.set(d, { dir: d, alias: `claude-${path.basename(d).replace(/^\./, '')}` })
  return [...byDir.values()]
}

const accountsFile = () => path.join(homeDir(), 'accounts.json')
/** Account dirs nattermatic has registered with (so uninstall can find them all). @returns {string[]} */
function registeredDirs() {
  try { const v = JSON.parse(fs.readFileSync(accountsFile(), 'utf8')); return Array.isArray(v) ? v.filter(d => typeof d === 'string' && d) : [] } catch { return [] }
}
/** @param {string} dir */
function rememberDir(dir) {
  if (!dir) return
  const dirs = registeredDirs()
  if (dirs.includes(dir)) return
  try { writeAtomic(accountsFile(), JSON.stringify([...dirs, dir]) + '\n', 0o600) } catch {}
}

/** Claude's per-account config file ('' = default account). @param {string} dir */
const configFile = dir => dir ? path.join(dir, '.claude.json') : path.join(HOME, '.claude.json')

/** @param {string} dir */
export function isRegistered(dir) {
  try {
    const servers = JSON.parse(fs.readFileSync(configFile(dir), 'utf8')).mcpServers
    const s = servers?.nattermatic
    if (servers?.agentlink) return false      // still registered under the old name
    if (!s || JSON.stringify([s.command, ...(s.args || [])]) !== JSON.stringify(adapterCmd())) return false
    // (a Claude Code too old for the hook is registered without it)
    return WAKE_EVENTS.every(ev => readSettings(settingsFile(dir)).hooks?.[ev]?.some((/** @type {any} */ g) => g.hooks?.some((/** @type {any} */ h) => isWakeHook(h) && h.command === wakeCmd()))) || !wakeSupport().ok
  } catch { return false }
}

/** @param {string} dir */
const envFor = dir => {
  const env = { ...process.env }
  if (dir) env.CLAUDE_CONFIG_DIR = dir
  else delete env.CLAUDE_CONFIG_DIR
  return env
}

/** Register the nattermatic MCP server (user scope) in one account. @param {string} dir */
export function register(dir) {
  const claude = claudeBin()
  if (!claude) throw new Error('claude not found on PATH')
  const env = envFor(dir)
  /** @type {any} */
  let was = null
  try { was = JSON.parse(fs.readFileSync(configFile(dir), 'utf8')).mcpServers?.nattermatic } catch {}
  spawnSync(claude, ['mcp', 'remove', '-s', 'user', 'nattermatic'], { stdio: 'ignore', env })
  spawnSync(claude, ['mcp', 'remove', '-s', 'user', 'agentlink'], { stdio: 'ignore', env })    // its name before the rename
  const r = spawnSync(claude, ['mcp', 'add', '-s', 'user', 'nattermatic', '--', ...adapterCmd()], { encoding: 'utf8', env })
  if (r.status !== 0) {
    // what worked before is better than nothing
    if (was?.command) spawnSync(claude, ['mcp', 'add', '-s', 'user', 'nattermatic', '--', was.command, ...(was.args || [])], { stdio: 'ignore', env })
    throw new Error((r.stderr || r.stdout || `exit ${r.status}`).trim())
  }
  rememberDir(dir)
  if (wakeSupport().ok) installHook(dir)
}

/**
 * Remove nattermatic from a Claude account. Returns false if Claude Code wasn't found to remove its
 * MCP server registration (only the hook was removed).
 * @param {string} dir
 */
export function unregister(dir) {
  const claude = claudeBin()
  if (claude) for (const name of ['nattermatic', 'agentlink']) spawnSync(claude, ['mcp', 'remove', '-s', 'user', name], { stdio: 'ignore', env: envFor(dir) })
  removeHook(dir)
  return !!claude
}

// The hook that wakes idle sessions. It ends when it wakes the session, so each of these arms it
// again: a session starting, each prompt, the end of a turn, a turn that failed (which isn't a Stop),
// and reading the inbox, which is what a woken session does first: a turn the user then interrupts
// ends with neither Stop nor StopFailure. It runs in the background for as long as the session is
// idle, and Claude Code enforces a timeout even so: 20 days, the most a timer can hold with room to spare.
const WAKE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'PostToolUse']
// the oldest Claude Code this has been tested with. Older ones may not know these hook events, and
// settings they can't read would affect far more than nattermatic, so they don't get the hook
export const WAKE_MIN_CLAUDE = '2.1.318'
const WAKE_TIMEOUT_S = 20 * 86400
// reading messages and seeing who's online run unattended; sending keeps the session's normal rules
const WAKE_TOOLS = ['mcp__nattermatic__inbox', 'mcp__nattermatic__peers']

const settingsFile = (/** @type {string} */ dir) => path.join(dir || path.join(HOME, '.claude'), 'settings.json')
const wakeCmd = () => [...selfCmd().map(a => a.startsWith('-') ? a : sq(a)), 'wake'].join(' ')
/** @param {any} h */
// (agentlink: the hook as it was before the rename, replaced by this one)
const isWakeHook = h => typeof h?.command === 'string' && /(^|[\s'"/])(natter|nattermatic|agentlink)(\.js)?['"]? wake$/.test(h.command)

/** @param {string} file @returns {Record<string, any>} */
function readSettings(file) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch (e) {
    if (/** @type {any} */ (e).code === 'ENOENT' && !isDangling(file)) return {}
    throw new Error(`can't read ${file}, so nattermatic left it alone (${errMsg(e)})`)
  }
  // never overwrite settings we can't read: they're the user's
  try { const v = JSON.parse(text); if (v && typeof v === 'object' && !Array.isArray(v)) return v } catch {}
  throw new Error(`${file} isn't valid JSON, so nattermatic left it alone. Fix it, then run natter setup again`)
}
/** A symlink to nothing: writing through it would quietly replace the link. @param {string} file */
function isDangling(file) { try { return fs.lstatSync(file).isSymbolicLink() } catch { return false } }
/**
 * Replace one of the user's files in one step, keeping its mode, and through a symlink (they're often
 * links into dotfiles). @param {string} file @param {string | Buffer} data @param {number} mode if it's new
 */
function replaceFile(file, data, mode) {
  const real = fs.existsSync(file) ? fs.realpathSync(file) : file
  writeAtomic(real, data, fs.existsSync(real) ? fs.statSync(real).mode & 0o777 : mode)
}
/** @param {string} file @param {Record<string, any>} s */
function writeSettings(file, s) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  replaceFile(file, JSON.stringify(s, null, 2) + '\n', 0o600)     // they can hold secrets in `env`
}
/** `s` with no nattermatic hook left, keeping everything else. @param {Record<string, any>} s */
function withoutHook(s) {
  if (!s.hooks || typeof s.hooks !== 'object') return s
  let took = false
  for (const ev of WAKE_EVENTS) {
    if (!Array.isArray(s.hooks[ev])) continue
    s.hooks[ev] = s.hooks[ev].flatMap((/** @type {any} */ g) => {
      if (!Array.isArray(g?.hooks) || !g.hooks.some(isWakeHook)) return [g]
      took = true
      const hooks = g.hooks.filter((/** @type {any} */ h) => !isWakeHook(h))
      return hooks.length ? [{ ...g, hooks }] : []
    })
    if (took && !s.hooks[ev].length) delete s.hooks[ev]
  }
  if (took && !Object.keys(s.hooks).length) delete s.hooks
  return s
}

/** Add the wake hook to one account's settings. @param {string} dir */
export function installHook(dir) {
  const file = settingsFile(dir)
  const s = withoutHook(readSettings(file))
  s.hooks ??= {}
  for (const ev of WAKE_EVENTS) (s.hooks[ev] ??= []).push({ ...(ev === 'PostToolUse' ? { matcher: 'mcp__nattermatic__inbox' } : {}), hooks: [{ type: 'command', command: wakeCmd(), async: true, asyncRewake: true, timeout: WAKE_TIMEOUT_S }] })
  s.permissions ??= {}
  // rules the user wrote for agentlink's tools, such as allowing send, keep applying under the new name
  for (const k of ['allow', 'ask', 'deny']) if (Array.isArray(s.permissions[k])) s.permissions[k] = [...new Set(s.permissions[k].map(renamedRule))]
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
    s.permissions.allow = s.permissions.allow.filter((/** @type {string} */ t) => !WAKE_TOOLS.includes(t) && !WAKE_TOOLS.includes(renamedRule(t)))
    if (!s.permissions.allow.length) delete s.permissions.allow
    if (!Object.keys(s.permissions).length) delete s.permissions
  }
  if (JSON.stringify(s) !== before) writeSettings(file, s)
}

/** Can the Claude Code here run the wake hook? @returns {{ ok: boolean, version: string }} */
export function wakeSupport() {
  const claude = claudeBin()
  const r = claude ? spawnSync(claude, ['--version'], { encoding: 'utf8', timeout: 15_000 }) : null
  const version = (r?.stdout || '').match(/^\d+\.\d+\.\d+/m)?.[0] || ''
  return { ok: !!version && cmpVersion(version, WAKE_MIN_CLAUDE) >= 0, version }
}

// Shell files are the user's, in whatever encoding: latin1 keeps every byte as it was
const readRc = (/** @type {string} */ rc) => {
  try { return fs.readFileSync(rc, 'latin1') } catch (e) {
    if (/** @type {any} */ (e).code === 'ENOENT' && !isDangling(rc)) return ''
    throw e                                              // never write over what we couldn't read
  }
}
const writeRc = (/** @type {string} */ rc, /** @type {string} */ text) => replaceFile(rc, Buffer.from(text, 'latin1'), 0o644)
const asRc = (/** @type {string} */ s) => Buffer.from(s, 'utf8').toString('latin1')
const fromRc = (/** @type {string} */ s) => Buffer.from(s, 'latin1').toString('utf8')
/** The PATH directory in a managed block, if it has one. @param {string} text */
function blockDir(text) {
  const m = text.match(new RegExp(BLOCK))?.[0].match(/^export PATH="((?:[^"\\]|\\.)*)":"\$PATH"$/m)
  return m ? fromRc(m[1]).replace(/\\(.)/g, '$1') : null
}
// `natter uninstall` takes the PATH line out and `natter setup` puts it back, with no installer to say what it was
const pathDirFile = () => path.join(homeDir(), 'bin-dir')

/**
 * Rewrite the managed block in the shell rc: the PATH entry, if one is needed. It used to hold launch
 * aliases too; a re-run clears those. With nothing to add, nothing is added, least of all a new file.
 * @param {{ pathDir?: string }} [opts]
 */
export function writeShellBlock({ pathDir } = {}) {
  const rc = primaryRc()
  const cur = readRc(rc)
  // a PATH line agentlink wrote into its old home: that home is this one now
  const prevDir = blockDir(renamedBlock(cur))?.replace(new RegExp(`^${escRe(oldHome())}(?=/|$)`), homeDir()) ?? null
  let saved = null
  try { saved = fs.readFileSync(pathDirFile(), 'utf8').trim() || null } catch {}
  // a re-run from a normal shell doesn't know the installer's bin dir: keep the one we wrote before
  const dir = pathDir || prevDir || saved
  // compare with the PATH the user's shell had before the installer touched it. A dir we wrote stays:
  // it may be on this shell's PATH only because of our line
  const userPath = (process.env.NATTERMATIC_ORIG_PATH || process.env.PATH || '').split(':')
  const line = dir && (dir === prevDir || dir === saved || !userPath.includes(dir)) ? `export PATH=${asRc(dq(dir))}:"$PATH"` : null
  const rest = stripBlock(renamedBlock(cur))
  const next = line ? `${rest.replace(/\n*$/, '\n')}\n${BEGIN}\n${line}\n${END}\n` : rest
  if (next !== cur) writeRc(rc, next)
  fs.rmSync(pathDirFile(), { force: true })
}

/** Take the managed block out of the shell files. Returns what couldn't be done. */
export function removeShellBlock() {
  /** @type {string[]} */
  const problems = []
  for (const rc of rcFiles()) {
    try {
      const cur = renamedBlock(readRc(rc))
      if (!cur.includes(BEGIN)) continue
      const dir = blockDir(cur)
      if (dir) try { ensureHomeDir(); writeAtomic(pathDirFile(), dir, 0o600) } catch {}    // only a convenience
      const rest = stripBlock(cur)
      // nothing of the user's left: an empty ~/.bash_profile would go on hiding ~/.profile
      if (!rest.trim() && /\.bash_(profile|login)$/.test(rc) && !fs.lstatSync(rc).isSymbolicLink()) fs.rmSync(rc)
      else writeRc(rc, rest)
    } catch (e) { problems.push(`could not update ${rc}: ${errMsg(e)}`) }
  }
  return problems
}

/** Is this word Claude Code's print option, alone or among other short ones (-cp)? @param {string} w */
export const isPrintFlag = w => /^(-[a-zA-Z]*p[a-zA-Z]*|--print)(=|$)/.test(w)

/**
 * `natter claude [args]`: run claude for the current account with nattermatic enabled.
 * @param {string[]} args
 * @param {() => Promise<unknown>} ensureNode
 */
export async function launchClaude(args, ensureNode) {
  const claude = claudeBin()
  if (!claude) { console.error('nattermatic: claude not found on PATH'); process.exit(127) }
  const dir = process.env.CLAUDE_CONFIG_DIR ? path.resolve(expand(process.env.CLAUDE_CONFIG_DIR)) : ''
  // subcommands, print mode (which ignores channels) and an uninstalled nattermatic run claude as is
  const disabled = fs.existsSync(path.join(homeDir(), 'disabled'))
  if (disabled) console.error('nattermatic: uninstalled on this machine (run `natter setup` to re-enable); starting claude without it')
  const passthrough = disabled || (args[0] && SUBCOMMANDS.has(args[0]))
  const print = args.some(isPrintFlag)
  if (!passthrough) {
    if (!isRegistered(dir)) {
      try { register(dir); console.error(`nattermatic: enabled for this Claude account (${dir || 'default'})`) }
      catch (e) { console.error(`nattermatic: could not register with this account: ${errMsg(e)}`) }
      const broken = checkAdapter()
      if (broken) console.error(`nattermatic: WARNING: Claude Code can't start nattermatic, so this session won't have it: ${broken}`)
    }
    await Promise.resolve().then(ensureNode).catch(e => console.error(`nattermatic: ${errMsg(e)}`))   // never blocks claude
  }
  // NATTERMATIC_CHANNEL tells the adapter that this session really has the channel enabled; without
  // it (a plain `claude`), pushed messages would be ignored, so the adapter keeps them for `inbox`
  const channel = !passthrough && !print
  const env = { ...process.env, NATTERMATIC_CHANNEL: channel ? '1' : '' }   // not inherited from an outer session
  const child = spawn(claude, channel ? [...CHANNEL_FLAGS, ...args] : args, { stdio: 'inherit', env })
  process.on('SIGINT', () => {})                       // the child owns the terminal, and gets this from it
  for (const sig of /** @type {const} */ (['SIGTERM', 'SIGHUP'])) process.on(sig, () => child.kill(sig))
  child.on('error', e => { console.error(`nattermatic: could not start claude: ${errMsg(e)}`); process.exit(127) })
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 + (os.constants.signals[signal] || 0) : 1)))
}
