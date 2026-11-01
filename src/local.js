// Client for the local node's loopback API, plus auto-start of the node.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { authHeader, verifyResponse } from './crypto.js'
import { ensureHomeDir, errMsg } from './config.js'
import { BIN, nodePath } from './claude.js'

const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms))

export class Local {
  /** @param {import('./types.js').Config} cfg */
  constructor(cfg) {
    this.cfg = cfg
    this.base = `http://127.0.0.1:${cfg.port}`
  }

  /**
   * Signed request to the local node's API; throws with the node's error message on failure.
   * The reply must carry the node's signature (bound to this request), so a process squatting on
   * the port without the secret can't read sends, fake receipts or answer for the node.
   * @param {'GET'|'POST'} method
   * @param {string} p
   * @param {object} [obj]
   * @returns {Promise<any>}
   */
  async req(method, p, obj, query = '') {
    const body = obj === undefined ? '' : JSON.stringify(obj)
    const auth = authHeader(this.cfg.secret, method, p, body)
    let res
    try {
      res = await fetch(this.base + p + query, {
        method,
        headers: { 'content-type': 'application/json', 'x-agentlink-auth': auth },
        body: method === 'GET' ? undefined : body,
        signal: AbortSignal.timeout(15_000),
      })
    } catch (e) { throw new Error(`cannot reach the agentlink node on port ${this.cfg.port}: ${errMsg(e)}`) }
    const text = await res.text()
    if (!verifyResponse(this.cfg.secret, auth, res.headers.get('x-agentlink-node') || '', text, res.headers.get('x-agentlink-sig'))) {
      if (res.status === 401) throw new Error(`the agentlink node on port ${this.cfg.port} rejected our credentials (it was started with a different secret; re-run agentlink setup)`)
      throw new Error(`port ${this.cfg.port} is not answered by this machine's agentlink node`)
    }
    /** @type {any} */
    let data = {}
    try { data = text ? JSON.parse(text) : {} } catch {}
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    return data
  }

  /** Unauthenticated liveness check (anything could answer it: use verify() before trusting it). */
  /** @returns {Promise<import('./types.js').Health | null>} */
  async health() {
    try {
      const r = await fetch(this.base + '/health', { signal: AbortSignal.timeout(1000) })
      return r.ok ? await r.json() : null
    } catch { return null }
  }

  /** Is the process on the port really a node holding our secret? */
  async verify() {
    try { await this.req('GET', '/local/whoami'); return true } catch { return false }
  }

  /** Make sure a node is running on this machine (start one in the background if not). */
  async ensureNode() {
    const h = await this.health()
    if (!h && fs.existsSync(path.join(this.cfg.dir, 'disabled'))) throw new Error('agentlink is uninstalled on this machine (run `agentlink setup` to re-enable)')
    if (h) {
      if (h.net !== this.cfg.net) throw new Error(`port ${this.cfg.port} is used by an agentlink node on a different network`)
      if (!await this.verify()) throw new Error(`port ${this.cfg.port} is used by something that is not this network's agentlink node (pid ${h.pid})`)
      return h
    }
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
      if (h2) return h2
      if (exited && i > 5) break   // it died (lost the race to a node still starting, or failed): one last look below
    }
    const h3 = await this.health()
    if (h3) return h3
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
    const p = '/local/stream'
    const auth = authHeader(this.cfg.secret, 'GET', p, '')
    const res = await fetch(`${this.base}${p}?name=${encodeURIComponent(name)}&token=${encodeURIComponent(token)}${poll ? '&mode=poll' : ''}`, {
      headers: { 'x-agentlink-auth': auth },
      signal,
    })
    if (!res.ok || !res.body) throw new Error(`stream HTTP ${res.status}`)
    if (!verifyResponse(this.cfg.secret, auth, res.headers.get('x-agentlink-node') || '', '', res.headers.get('x-agentlink-sig'))) {
      await res.body.cancel().catch(() => {})
      throw new Error(`port ${this.cfg.port} is not answered by this machine's agentlink node`)
    }
    const dec = new TextDecoder()
    let buf = ''
    for await (const chunk of res.body) {
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
