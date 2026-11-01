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
import { authedRequest, authedRaw, PinError } from './tls.js'
import { ensureHomeDir, errMsg, readDks } from './config.js'
import { BIN, nodePath } from './claude.js'

const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms))

export class Local {
  /** @param {Pick<import('./types.js').Config, 'identity' | 'port' | 'dir'>} cfg */
  constructor(cfg) {
    this.cfg = cfg
    this.addr = `127.0.0.1:${cfg.port}`
    this.accept = new Map([[cfg.identity.fp, crypto.createPublicKey(cfg.identity.key)]])
  }

  /** @param {{ path: string, method?: 'GET' | 'POST', body?: string, timeout?: number, signal?: AbortSignal }} o */
  opts(o) { return { addr: this.addr, identity: this.cfg.identity, accept: this.accept, dks: readDks(this.cfg.dir), ...o } }

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
      r = await authedRequest(this.opts({ method, path: p + query, body: obj === undefined ? '' : JSON.stringify(obj), timeout: 15_000 }))
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
      const code = /** @type {any} */ (e)?.code
      if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return null
      if (e instanceof PinError || code === 'EPROTO') return { foreign: true }
      return null
    }
  }

  /** Make sure a node is running on this machine (start one in the background if not). */
  async ensureNode() {
    const h = await this.health()
    if (h && 'foreign' in h) throw new Error(`port ${this.cfg.port} is used by something that is not this machine's agentlink node`)
    if (h) return h
    if (fs.existsSync(path.join(this.cfg.dir, 'disabled'))) throw new Error('agentlink is uninstalled on this machine (run `agentlink setup` to re-enable)')
    ensureHomeDir(this.cfg.dir)
    const out = fs.openSync(path.join(this.cfg.dir, 'node.log'), 'a', 0o600)
    let exited = false, spawnErr = ''
    try {
      // --on-demand: if another node wins the race for the port, this one exits instead of standing by.
      // nodePath(): a Node path that survives upgrades (the versioned execPath may be removed by brew).
      const child = spawn(nodePath(), ['--no-warnings', BIN, 'node', '--on-demand'], { detached: true, stdio: ['ignore', out, out], env: process.env })
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

  /** Long-lived SSE stream of messages for session `name`; `token` lets a reconnect reclaim the same name. Resolves when the stream ends. */
  /**
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
        path: `/local/stream?name=${encodeURIComponent(name)}&token=${encodeURIComponent(token)}${poll ? '&mode=poll' : ''}`,
      })))
    } catch (e) { throw /** @type {any} */ (e)?.name === 'AbortError' ? e : this.wrap(e) }
    if (res.statusCode !== 200) { res.destroy(); throw new Error(`stream HTTP ${res.statusCode}`) }
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
        if (data) await onEvent(event, JSON.parse(data))
      }
    }
  }
}
