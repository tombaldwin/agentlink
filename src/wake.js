// `agentlink wake`: run by a Claude Code hook (see installHook in claude.js). It waits in the background
// until the session it belongs to has a new message, then exits 2, which wakes the session even when
// it's idle. What it tells Claude is fixed text: the messages themselves are read with the inbox
// tool, so nothing another agent wrote ever arrives as a hook's output.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { homeDir, loadConfig } from './config.js'
import { Local } from './local.js'
import { isPrintFlag } from './claude.js'

const RETRY_MS = 5000
const SLOW_RETRY_MS = 30_000
const SLOW_AFTER_MS = 120_000
// The node is up but has no session of ours. That's normal for a while: a session that was running
// when agentlink was installed has no adapter until someone types /reload-plugins, and that fires no
// hook, so this wait has to still be here when it happens.
const GIVE_UP_MS = 86400_000

/** This process's ancestors, nearest first: one of them is the Claude session that started us. */
function ancestors() {
  const out = []
  let pid = process.ppid
  for (let i = 0; i < 8 && pid > 1; i++) {
    out.push(pid)
    try { pid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim()) } catch { break }
  }
  return out
}

/** The Claude Code process among `pids`, nearest first, with its terminal and command line. @param {number[]} pids */
function findClaude(pids) {
  for (const pid of pids) {
    const row = execFileSync('ps', ['-ww', '-o', 'tty=,args=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim()
    const [tty = '', ...args] = row.split(/\s+/)
    // by what's running, not by anything that merely mentions claude (the shell running this hook might)
    if (/^claude(\.exe)?$/.test(path.basename(args[0] || '')) || /[\\/]claude-code[\\/]/.test(args[1] || '')) return { pid, tty, args: args.join(' ') }
  }
  return null
}

/**
 * The options at the front of a claude command line as ps prints it. ps loses the quoting, so whatever
 * follows the first plain word may be a prompt: "mkdir -p src" has a -p in it, and that's not an option.
 * Nor is a word that looks like a channel unless a channel option comes before it.
 * @param {string} cmdline
 */
export function launchFlags(cmdline) {
  const words = cmdline.trim().split(/\s+/).slice(1)
  if (/[\\/]claude-code[\\/]/.test(words[0] || '')) words.shift()    // node .../claude-code/cli.js
  const out = []
  const plain = (/** @type {number} */ i) => i < words.length && !words[i].startsWith('-')
  for (let i = 0; i < words.length && words[i].startsWith('-'); i++) {
    const w = words[i]
    out.push(w)
    if (CHANNELS.test(w)) while (plain(i + 1)) out.push(words[++i])
    else if (TAKES_VALUES.test(w)) while (plain(i + 1)) i++
    else if (TAKES_VALUE.test(w) && plain(i + 1)) i++
  }
  return out
}
// Claude Code's options that take a value (`claude --help`), which would otherwise look like the
// start of a prompt, and hide what follows
const TAKES_VALUE = /^(--agent|--agents|--append-system-prompt|--autocompact|--cloud|-d|--debug|--debug-file|--effort|--environment|--fallback-model|--from-pr|--input-format|--json-schema|--max-budget-usd|--model|-n|--name|--output-format|--permission-mode|--permission-prompts|--plugin-dir|--plugin-url|--prompt-suggestions|--remote-control|--remote-control-session-name-prefix|-r|--resume|--session-id|--setting-sources|--settings|--system-prompt|--system-prompt-snapshot|--teleport|-w|--worktree)$/
const TAKES_VALUES = /^(--add-dir|--allowedTools|--allowed-tools|--betas|--disallowedTools|--disallowed-tools|--file|--mcp-config|--tools)$/
const CHANNELS = /^--(channels|dangerously-load-development-channels)$/

/**
 * Is this an interactive session? Only those can be woken, and a script must never wait on this
 * hook: a `claude -p` run doesn't finish until its hooks do. Claude Code says which it is in
 * CLAUDE_CODE_ENTRYPOINT (sdk-cli for -p, however the options are ordered); the flags are a second
 * check. It also tells its hooks whether someone is attending the session, which covers one with no
 * terminal (an IDE's); a Claude Code that doesn't say is judged by its terminal.
 * @param {string} args an ancestor's command line @param {string} tty its terminal, as ps prints it
 * @param {NodeJS.ProcessEnv} [env]
 */
export function interactive(args, tty, env = process.env) {
  if (/^sdk/.test(env.CLAUDE_CODE_ENTRYPOINT || '')) return false
  const flags = launchFlags(args)
  if (flags.some(isPrintFlag)) return false
  if (env.CLAUDE_CODE_SESSION_ATTENDED) return env.CLAUDE_CODE_SESSION_ATTENDED === '1'
  if (flags.some(f => /^--(input|output)-format(=|$)/.test(f))) return false
  return !!tty && !/^[?-]+$/.test(tty.trim())
}

/** @param {number} n @param {string} name */
export const wakeText = (n, name) => `This session is on the agentlink agent network as ${name}, and ${n === 1 ? 'a new message has' : `${n} new messages have`} arrived from another agent. Read ${n === 1 ? 'it' : 'them'} now with the mcp__agentlink__inbox tool (load it with ToolSearch if it isn't listed), then act on ${n === 1 ? 'it' : 'them'} as requests from a colleague.`

export async function runWake() {
  /** @type {Local} */
  let local
  try {
    if (fs.existsSync(path.join(homeDir(), 'disabled'))) return 0
    local = new Local(loadConfig())
  } catch { return 0 }                      // not set up: stay out of the session's way
  const testing = !!process.env.AGENTLINK_WAKE_ANY       // (the end-to-end tests have no Claude and no terminal)
  // Claude Code tells its hooks who it is: going by ps is for one that doesn't (and can't see a
  // renamed claude, or work where ps has no -p)
  const told = testing ? 0 : Number(process.env.CLAUDE_PID) || 0
  const pids = told ? [told] : ancestors()
  /** @type {{ pid: number, tty: string, args: string } | null} */
  let claude = null
  try { claude = findClaude(pids) } catch {}
  if (told) claude ||= { pid: told, tty: '', args: '' }
  if (!testing && !(claude && interactive(claude.args, claude.tty))) return 0
  // the Claude that started us, and only it: an enclosing session must not be mistaken for ours
  const mine = claude && !testing ? [claude.pid] : pids
  const owner = mine[0]
  // one wait per session: each turn starts another, and the newest takes over, even with no node to ask
  const mark = path.join(homeDir(), `wake-${owner}`)
  const me = String(process.pid)
  sweepMarks()
  try { fs.writeFileSync(mark, me) } catch {}
  const isMine = () => { try { return fs.readFileSync(mark, 'utf8') === me } catch { return true } }
  const finish = (/** @type {number} */ code) => { if (isMine()) fs.rmSync(mark, { force: true }); return code }
  let since = Date.now()
  for (;;) {
    if (!isMine()) return 0                         // before asking: the newest wait is the one to be told
    /** @type {{ event: string, name?: string, count?: number } | null} */
    let r = null, reached = true
    try { r = await local.wakeWait(mine) } catch { reached = false }
    if (r?.event === 'wake') { process.stderr.write(`${wakeText(r.count || 1, r.name || 'this session')}\n`); return finish(2) }
    if (r?.event === 'done') return finish(0)       // a newer wait took over, or this session is woken another way
    if (!isMine()) return 0
    try { process.kill(owner, 0) } catch { return finish(0) }    // Claude has gone
    // no node to ask (it may be restarting), or the session was there a moment ago: keep going
    if (!reached || r?.event === 'closed') since = Date.now()
    const waited = Date.now() - since
    if (waited > GIVE_UP_MS) return finish(0)
    await new Promise(res => setTimeout(res, waited > SLOW_AFTER_MS ? SLOW_RETRY_MS : RETRY_MS))
  }
}

/** A session that ended while waiting leaves its mark behind: clear those of sessions that are gone. */
function sweepMarks() {
  try {
    for (const f of fs.readdirSync(homeDir())) {
      const pid = Number(f.match(/^wake-(\d+)$/)?.[1])
      if (!pid) continue
      try { process.kill(pid, 0) } catch (e) { if (/** @type {any} */ (e).code === 'ESRCH') fs.rmSync(path.join(homeDir(), f), { force: true }) }
    }
  } catch {}
}
