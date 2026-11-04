// `agentlink wake`: run by a Claude Code hook (see installHook in claude.js). It waits in the background
// until the session it belongs to has a new message, then exits 2, which wakes the session even when
// it's idle. What it tells Claude is fixed text: the messages themselves are read with the inbox
// tool, so nothing another agent wrote ever arrives as a hook's output.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { homeDir, loadConfig } from './config.js'
import { Local } from './local.js'

const RETRY_MS = 5000

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
 * Is this an interactive session? Only those can be woken, and a script must never wait on this
 * hook: a `claude -p` run doesn't finish until its hooks do. When in doubt, the answer is no.
 * @param {string} args an ancestor's command line @param {string} tty its terminal, as ps prints it
 * @param {NodeJS.ProcessEnv} [env]
 */
export function interactive(args, tty, env = process.env) {
  if (/^sdk/.test(env.CLAUDE_CODE_ENTRYPOINT || '')) return false
  if (/(^|\s)(-p|--print|--input-format|--output-format)(?=$|[\s=])/.test(args)) return false
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
  const pids = ancestors()
  let claude = null
  try { claude = findClaude(pids) } catch {}
  const testing = !!process.env.AGENTLINK_WAKE_ANY       // (the end-to-end tests have no Claude and no terminal)
  if (!testing && !(claude && interactive(claude.args, claude.tty))) return 0
  // the Claude that started us, and only it: an enclosing session must not be mistaken for ours
  const mine = claude && !testing ? [claude.pid] : pids
  const owner = mine[0]
  for (;;) {
    /** @type {{ event: string, name?: string, count?: number } | null} */
    let r = null
    try { r = await local.wakeWait(mine) } catch {}
    if (r?.event === 'wake') { process.stderr.write(`${wakeText(r.count || 1, r.name || 'this session')}\n`); return 2 }
    if (r?.event === 'done') return 0       // a newer wait took over, or this session is woken another way
    // the node is restarting, or the session hasn't connected yet: keep going for as long as Claude runs
    try { process.kill(owner, 0) } catch { return 0 }
    await new Promise(res => setTimeout(res, RETRY_MS))
  }
}
