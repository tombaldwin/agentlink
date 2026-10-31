// Client for the local node's loopback API, plus auto-start of the node.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { authHeader } from './crypto.js'

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agentlink.js')
const sleep = ms => new Promise(r => setTimeout(r, ms))

export class Local {
  constructor(cfg) {
    this.cfg = cfg
    this.base = `http://127.0.0.1:${cfg.port}`
  }

  async req(method, p, obj, query = '') {
    const body = obj === undefined ? '' : JSON.stringify(obj)
    const res = await fetch(this.base + p + query, {
      method,
      headers: { 'content-type': 'application/json', 'x-agentlink-auth': authHeader(this.cfg.secret, method, p, body) },
      body: method === 'GET' ? undefined : body,
      signal: AbortSignal.timeout(15_000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    return data
  }

  async health() {
    try {
      const r = await fetch(this.base + '/health', { signal: AbortSignal.timeout(1000) })
      return r.ok ? await r.json() : null
    } catch { return null }
  }

  /** Make sure a node is running on this machine (start one in the background if not). */
  async ensureNode() {
    const h = await this.health()
    if (!h && fs.existsSync(path.join(this.cfg.dir, 'disabled'))) throw new Error('agentlink is uninstalled on this machine (run `agentlink setup` to re-enable)')
    if (h) {
      if (h.net !== this.cfg.net) throw new Error(`port ${this.cfg.port} is used by a agentlink node on a different network`)
      return h
    }
    fs.mkdirSync(this.cfg.dir, { recursive: true, mode: 0o700 })
    const out = fs.openSync(path.join(this.cfg.dir, 'node.log'), 'a')
    const child = spawn(process.execPath, ['--no-warnings', BIN, 'node'], { detached: true, stdio: ['ignore', out, out], env: process.env })
    child.unref()
    for (let i = 0; i < 60; i++) {
      await sleep(100)
      const h2 = await this.health()
      if (h2) return h2
    }
    throw new Error(`could not start agentlink node (see ${path.join(this.cfg.dir, 'node.log')})`)
  }

  /** Long-lived SSE stream of messages for session `name`; `token` lets a reconnect reclaim the same name. Resolves when the stream ends. */
  async stream(name, token, onEvent, signal) {
    const p = '/local/stream'
    const res = await fetch(`${this.base}${p}?name=${encodeURIComponent(name)}&token=${encodeURIComponent(token)}`, {
      headers: { 'x-agentlink-auth': authHeader(this.cfg.secret, 'GET', p, '') },
      signal,
    })
    if (!res.ok) throw new Error(`stream HTTP ${res.status}`)
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
