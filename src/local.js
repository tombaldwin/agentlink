// Client for the local node's loopback API, plus auto-start of the node.
//
// The local API runs over TLS on 127.0.0.1 with the same in-band identity check as connections
// between machines (see tls.js): the node must prove it holds this machine's key, and so must the
// client. Only a process that can read this machine's private key (this user) gets in, and a
// process squatting on the port is refused before it is sent anything.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import { authedRequest, authedRaw, PinError, PROTO } from './tls.js'
import { cmpVersion, ensureHomeDir, errMsg, rosterPath, sleep, VERSION } from './config.js'
import { Roster } from './roster.js'
import { selfCmd } from './claude.js'

const MAX_LOCAL_REPLY = 64 << 20   // the most an inbox read can come to: 100 messages of 64 KB, escaped

/**
 * The running node is a newer agentlink than this process: this process (a session's adapter
 * started before an upgrade, say) is the one that is out of date, and must not replace the node.
 */
export class StaleError extends Error {}

/** Is the node behind `h` a different version from this process, and is it newer? @param {import('./types.js').Health} h */
export function versionOf(h) {
  const proto = h.proto ?? 0     // nodes from before the protocol number count as older
  const differs = proto !== PROTO || h.version !== VERSION
  const newer = proto !== PROTO ? proto > PROTO : cmpVersion(h.version, VERSION) > 0
  return { differs, newer: differs && newer }
}

/** @type {{ stamp: string, dks: string[] } | null} */
let dkCache = null
/**
 * The discovery keys that open this machine's node, read fresh (a removal elsewhere rotates them
 * while long-lived clients, like MCP adapters, keep running) but through the roster's own rules, so
 * only keys that count are used. Replaying the roster is only needed when the file has changed.
 * @param {string} [dir] @returns {string[]}
 */
function readDks(dir) {
  try {
    const file = rosterPath(dir)
    const st = fs.statSync(file)
    const stamp = `${file} ${st.mtimeMs} ${st.size}`
    if (dkCache?.stamp !== stamp) dkCache = { stamp, dks: Roster.load(file).gateDks() }
    return dkCache.dks
  } catch { return [] }
}

export class Local {
  /** @param {Pick<import('./types.js').Config, 'identity' | 'port' | 'dir'>} cfg */
  constructor(cfg) {
    this.cfg = cfg
    this.addr = `127.0.0.1:${cfg.port}`
    this.accept = new Map([[cfg.identity.fp, crypto.createPublicKey(cfg.identity.key)]])
  }

  /** @param {{ path: string, method?: 'GET' | 'POST', body?: string, timeout?: number, signal?: AbortSignal }} o */
  // anyProto: after an upgrade the running node may be the previous version; setup must still reach it to stop it
  opts(o) { return { addr: this.addr, identity: this.cfg.identity, accept: this.accept, dks: readDks(this.cfg.dir), anyProto: true, ...o } }

  /** @param {unknown} e */
  wrap(e) {
    if (e instanceof PinError || /** @type {any} */ (e)?.code === 'EPROTO') return new Error(`port ${this.cfg.port} is not answered by this machine's agentlink node`)
    return new Error(`cannot reach the agentlink node on port ${this.cfg.port}: ${errMsg(e)}`)
  }

  /**
   * Request to the local node's API; throws with the node's error message on failure.
   * @param {'GET'|'POST'} method
   * @param {string} p
   * @param {object} [obj]
   * @returns {Promise<any>}
   */
  async req(method, p, obj, query = '') {
    let r
    try {
      r = await authedRequest(this.opts({ method, path: p + query, body: obj === undefined ? '' : JSON.stringify(obj), timeout: 15_000 }), MAX_LOCAL_REPLY)
    } catch (e) { throw this.wrap(e) }
    /** @type {any} */
    let data = {}
    try { data = r.text ? JSON.parse(r.text) : {} } catch {}
    if (r.status < 200 || r.status >= 300) throw new Error(data.error || `HTTP ${r.status}`)
    return data
  }

  /**
   * Is a node running on the port? null: nothing is listening. { foreign: true }: something that
   * isn't this machine's node (another network's node, another user's, or not agentlink at all).
   * @returns {Promise<import('./types.js').Health | { foreign: true } | null>}
   */
  async health() {
    try {
      const r = await authedRequest(this.opts({ path: '/health', timeout: 1000 }))
      return r.status === 200 ? JSON.parse(r.text) : { foreign: true }
    } catch (e) {
      return e instanceof PinError || /** @type {any} */ (e)?.code === 'EPROTO' ? { foreign: true } : null
    }
  }

