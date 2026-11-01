// The per-machine node: durable store, local session hub, peer-to-peer delivery, LAN discovery.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import net from 'node:net'
import dns from 'node:dns/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { openStore } from './store.js'
import { startDiscovery } from './discovery.js'
import { signEnvelope, verifyEnvelope, authHeader, checkAuth, signResponse, verifyResponse, NonceCache, safeEq } from './crypto.js'
import { parseAddr, normHost, sanitizeName, validAddr, tailscaleName, errMsg, ensureHomeDir, MAX_TTL_MS, VERSION } from './config.js'

const MAX_REQ = 2 << 20
const MAX_BATCH = 256 << 10            // bytes of envelopes per request (well under MAX_REQ)
const MIN_RATE = 25                    // bytes/ms (~200 kbit/s): request timeouts grow with the payload
const MAX_MSG = 64 * 1024
const BACKOFF_MAX = 60_000
const HELLO_EVERY = 120_000
const REPLICATE_TO = 3                 // max other nodes that hold a copy for an offline machine
const PEER_FORGET_MS = 30 * 86400_000
const IN_FLIGHT_MS = 30_000            // a send being delivered directly is hidden from the flush loop
const PROBE_RETRY_MS = 10 * 60_000     // don't re-probe an address that just failed verification
const HELLO_CONCURRENCY = 2            // offline .local names tie up a DNS (libuv) thread each for seconds

/** @typedef {import('./types.js').Config} Config */
/** @typedef {import('./types.js').Envelope} Envelope */
/** @typedef {import('./types.js').MessageRow} MessageRow */
/** @typedef {import('./types.js').PeerRow} PeerRow */
/** @typedef {http.ServerResponse & { reqAuth?: string, nodeHdr?: string }} Res */

const execFileP = promisify(execFile)
const now = () => Date.now()
const backoff = (/** @type {number} */ n) => Math.min(BACKOFF_MAX, 2000 * 2 ** Math.min(n, 5))

/**
 * @param {import('./types.js').Config} cfg
 * @param {(...a: any[]) => void} [log]
 */
