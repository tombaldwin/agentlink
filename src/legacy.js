// nattermatic was called agentlink until 0.2.0. This moves a machine set up under the old name
// onto the new one, keeping its key, network and messages, and keeps the old names working for
// whatever still uses them: the user's scripts and settings, and sessions started before the upgrade.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const OLD = 'agentlink'
/** agentlink's home, where a machine set up before the rename keeps its key and messages. */
export const oldHome = () => path.join(os.homedir(), '.agentlink')

/**
 * AGENTLINK_* settings still count, under their new names, unless the new name is set too.
 * Run before anything reads the environment.
 */
export function legacyEnv() {
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('AGENTLINK_')) continue
    const n = `NATTERMATIC_${k.slice('AGENTLINK_'.length)}`
    if (!(n in process.env)) process.env[n] = v
  }
}

const uid = () => process.getuid?.() ?? 0

/** Stop and remove agentlink's background service, so it can't restart the old node. */
export function removeOldService() {
  if (process.platform === 'darwin') {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.agentlink.node.plist')
    if (!fs.existsSync(plist)) return false
    spawnSync('launchctl', ['bootout', `gui/${uid()}/com.agentlink.node`], { stdio: 'ignore' })
    fs.rmSync(plist, { force: true })
    return true
  }
  if (process.platform === 'linux') {
    const unit = path.join(os.homedir(), '.config', 'systemd', 'user', 'agentlink.service')
    if (!fs.existsSync(unit)) return false
    spawnSync('systemctl', ['--user', 'disable', '--now', 'agentlink'], { stdio: 'ignore' })
    fs.rmSync(unit, { force: true })
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' })
    return true
  }
  return false
}

/**
 * Move ~/.agentlink to `home` and leave a link in its place, for sessions and shell lines that
 * still use the old path. Only for the usual home, and only if `home` doesn't exist yet or holds
 * nothing but what the installer has just put there (bin, pkg, node): entries already in `home`
 * win, and what's left of the old home is the old program, which the new one replaces.
 * If ~/.agentlink is itself a link (to a folder on another disk, say), the data stays where it is:
 * the installer's entries go into that folder and `home` becomes a link to it too.
 * Returns what happened, or null if there was nothing to move.
 * @param {string} home @returns {string | null}
 */
export function moveOldHome(home) {
  const old = oldHome()
  let st
  try { st = fs.lstatSync(old) } catch { return null }
  /** @type {string | null} */
  let target = null          // where a linked ~/.agentlink really is
  if (st.isSymbolicLink()) {
    try { target = fs.realpathSync(old) } catch { return `${old} was left alone: it is a link to a folder that isn't there` }
    if (!fs.statSync(target).isDirectory()) return null
    let real = null
    try { real = fs.realpathSync(home) } catch {}
    if (real === target) return null                 // moved already: both names lead to the same folder
  } else if (!st.isDirectory()) return null
  if (path.resolve(home) === old) return null
  const installed = new Set(['bin', 'pkg', 'node'])
  /** @type {string[]} */
  let have = []
  try { have = fs.readdirSync(home) } catch {}
  if (have.some(e => !installed.has(e))) return `${old} was left alone: ${home} is already in use`
  removeOldService()
  if (target) {
    // the new program replaces the old one in that folder; then home leads there
    for (const e of have) {
      fs.rmSync(path.join(target, e), { recursive: true, force: true })
      moveEntry(path.join(home, e), path.join(target, e))
    }
    fs.rmSync(home, { recursive: true, force: true })
    fs.symlinkSync(target, home)
    return `linked ${home} to ${target}, where ${old} leads`
  }
  if (!have.length) {
    fs.rmSync(home, { recursive: true, force: true })
    fs.renameSync(old, home)
  } else {
    for (const e of fs.readdirSync(old)) if (!have.includes(e)) fs.renameSync(path.join(old, e), path.join(home, e))
    fs.rmSync(old, { recursive: true, force: true })
  }
  fs.symlinkSync(home, old)
  return `moved ${old} to ${home}`
}

/** rename, or copy and remove when the two are on different disks. @param {string} from @param {string} to */
function moveEntry(from, to) {
  try { fs.renameSync(from, to) } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EXDEV') throw e
    fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true })
    fs.rmSync(from, { recursive: true, force: true })
  }
}

/**
 * The database's old file name, renamed once nothing has it open: called by the node after it has
 * the port, so no other node of this machine is running.
 * @param {string} dir
 */
export function renameOldDb(dir) {
  const from = path.join(dir, 'agentlink.db'), to = path.join(dir, 'nattermatic.db')
  if (!fs.existsSync(from) || fs.existsSync(to)) return
  for (const ext of ['-wal', '-shm', '']) {
    try { fs.renameSync(from + ext, to + ext) } catch (e) { if (/** @type {any} */ (e).code !== 'ENOENT') throw e }
  }
}

/** A permission rule naming agentlink's tools, under its new name. @param {any} rule @returns {any} */
export const renamedRule = rule => typeof rule === 'string' ? rule.replace(/^mcp__agentlink(?=__|$|\()/, 'mcp__nattermatic') : rule

/** agentlink.app, beside the app this runs from: replaced by nattermatic.app. @param {string | null} bundle */
export function removeOldApp(bundle) {
  if (!bundle) return false
  const old = path.join(path.dirname(bundle), 'agentlink.app')
  if (old === bundle || !fs.existsSync(path.join(old, 'Contents', 'Info.plist'))) return false
  fs.rmSync(old, { recursive: true, force: true })
  return true
}
