// The per-machine node: durable store, local session hub, peer-to-peer delivery, LAN discovery.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { openStore } from './store.js'
import { startDiscovery } from './discovery.js'
import { signEnvelope, verifyEnvelope, authHeader, checkAuth, signResponse, verifyResponse, NonceCache, safeEq } from './crypto.js'
import { parseAddr, normHost, sanitizeName, validAddr, tailscaleName, VERSION } from './config.js'

const MAX_REQ = 2 << 20
const MAX_BATCH = 1 << 20              // bytes of envelopes per request (well under MAX_REQ)
const MAX_MSG = 64 * 1024
const BACKOFF_MAX = 60_000
const HELLO_EVERY = 120_000
const REPLICATE_TO = 3                 // max other nodes that hold a copy for an offline machine
const PEER_FORGET_MS = 30 * 86400_000
const IN_FLIGHT_MS = 30_000            // a send being delivered directly is hidden from the flush loop

const execFileP = promisify(execFile)
const now = () => Date.now()
const backoff = n => Math.min(BACKOFF_MAX, 2000 * 2 ** Math.min(n, 5))
const errText = err => String(err.cause?.code || err.message || err)

export async function runNode(cfg, log = (...a) => console.error(new Date().toISOString(), ...a)) {
  fs.mkdirSync(cfg.dir, { recursive: true, mode: 0o700 })
  // Bind the port before touching the shared database: a node that loses the race for the port
  // (a standby service, a second session-started node) must not reset retry state or leak handles.
  let onRequest = (req, res) => { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"starting"}') }
  const server = http.createServer((req, res) => onRequest(req, res))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(cfg.port, () => { server.off('error', reject); resolve() })
  })
  let db
  try { db = openStore(path.join(cfg.dir, 'agentlink.db')) } catch (e) { server.close(); throw e }
  const nodeHeader = `${cfg.host};net=${cfg.net};port=${cfg.port}`
  const nonces = new NonceCache()
  const sessions = new Map()           // name -> { res, sent:Set<id>, token }

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
    history: db.prepare(`SELECT * FROM messages WHERE role='inbox' AND to_name=? ORDER BY sent_at DESC LIMIT ?`),
    expire: db.prepare(`UPDATE messages SET state='expired', updated_at=? WHERE state IN ('pending','queued') AND expires_at<=?`),
    gc: db.prepare(`DELETE FROM messages WHERE expires_at < ?`),
    counts: db.prepare(`SELECT role, state, count(*) n FROM messages GROUP BY role, state`),
    upsertPeer: db.prepare(`INSERT INTO peers(host,addr,last_seen,configured) VALUES(?,?,?,?)
      ON CONFLICT(host) DO UPDATE SET last_seen=excluded.last_seen,
        addr=COALESCE(excluded.addr, peers.addr), configured=MAX(peers.configured, excluded.configured)`),
    peer: db.prepare(`SELECT * FROM peers WHERE host=?`),
    peers: db.prepare(`SELECT * FROM peers ORDER BY host`),
    insertPeerIfNew: db.prepare(`INSERT OR IGNORE INTO peers(host,addr,last_seen,configured) VALUES(?,?,?,0)`),
    setAlias: db.prepare(`UPDATE peers SET alias_of=? WHERE host=?`),
    clearAlias: db.prepare(`UPDATE peers SET alias_of=NULL WHERE host=? AND alias_of IS NOT NULL`),
    deletePeer: db.prepare(`DELETE FROM peers WHERE host=?`),
    forgetPeers: db.prepare(`DELETE FROM peers WHERE configured=0 AND last_seen < ?`),
    verified: db.prepare(`UPDATE peers SET verified=1 WHERE host=?`),
    clearAddr: db.prepare(`UPDATE peers SET addr=NULL WHERE host=?`),
  }

  // ---------- identity ----------
  const selfAliases = new Set(cfg.aliases)
  const ts = cfg.autoAliases ? tailscaleName() : null
  if (ts) selfAliases.add(ts)
  selfAliases.delete(cfg.host)
  const isSelf = h => h === cfg.host || selfAliases.has(h)

  /**
   * A request for `name` was answered by this node. If `name` is a machine we know to be a separate
   * node (it has answered as itself, or it's a configured peer), the address we used is simply wrong
   * now (DHCP reuse, spoofed name resolution): forget the address and keep retrying. Otherwise `name`
   * is one of our own names (an IP, a Tailscale name used by a sender): take delivery of anything
   * queued for it. Learned aliases are kept in memory only.
   * Returns true if adopted.
   */
  function reachedSelfAs(name) {
    if (!name || name === cfg.host) return true
    const row = q.peer.get(name)
    if (row && (row.verified || row.configured)) {
      log(`address ${row.addr || name} for ${name} now reaches this machine; forgetting it`)
      q.clearAddr.run(name)
      return false
    }
    if (!selfAliases.has(name)) log(`learned that ${name} is this machine`)
    selfAliases.add(name)
    if (row) q.deletePeer.run(name)
    const names = new Set(q.toInbox.all(cfg.host, now(), name).map(r => r.to_name))
    for (const n of names) pump(n)
    return true
  }

  for (const pe of cfg.peers) if (!isSelf(pe.host)) q.upsertPeer.run(pe.host, pe.addr, now(), 1)
  db.exec(`UPDATE messages SET next_attempt=0 WHERE state='pending'`)   // fresh start: retry everything now

  // ---------- peers ----------
  const addrOf = host => cfg.routes[host] || q.peer.get(host)?.addr || `${host}:${cfg.port}`
  const hostOf = hdr => { try { return normHost(String(hdr || '').split(';')[0]) } catch { return null } }

  /** Authenticated request to another node. Returns { data, real } where real is the host that answered. */
  async function request(host, method, p, obj, { timeout = 4000, addr } = {}) {
    const body = obj === undefined ? '' : JSON.stringify(obj)
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
    const text = await res.text()
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
      const row = q.peer.get(host)
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
    return { data: text ? JSON.parse(text) : {}, real }
  }
  const call = async (...a) => (await request(...a)).data

  /** Start routing `host` to `addr`, but only once a node there proves (with the secret) that it is `host`. */
  const probing = new Set()
  async function probe(host, addr) {
    if (!validAddr(addr) || isSelf(host)) return
    const cur = q.peer.get(host)
    if (cur?.addr === addr) {
      q.upsertPeer.run(host, null, now(), 0)
      if (q.wake.run(host).changes) kick()
      return
    }
    const key = `${host} ${addr}`
    if (probing.has(key)) return
    probing.add(key)
    try {
      const { data, real } = await request(host, 'POST', '/v1/hello', { peers: shareablePeers() }, { addr, timeout: 2500 })
      if (real !== host) return
      q.upsertPeer.run(host, addr, now(), 0)
      learnPeers(data.peers)
      if (cur?.addr !== addr) log(`${host} is at ${addr}`)
      if (q.wake.run(host).changes) kick()
    } catch {} finally { probing.delete(key) }
  }

  /** Track a peer that sent us an authenticated request. */
  function notePeer(hdr, remoteIp) {
    if (!hdr) return null
    const parts = Object.fromEntries(hdr.split(';').slice(1).map(kv => kv.split('=')))
    if (parts.net !== cfg.net) return null
    const host = hostOf(hdr)
    if (!host || isSelf(host)) return null
    q.upsertPeer.run(host, null, now(), 0)
    q.verified.run(host)
    const ip = String(remoteIp || '').replace(/^::ffff:/, '')
    const port = Number(parts.port)
    if (ip && !/^(127\.|::1$)/.test(ip) && port > 0 && port < 65536) {
      const addr = ip.includes(':') ? `[${ip}]:${port}` : `${ip}:${port}`
      if (q.peer.get(host)?.addr !== addr && !cfg.routes[host]) probe(host, addr)
    }
    return host
  }

  function knownPeers({ includeAliases = true } = {}) {
    return q.peers.all().filter(r => !isSelf(r.host) && (includeAliases || !r.alias_of)).map(r => r.host)
  }

  /** Peers worth telling others about (so every node learns the whole network). */
  function shareablePeers() {
    const cutoff = now() - 86400_000
    return q.peers.all().filter(r => !r.alias_of && r.last_seen >= cutoff && r.addr).map(r => ({ host: r.host, addr: r.addr }))
  }
  function learnPeers(list) {
    for (const pe of Array.isArray(list) ? list.slice(0, 200) : []) {
      if (typeof pe?.host !== 'string' || !validAddr(pe?.addr)) continue
      const h = hostOf(pe.host)
      if (h && !isSelf(h)) q.insertPeerIfNew.run(h, pe.addr, now() - 3600_000)
    }
  }

  async function hello(host) {
    try {
      const r = await call(host, 'POST', '/v1/hello', { peers: shareablePeers() }, { timeout: 2500 })
      learnPeers(r.peers)
      if (q.wake.run(host).changes) kick()   // it's reachable: retry anything waiting for it now
    } catch {}
  }
  function helloAll() { for (const h of knownPeers()) hello(h) }

  // ---------- messages ----------
  const envOf = r => ({ id: r.id, from: r.from_addr, to: r.to_addr, body: r.body, sent_at: r.sent_at, expires_at: r.expires_at, sig: r.sig })

  function validEnv(e) {
    return e && typeof e === 'object' &&
      ['id', 'from', 'to', 'body', 'sig'].every(k => typeof e[k] === 'string') &&
      e.id.length <= 64 && e.from.length <= 320 && e.to.length <= 320 &&
      Number.isFinite(e.sent_at) && Number.isFinite(e.expires_at) &&
      Buffer.byteLength(e.body) <= MAX_MSG && verifyEnvelope(cfg.secret, e)
  }

  /**
   * Store an incoming envelope durably. Returns 'live' | 'queued' | 'held' | 'expired' | null(rejected).
   * null means the envelope itself is bad (the sender must not retry it). Storage errors (disk full,
   * database busy) throw, so callers can report a temporary failure and the sender retries.
   */
  function accept(e) {
    let to
    try {
      if (!validEnv(e)) return null
      to = parseAddr(e.to, cfg.host)
    } catch (err) {
      log('rejected envelope:', err.message)
      return null
    }
    if (e.expires_at <= now()) return 'expired'
    if (isSelf(to.host)) {
      q.insert.run(e.id, e.from, e.to, cfg.host, to.name, e.body, e.sent_at, e.expires_at, e.sig, 'inbox', 'queued', 0, now())
      pump(to.name)
      return sessions.has(to.name) ? 'live' : 'queued'
    }
    q.insert.run(e.id, e.from, e.to, to.host, to.name, e.body, e.sent_at, e.expires_at, e.sig, 'held', 'pending', 0, now())
    kick()
    return 'held'
  }

  function pump(name) {
    const s = sessions.get(name)
    if (!s) return
    for (const r of q.inboxQueued.all(name, now())) {
      if (s.sent.has(r.id)) continue
      s.sent.add(r.id)
      sse(s.res, 'message', { id: r.id, from: r.from_addr, to: r.to_addr, body: r.body, sent_at: r.sent_at })
    }
  }

  /** Split rows into request-sized batches. */
  function batches(rows) {
    const out = []
    let cur = [], size = 0
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
        if (err.self) return null            // rows were taken into our own inbox
        const rest = rows.slice(rows.indexOf(batch[0]))
        for (const r of rest) q.retry.run(now() + backoff(r.attempts), errText(err), now(), r.id)
        return { err, rest }
      }
    }
    return null
  }

  // ---------- forwarding loop ----------
  let flushing = null, again = false
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
    for (const r of q.due.all(t, t)) {
      if (isSelf(r.to_host)) { reachedSelfAs(r.to_host); continue }
      if (!byHost.has(r.to_host)) byHost.set(r.to_host, [])
      byHost.get(r.to_host).push(r)
    }
    await Promise.all([...byHost].map(async ([host, rows]) => {
      const failure = await handOver(host, rows)
      if (failure) await replicate(host, failure.rest.filter(r => r.role === 'outbox' && !r.replicated))
    }))
  }

  /** Hand copies to other reachable nodes so they can deliver when `host` comes back. */
  async function replicate(host, rows) {
    try { await replicateInner(host, rows) } catch (e) { log('replicate error', e.message) }
  }
  async function replicateInner(host, rows) {
    if (!rows.length) return
    const cutoff = now() - 10 * 60_000
    const candidates = q.peers.all()
      .filter(p => !isSelf(p.host) && p.host !== host && !p.alias_of && p.alias_of !== host && p.last_seen >= cutoff)
      .filter(p => q.peer.get(host)?.alias_of !== p.host)
      .sort((a, b) => b.last_seen - a.last_seen)
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
  async function localSend(d) {
    if (typeof d.body !== 'string' || !d.body) throw httpErr(400, 'message body required')
    if (Buffer.byteLength(d.body) > MAX_MSG) throw httpErr(413, `message too large (max ${MAX_MSG} bytes)`)
    if (!d.to) throw httpErr(400, 'recipient required (name@host)')
    let to
    try { to = parseAddr(d.to, cfg.host) } catch (e) { throw httpErr(400, `bad recipient "${d.to}": ${e.message}`) }
    const real = q.peer.get(to.host)?.alias_of          // e.g. desk.tailnet.ts.net -> desk.local
    if (real) to.host = real
    if (isSelf(to.host)) to.host = cfg.host
    const e = {
      id: crypto.randomUUID(),
      from: `${sanitizeName(d.from || 'cli')}@${cfg.host}`,
      to: `${to.name}@${to.host}`,
      body: d.body,
      sent_at: now(),
      expires_at: now() + (Number(d.ttl_ms) > 0 ? Math.min(Number(d.ttl_ms), cfg.ttlMs) : cfg.ttlMs),
    }
    e.sig = signEnvelope(cfg.secret, e)
    if (to.host === cfg.host) {
      let st
      try { st = accept(e) } catch (err) { throw httpErr(503, `could not queue message: ${err.message}`) }
      if (!st) throw httpErr(500, 'could not queue message')
      return { id: e.id, to: e.to, status: st === 'live' ? 'delivered (live session on this machine)' : `queued on this machine until ${e.to} connects` }
    }
    // hidden from the flush loop while we try the direct hand-off, so it isn't sent twice
    q.insert.run(e.id, e.from, e.to, to.host, to.name, e.body, e.sent_at, e.expires_at, e.sig, 'outbox', 'pending', now() + IN_FLIGHT_MS, now())
    let remote = null, replicating = false
    try {
      const res = await call(to.host, 'POST', '/v1/deliver', { messages: [e] })
      remote = res.results?.[e.id]
      if (remote) q.forwarded.run(now(), e.id)
      else q.failed.run(`rejected by ${to.host} (invalid or malformed message)`, now(), e.id)
    } catch (err) {
      if (!err.self) {
        q.retry.run(now() + backoff(0), errText(err), now(), e.id)
        const row = q.get.get(e.id)
        // the message is stored durably now: answer the client and hand out copies in the background
        // (trying several offline candidates in turn could otherwise outlast the client's timeout)
        if (row?.state === 'pending') { replicating = true; replicate(to.host, [row]) }
      }
    }
    const r = q.get.get(e.id)
    let status
    if (r.role === 'inbox') status = `${to.host} is this machine — ${sessions.has(to.name) ? 'delivered (live)' : `queued until ${to.name} connects`}`
    else if (r.state === 'forwarded') status = remote === 'live' ? `delivered to ${e.to} (live)` : `stored on ${to.host}; will be delivered when ${to.name} connects`
    else if (r.state === 'failed') status = `FAILED: ${r.last_error}`
    else status = `${to.host} unreachable (${r.last_error}); queued — will deliver when it comes back` + (replicating ? ' (also handing copies to other online nodes)' : '')
    return { id: e.id, to: e.to, status }
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
  function reply(res, status, obj) {
    const body = JSON.stringify(obj)
    const headers = { 'content-type': 'application/json' }
    if (res.reqAuth) headers['x-agentlink-sig'] = signResponse(cfg.secret, res.reqAuth, nodeHeader, body)
    res.writeHead(status, headers)
    res.end(body)
  }

  onRequest = (req, res) => handle(req, res).catch(err => {
    if (!res.headersSent) reply(res, err.status || 500, { error: err.status ? err.message : 'internal error' })
    else res.destroy()
    if (!err.status) log('request error', req.method, req.url, err)
  })

  async function handle(req, res) {
    const u = new URL(req.url, 'http://x')
    const p = u.pathname
    res.setHeader('x-agentlink-node', nodeHeader)
    if (p === '/health') return reply(res, 200, { ok: true, host: cfg.host, net: cfg.net, version: VERSION, pid: process.pid })
    if (req.method === 'GET' && (p === '/install' || p === '/pkg.tgz')) {
      if (!safeEq(u.searchParams.get('k'), cfg.secret)) return reply(res, 404, { error: 'not found' })
      if (p === '/install') {
        res.writeHead(200, { 'content-type': 'text/x-shellscript' })
        return res.end(installScript(req.headers.host, cfg))
      }
      const tgz = await packTarball(cfg.dir)
      const stream = fs.createReadStream(tgz)
      stream.on('error', () => { if (!res.headersSent) reply(res, 500, { error: 'package unavailable' }); else res.destroy() })
      stream.on('open', () => {
        res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': fs.statSync(tgz).size })
        stream.pipe(res)
      })
      return
    }
    const nodeHdr = req.headers['x-agentlink-node'] || ''
    const auth = req.headers['x-agentlink-auth']
    const body = req.method === 'POST' ? await readBody(req) : ''
    if (!checkAuth(cfg.secret, auth, req.method, p, body, nodeHdr, nonces))
      return reply(res, 401, { error: 'unauthorized (different network secret, replayed request, or clocks more than 5 minutes apart)' })
    res.reqAuth = auth
    let d = {}
    if (body) { try { d = JSON.parse(body) } catch { return reply(res, 400, { error: 'bad JSON' }) } }
    if (!d || typeof d !== 'object') d = {}
    const loopback = isLoopback(req.socket.remoteAddress)
    if (p.startsWith('/local/') && !loopback) return reply(res, 403, { error: 'local only' })
    const peerHost = p.startsWith('/v1/') ? notePeer(nodeHdr, req.socket.remoteAddress) : null

    switch (`${req.method} ${p}`) {
      // ---- node <-> node ----
      case 'POST /v1/deliver': {
        const results = {}
        for (const e of Array.isArray(d.messages) ? d.messages.slice(0, 2000) : []) {
          let st
          try { st = accept(e) } catch (err) {
            // temporary storage failure: 503 makes the sender back off and retry the whole batch
            // (already-stored ids are deduplicated), instead of marking messages permanently failed
            log('could not store delivered messages:', err.message)
            throw httpErr(503, 'temporarily unable to store messages; retry later')
          }
          if (st) results[e.id] = st
        }
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
        for (let i = 2; sessions.has(name); i++) name = `${want}-${i}`
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        const s = { res, sent: new Set(), token }
        sessions.set(name, s)
        sse(res, 'hello', { name, address: `${name}@${cfg.host}`, host: cfg.host })
        const ping = setInterval(() => res.write(': ping\n\n'), 20_000)
        res.on('close', () => { clearInterval(ping); if (sessions.get(name) === s) sessions.delete(name) })
        log(`session connected: ${name}`)
        pump(name)
        return
      }
      case 'POST /local/ack': {
        const s = sessions.get(d.name)
        for (const id of Array.isArray(d.ids) ? d.ids : []) { q.delivered.run(now(), String(id)); s?.sent.delete(String(id)) }
        return reply(res, 200, { ok: true })
      }
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
        const rows = q.history.all(sanitizeName(u.searchParams.get('name')), Math.min(Number(u.searchParams.get('limit')) || 20, 200))
        return reply(res, 200, { messages: rows.map(r => ({ id: r.id, from: r.from_addr, body: r.body, sent_at: r.sent_at, state: r.state })) })
      }
      case 'GET /local/status':
        return reply(res, 200, {
          host: cfg.host, aliases: [...selfAliases], net: cfg.net, port: cfg.port, version: VERSION, pid: process.pid,
          sessions: [...sessions.keys()], counts: q.counts.all(), peers: q.peers.all(),
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
function packTarball(dir) {
  return packing ||= (async () => {
    const out = path.join(dir, 'dist')
    fs.rmSync(out, { recursive: true, force: true })
    fs.mkdirSync(out, { recursive: true })
    const { stdout } = await execFileP('npm', ['pack', '--silent', '--pack-destination', out], { cwd: PKG_ROOT })
    return path.join(out, stdout.trim().split('\n').pop())
  })().finally(() => setTimeout(() => { packing = null }, 60_000))
}

/** install.sh with this network preset: package from us, secret, and how to reach us. */
function installScript(hostHeader, cfg) {
  const sh = v => `'${String(v).replace(/'/g, `'\\''`)}'`
  // the name the joining machine used to reach us is, by definition, one that works for it
  const used = /^[a-z0-9.-]+(:\d{1,5})?$/i.test(String(hostHeader || '')) ? hostHeader : `${cfg.host}:${cfg.port}`
  const peers = [...new Set([used.includes(':') ? used : `${used}:${cfg.port}`, `${cfg.host}:${cfg.port}`])]
  const preset = [
    `AGENTLINK_PKG=${sh(`http://${used}/pkg.tgz?k=${encodeURIComponent(cfg.secret)}`)}`,
    `set -- ${sh(cfg.secret)} ${peers.map(p => `--peer ${sh(p)}`).join(' ')}`,
  ].join('\n')
  return fs.readFileSync(path.join(PKG_ROOT, 'install.sh'), 'utf8').replace('#@@PRESET@@', preset)
}

function sse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
function httpErr(status, message) { return Object.assign(new Error(message), { status }) }
const isLoopback = a => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', c => {
      size += c.length
      if (size > MAX_REQ) { reject(httpErr(413, 'request too large')); req.destroy() } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