export async function runNode(cfg, log = (...a) => console.error(new Date().toISOString(), ...a)) {
  ensureHomeDir(cfg.dir)
  // Bind the port before touching the shared database: a node that loses the race for the port
  // (a standby service, a second session-started node) must not reset retry state or leak handles.
  /** @type {(req: http.IncomingMessage, res: Res) => void} */
  let onRequest = (req, res) => { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"starting"}') }
  const server = http.createServer((req, res) => onRequest(req, res))
  await new Promise(/** @param {(v?: void) => void} resolve */ (resolve, reject) => {
    server.once('error', reject)
    server.listen(cfg.port, () => { server.off('error', reject); resolve() })
  })
  /** @type {import('node:sqlite').DatabaseSync} */
  let db
  try { db = openStore(path.join(cfg.dir, 'agentlink.db')) } catch (e) { server.close(); throw e }
  const nodeHeader = `${cfg.host};net=${cfg.net};port=${cfg.port}`
  const nonces = new NonceCache()
  /** @type {Map<string, { res: Res, sent: Set<string>, token: string, live: boolean }>} name -> session stream (live: woken by channel pushes) */
  const sessions = new Map()

  const q = {
    insert: db.prepare(`INSERT OR IGNORE INTO messages
      (id,from_addr,to_addr,to_host,to_name,body,sent_at,expires_at,sig,role,state,next_attempt,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    get: db.prepare(`SELECT * FROM messages WHERE id=?`),
    due: db.prepare(`SELECT * FROM messages WHERE state='pending' AND next_attempt<=? AND expires_at>? ORDER BY sent_at LIMIT 2000`),
    forwarded: db.prepare(`UPDATE messages SET state='forwarded', updated_at=? WHERE id=? AND state='pending'`),
    failed: db.prepare(`UPDATE messages SET state='failed', last_error=?, updated_at=? WHERE id=?`),
    retry: db.prepare(`UPDATE messages SET attempts=attempts+1, next_attempt=?, last_error=?, updated_at=? WHERE id=? AND state='pending'`),
    replicated: db.prepare(`UPDATE messages SET replicated=1 WHERE id=?`),
    wake: db.prepare(`UPDATE messages SET next_attempt=0 WHERE state='pending' AND to_host=?`),
    toInbox: db.prepare(`UPDATE messages SET role='inbox', state='queued', to_host=?, updated_at=? WHERE to_host=? AND state='pending' RETURNING to_name`),
    inboxQueued: db.prepare(`SELECT * FROM messages WHERE role='inbox' AND to_name=? AND state='queued' AND expires_at>? ORDER BY sent_at`),
    delivered: db.prepare(`UPDATE messages SET state='delivered', updated_at=? WHERE id=? AND role='inbox'`),
    // pushed into a channel session: Claude Code gives no receipt, so this means "shown", not "read"
    pushed: db.prepare(`UPDATE messages SET state='pushed', updated_at=? WHERE id=? AND role='inbox' AND state='queued'`),
    history: db.prepare(`SELECT * FROM messages WHERE role='inbox' AND to_name=? ORDER BY sent_at DESC LIMIT ?`),
    expire: db.prepare(`UPDATE messages SET state='expired', updated_at=? WHERE state IN ('pending','queued') AND expires_at<=?`),
    gc: db.prepare(`DELETE FROM messages WHERE expires_at < ?`),
    counts: db.prepare(`SELECT role, state, count(*) n FROM messages GROUP BY role, state`),
    upsertPeer: db.prepare(`INSERT INTO peers(host,addr,last_seen,configured) VALUES(?,?,?,?)
      ON CONFLICT(host) DO UPDATE SET last_seen=excluded.last_seen,
        addr=COALESCE(excluded.addr, peers.addr), configured=MAX(peers.configured, excluded.configured)`),
    peer: db.prepare(`SELECT * FROM peers WHERE host=?`),
    peers: db.prepare(`SELECT * FROM peers ORDER BY host`),
    setAlias: db.prepare(`UPDATE peers SET alias_of=? WHERE host=?`),
    clearAlias: db.prepare(`UPDATE peers SET alias_of=NULL WHERE host=? AND alias_of IS NOT NULL`),
    deletePeer: db.prepare(`DELETE FROM peers WHERE host=?`),
    forgetPeers: db.prepare(`DELETE FROM peers WHERE configured=0 AND last_seen < ?`),
    verified: db.prepare(`UPDATE peers SET verified=1 WHERE host=?`),
    clearAddr: db.prepare(`UPDATE peers SET addr=NULL WHERE host=?`),
  }

  // typed views of the rows node:sqlite returns
  const peerRow = (/** @type {string} */ host) => /** @type {PeerRow | undefined} */ (q.peer.get(host))
  const allPeers = () => /** @type {PeerRow[]} */ (/** @type {unknown} */ (q.peers.all()))
  const msgRow = (/** @type {string} */ id) => /** @type {MessageRow | undefined} */ (q.get.get(id))
  /** @type {(...a: import('node:sqlite').SQLInputValue[]) => MessageRow[]} */
  const dueRows = (...a) => /** @type {MessageRow[]} */ (/** @type {unknown} */ (q.due.all(...a)))
  /** @type {(name: string, t: number) => MessageRow[]} */
  const inboxRows = (name, t) => /** @type {MessageRow[]} */ (/** @type {unknown} */ (q.inboxQueued.all(name, t)))

  // ---------- identity ----------
  const selfAliases = new Set(cfg.aliases)
  const ts = cfg.autoAliases ? tailscaleName() : null
  if (ts) selfAliases.add(ts)
  selfAliases.delete(cfg.host)
  const isSelf = (/** @type {string} */ h) => h === cfg.host || selfAliases.has(h)

  /**
   * A request for `name` was answered by this node. If `name` is a machine we know to be a separate
   * node (it has answered as itself, or it's a configured peer), the address we used is simply wrong
   * now (DHCP reuse, spoofed name resolution): forget the address and keep retrying. Otherwise `name`
   * is one of our own names (an IP, a Tailscale name used by a sender): take delivery of anything
   * queued for it. Learned aliases are kept in memory only.
   * Returns true if adopted.
   * @param {string} name
   */
  function reachedSelfAs(name) {
    if (!name || name === cfg.host) return true
    const row = peerRow(name)
    if (row && (row.verified || row.configured)) {
      log(`address ${row.addr || name} for ${name} now reaches this machine; forgetting it`)
      q.clearAddr.run(name)
      return false
    }
    if (!selfAliases.has(name)) log(`learned that ${name} is this machine`)
    selfAliases.add(name)
    if (row) q.deletePeer.run(name)
    const names = new Set(q.toInbox.all(cfg.host, now(), name).map(r => String(r.to_name)))
    for (const n of names) pump(n)
    return true
  }

  for (const pe of cfg.peers) if (!isSelf(pe.host)) q.upsertPeer.run(pe.host, pe.addr, now(), 1)
  db.exec(`UPDATE messages SET next_attempt=0 WHERE state='pending'`)   // fresh start: retry everything now
  // rows with out-of-range timestamps (stored before they were validated) can't even be read back by
  // node:sqlite, and would stall the forwarding loop for good: drop them without selecting them
  {
    const bad = db.prepare(`DELETE FROM messages WHERE expires_at > ? OR sent_at > ? OR sent_at < 0`).run(now() + 2 * MAX_TTL_MS, now() + 2 * MAX_TTL_MS)
    if (bad.changes) log(`dropped ${bad.changes} stored message(s) with invalid timestamps`)
  }

  // ---------- peers ----------
  const addrOf = (/** @type {string} */ host) => cfg.routes[host] || peerRow(host)?.addr || `${host}:${cfg.port}`
  /** The machine name in an x-agentlink-node header ("host;net=..;port=.."), or null. */
  const hostOf = (/** @type {unknown} */ hdr) => { try { return normHost(String(hdr || '').split(';')[0]) } catch { return null } }

  /**
   * Authenticated request to another node. Returns { data, real } where real is the host that answered.
   * `addr` dials an explicit, not yet verified address instead of the stored route for `host`.
   * @param {string} host
   * @param {'GET'|'POST'} method
   * @param {string} p
   * @param {object} [obj]
   * @param {{ timeout?: number, addr?: string }} [opts]
   * @returns {Promise<{ data: any, real: string | null, at: string | null }>} at: the address the responder says it was reached on
   */
  async function request(host, method, p, obj, { timeout = 4000, addr } = {}) {
    const body = obj === undefined ? '' : JSON.stringify(obj)
    timeout += Math.ceil(Buffer.byteLength(body) / MIN_RATE)   // big batches on slow links still finish
    const auth = authHeader(cfg.secret, method, p, body, nodeHeader)
    const target = addr || addrOf(host)
    if (!validAddr(target)) throw new Error(`invalid address for ${host}: ${target}`)
    const res = await fetch(`http://${target}${p}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-agentlink-auth': auth, 'x-agentlink-node': nodeHeader },
      body: method === 'GET' ? undefined : body,
      signal: AbortSignal.timeout(timeout),
      redirect: 'error',
    })
    const text = await readCapped(res, MAX_REQ)   // bounded: read before we know who answered
    const peerHdr = res.headers.get('x-agentlink-node') || ''
    if (!verifyResponse(cfg.secret, auth, peerHdr, text, res.headers.get('x-agentlink-sig'))) {
      if (res.status === 401) throw new Error(`${host} rejected our credentials (different network secret, or clocks more than 5 minutes apart)`)
      throw new Error(`${host} at ${target}: not an agentlink node on this network`)
    }
    if (!res.ok) throw new Error(`${host} HTTP ${res.status}: ${text.slice(0, 200)}`)
    const real = hostOf(peerHdr)
    if (real && isSelf(real)) {
      // An explicit address is an unverified hint (a beacon's source IP, a request's remote IP), and
      // both can be spoofed: it only tells us that this address is not `host`. It must never make us
      // adopt `host` as our own name or forget `host`'s real address.
      if (addr) throw new Error(`${addr} reaches this machine, not ${host}`)
      if (reachedSelfAs(host)) throw Object.assign(new Error(`${host} is this machine`), { self: true })
      throw new Error(`${host}: its address now reaches this machine`)
    }
    if (real) {                                   // a node proved it is `real`
      q.upsertPeer.run(real, null, now(), 0)
      q.verified.run(real)
      q.clearAlias.run(real)                      // a node answering as itself is nobody's alias
    }
    if (!addr && real && real !== host) {
      const row = peerRow(host)
      if (row?.verified && row.alias_of !== real) {
        // `host` is a separate node (it has answered as itself before): the address we used now
        // reaches a different member (DHCP reuse, a stale gossiped address, a laptop that moved).
        // Forget the address rather than aliasing one machine's name to another's.
        if (!cfg.routes[host]) q.clearAddr.run(host)
        q.clearAlias.run(host)
        log(`address ${target} for ${host} now reaches ${real}; forgetting it`)
        throw new Error(`${host} at ${target}: answered by ${real} (stale address)`)
      }
    }
    if (!addr) {
      q.upsertPeer.run(host, null, now(), 0)
      if (real && real !== host) {
        // we dialed it by another name (Tailscale name, IP...): route its real name the same way
        q.upsertPeer.run(real, addrOf(host), now(), 0)
        q.setAlias.run(real, host)
      }
    }
    const at = peerHdr.split(';').find(kv => kv.startsWith('at='))?.slice(3) || null
    return { data: text ? JSON.parse(text) : {}, real, at }
  }
  /** @type {(...a: Parameters<typeof request>) => Promise<any>} */
  const call = async (...a) => (await request(...a)).data

  /**
   * Start routing `host` to `addr`, but only once a node there proves (with the secret) that it is
   * `host` AND that it was reached directly at that address: its signed reply names the local address
   * it was reached on, so an outsider relaying a replayed beacon's probe to the real node (to sit in
   * the middle of all later traffic) is caught by the address mismatch.
   */
  const probing = new Set()
  /** @type {Map<string, number>} "host addr" -> when verification last failed */
  const probeFailed = new Map()
  /** @param {string} host @param {string} addr @param {{ refresh?: boolean }} [opts] refresh: a fresh sighting (beacon, request) */
  async function probe(host, addr, { refresh = true } = {}) {
    if (!validAddr(addr) || isSelf(host)) return
    const cur = peerRow(host)
    if (cur?.addr === addr) {
      if (!refresh) return
      q.upsertPeer.run(host, null, now(), 0)
      if (q.wake.run(host).changes) kick()
      return
    }
    const key = `${host} ${addr}`
    if (probing.has(key) || now() - (probeFailed.get(key) || 0) < PROBE_RETRY_MS) return
    probing.add(key)
    try {
      const { data, real, at } = await request(host, 'POST', '/v1/hello', { peers: shareablePeers() }, { addr, timeout: 2500 })
      if (real !== host || !await reachedDirectly(addr, at)) { probeFailed.set(key, now()); return }
      q.upsertPeer.run(host, addr, now(), 0)
      learnPeers(data.peers)
      if (cur?.addr !== addr) log(`${host} is at ${addr}`)
      if (q.wake.run(host).changes) kick()
    } catch { probeFailed.set(key, now()) } finally { probing.delete(key) }
    if (probeFailed.size > 1000) probeFailed.clear()
  }

  /** Track a peer that sent us an authenticated request. */
  /** @param {string} hdr @param {string | undefined} remoteIp */
  function notePeer(hdr, remoteIp) {
    if (!hdr) return null
    const parts = Object.fromEntries(hdr.split(';').slice(1).map((/** @type {string} */ kv) => kv.split('=')))
    if (parts.net !== cfg.net) return null
    const host = hostOf(hdr)
    if (!host || isSelf(host)) return null
    q.upsertPeer.run(host, null, now(), 0)
    q.verified.run(host)
    q.clearAlias.run(host)                      // a node speaking as itself is nobody's alias
    const ip = String(remoteIp || '').replace(/^::ffff:/, '')
    const port = Number(parts.port)
    if (ip && !/^(127\.|::1$)/.test(ip) && port > 0 && port < 65536) {
      const addr = ip.includes(':') ? `[${ip}]:${port}` : `${ip}:${port}`
      if (peerRow(host)?.addr !== addr && !cfg.routes[host]) probe(host, addr)
    }
    return host
  }

  function knownPeers({ includeAliases = true } = {}) {
    return allPeers().filter(r => !isSelf(r.host) && (includeAliases || !r.alias_of)).map(r => r.host)
  }

  /** Peers worth telling others about (so every node learns the whole network). */
  function shareablePeers() {
    const cutoff = now() - 86400_000
    return allPeers().filter(r => !r.alias_of && r.last_seen >= cutoff && r.addr).map(r => ({ host: r.host, addr: r.addr }))
  }
  /**
   * Peers another node told us about. Gossiped addresses may be stale (DHCP reuse) or wrong, so they
   * are never stored as routes: each one is probed, and used only once the node there proves it is
   * that machine (see probe). Machines we already have an address for keep it.
   * @param {unknown} list
   */
  function learnPeers(list) {
    for (const pe of Array.isArray(list) ? list.slice(0, 200) : []) {
      if (typeof pe?.host !== 'string' || !validAddr(pe?.addr)) continue
      const h = hostOf(pe.host)
      if (h && !isSelf(h) && !cfg.routes[h] && !peerRow(h)?.addr) probe(h, pe.addr, { refresh: false })
    }
  }

  /** @param {string} host */
  async function hello(host) {
    try {
      const r = await call(host, 'POST', '/v1/hello', { peers: shareablePeers() }, { timeout: 2500 })
      learnPeers(r.peers)
      if (q.wake.run(host).changes) kick()   // it's reachable: retry anything waiting for it now
    } catch {}
  }
  let helloing = false
  async function helloAll() {
    if (helloing) return
    helloing = true
    try {
      const hosts = knownPeers()
      let i = 0
      await Promise.all(Array.from({ length: Math.min(HELLO_CONCURRENCY, hosts.length) }, async () => {
        while (i < hosts.length) await hello(hosts[i++])
      }))
    } finally { helloing = false }
  }

  // ---------- messages ----------
  /** @type {(r: import('./types.js').MessageRow) => import('./types.js').Envelope} */
  const envOf = r => ({ id: r.id, from: r.from_addr, to: r.to_addr, body: r.body, sent_at: r.sent_at, expires_at: r.expires_at, sig: r.sig })

  /** @param {any} e @returns {e is Envelope} */
  function validEnv(e) {
    return e && typeof e === 'object' &&
      ['id', 'from', 'to', 'body', 'sig'].every(k => typeof e[k] === 'string') &&
      e.id.length <= 64 && e.from.length <= 320 && e.to.length <= 320 &&
      // safe, bounded integers: anything else can't be stored and read back reliably
      Number.isSafeInteger(e.sent_at) && Number.isSafeInteger(e.expires_at) && e.sent_at >= 0 &&
      e.expires_at - now() <= MAX_TTL_MS && e.sent_at - now() <= MAX_TTL_MS &&
      Buffer.byteLength(e.body) <= MAX_MSG && verifyEnvelope(cfg.secret, e)
  }

  /**
   * Store an incoming envelope durably. Returns 'live' | 'queued' | 'held' | 'expired' | null(rejected).
   * null means the envelope itself is bad (the sender must not retry it). Storage errors (disk full,
   * database busy) throw, so callers can report a temporary failure and the sender retries.
   */
  /**
   * @param {unknown} e
   * @param {Set<string>} [toPump] collect local recipients here instead of pumping each one now
   * @returns {import('./types.js').AcceptResult}
   */
  function accept(e, toPump) {
    let to
    try {
      if (!validEnv(e)) return null
      to = parseAddr(e.to, cfg.host)
    } catch (err) {
      log('rejected envelope:', errMsg(err))
      return null
    }
    if (e.expires_at <= now()) return 'expired'
    if (isSelf(to.host)) {
      q.insert.run(e.id, e.from, e.to, cfg.host, to.name, e.body, e.sent_at, e.expires_at, e.sig, 'inbox', 'queued', 0, now())
      if (toPump) toPump.add(to.name)
      else pump(to.name)
      return sessions.get(to.name)?.live ? 'live' : 'queued'
    }
    q.insert.run(e.id, e.from, e.to, to.host, to.name, e.body, e.sent_at, e.expires_at, e.sig, 'held', 'pending', 0, now())
    kick()
    return 'held'
  }

  /** Offer `name`'s queued messages to its live session, if it has one. @param {string} name */
  function pump(name) {
    const s = sessions.get(name)
    if (!s) return
    for (const r of inboxRows(name, now())) {
      if (s.sent.has(r.id)) continue
      s.sent.add(r.id)
      sse(s.res, 'message', { id: r.id, from: r.from_addr, to: r.to_addr, body: r.body, sent_at: r.sent_at })
    }
  }

  /** Split rows into request-sized batches. */
  /** @param {MessageRow[]} rows */
  function batches(rows) {
    /** @type {MessageRow[][]} */
    const out = []
    /** @type {MessageRow[]} */
    let cur = []
    let size = 0
    for (const r of rows) {
      const n = Buffer.byteLength(JSON.stringify(envOf(r))) + 1
      if (cur.length && size + n > MAX_BATCH) { out.push(cur); cur = []; size = 0 }
      cur.push(r)
      size += n
    }
    if (cur.length) out.push(cur)
    return out
  }

  /** Hand rows to `host`'s node. Returns null on success, else the error. */
  /**
   * @param {string} host
   * @param {MessageRow[]} rows
   * @returns {Promise<null | { err: unknown, rest: MessageRow[] }>}
   */
  async function handOver(host, rows) {
    for (const batch of batches(rows)) {
      try {
        const res = await call(host, 'POST', '/v1/deliver', { messages: batch.map(envOf) })
        const results = res.results || {}
        for (const r of batch) {
          if (results[r.id]) q.forwarded.run(now(), r.id)
          else q.failed.run(`rejected by ${host} (invalid or malformed message)`, now(), r.id)
        }
      } catch (err) {
        if (isSelfErr(err)) return null      // rows were taken into our own inbox
        const rest = rows.slice(rows.indexOf(batch[0]))
        for (const r of rest) q.retry.run(now() + backoff(r.attempts), errMsg(err), now(), r.id)
        return { err, rest }
      }
    }
    return null
  }

  // ---------- forwarding loop ----------
  /** @type {Promise<void> | null} */
  let flushing = null
  let again = false
  function flush() {
    if (flushing) { again = true; return flushing }
    flushing = (async () => {
      try {
        do { again = false; await flushOnce() } while (again)
      } catch (e) { log('flush error', e) } finally { flushing = null }
    })()
    return flushing
  }
  const kick = () => setImmediate(flush)

  async function flushOnce() {
    const t = now()
    q.expire.run(t, t)
    const byHost = new Map()
    for (const r of dueRows(t, t)) {
      if (isSelf(r.to_host)) { reachedSelfAs(r.to_host); continue }
      if (!byHost.has(r.to_host)) byHost.set(r.to_host, [])
      byHost.get(r.to_host).push(r)
    }
    await Promise.all([...byHost].map(async ([host, rows]) => {
      const failure = await handOver(host, rows)
      // in the background: trying several (possibly offline) holders must not stall deliveries
      if (failure) replicate(host, failure.rest.filter(r => r.role === 'outbox' && !r.replicated))
    }))
  }

  /** Other recently seen nodes that could hold copies for `host` while it is offline. @param {string} host */
  function holderCandidates(host) {
    const cutoff = now() - 10 * 60_000
    const hostAlias = peerRow(host)?.alias_of
    return allPeers()
      .filter(p => !isSelf(p.host) && p.host !== host && !p.alias_of && p.host !== hostAlias && p.last_seen >= cutoff)
      .sort((a, b) => b.last_seen - a.last_seen)
  }

  /** Hand copies to other reachable nodes so they can deliver when `host` comes back. */
  /** @type {Set<string>} hosts with a replication in progress */
  const replicating = new Set()
  /** @param {string} host @param {MessageRow[]} rows */
  async function replicate(host, rows) {
    if (!rows.length || replicating.has(host)) return
    replicating.add(host)
    try { await replicateInner(host, rows) } catch (e) { log('replicate error', errMsg(e)) } finally { replicating.delete(host) }
  }
  /** @param {string} host @param {MessageRow[]} rows */
  async function replicateInner(host, rows) {
    const candidates = holderCandidates(host)
    let held = 0
    for (const p of candidates) {
      if (held >= REPLICATE_TO) break
      try {
        for (const batch of batches(rows)) await call(p.host, 'POST', '/v1/deliver', { messages: batch.map(envOf) }, { timeout: 3000 })
        held++
      } catch {}
    }
    if (held) for (const r of rows) q.replicated.run(r.id)
  }

  function gc() {
    q.gc.run(now() - 86400_000)
    q.forgetPeers.run(now() - PEER_FORGET_MS)
  }

  // ---------- local API helpers ----------
  /** @param {{ from?: unknown, to?: unknown, body?: unknown, ttl_ms?: unknown }} d */
  async function localSend(d) {
    if (typeof d.body !== 'string' || !d.body) throw httpErr(400, 'message body required')
    if (Buffer.byteLength(d.body) > MAX_MSG) throw httpErr(413, `message too large (max ${MAX_MSG} bytes)`)
    if (!d.to) throw httpErr(400, 'recipient required (name@host)')
    let to
    try { to = parseAddr(d.to, cfg.host) } catch (e) { throw httpErr(400, `bad recipient "${d.to}": ${errMsg(e)}`) }
    const real = peerRow(to.host)?.alias_of          // e.g. desk.tailnet.ts.net -> desk.local
    if (real) to.host = real
    if (isSelf(to.host)) to.host = cfg.host
    /** @type {Omit<Envelope, 'sig'>} */
    const unsigned = {
      id: crypto.randomUUID(),
      from: `${sanitizeName(d.from || 'cli')}@${cfg.host}`,
      to: `${to.name}@${to.host}`,
      body: d.body,
      sent_at: now(),
      expires_at: now() + (Number(d.ttl_ms) > 0 ? Math.min(Number(d.ttl_ms), cfg.ttlMs) : cfg.ttlMs),
    }
    /** @type {Envelope} */
    const e = { ...unsigned, sig: signEnvelope(cfg.secret, unsigned) }
    if (to.host === cfg.host) {
      let st
      try { st = accept(e) } catch (err) { throw httpErr(503, `could not queue message: ${errMsg(err)}`) }
      if (!st) throw httpErr(500, 'could not queue message')
      return { id: e.id, to: e.to, status: localStatus(to.name) }
    }
    // hidden from the flush loop while we try the direct hand-off, so it isn't sent twice
    q.insert.run(e.id, e.from, e.to, to.host, to.name, e.body, e.sent_at, e.expires_at, e.sig, 'outbox', 'pending', now() + IN_FLIGHT_MS, now())
    let remote = null, copies = false
    try {
      const res = await call(to.host, 'POST', '/v1/deliver', { messages: [e] })
      remote = res.results?.[e.id]
      if (remote) q.forwarded.run(now(), e.id)
      else q.failed.run(`rejected by ${to.host} (invalid or malformed message)`, now(), e.id)
    } catch (err) {
      if (!isSelfErr(err)) {
        q.retry.run(now() + backoff(0), errMsg(err), now(), e.id)
        const row = msgRow(e.id)
        // the message is stored durably now: answer the client and hand out copies in the background
        // (trying several offline candidates in turn could otherwise outlast the client's timeout)
        if (row?.state === 'pending' && holderCandidates(to.host).length) { copies = true; replicate(to.host, [row]) }
      }
    }
    const r = msgRow(e.id)
    if (!r) throw httpErr(500, 'message vanished from the store')
    let status
    if (r.role === 'inbox') status = `${to.host} is this machine — ${localStatus(to.name)}`
    else if (r.state === 'forwarded') status = remote === 'live' ? `pushed to ${e.to}'s live session` : `stored on ${to.host}; ${to.name} will get it when it next connects or checks its inbox`
    else if (r.state === 'failed') status = `FAILED: ${r.last_error}`
    else status = `${to.host} unreachable (${r.last_error}); queued — will deliver when it comes back` + (copies ? ' (also offering copies to other online machines)' : '')
    return { id: e.id, to: e.to, status }
  }
  /** @param {string} name */
  function localStatus(name) {
    const s = sessions.get(name)
    return s?.live ? 'pushed to its live session' : s ? `waiting in ${name}'s inbox (the session is connected but reads with the inbox tool)` : `queued until ${name} connects`
  }

  async function localPeers() {
    const results = await Promise.all(knownPeers({ includeAliases: false }).map(async h => {
      try {
        const r = await call(h, 'GET', '/v1/sessions', undefined, { timeout: 1500 })
        return { host: hostOf(r.host) || h, online: true, sessions: Array.isArray(r.sessions) ? r.sessions.map(String) : [] }
      } catch { return { host: h, online: false, sessions: [] } }
    }))
    const byHost = new Map()
    for (const r of results) if (!isSelf(r.host) && (!byHost.has(r.host) || r.online)) byHost.set(r.host, r)
    return { self: cfg.host, local: [...sessions.keys()], remote: [...byHost.values()] }
  }

  // ---------- HTTP ----------
  /** JSON reply, signed when answering an authenticated request. */
  /** @param {Res} res @param {number} status @param {unknown} obj */
  function reply(res, status, obj) {
    const body = JSON.stringify(obj)
    /** @type {Record<string, string>} */
    const headers = { 'content-type': 'application/json' }
    if (res.reqAuth) headers['x-agentlink-sig'] = signResponse(cfg.secret, res.reqAuth, res.nodeHdr || nodeHeader, body)
    res.writeHead(status, headers)
    res.end(body)
  }

  onRequest = (req, res) => handle(req, res).catch(err => {
    if (!res.headersSent) reply(res, err.status || 500, { error: err.status ? err.message : 'internal error' })
    else res.destroy()
    if (!err.status) log('request error', req.method, (req.url || '').split('?')[0], err)   // never log the query: it can hold the secret
  })

  /** @param {http.IncomingMessage} req @param {Res} res */
  async function handle(req, res) {
    const u = new URL(req.url || '/', 'http://x')
    const p = u.pathname
    // the local address this request reached us on (signed with every reply): lets a prober tell a
    // direct connection from one relayed through someone else's address
    res.nodeHdr = `${nodeHeader};at=${String(req.socket.localAddress || '').replace(/^::ffff:/, '')}/${req.socket.localPort}`
    res.setHeader('x-agentlink-node', res.nodeHdr)
    if (p === '/health') return reply(res, 200, { ok: true, host: cfg.host, net: cfg.net, version: VERSION, pid: process.pid })
    if (req.method === 'GET' && (p === '/install' || p === '/pkg.tgz')) {
      if (!safeEq(u.searchParams.get('k'), cfg.secret)) return reply(res, 404, { error: 'not found' })
      if (p === '/install') {
        res.writeHead(200, { 'content-type': 'text/x-shellscript' })
        return res.end(installScript(req.headers.host, cfg))
      }
      let tgz, size
      try { tgz = await packTarball(cfg.dir); size = (await fs.promises.stat(tgz)).size } catch (e) {
        log('could not pack agentlink for an installing machine:', errMsg(e))
        return reply(res, 500, { error: 'package unavailable' })
      }
      const stream = fs.createReadStream(tgz)
      stream.on('error', () => { if (!res.headersSent) reply(res, 500, { error: 'package unavailable' }); else res.destroy() })
      stream.on('open', () => {
        res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': size })
        stream.pipe(res)
      })
      return
    }
    const nodeHdr = String(req.headers['x-agentlink-node'] || '')
    const auth = req.headers['x-agentlink-auth']
    const body = req.method === 'POST' ? await readBody(req) : ''
    const method = req.method || 'GET'
    if (!checkAuth(cfg.secret, auth, method, p, body, nodeHdr, nonces))
      return reply(res, 401, { error: 'unauthorized (different network secret, replayed request, or clocks more than 5 minutes apart)' })
    res.reqAuth = /** @type {string} checked above */ (auth)
    /** @type {Record<string, any>} request body (untrusted: every field is checked where it's used) */
    let d = {}
    if (body) { try { d = JSON.parse(body) } catch { return reply(res, 400, { error: 'bad JSON' }) } }
    if (!d || typeof d !== 'object') d = {}
    const loopback = isLoopback(req.socket.remoteAddress)
    if (p.startsWith('/local/') && !loopback) return reply(res, 403, { error: 'local only' })
    const peerHost = p.startsWith('/v1/') ? notePeer(nodeHdr, req.socket.remoteAddress) : null

    switch (`${req.method} ${p}`) {
      // ---- node <-> node ----
      case 'POST /v1/deliver': {
        /** @type {Record<string, string>} */
        const results = {}
        /** @type {Set<string>} */
        const toPump = new Set()    // offer each local recipient its new messages once, not per envelope
        for (const e of Array.isArray(d.messages) ? d.messages.slice(0, 2000) : []) {
          let st
          try { st = accept(e, toPump) } catch (err) {
            for (const n of toPump) pump(n)
            // temporary storage failure: 503 makes the sender back off and retry the whole batch
            // (already-stored ids are deduplicated), instead of marking messages permanently failed
            log('could not store delivered messages:', errMsg(err))
            throw httpErr(503, 'temporarily unable to store messages; retry later')
          }
          if (st) results[e.id] = st
        }
        for (const n of toPump) pump(n)
        return reply(res, 200, { results })
      }
      case 'POST /v1/hello': {
        if (peerHost && q.wake.run(peerHost).changes) kick()
        learnPeers(d.peers)
        return reply(res, 200, { host: cfg.host, peers: shareablePeers() })
      }
      case 'GET /v1/sessions':
        return reply(res, 200, { host: cfg.host, sessions: [...sessions.keys()] })

      // ---- local sessions ----
      case 'GET /local/stream': {
        const want = sanitizeName(u.searchParams.get('name'))
        const token = String(u.searchParams.get('token') || '')
        let name = want
        const existing = sessions.get(want)
        // a reconnecting session (same token) replaces its own stale stream; anyone else gets a new name
        if (existing && token && existing.token === token) { existing.res.end(); sessions.delete(want) }
        for (let i = 2; sessions.has(name); i++) name = `${want.slice(0, 47 - String(i).length)}-${i}`   // stays within the 48-char name limit
        // signed like any reply, so the session knows it's talking to the real node, not a squatter on the port
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive',
          'x-agentlink-sig': signResponse(cfg.secret, res.reqAuth || '', res.nodeHdr || nodeHeader, '') })
        const s = { res, sent: new Set(), token, live: u.searchParams.get('mode') !== 'poll' }
        sessions.set(name, s)
        sse(res, 'hello', { name, address: `${name}@${cfg.host}`, host: cfg.host })
        const ping = setInterval(() => res.write(': ping\n\n'), 20_000)
        res.on('close', () => { clearInterval(ping); if (sessions.get(name) === s) sessions.delete(name) })
        log(`session connected: ${name}`)
        pump(name)
        return
      }
      case 'POST /local/ack': {               // state 'pushed': shown in a channel session (no read receipt)
        const s = sessions.get(d.name)
        const mark = d.state === 'pushed' ? q.pushed : q.delivered
        for (const id of Array.isArray(d.ids) ? d.ids : []) { mark.run(now(), String(id)); s?.sent.delete(String(id)) }
        return reply(res, 200, { ok: true })
      }
      case 'GET /local/whoami':
        return reply(res, 200, { host: cfg.host, net: cfg.net, pid: process.pid })
      case 'POST /local/nack': {               // the session couldn't take these: offer them again
        const s = sessions.get(d.name)
        for (const id of Array.isArray(d.ids) ? d.ids : []) s?.sent.delete(String(id))
        if (s) setTimeout(() => pump(d.name), 2000)
        return reply(res, 200, { ok: true })
      }
      case 'POST /local/send':
        return reply(res, 200, await localSend(d))
      case 'GET /local/peers':
        return reply(res, 200, await localPeers())
      case 'GET /local/history': {
        const limit = Math.max(1, Math.min(Math.floor(Number(u.searchParams.get('limit'))) || 20, 200))
        const rows = q.history.all(sanitizeName(u.searchParams.get('name')), limit)
        return reply(res, 200, { messages: rows.map(r => ({ id: r.id, from: r.from_addr, body: r.body, sent_at: r.sent_at, state: r.state })) })
      }
      case 'GET /local/status':
        return reply(res, 200, {
          host: cfg.host, aliases: [...selfAliases], net: cfg.net, port: cfg.port, version: VERSION, pid: process.pid,
          sessions: [...sessions.keys()], counts: q.counts.all(), peers: allPeers(),
          pending: db.prepare(`SELECT id,to_addr,role,attempts,replicated,last_error FROM messages WHERE state='pending' ORDER BY sent_at LIMIT 20`).all(),
        })
      case 'POST /local/shutdown':
        reply(res, 200, { ok: true })
        return setTimeout(() => shutdown(), 50)
    }
    return reply(res, 404, { error: 'not found' })
  }

  log(`agentlink node ${VERSION} up: ${cfg.host}:${cfg.port} (network ${cfg.net}, pid ${process.pid})`)

  // ---------- discovery ----------
  const discovery = cfg.discovery ? startDiscovery(cfg, ({ host, addr }) => {
    const h = hostOf(host)
    if (h && !isSelf(h)) probe(h, addr)        // beacons are only hints: verify before routing
  }, log) : null

  const timers = [
    setInterval(flush, 5000),
    setInterval(helloAll, HELLO_EVERY),
    setInterval(gc, 3600_000),
  ]
  helloAll()
  kick()
  gc()

  let closing = false
  function shutdown() {
    if (closing) return
    closing = true
    log('shutting down')
    timers.forEach(clearInterval)
    for (const s of sessions.values()) s.res.end()
    discovery?.stop()
    server.close()
    setTimeout(() => { try { db.close() } catch {}; process.exit(0) }, 300)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  return { server, shutdown }
}

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let packing = null
/** npm-pack this installation so another machine can install it from us. */
/** @param {string} dir @returns {Promise<string>} path of the tarball */
function packTarball(dir) {
  return packing ||= (async () => {
    const out = path.join(dir, 'dist')
    fs.rmSync(out, { recursive: true, force: true })
    fs.mkdirSync(out, { recursive: true })
    const { stdout } = await execFileP('npm', ['pack', '--silent', '--pack-destination', out], { cwd: PKG_ROOT })
    return path.join(out, stdout.trim().split('\n').pop() || '')
  })().finally(() => setTimeout(() => { packing = null }, 60_000))
}