  /** Make sure a node is running on this machine (start one in the background if not). */
  async ensureNode() {
    let h = await this.health()
    if (h && 'foreign' in h) throw new Error(`port ${this.cfg.port} is used by something that is not this machine's agentlink node`)
    if (h && versionOf(h).newer) {
      // agentlink was upgraded while this process was running: replacing the node would downgrade it
      throw new StaleError(`agentlink on this machine was upgraded (to ${h.version}, protocol ${h.proto}) while this program (${VERSION}, protocol ${PROTO}) was running, so it can't use the node any more`)
    }
    // agentlink was upgraded under a running node: replace it with this version
    if (h && versionOf(h).differs) {
      try { await this.req('POST', '/local/shutdown') } catch {}
      for (let i = 0; i < 30 && (h = await this.health()) && !('foreign' in h) && versionOf(h).differs; i++) await sleep(100)
    }
    if (h && !('foreign' in h) && !versionOf(h).differs) return h
    if (fs.existsSync(path.join(this.cfg.dir, 'disabled'))) throw new Error('agentlink is uninstalled on this machine (run `agentlink setup` to re-enable)')
    ensureHomeDir(this.cfg.dir)
    const out = fs.openSync(path.join(this.cfg.dir, 'node.log'), 'a', 0o600)
    let exited = false, spawnErr = ''
    try {
      // --on-demand: if another node wins the race for the port, this one exits instead of standing by.
      // selfCmd(): a Node path that survives upgrades (the versioned execPath may be removed by brew)
      const [cmd, ...args] = selfCmd()
      const child = spawn(cmd, [...args, 'node', '--on-demand'], { detached: true, stdio: ['ignore', out, out], env: process.env })
      child.on('error', e => { exited = true; spawnErr = errMsg(e) })   // e.g. ENOENT: must not crash the caller
      child.on('exit', () => { exited = true })
      child.unref()
    } finally { fs.closeSync(out) }
    for (let i = 0; i < 60; i++) {
      await sleep(100)
      const h2 = await this.health()
      if (h2 && !('foreign' in h2)) return h2
      if (exited && i > 5) break   // it died (lost the race to a node still starting, or failed): one last look below
    }
    const h3 = await this.health()
    if (h3 && !('foreign' in h3)) return h3
    throw new Error(`could not start agentlink node${spawnErr ? ` (${spawnErr})` : ''} (see ${path.join(this.cfg.dir, 'node.log')})`)
  }

  /**
   * Wait for news for the session owned by one of `pids`. null: there's no such session (yet).
   * @param {number[]} pids @returns {Promise<{ event: string, name?: string, count?: number } | null>}
   */
  async wakeWait(pids) {
    const { res } = await authedRaw(this.opts({ timeout: 0, path: `/local/wake?pids=${pids.join(',')}` }))
    if (res.statusCode !== 200) { res.destroy(); return null }
    for await (const { event, data } of sseEvents(res)) { res.destroy(); return { event, ...data } }
    return { event: 'closed' }
  }

  /**
   * Long-lived stream of messages for session `name`; `token` lets a reconnect reclaim the same name.
   * Resolves when the stream ends.
   * @param {string} name
   * @param {string} token
   * @param {(event: string, data: any) => Promise<void> | void} onEvent
   * @param {{ signal?: AbortSignal, poll?: boolean }} [opts] poll: messages are read with the inbox tool, not pushed
   */
  async stream(name, token, onEvent, { signal, poll = false } = {}) {
    let res
    try {
      ({ res } = await authedRaw(this.opts({
        timeout: 0, signal,
        // owner: the Claude session that started this adapter, so its hook can find it (see wake.js)
        path: `/local/stream?name=${encodeURIComponent(name)}&token=${encodeURIComponent(token)}&owner=${process.ppid}${poll ? '&mode=poll' : ''}`,
      })))
    } catch (e) { throw /** @type {any} */ (e)?.name === 'AbortError' ? e : this.wrap(e) }
    if (res.statusCode !== 200) { res.destroy(); throw new Error(`stream HTTP ${res.statusCode}`) }
    for await (const { event, data } of sseEvents(res)) await onEvent(event, data)
  }
}

/** The events of a server-sent stream, as they arrive. @param {import('node:http').IncomingMessage} res */
async function* sseEvents(res) {
  const dec = new TextDecoder()
  let buf = ''
  for await (const chunk of res) {
    buf += dec.decode(chunk, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i)
      buf = buf.slice(i + 2)
      let event = 'message', data = ''
      for (const line of raw.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7)
        else if (line.startsWith('data: ')) data += line.slice(6)
      }
      if (data) yield { event, data: JSON.parse(data) }
    }
  }
}