/** install.sh with this network preset: package from us, secret, and how to reach us. */
/** @param {string | undefined} hostHeader @param {Config} cfg */
function installScript(hostHeader, cfg) {
  const sh = (/** @type {unknown} */ v) => `'${String(v).replace(/'/g, `'\\''`)}'`
  // the name the joining machine used to reach us is, by definition, one that works for it
  const hh = String(hostHeader || '')
  const used = /^[a-z0-9.-]+(:\d{1,5})?$/i.test(hh) ? hh : `${cfg.host}:${cfg.port}`
  const peers = [...new Set([used.includes(':') ? used : `${used}:${cfg.port}`, `${cfg.host}:${cfg.port}`])]
  const preset = [
    `AGENTLINK_PKG=${sh(`http://${used}/pkg.tgz?k=${encodeURIComponent(cfg.secret)}`)}`,
    // "--" ends the flags, so a secret can never be mistaken for one
    `set -- ${peers.map(p => `--peer ${sh(p)}`).join(' ')} -- ${sh(cfg.secret)}`,
  ].join('\n')
  return fs.readFileSync(path.join(PKG_ROOT, 'install.sh'), 'utf8').replace('#@@PRESET@@', () => preset)   // no $-patterns
}

/** @param {http.ServerResponse} res @param {string} event @param {unknown} data */
function sse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
/** An error carrying the HTTP status to reply with. @param {number} status @param {string} message */
function httpErr(status, message) { return Object.assign(new Error(message), { status }) }
const isLoopback = (/** @type {string | undefined} */ a) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'

/** @param {http.IncomingMessage} req @returns {Promise<string>} */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    /** @type {Buffer[]} */
    const chunks = []
    req.on('data', (/** @type {Buffer} */ c) => {
      size += c.length
      if (size > MAX_REQ) { reject(httpErr(413, 'request too large')); req.destroy() } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * A response body, refusing to buffer more than `max` bytes (whoever answered isn't verified yet).
 * @param {Response} res @param {number} max
 */
async function readCapped(res, max) {
  if (Number(res.headers.get('content-length')) > max) { await res.body?.cancel().catch(() => {}); throw new Error('response too large') }
  if (!res.body) return ''
  /** @type {Buffer[]} */
  const chunks = []
  let n = 0
  for await (const c of res.body) {
    n += c.length
    if (n > max) throw new Error('response too large')   // leaving the loop cancels the stream
    chunks.push(Buffer.from(c))
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Did a probe of `addr` reach the responder directly? `at` is the local "ip/port" the responder saw
 * the connection arrive on (signed). A relay (someone replaying a beacon from their own address and
 * forwarding to the real node) shows up as a mismatch. Names are resolved and any address matches.
 * @param {string} addr @param {string | null} at
 */
async function reachedDirectly(addr, at) {
  const m = at?.match(/^(.+)\/(\d+)$/)
  const port = addr.match(/:(\d+)$/)?.[1]
  if (!m || m[2] !== port) return false
  const h = addr.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
  const norm = (/** @type {string} */ a) => a.toLowerCase().replace(/^::ffff:/, '')
  if (net.isIP(h)) return norm(h) === norm(m[1])
  try { return (await dns.lookup(h, { all: true })).some(r => norm(r.address) === norm(m[1])) } catch { return false }
}

/** A request() failure meaning "that name is this machine; the rows were taken into our inbox". */
const isSelfErr = (/** @type {unknown} */ err) => !!(err && typeof err === 'object' && 'self' in err && err.self)
