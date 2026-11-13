// The per-machine node: durable store, local session hub, peer-to-peer delivery, LAN discovery.
//
// Every connection, in and out, is TLS. The certificate this node presents is a throwaway (a fresh
// key per connection; while invites are open, the invite key), so connecting to the port shows
// nothing that identifies the machine. Who is who is proved inside the connection (see tls.js):
// outgoing connections accept only the machine the roster says should be at the other end, so an
// address is usable for a machine exactly when the machine there proves it holds that key, and a
// stranger who happens to hold a stored address is never told who we are or sent a request.
import https from 'node:https'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { openStore } from './store.js'
import { startDiscovery } from './discovery.js'
import { signEnvelope, verifyEnvelope, sha256, randomToken, gateOk, proveAuth, checkAuth } from './crypto.js'
import { fingerprint, shortFp, newIdentity, selfSignedCert } from './cert.js'
import { Roster, MAX_ROSTER_BYTES } from './roster.js'
import { authedRequest, exporterOf, PinError, ProtoError, PROTO, MAX_BODY as MAX_REQ, MIN_RATE } from './tls.js'
import { SEA, PKG_ROOT, readAsset, appBundle } from './self.js'
import { renameOldDb } from './legacy.js'
import { createLeases, parseResource, sessionId, cleanLease, MAX_RESOURCE, SID } from './leases.js'
import { parseAddr, parsePeer, normHost, machineName, sanitizeName, shQuote, validAddr, tailscaleName, localIPv4s, errMsg, netHint, ensureHomeDir, rosterPath, MAX_TTL_MS, VERSION } from './config.js'

const MAX_JOIN_REQ = 16 << 10          // a join request (before any identity check) is small
const MAX_JOIN_CHAIN = 4               // add records an unknown client may submit (it, whoever added it, ...)
const MAX_REPLY = 1 << 20              // a reply to anything but a hello: only a hello carries a roster
const MAX_BATCH = 256 << 10            // bytes of envelopes per request (well under MAX_REQ)
const MAX_MSG = 64 * 1024
const BACKOFF_MAX = 60_000
const HELLO_EVERY = 120_000
const REPLICATE_TO = 3                 // max other nodes that hold a copy for an offline machine
const PEER_FORGET_MS = 30 * 86400_000
const IN_FLIGHT_MS = 30_000            // a send being delivered directly is hidden from the flush loop
const PROBE_RETRY_MS = 10 * 60_000     // don't re-probe an address that just failed verification
const HELLO_CONCURRENCY = 2            // offline .local names tie up a DNS (libuv) thread each for seconds
const FLUSH_HOSTS = 8                  // machines being delivered to at once
const PUMP_WINDOW = 256                // messages a session may hold unacknowledged: the rest wait here
const PUMP_BUFFER = 1 << 20            // bytes waiting for a session to read before we stop writing
const PEERS_WAIT_MS = 5000             // `peers` answers by then: a machine that slow counts as offline
const CLOCK_SLACK_MS = 86400_000       // how far ahead of us a sender's clock can put a message's expiry
const INVITE_TTL_MS = 24 * 3600_000
const SEND_WAIT_MS = 10_000            // a send answers by then: it's stored, and clients stop waiting at 15 s
const COMPACT_WAIT_MS = 100_000        // to catch up before a snapshot: the command waits a little longer
const MAX_LOG = 10 << 20               // node.log is cut back to its last MB past this
const LOG_ERRORS_PER_MIN = 10          // failed requests logged: anyone can cause one

/** @typedef {import('./types.js').Config} Config */
/** @typedef {import('./types.js').Envelope} Envelope */
/** @typedef {import('./types.js').MessageRow} MessageRow */
/** @typedef {import('./types.js').PeerRow} PeerRow */
/** @typedef {http.ServerResponse} Res */
/** What the forwarding loop needs of a row: the text is read only when it's being sent. */
/** @typedef {Pick<MessageRow, 'id' | 'to_host' | 'role' | 'attempts' | 'replicated'>} DueRow */

const execFileP = promisify(execFile)
const now = () => Date.now()
const backoff = (/** @type {number} */ n) => Math.min(BACKOFF_MAX, 2000 * 2 ** Math.min(n, 5))
const ignore = () => {}

/**
 * @param {Config} cfg
 * @param {(...a: any[]) => void} [log]
 */
export async function runNode(cfg, log = (...a) => { try { console.error(new Date().toISOString(), ...a) } catch {} }) {
  ensureHomeDir(cfg.dir)
  // a full disk mustn't take the node down with its log. (Once: a standby service gets here on every retry)
  if (!process.stderr.listeners('error').includes(ignore)) process.stderr.on('error', ignore)
  const me = cfg.identity
  // Bind the port before touching the shared database: a node that loses the race for the port
  // (a standby service, a second session-started node) must not reset retry state or leak handles.
  /** @type {(req: http.IncomingMessage, res: Res) => void} */
  let onRequest = (req, res) => { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"starting"}') }
  // TLS 1.2 is accepted for the installer download (macOS curl's SecureTransport has no TLS 1.3);
  // the identity exchange requires TLS 1.3.
  /** @param {{ key: string, cert: string }} id */
  const tlsOpts = id => ({ key: id.key, cert: id.cert, minVersion: /** @type {const} */ ('TLSv1.2') })
  const server = https.createServer(tlsOpts(newIdentity()), (req, res) => onRequest(req, res))
  server.on('tlsClientError', () => {})
  /** @type {() => void} */
  let rotate = () => {}
  server.on('connection', () => rotate())
  await new Promise(/** @param {(v?: void) => void} resolve */ (resolve, reject) => {
    server.once('error', reject)
    server.listen(cfg.port, () => { server.off('error', reject); resolve() })
  })
  /** @type {import('node:sqlite').DatabaseSync} */
  let db
  /** @type {Roster} */
  let roster
  try {
    roster = Roster.load(rosterPath(cfg.dir))
    renameOldDb(cfg.dir)          // this node has the port, so no other node of this machine has it open
    db = openStore(path.join(cfg.dir, 'nattermatic.db'))
  } catch (e) { server.close(); throw e }
  const myPub = crypto.createPublicKey(me.key)
  // the roster decides this machine's name: under any other, its messages wouldn't be accepted
  const rosterName = roster.members.get(me.fp)?.host
  if (rosterName && rosterName !== cfg.host) {
    log(`this machine is ${rosterName} on its network, not ${cfg.host}: using ${rosterName}`)
    cfg.host = rosterName
  }
  if (!roster.members.has(me.fp)) log(roster.removed.has(me.fp) ? 'this machine has been removed from the network' : 'this machine is not (yet) a member of its network')
  /** @type {Map<string, { res: Res, sent: Set<string>, token: string, live: boolean, owner: number, cwd: string, notified: Set<string>, waiter: Res | null, more: boolean, draining: boolean, lastActive: number }>} name -> session stream (live: woken by channel pushes; sent: offered, not yet acknowledged) */
  const sessions = new Map()

  const q = {
    insert: db.prepare(`INSERT OR IGNORE INTO messages
      (id,from_addr,to_addr,to_host,to_name,body,sent_at,expires_at,sig,role,state,next_attempt,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    get: db.prepare(`SELECT * FROM messages WHERE id=?`),
    // the names with something due, those tried least first, so a backlog for a machine that's off
    // can't keep the others waiting; what's due for one name, the oldest first; and the names nothing
    // has identified, the same way, so a crowd of made-up names can't keep a real one waiting
    due: db.prepare(`SELECT to_host FROM messages WHERE state='pending' AND next_attempt<=? AND expires_at>? AND to_host IN (SELECT value FROM json_each(?)) GROUP BY to_host ORDER BY MIN(attempts)`),
    dueFor: db.prepare(`SELECT id,to_host,role,attempts,replicated FROM messages WHERE state='pending' AND next_attempt<=? AND expires_at>? AND to_host=? ORDER BY sent_at LIMIT 2000`),
    dueNames: db.prepare(`SELECT to_host FROM messages WHERE state='pending' AND next_attempt<=? AND expires_at>? AND to_host NOT IN (SELECT value FROM json_each(?)) GROUP BY to_host ORDER BY MIN(attempts) LIMIT ?`),
    // handed over: the text has no more use here, and shouldn't sit on a holder until the message expires
    forwarded: db.prepare(`UPDATE messages SET state='forwarded', body='', updated_at=? WHERE id=? AND state='pending'`),
    failed: db.prepare(`UPDATE messages SET state='failed', last_error=?, updated_at=? WHERE id=?`),
    retry: db.prepare(`UPDATE messages SET attempts=attempts+1, next_attempt=?, last_error=?, updated_at=? WHERE id=? AND state='pending'`),
    replicated: db.prepare(`UPDATE messages SET replicated=1 WHERE id=?`),
    wake: db.prepare(`UPDATE messages SET next_attempt=0 WHERE state='pending' AND to_host=?`),
    toInbox: db.prepare(`UPDATE messages SET role='inbox', state='queued', to_host=?, updated_at=? WHERE to_host=? AND state='pending' RETURNING to_name`),
    inboxQueued: db.prepare(`SELECT id FROM messages WHERE role='inbox' AND to_name=? AND state='queued' AND expires_at>? ORDER BY sent_at LIMIT ?`),
    // the machine's own copy of something it was holding as a copy for a name it didn't know was its own
    claim: db.prepare(`UPDATE messages SET role='inbox', state='queued', to_host=?, to_name=?, updated_at=? WHERE id=? AND role='held' AND state='pending'`),
    delivered: db.prepare(`UPDATE messages SET state='delivered', updated_at=? WHERE id=? AND role='inbox'`),
    // pushed into a channel session: Claude Code gives no receipt, so this means "shown", not "read"
    pushed: db.prepare(`UPDATE messages SET state='pushed', updated_at=? WHERE id=? AND role='inbox' AND state='queued'`),
    // newest to arrive: sent_at is whatever the sender says
    history: db.prepare(`SELECT * FROM messages WHERE role='inbox' AND to_name=? ORDER BY rowid DESC LIMIT ?`),
    expire: db.prepare(`UPDATE messages SET state='expired', updated_at=? WHERE state IN ('pending','queued') AND expires_at<=?`),
    gc: db.prepare(`DELETE FROM messages WHERE expires_at < ?`),
    counts: db.prepare(`SELECT role, state, count(*) n FROM messages GROUP BY role, state`),
    waiting: db.prepare(`SELECT count(*) n FROM messages WHERE to_host=? AND to_name=? AND state IN ('pending','queued')`),
    // pages in use: what's been freed is used again before the file grows
    stored: db.prepare(`SELECT (p.page_count - f.freelist_count) * s.page_size n FROM pragma_page_count p, pragma_freelist_count f, pragma_page_size s`),
    upsertPeer: db.prepare(`INSERT INTO peers(host,addr,last_seen,configured) VALUES(?,?,?,?)
      ON CONFLICT(host) DO UPDATE SET last_seen=excluded.last_seen,
        addr=COALESCE(excluded.addr, peers.addr), configured=MAX(peers.configured, excluded.configured)`),
    peer: db.prepare(`SELECT * FROM peers WHERE host=?`),
    peers: db.prepare(`SELECT * FROM peers ORDER BY host`),
    setAlias: db.prepare(`UPDATE peers SET alias_of=? WHERE host=?`),
    setVersion: db.prepare(`INSERT INTO peers(host,last_seen,configured,version) VALUES(?,?,0,?)
      ON CONFLICT(host) DO UPDATE SET version=excluded.version`),
    deletePeer: db.prepare(`DELETE FROM peers WHERE host=?`),
    clearAddr: db.prepare(`UPDATE peers SET addr=NULL WHERE host=?`),
    forgetPeers: db.prepare(`DELETE FROM peers WHERE configured=0 AND last_seen < ?`),
    addInvite: db.prepare(`INSERT INTO invites(hash, created_at, expires_at) VALUES(?,?,?)`),
    invite: db.prepare(`SELECT * FROM invites WHERE hash=?`),
    useInvite: db.prepare(`UPDATE invites SET used_at=? WHERE hash=? AND used_at IS NULL`),
    revokeInvites: db.prepare(`DELETE FROM invites WHERE used_at IS NULL`),
    gcInvites: db.prepare(`DELETE FROM invites WHERE expires_at < ?`),
    openInvite: db.prepare(`SELECT 1 FROM invites WHERE used_at IS NULL AND expires_at > ? LIMIT 1`),
    openInvites: db.prepare(`SELECT created_at, expires_at FROM invites WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at`),
  }

  // ---------- the certificate we present ----------
  // While an invite is open, the invite key (the one its curl line pins; shared by all open invites,
  // kept across restarts, replaced once none are open). Otherwise a fresh key for each connection,
  // or at most each second (key generation costs about a millisecond).
  const inviteKeyPath = path.join(cfg.dir, 'invite.key')
  /** @type {{ key: string, cert: string, fp: string } | null} */
  let invite = null
  /** The invite key if any invite is open (deleted once none is). */
  function inviteIdentity() {
    if (!q.openInvite.get(now())) {
      if (invite || fs.existsSync(inviteKeyPath)) { fs.rmSync(inviteKeyPath, { force: true }); invite = null }
      return null
    }
    if (!invite) {
      try {
        const key = fs.readFileSync(inviteKeyPath, 'utf8'), k = crypto.createPrivateKey(key)
        invite = { key, cert: selfSignedCert(k), fp: fingerprint(k) }
      } catch {}
    }
    return invite
  }
  let presenting = '', rotatedAt = 0
  /** @type {NodeJS.Timeout | null} */
  let rotateTimer = null
  rotate = () => {
    let inv = null
    try { inv = inviteIdentity() } catch (e) { log('invite key:', errMsg(e)) }
    if (inv) {
      if (presenting !== inv.fp) { server.setSecureContext(tlsOpts(inv)); presenting = inv.fp }
      return
    }
    // the current key has just been shown: replace it now, or once a second has passed since the last
    // replacement, so no two connections a second or more apart ever see the same key
    const wait = presenting === 'throwaway' ? 1000 - (now() - rotatedAt) : 0
    if (wait > 0) {
      rotateTimer ||= setTimeout(() => { rotateTimer = null; rotate() }, wait)
      rotateTimer.unref()
      return
    }
    server.setSecureContext(tlsOpts(newIdentity()))
    presenting = 'throwaway'
    rotatedAt = now()
  }
  /** A new invite token; makes the invite key if none is open. */
  function newInvite() {
    if (!inviteIdentity()) {
      const id = newIdentity()
      fs.writeFileSync(inviteKeyPath, id.key, { mode: 0o600 })
      invite = id
    }
    const inv = /** @type {{ key: string, cert: string, fp: string }} */ (invite)
    const token = randomToken()
    q.addInvite.run(sha256(token), now(), now() + INVITE_TTL_MS)
    rotate()
    return { token, fp: inv.fp }
  }
  rotate()

  // typed views of the rows node:sqlite returns
  const peerRow = (/** @type {string} */ host) => /** @type {PeerRow | undefined} */ (q.peer.get(host))
  const allPeers = () => /** @type {PeerRow[]} */ (/** @type {unknown} */ (q.peers.all()))
  const msgRow = (/** @type {string} */ id) => /** @type {MessageRow | undefined} */ (q.get.get(id))
  /** @type {(rows: unknown) => DueRow[]} */
  const dueRows = rows => /** @type {DueRow[]} */ (rows)
  /** One commit for many row updates. @param {() => void} fn */
  function tx(fn) {
    db.exec('BEGIN IMMEDIATE')
    try { fn(); db.exec('COMMIT') } catch (e) { try { db.exec('ROLLBACK') } catch {} throw e }
  }

  // ---------- identity ----------
  const selfAliases = new Set(cfg.aliases)
  /** This machine's Tailscale name, if it has one now (Tailscale may arrive while the node runs). */
  function tailscale() {
    const name = cfg.autoAliases ? tailscaleName() : null
    if (name && name !== cfg.host) selfAliases.add(name)
    return name
  }
  tailscale()
  selfAliases.delete(cfg.host)
  const isSelf = (/** @type {string} */ h) => h === cfg.host || selfAliases.has(h)
  /** A current member other than this machine, by name. @param {string} host */
  const member = host => { const m = roster.byHost.get(host); return m && m.fp !== me.fp ? m : undefined }
  const otherMembers = () => [...roster.members.values()].filter(m => m.fp !== me.fp)
  let leaseBusy = false
  const leases = createLeases({
    db, host: () => cfg.host, dir: cfg.dir, sessions, log,
    call: (h, m, p, o, opts) => call(h, /** @type {'GET'|'POST'} */ (m), p, /** @type {object | undefined} */ (o), opts),
    // a fixed notice from this machine's node, to a holder or a waiter: it wakes their session
    notify: (to, body) => { localSend({ from: 'leases', to, body }).catch(e => log(`could not tell ${to} about a lease: ${errMsg(e)}`)) },
  })
  /** Merge membership records from a peer; persist if anything changed. @param {unknown} records */
  function mergeRoster(records) {
    if (!roster.merge(records)) return false
    try { roster.save() } catch (e) { log('could not save the roster:', errMsg(e)) }
    return true
  }

  /**
   * `name` turned out to be one of this machine's names (an IP, a Tailscale name used by a sender):
   * take delivery of anything queued for it. Configured peers are other machines by definition, so
   * a configured name whose address now reaches us (DHCP reuse) is not adopted.
   * @param {string} name
   */
  function adoptSelfAlias(name) {
    const row = peerRow(name)
    if (row?.configured) {
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
  const helloBody = () => ({ peers: shareablePeers(), records: roster.records, version: VERSION })
  /**
   * The version a member says it runs. Only from that member's own hello (request or reply), whose
   * sender proved its key: what one machine says about another's version is never taken.
   * @param {string} host @param {unknown} v
   */
  function noteVersion(host, v) {
    if (typeof v !== 'string' || !/^\d{1,5}\.\d{1,5}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,20})?$/.test(v) || !member(host) || host === cfg.host) return
    if (peerRow(host)?.version !== v) q.setVersion.run(host, now(), v)
  }

  /**
   * Request to another member. The machine at the address must prove it holds that member's key
   * before we say who we are or send the request: anyone else gets nothing.
   * `addr` dials an explicit, not yet verified address instead of the stored route for `host`.
   * @param {string} host
   * @param {'GET'|'POST'} method
   * @param {string} p
   * @param {object} [obj]
   * @param {{ timeout?: number, addr?: string, retried?: boolean, deadline?: number }} [opts]
   * @returns {Promise<any>}
   */
  async function call(host, method, p, obj, { timeout = 4000, addr, retried = false, deadline } = {}) {
    const m = member(host)
    if (!m) throw new Error(notMember(host))
    const body = obj === undefined ? '' : JSON.stringify(obj)
    timeout += Math.ceil(Buffer.byteLength(body) / MIN_RATE)   // big batches on slow links still finish
    const target = addr || addrOf(host)
    if (!validAddr(target)) throw new Error(`invalid address for ${host}: ${target}`)
    let r
    try {
      r = await authedRequest({ addr: target, method, path: p, body, headers: { 'x-agentlink-port': String(cfg.port) }, identity: me, accept: new Map([[m.fp, m.publicKey]]), dks: roster.dks, timeout, deadline }, p === '/v1/hello' ? MAX_REQ : MAX_REPLY)
    } catch (e) {
      // reason: why the machine can't be reached, without its name (peers shows it next to the name)
      const reason = e instanceof PinError ? `${target} is answered by a different machine (not ${host}'s key)`
        : e instanceof ProtoError ? e.message
        : `${target}: ${errMsg(e)}${netHint(e)}`
      if (!addr) noteReach(host, reason)   // a probe of an unverified address says nothing about the machine
      throw Object.assign(new Error(e instanceof ProtoError ? `${host}: ${reason}` : `${host} at ${reason}`), { reason })
    }
    if (!addr) noteReach(host, null)
    // a member that hasn't heard we joined yet: tell it (hello carries the records that add us), then retry
    if (r.status === 403 && p !== '/v1/hello' && !retried) {
      await call(host, 'POST', '/v1/hello', helloBody(), { timeout: 2500, addr })
      return call(host, method, p, obj, { timeout, addr, retried: true, deadline })
    }
    /** @type {any} */
    let data = {}
    try { data = r.text ? JSON.parse(r.text) : {} } catch { throw new Error(`${host}: bad reply`) }
    // only the status: what another machine writes here would reach sessions and terminals as our own words
    if (r.status < 200 || r.status >= 300) throw new Error(`${host} answered HTTP ${r.status}`)
    q.upsertPeer.run(host, null, now(), 0)
    if (data.records) mergeRoster(data.records)
    return data
  }
  /** Why `host` can't be sent to. @param {string} host */
  const notMember = host => removedHost(host) ? `${host} was removed from the network` : `${host} is not a known machine on this network (yet)`

  /**
   * Which machine answers at `addr`? Any member is accepted (including us); returns that
   * member, or throws. Used for names that aren't member names: IPs, Tailscale names, configured peers.
   * @param {string} addr
   */
  async function identify(addr, timeout = 2500) {
    if (!validAddr(addr)) throw new Error(`invalid address ${addr}`)
    const accept = new Map([...roster.members.values()].map(m => [m.fp, m.publicKey]))
    let r
    try {
      r = await authedRequest({ addr, method: 'POST', path: '/v1/hello', body: JSON.stringify(helloBody()), headers: { 'x-agentlink-port': String(cfg.port) }, identity: me, accept, dks: roster.dks, timeout }, MAX_REQ)
    } catch (e) { throw new Error(e instanceof PinError ? `${addr}: not a machine on this network` : `${addr}: ${errMsg(e)}`) }
    const m = roster.members.get(r.peerFp)
    if (!m) throw new Error(`${addr}: not a machine on this network`)
    if (r.status === 200 && m.fp !== me.fp) { try { const d = JSON.parse(r.text); mergeRoster(d.records); learnPeers(d.peers); noteVersion(m.host, d.version) } catch {} }
    return m
  }

  /**
   * Work out which member a non-member name (IP, Tailscale name, configured peer) refers to, and
   * remember it. Returns the member's host (cfg.host if it's us), or null.
   * @param {string} name
   */
  async function resolveName(name) {
    const real = peerRow(name)?.alias_of
    if (real && (member(real) || real === cfg.host)) return real
    const addr = addrOf(name)
    let m
    try { m = await identify(addr) } catch { return null }
    if (m.fp === me.fp) return adoptSelfAlias(name) ? cfg.host : null
    q.upsertPeer.run(name, addr, now(), 0)
    q.setAlias.run(m.host, name)
    if (!cfg.routes[m.host]) q.upsertPeer.run(m.host, addr, now(), 0)
    log(`${name} is ${m.host}`)
    return m.host
  }

  const probing = new Set()
  /** @type {Map<string, number>} "host addr" -> when verification last failed */
  const probeFailed = new Map()
  /**
   * Start routing member `host` to `addr`, but only once the machine there proves it holds its key.
   * @param {string} host @param {string} addr @param {{ refresh?: boolean }} [opts] refresh: a fresh sighting (beacon, request)
   */
  async function probe(host, addr, { refresh = true } = {}) {
    if (!validAddr(addr) || isSelf(host) || !member(host)) return
    const key = `${host} ${addr}`
    try {   // nothing awaits this, so a failed write here (a full disk) must stop here too
      const cur = peerRow(host)
      if (cur?.addr === addr) {
        if (!refresh) return
        q.upsertPeer.run(host, null, now(), 0)
        if (q.wake.run(host).changes) kick()
        return
      }
      if (probing.has(key) || now() - (probeFailed.get(key) || 0) < PROBE_RETRY_MS) return
      probing.add(key)
      try {
        const data = await call(host, 'POST', '/v1/hello', helloBody(), { addr, timeout: 2500 })
        if (!cfg.routes[host]) q.upsertPeer.run(host, addr, now(), 0)
        learnPeers(data.peers)
        noteVersion(host, data.version)
        log(`${host} is at ${addr}`)
        if (q.wake.run(host).changes) kick()
      } catch { probeFailed.set(key, now()) } finally { probing.delete(key) }
      if (probeFailed.size > 1000) probeFailed.clear()
    } catch (e) { log('probe error', errMsg(e)) }
  }

  /** Track a member that sent us a request from `remoteIp` (its listening port in the header). @param {string} host @param {string | undefined} remoteIp @param {unknown} portHdr */
  function notePeer(host, remoteIp, portHdr) {
    q.upsertPeer.run(host, null, now(), 0)
    const ip = String(remoteIp || '').replace(/^::ffff:/, '')
    const port = Number(portHdr)
    if (ip && !/^(127\.|::1$)/.test(ip) && Number.isInteger(port) && port > 0 && port < 65536) {
      const addr = ip.includes(':') ? `[${ip}]:${port}` : `${ip}:${port}`
      if (peerRow(host)?.addr !== addr && !cfg.routes[host]) probe(host, addr)
    }
  }

  const knownPeers = () => otherMembers().map(m => m.host)

  /** @type {Map<string, Set<string>>} member -> addresses other members have told us about */
  const heard = new Map()
  /**
   * Other places `host` might be when its stored address stops answering: what it was configured or
   * first found under (a Tailscale name, an IP), what other members told us, and its own name. A
   * laptop that moves between networks keeps an address that no beacon will ever replace.
   * @param {string} host
   */
  function otherAddrs(host) {
    const cur = addrOf(host)
    const names = allPeers().filter(r => r.alias_of === host).map(r => addrOf(r.host))
    // what we were told comes last, newest first: any member can say anything, and can't crowd out the rest
    return [...new Set([...names, `${host}:${cfg.port}`, ...[...(heard.get(host) || [])].reverse()])].filter(a => a !== cur && validAddr(a))
  }

  /** Addresses worth telling other members about (so every node learns the whole network). */
  function shareablePeers() {
    const cutoff = now() - 86400_000
    return allPeers().filter(r => member(r.host) && r.last_seen >= cutoff && r.addr).map(r => ({ host: r.host, addr: r.addr }))
  }
  /**
   * Addresses another member told us about. They may be stale (DHCP reuse) or wrong, so they are
   * never used directly: each is probed, and only used once the handshake there presents the key.
   * @param {unknown} list
   */
  function learnPeers(list) {
    for (const pe of Array.isArray(list) ? list.slice(0, 200) : []) {
      if (typeof pe?.host !== 'string' || !validAddr(pe?.addr)) continue
      let h
      try { h = normHost(pe.host) } catch { continue }
      if (!member(h) || cfg.routes[h]) continue
      if (!peerRow(h)?.addr) probe(h, pe.addr, { refresh: false })
      else if (pe.addr !== peerRow(h)?.addr) {
        if (!heard.has(h)) heard.set(h, new Set())
        const known = /** @type {Set<string>} */ (heard.get(h))
        known.delete(pe.addr)
        known.add(pe.addr)                                    // newest last; the oldest makes way
        if (known.size > 8) known.delete(/** @type {string} */ (known.values().next().value))
      }
    }
  }

  /** @param {string} host */
  async function hello(host) {
    try {
      const r = await call(host, 'POST', '/v1/hello', helloBody(), { timeout: 2500 })
      learnPeers(r.peers)
      noteVersion(host, r.version)
      if (q.wake.run(host).changes) kick()   // it's reachable: retry anything waiting for it now
    } catch {
      // nothing answers where we think it is: look for it. Each address must prove it holds the key.
      if (!cfg.routes[host]) await Promise.all(otherAddrs(host).slice(0, 4).map(addr => probe(host, addr)))
    }
  }
  /** @type {Promise<void> | null} */
  let helloing = null
  /** Say hello to everyone: finished when the round in progress, or a new one, is. */
  const helloAll = () => helloing ??= helloRound().finally(() => { helloing = null })
  async function helloRound() {
    try {
      // configured names that aren't member names (an IP, a Tailscale name): find out who they are
      for (const pe of cfg.peers) if (!member(pe.host) && !isSelf(pe.host) && !peerRow(pe.host)?.alias_of) await resolveName(pe.host)
      const hosts = knownPeers()
      let i = 0
      await Promise.all(Array.from({ length: Math.min(HELLO_CONCURRENCY, hosts.length) }, async () => {
        while (i < hosts.length) await hello(hosts[i++])
      }))
    } catch (e) { log('hello error', errMsg(e)) }
  }

  // ---------- messages ----------
  /** @type {(r: MessageRow) => Envelope} */
  const envOf = r => ({ id: r.id, from: r.from_addr, to: r.to_addr, body: r.body, sent_at: r.sent_at, expires_at: r.expires_at, sig: r.sig })

  /**
   * Is this a well-formed envelope signed by the machine it claims to come from? 'unknown-sender'
   * if it names a machine we haven't heard of (yet): it may have joined while we were offline.
   * @param {any} e @returns {'ok' | 'unknown-sender' | 'bad'}
   */
  function checkEnv(e) {
    if (!(e && typeof e === 'object' &&
      ['id', 'from', 'to', 'body', 'sig'].every(k => typeof e[k] === 'string') &&
      /^[\w-]{1,64}$/.test(e.id) && e.from.length <= 320 && e.to.length <= 320 &&
      // text that wouldn't survive the store unchanged would fail its signature once re-read
      e.body.isWellFormed() && !e.body.includes('\0') &&
      // safe, bounded integers: anything else can't be stored and read back reliably
      Number.isSafeInteger(e.sent_at) && Number.isSafeInteger(e.expires_at) && e.sent_at >= 0 &&
      e.expires_at - now() <= MAX_TTL_MS + CLOCK_SLACK_MS && e.sent_at - now() <= MAX_TTL_MS &&
      Buffer.byteLength(e.body) <= MAX_MSG)) return 'bad'
    // addresses exactly as a node writes them: only the host is proved below, so whatever else `from`
    // held (a line break, a NUL) could otherwise pass for another sender when it's shown to a session
    const from = parseAddr(e.from, ''), to = parseAddr(e.to, '')
    if (e.from !== `${from.name}@${from.host}` || e.to !== `${to.name}@${to.host}`) return 'bad'
    const host = from.host
    const sender = roster.byHost.get(host)
    if (!sender) {
      const gone = removedKey(host), key = gone && roster.ranked.get(gone)?.publicKey
      // signed by another key, it may be that name's machine back with a new one we haven't heard of.
      // So may a key that was dropped, which we can't check: its holder tries again, and tells us what it knows
      return key && verifyEnvelope(key, e) ? 'bad' : 'unknown-sender'
    }
    return verifyEnvelope(sender.publicKey, e) ? 'ok' : 'bad'
  }
  /** The key of a machine called `host` that was removed, or whose add never counted (it never will). @param {string} host */
  const removedKey = host => {
    const fp = [...roster.records].reverse().find(r => r.type === 'add' && r.host === host)?.fp ?? [...roster.ranked.values()].reverse().find(m => m.host === host)?.fp
    return fp && (roster.removed.has(fp) || roster.dropped.has(fp)) ? fp : null
  }
  /** @param {string} host */
  const removedHost = host => removedKey(host) !== null
  /**
   * Store a row unless one with that id exists. An existing id is only fine for the same message:
   * a different message reusing an id someone has seen is refused, not reported as delivered. (The
   * same message, not the same signature: a copy can carry another encoding of it, and the envelope
   * has been verified by now. Nothing keeps the text of what it has passed on.)
   * @param {Envelope} e @param {string} toHost @param {string} toName @param {'inbox' | 'held'} role @param {'queued' | 'pending'} state
   */
  function store(e, toHost, toName, role, state) {
    if (q.insert.run(e.id, e.from, e.to, toHost, toName, e.body, e.sent_at, e.expires_at, e.sig, role, state, 0, now()).changes) return true
    const r = msgRow(e.id)
    return !!r && r.from_addr === e.from && r.to_addr === e.to && r.sent_at === e.sent_at && r.expires_at === e.expires_at && (r.body === e.body || r.state === 'forwarded')
  }

  /**
   * Is there no room for another message to this session? Whatever sends too much, a script gone wrong
   * or agents stuck in a loop, is held back at the sender, and everything else keeps moving. The limit
   * on the store as a whole is for what no one recipient's limit sees: any number of made-up names, or
   * messages read as fast as they come. Nothing is lost by this: the sender keeps trying until the
   * message expires, and a session here is told at once.
   * @param {string} host @param {string} name
   */
  const full = (host, name) => Number(q.waiting.get(host, name)?.n) >= cfg.maxWaiting || Number(q.stored.get()?.n) >= cfg.maxStoreBytes

  /**
   * Store an incoming envelope durably. Returns 'live' | 'queued' | 'held' | 'expired' |
   * 'full' (not stored: no room for now, and the sender should retry) |
   * 'unknown-sender' (not stored: the sender should tell us its membership records, then retry) |
   * null (rejected: the envelope itself is bad, and the sender must not retry it). Storage errors (disk full,
   * database busy) throw, so callers can report a temporary failure and the sender retries.
   * @param {unknown} e
   * @param {Set<string>} [toPump] collect local recipients here instead of pumping each one now
   * @param {string} [mine] the machine delivering this says its name for the recipient's machine (a
   *   nickname of its own, which we may not know) means us. Believed only from the message's own
   *   sender: a holder could otherwise turn a copy addressed elsewhere into a message for a session here.
   * @returns {import('./types.js').AcceptResult}
   */
  function accept(e, toPump, mine) {
    let to
    /** @type {Envelope} */
    let env
    try {
      const v = checkEnv(e)
      if (v === 'unknown-sender') return v
      if (v !== 'ok') return null
      env = /** @type {Envelope} */ (e)
      to = parseAddr(env.to, cfg.host)
    } catch (err) {
      log('rejected envelope:', errMsg(err))
      return null
    }
    if (env.expires_at <= now()) return 'expired'
    if (isSelf(to.host) || (mine && mine === parseAddr(env.from, '').host && !member(to.host) && !removedHost(to.host))) {
      if (full(cfg.host, to.name) && !msgRow(env.id)) return 'full'
      if (!store(env, cfg.host, to.name, 'inbox', 'queued')) return null
      q.claim.run(cfg.host, to.name, now(), env.id)
      const s = sessions.get(to.name)
      const live = s?.live || s?.waiter               // before pumping: a wait ends once it has woken the session
      if (toPump) toPump.add(to.name)
      else pump(to.name)
      return live ? 'live' : 'queued'
    }
    if (full(to.host, to.name) && !msgRow(env.id)) return 'full'
    if (!store(env, to.host, to.name, 'held', 'pending')) return null
    kick()
    return 'held'
  }

  /**
   * Offer `name`'s queued messages to its live session, if it has one. A few at a time: the session's
   * acknowledgements bring the next ones, so a big queue is never in memory here or in the session.
   * @param {string} name
   */
  function pump(name) {
    const s = sessions.get(name)
    if (!s) return
    let more = false
    for (const { id } of q.inboxQueued.all(name, now(), 2 * PUMP_WINDOW)) {     // ids first: most may have been offered already
      if (s.sent.has(String(id))) continue
      if (s.sent.size >= PUMP_WINDOW || s.res.writableLength > PUMP_BUFFER) { more = true; break }
      const r = msgRow(String(id))
      if (!r) continue
      s.sent.add(r.id)
      sse(s.res, 'message', { id: r.id, from: r.from_addr, to: r.to_addr, body: r.body, sent_at: r.sent_at })
    }
    if (s.res.writableLength > PUMP_BUFFER && !s.draining) {
      s.draining = true
      s.res.once('drain', () => { s.draining = false; pump(name) })
    }
    if (more !== s.more) { s.more = more; sse(s.res, 'queue', { more }) }
    nudge(name)
  }

  /** Wake `name`'s session if a wait is open and it has messages it hasn't been told about. @param {string} name */
  function nudge(name) {
    const s = sessions.get(name)
    if (!s?.waiter) return
    const fresh = [...s.sent].filter(id => !s.notified.has(id))
    if (!fresh.length) return
    for (const id of fresh) s.notified.add(id)
    sse(s.waiter, 'wake', { name, count: fresh.length })
    s.waiter.end()
    s.waiter = null
  }

  /**
   * Rows still to hand over, in request-sized batches, read as they're needed: a machine that doesn't
   * answer costs one batch, however much is waiting for it.
   * @param {DueRow[]} rows @returns {Generator<MessageRow[]>}
   */
  function* batches(rows) {
    /** @type {MessageRow[]} */
    let cur = []
    let size = 0
    for (const { id } of rows) {
      const r = msgRow(id)
      if (r?.state !== 'pending') continue
      const n = Buffer.byteLength(JSON.stringify(envOf(r))) + 1
      if (cur.length && size + n > MAX_BATCH) { yield cur; cur = []; size = 0 }
      cur.push(r)
      size += n
    }
    if (cur.length) yield cur
  }

  /**
   * Hand rows to member `host`'s node. Returns null on success, else the error.
   * @param {string} host
   * @param {DueRow[]} rows
   * @returns {Promise<null | { err: unknown, rest: DueRow[] }>}
   */
  async function handOver(host, rows) {
    for (const batch of batches(rows)) {
      try {
        // addressed under a name only we use for this machine: tell it they're for it
        const res = await call(host, 'POST', '/v1/deliver', { messages: batch.map(envOf), mine: batch.filter(r => r.role === 'outbox' && r.to_host !== host).map(r => r.id) })
        const results = res.results || {}
        const unknown = new Set(Array.isArray(res.unknown) ? res.unknown : [])
        const noRoom = new Set(Array.isArray(res.full) ? res.full : [])
        let tell = false
        tx(() => {
          for (const r of batch) {
            if (results[r.id]) q.forwarded.run(now(), r.id)
            // it hasn't heard of the sending machine yet: tell it what we know, then try again later
            else if (unknown.has(r.id)) { q.retry.run(now() + backoff(r.attempts), `${host} doesn't know the sender yet`, now(), r.id); tell ||= r.attempts < 3 }
            else if (noRoom.has(r.id)) q.retry.run(now() + backoff(r.attempts), `no room on ${host} for now`, now(), r.id)
            else q.failed.run(`rejected by ${host} (invalid or malformed message)`, now(), r.id)
          }
        })
        if (tell) setImmediate(() => hello(host))
      } catch (err) {
        const rest = rows.slice(rows.findIndex(r => r.id === batch[0].id))
        tx(() => { for (const r of rest) q.retry.run(now() + backoff(r.attempts), errMsg(err), now(), r.id) })
        return { err, rest }
      }
    }
    return null
  }

  /**
   * Which member should messages for `host` go to? A member name is used as is; any other name
   * is resolved by asking who answers at its address. 'self' if it turns out to be this machine.
   * @param {string} host @returns {Promise<string | 'self' | null>}
   */
  async function routeFor(host) {
    if (isSelf(host)) return 'self'
    if (member(host)) return host
    const alias = peerRow(host)?.alias_of
    if (alias && member(alias)) return alias
    const r = await resolveName(host)
    return r === cfg.host ? 'self' : r
  }

  // ---------- forwarding loop ----------
  /** @type {Set<string>} sends being handed over directly: not for the flush loop too */
  const inFlight = new Set()
  /** @type {Set<string>} names being delivered to now: a machine that's slow to answer holds up only itself */
  const busy = new Set()
  let delivering = 0, lookingUp = 0
  let kicked = false
  /** Flush soon: once, however many messages came in together. */
  const kick = () => { if (!kicked) { kicked = true; setImmediate(() => { kicked = false; flush() }) } }

  function flush() {
    try {
      const t = now()
      q.expire.run(t, t)
      // every name we can put a machine to
      const known = [cfg.host, ...selfAliases, ...knownPeers(), ...allPeers().filter(p => member(p.alias_of || '')).map(p => p.host)]
      for (const row of q.due.all(t, t, JSON.stringify(known.filter(h => !busy.has(h))))) {
        if (delivering >= FLUSH_HOSTS) break
        const host = String(row.to_host)
        const rows = dueRows(q.dueFor.all(t, t, host)).filter(r => !inFlight.has(r.id))
        if (!rows.length) continue
        delivering++
        busy.add(host)
        deliver(host, rows).catch(e => log('flush error', errMsg(e))).finally(() => { busy.delete(host); delivering-- })
      }
      // A name nothing has identified yet costs a hello and a name lookup, and any member can queue
      // thousands of them: a few at a time, off to the side of what's going to machines we know
      if (lookingUp >= HELLO_CONCURRENCY) return
      for (const row of q.dueNames.all(t, t, JSON.stringify([...known, ...busy]), HELLO_CONCURRENCY - lookingUp)) {
        const host = String(row.to_host)
        lookingUp++
        busy.add(host)
        deliver(host, dueRows(q.dueFor.all(t, t, host)).filter(r => !inFlight.has(r.id))).catch(e => log('flush error', errMsg(e))).finally(() => { busy.delete(host); lookingUp-- })
      }
    } catch (e) { log('flush error', errMsg(e)) }
  }

  /** @param {string} host @param {DueRow[]} rows */
  async function deliver(host, rows) {
    const dest = await routeFor(host)
    if (dest === 'self') { if (isSelf(host)) adoptSelfAlias(host); return }
    if (!dest) {
      const why = notMember(host)
      tx(() => { for (const r of rows) q.retry.run(now() + backoff(r.attempts), why, now(), r.id) })
      return
    }
    const failure = await handOver(dest, rows)
    // in the background: trying several (possibly offline) holders must not stall deliveries
    if (failure) replicate(dest, failure.rest.filter(r => r.role === 'outbox' && !r.replicated))
  }

  /** Other recently seen members that could hold copies for `host` while it is offline. @param {string} host */
  function holderCandidates(host) {
    const cutoff = now() - 10 * 60_000
    return allPeers()
      .filter(p => member(p.host) && p.host !== host && p.last_seen >= cutoff)
      .sort((a, b) => b.last_seen - a.last_seen)
  }

  /** @type {Set<string>} hosts with a replication in progress */
  const replicating = new Set()
  /** Hand copies to other reachable members so they can deliver when `host` comes back. @param {string} host @param {DueRow[]} rows */
  async function replicate(host, rows) {
    if (!rows.length || replicating.has(host)) return
    replicating.add(host)
    try { await replicateInner(host, rows) } catch (e) { log('replicate error', errMsg(e)) } finally { replicating.delete(host) }
  }
  /** @param {string} host @param {DueRow[]} rows */
  async function replicateInner(host, rows) {
    /** @type {Map<string, number>} message -> how many holders stored it */
    const copies = new Map()
    let holders = 0
    for (const p of holderCandidates(host)) {
      if (holders >= REPLICATE_TO) break
      try {
        let stored = 0
        for (const batch of batches(rows)) {
          const { results } = await call(p.host, 'POST', '/v1/deliver', { messages: batch.map(envOf) }, { timeout: 3000 })
          for (const r of batch) if (results?.[r.id]) { copies.set(r.id, (copies.get(r.id) || 0) + 1); stored++ }
        }
        if (stored) holders++
      } catch {}
    }
    for (const id of copies.keys()) q.replicated.run(id)
  }

  function gc() {
    try {
      q.gc.run(now() - 86400_000)
      q.forgetPeers.run(now() - PEER_FORGET_MS)
      q.gcInvites.run(now() - 86400_000)
    } catch (e) { log('gc error', errMsg(e)) }
    trimLog()
  }
  /** Keep node.log from growing without end. It's opened for appending, so writers carry on at the new end. */
  function trimLog() {
    const file = path.join(cfg.dir, 'node.log')
    try {
      const { size } = fs.statSync(file)
      if (size <= MAX_LOG) return
      const fd = fs.openSync(file, 'r')
      const tail = Buffer.alloc(1 << 20)
      try { fs.readSync(fd, tail, 0, tail.length, size - tail.length) } finally { fs.closeSync(fd) }
      fs.truncateSync(file, 0)
      fs.appendFileSync(file, tail.subarray(tail.indexOf(10) + 1))
    } catch {}
  }

  // ---------- local API helpers ----------
  /** The member name of the machine a resource names, or throw. @param {string} h */
  async function authorityFor(h) {
    if (isSelf(h)) return cfg.host
    if (member(h)) return h
    const r = await routeFor(h).catch(() => null)
    if (r === 'self') return cfg.host
    if (r && member(r)) return r
    throw httpErr(404, `${h} is not a machine on this network (machines: ${[cfg.host, ...knownPeers()].join(', ')})`)
  }

  /**
   * Ask the machine that keeps a resource's leases. A machine on a version without leases answers
   * 404 to any path it doesn't know: say which version it runs, if it has said.
   * @param {string} auth @param {Record<string, unknown>} body
   */
  async function askAuthority(auth, body) {
    if (auth === cfg.host) return remoteLease(cfg.host, body)
    let r
    try { r = await call(auth, 'POST', '/v1/lease', body, { timeout: 5000 }) } catch (e) {
      if (/answered HTTP 404/.test(errMsg(e))) {
        const v = peerRow(auth)?.version
        throw httpErr(501, `${auth} runs ${v ? `nattermatic ${v}` : 'an older nattermatic'}, which doesn't have leases: it needs upgrading first`)
      }
      if (/answered HTTP/.test(errMsg(e))) throw httpErr(502, errMsg(e))
      throw httpErr(503, `${auth} can't be reached, so its resources can't be claimed or released now (${errMsg(e)})`)
    }
    // what another machine says is rebuilt from checked parts: none of its words reach a session as ours
    const flag = (/** @type {string} */ k) => r?.[k] === true
    const lease = cleanLease(r?.lease, auth)
    // a reply that must describe the lease and can't be read is an error, not a lease without details
    const needs = body.op === 'claim' || (body.op === 'renew' && flag('ok')) || (body.op === 'release' && !flag('ok'))
    if (needs && !lease) throw httpErr(502, `${auth} gave an answer about ${body.resource} that couldn't be read`)
    return {
      ok: flag('ok'), renewed: flag('renewed'), released: flag('released'), broken: flag('broken'), same_name: flag('same_name'), notify: flag('notify'), gone: flag('gone'),
      lease,
      ...(body.op === 'list' ? { host: auth, leases: (Array.isArray(r?.leases) ? r.leases.slice(0, 1000) : []).map((/** @type {unknown} */ l) => cleanLease(l, auth)).filter(Boolean) } : {}),
    }
  }

  /**
   * A lease request from a machine of the network (or this one), about one of this machine's
   * resources. The holder's machine is the one that proved its key; its node vouches for the name.
   * @param {string} from @param {Record<string, any>} d
   */
  function remoteLease(from, d) {
    const op = String(d.op || '')
    if (op === 'list') return { ok: true, host: cfg.host, leases: leases.list() }
    const resource = String(d.resource || '')
    let parsed = null
    try { parsed = resource && resource.length <= MAX_RESOURCE ? parseResource(resource, cfg.host).name : null } catch {}
    if (!parsed || resource !== parsed) throw httpErr(400, 'bad resource name')
    if (op === 'check') { const row = leases.current(resource); return { ok: true, lease: row ? leases.view(row) : null } }
    const name = sanitizeName(d.name)
    if (op === 'break') return leases.breakLease({ resource, by: `${name}@${from}` })
    const sid = String(d.sid || '')
    if (!SID.test(sid)) throw httpErr(400, 'a lease needs the session that holds it')
    /** @type {import('./leases.js').Holder} */
    const holder = { host: from, name, sid, kind: d.kind === 'process' ? 'process' : 'session' }
    if (op === 'claim') return leases.claim({ resource, holder, note: d.note, ttl_ms: d.ttl_ms, cap_ms: d.cap_ms, notify: d.notify, takeover: d.takeover })
    if (op === 'release') return leases.release({ resource, holder, takeover: d.takeover })
    if (op === 'renew') return leases.renew({ resource, holder, ttl_ms: d.ttl_ms })
    if (op === 'rebind' && holder.kind === 'session' && SID.test(String(d.old_sid || ''))) return leases.rebind({ resource, holder, old_sid: String(d.old_sid) })
    throw httpErr(400, `unknown lease request "${op}"`)
  }

  /** The session whose owner is the first of `pids` (nearest first) to own one. @param {number[]} pids */
  const sessionOwnedBy = pids => pids.map(pid => [...sessions].find(([, x]) => x.owner === pid)).find(Boolean)

  /**
   * A lease request from this machine: a session's tool call (by its name: the node knows which
   * session that is), a `natter lease` command (a process with its own id), or the heartbeat hook.
   * @param {Record<string, any>} d
   */
  async function localLease(d) {
    const op = String(d.op || '')
    if (op === 'beat') {
      const pids = (Array.isArray(d.pids) ? d.pids : []).map(Number).filter(Boolean)
      const found = sessionOwnedBy(pids)
      if (!found) return { ok: false }
      found[1].lastActive = now()
      return { ok: true, name: found[0] }
    }
    if (op === 'list') {
      const auth = d.host ? await authorityFor(normHost(String(d.host))) : cfg.host
      const r = await askAuthority(auth, { op: 'list' })
      return { ...r, held: leases.heldRows().map(h => ({ resource: `${h.resource}@${h.authority}`, holder: `${h.name}@${cfg.host}`, kind: h.kind })) }
    }
    let res
    try { res = parseResource(d.resource, cfg.host) } catch (e) { throw httpErr(400, errMsg(e)) }
    const auth = await authorityFor(res.host)
    const resource = `${res.name}@${auth}`
    if (op === 'check') return { ...(await askAuthority(auth, { op, resource: res.name })), resource }
    if (op === 'break') return { ...(await askAuthority(auth, { op, resource: res.name, name: d.by || 'cli' })), resource }
    /** @type {import('./leases.js').Holder} */
    let holder
    if (d.kind === 'process') {
      if (!SID.test(String(d.sid || ''))) throw httpErr(400, 'a lease needs the process that holds it')
      holder = { host: cfg.host, name: sanitizeName(d.name || 'cli'), sid: String(d.sid), kind: 'process' }
    } else {
      const s = sessions.get(String(d.name || ''))
      if (!s?.token) throw httpErr(409, `no session named ${d.name || '(none)'} is connected to this machine's node`)
      s.lastActive = now()
      holder = { host: cfg.host, name: String(d.name), sid: sessionId(s.token), kind: 'session' }
    }
    if (!['claim', 'release', 'renew'].includes(op)) throw httpErr(400, `unknown lease request "${op}"`)
    const ask = () => askAuthority(auth, { op, resource: res.name, name: holder.name, sid: holder.sid, kind: holder.kind, note: d.note, ttl_ms: d.ttl_ms, cap_ms: d.cap_ms, notify: d.notify, takeover: d.takeover })
    // a release is forgotten here whatever happens: if the machine can't be told, the lease runs out
    // (only this holder's own record: a refused release mustn't drop the real holder's)
    if (op === 'release') { try { return { ...(await ask()), resource } } finally { leases.forget(auth, res.name, holder.sid) } }
    const r = await ask()
    if (r.ok && r.lease) {
      if (op === 'claim') leases.noteHeld(auth, res.name, holder, r.lease.ttl_s * 1000)
      else leases.noteRenewed(auth, res.name, holder.sid, r.lease.ttl_s * 1000)
    } else if (op === 'renew') leases.forget(auth, res.name, holder.sid)
    return { ...r, resource }
  }

  /** @param {{ from?: unknown, to?: unknown, body?: unknown, ttl_ms?: unknown }} d */
  async function localSend(d) {
    if (typeof d.body !== 'string' || !d.body) throw httpErr(400, 'message body required')
    const body = /** @type {any} */ (d.body).toWellFormed().replaceAll('\0', '\uFFFD')     // what the store can give back unchanged
    if (Buffer.byteLength(body) > MAX_MSG) throw httpErr(413, `message too large (max ${MAX_MSG} bytes)`)
    if (!d.to) throw httpErr(400, 'recipient required (name@host)')
    let to
    try { to = parseAddr(d.to, cfg.host) } catch (e) { throw httpErr(400, `bad recipient "${d.to}": ${errMsg(e)}`) }
    // address it to the machine's member name if we can tell (e.g. desk.tailnet.ts.net -> desk.local)
    if (!isSelf(to.host) && !member(to.host)) {
      const r = await routeFor(to.host).catch(() => null)
      if (r === 'self') to.host = cfg.host
      else if (r) to.host = r
    }
    if (isSelf(to.host)) to.host = cfg.host
    // not a machine on this network (a typo, or a machine that hasn't joined): say so now rather
    // than queue it for days. Names configured as peers (a Tailscale name, an IP) are queued: the
    // machine may just be offline, and is found when it answers.
    if (to.host !== cfg.host && !member(to.host) && removedHost(to.host)) throw httpErr(410, `${to.host} was removed from the network`)
    if (to.host !== cfg.host && !member(to.host) && !peerRow(to.host)?.configured) {
      const known = [cfg.host, ...knownPeers()].join(', ')
      throw httpErr(404, `${to.host} is not a machine on this network, and nothing at that name answered as one (machines: ${known}). If it is new, run \`natter invite\` and join it first.`)
    }
    if (full(to.host, to.name)) throw fullError(`${to.name}@${to.host}`)
    /** @type {Omit<Envelope, 'sig'>} */
    const unsigned = {
      id: crypto.randomUUID(),
      from: `${sanitizeName(d.from || 'cli')}@${cfg.host}`,
      to: `${to.name}@${to.host}`,
      body,
      sent_at: now(),
      expires_at: now() + (Number(d.ttl_ms) > 0 ? Math.min(Number(d.ttl_ms), cfg.ttlMs) : cfg.ttlMs),
    }
    /** @type {Envelope} */
    const e = { ...unsigned, sig: signEnvelope(me.key, unsigned) }
    if (to.host === cfg.host) {
      let st
      try { st = accept(e) } catch (err) { throw httpErr(503, `could not queue message: ${errMsg(err)}`) }
      if (st === 'unknown-sender') throw httpErr(409, `this machine (${cfg.host}) isn't on its member list, so nothing was sent: run \`natter setup\``)
      if (st === 'expired') throw httpErr(400, 'the message expired before it could be queued')
      if (st === 'full') throw fullError(e.to)
      if (!st) throw httpErr(500, 'could not queue message')
      return { id: e.id, to: e.to, status: `${d.to !== e.to && String(d.to).includes('@') ? `${parseAddr(d.to, cfg.host).host} is this machine — ` : ''}${localStatus(to.name, st === 'live')}` }
    }
    // hidden from the flush loop while we try the direct hand-off, so it isn't sent twice
    inFlight.add(e.id)
    q.insert.run(e.id, e.from, e.to, to.host, to.name, e.body, e.sent_at, e.expires_at, e.sig, 'outbox', 'pending', now() + IN_FLIGHT_MS, now())
    let remote = null, copies = false, refused = false
    try {
      if (!member(to.host)) throw new Error(notMember(to.host))
      /** @type {NodeJS.Timeout | undefined} */
      let wait
      const res = await Promise.race([
        call(to.host, 'POST', '/v1/deliver', { messages: [e] }),
        new Promise((_, reject) => { wait = setTimeout(() => reject(new Error('no answer yet')), SEND_WAIT_MS) }),
      ]).finally(() => clearTimeout(wait))
      remote = res.results?.[e.id]
      if (remote) q.forwarded.run(now(), e.id)
      else if (Array.isArray(res.unknown) && res.unknown.includes(e.id)) throw new Error(`${to.host} doesn't know this machine yet`)
      else if (Array.isArray(res.full) && res.full.includes(e.id)) { refused = true; q.retry.run(now() + backoff(0), `no room on ${to.host} for now`, now(), e.id) }
      else q.failed.run(`rejected by ${to.host} (invalid or malformed message)`, now(), e.id)
    } catch (err) {
      q.retry.run(now() + backoff(0), errMsg(err), now(), e.id)
      const row = msgRow(e.id)
      // the message is stored durably now: answer the client and hand out copies in the background
      // (trying several offline candidates in turn could otherwise outlast the client's timeout)
      if (row?.state === 'pending' && member(to.host) && holderCandidates(to.host).length) { copies = true; replicate(to.host, [row]) }
    } finally { inFlight.delete(e.id) }
    const r = msgRow(e.id)
    if (!r) throw httpErr(500, 'message vanished from the store')
    let status
    if (r.role === 'inbox') status = `${to.host} is this machine — ${localStatus(to.name)}`
    else if (r.state === 'forwarded') status = remote === 'live' ? `pushed to ${e.to}'s live session` : `stored on ${to.host}; ${to.name} will get it when it next connects or checks its inbox`
    else if (r.state === 'failed') status = `FAILED: ${r.last_error}`
    else if (refused) status = `${to.host} has no room for more messages to ${to.name} for now; queued here — will deliver once it has`
    else status = `${to.host} unreachable (${r.last_error}); queued — will deliver when it comes back` + (copies ? ' (also offering copies to other online machines)' : '')
    return { id: e.id, to: e.to, status }
  }
  const rosterStatus = () => {
    const bytes = Buffer.byteLength(JSON.stringify(roster.records))
    return { bytes, limit: MAX_ROSTER_BYTES, ...(bytes > MAX_ROSTER_BYTES * 0.75 ? { note: 'the member list is nearly full: remove any machine flooding it, then run `natter compact` on the founding machine' } : {}) }
  }
  /** @param {string} to */
  const fullError = to => httpErr(429, `not sent: too many messages are waiting for ${to}, or this machine's message store is full. Try again once they've been read`)
  /** @param {string} name @param {boolean} [live] it was just told (its wait, having woken it, is over) */
  function localStatus(name, live) {
    const s = sessions.get(name)
    return live || s?.live || s?.waiter ? 'pushed to its live session' : s ? `waiting in ${name}'s inbox (the session is connected but reads with the inbox tool)` : `queued until ${name} connects`
  }

  /** @type {Map<string, string>} host -> why it was last unreachable ('' once reached) */
  const reach = new Map()
  /** @type {Map<string, number>} host -> when it last answered */
  const reachedAt = new Map()
  /**
   * Log when a machine becomes unreachable, or reachable again (not every attempt).
   * @param {string} host @param {string | null} reason null: reached
   */
  function noteReach(host, reason) {
    if (reason === null) reachedAt.set(host, now())
    const prev = reach.get(host)
    if (reason === null) {
      if (prev) log(`${host} is reachable again`)
      reach.set(host, '')
    } else if (prev !== reason) {
      log(`cannot reach ${host}: ${reason}`)
      reach.set(host, reason)
    }
  }

  async function localPeers() {
    const remote = await Promise.all(knownPeers().map(async h => {
      try {
        const r = await call(h, 'GET', '/v1/sessions', undefined, { timeout: 1500, deadline: PEERS_WAIT_MS })
        return { host: h, online: true, sessions: sessionNames(r.sessions) }
      } catch (e) { return { host: h, online: false, sessions: [], error: /** @type {any} */ (e).reason || errMsg(e) } }
    }))
    return { self: cfg.host, local: [...sessions.keys()], remote }
  }

  const hostOfFp = (/** @type {string} */ fp) => roster.members.get(fp)?.host ||
    roster.ranked.get(fp)?.host || [...roster.records].reverse().find(r => r.type === 'add' && r.fp === fp)?.host || shortFp(fp)
  function members() {
    // in joining order: each machine can remove the ones listed after it
    return [...roster.members.values()].sort((a, b) => a.rank - b.rank).map(m => ({
      host: m.host, fp: shortFp(m.fp), added_by: m.by === m.fp ? '(founded the network)' : hostOfFp(m.by), added_at: m.at, self: m.fp === me.fp,
      // the version it said it runs when last heard from: null for one older than 0.3.0, or not heard from yet
      version: m.fp === me.fp ? VERSION : peerRow(m.host)?.version ?? null,
    }))
  }

  /** @param {string} token */
  function inviteValid(token) {
    const row = /** @type {{ expires_at: number, used_at: number | null } | undefined} */ (q.invite.get(sha256(token)))
    return !!row && !row.used_at && row.expires_at > now()
  }

  /**
   * A machine joining with an invite token: add it to the roster (signed by us).
   * @param {{ token?: unknown, host?: unknown, cert?: unknown }} d
   */
  function join(d) {
    if (typeof d.token !== 'string' || !inviteValid(d.token)) throw httpErr(403, 'this invite is not valid (already used, expired or revoked): run `natter invite` on a member for a new one')
    let pem, host
    try { pem = new crypto.X509Certificate(Buffer.from(String(d.cert), 'base64')).toString(); host = normHost(d.host) } catch { throw httpErr(400, 'bad join request') }
    if (!machineName(host)) throw httpErr(400, `"${host}" can't identify a machine: join under a name, by ending the invite line with \`| sh -s -- --host <name>\``)
    const fp = fingerprint(pem)
    const cur = roster.members.get(fp)
    if (cur && cur.host !== host) throw httpErr(409, `this machine is already a member as ${cur.host}. To rename it, run \`natter remove ${cur.host}\` on a machine that joined before it, then run a new invite line with \`| sh -s -- --host ${host}\` at the end`)
    if (!cur) {
      // 410: setup answers it by joining again with a new key (a machine isn't told it was removed)
      if (roster.removed.has(fp)) throw httpErr(410, 'this machine\'s key was removed from the network')
      if (roster.byHost.has(host)) throw httpErr(409, `${host} is already a member of this network with a different key. On a member, run \`natter remove ${host}\` first, or join under another name by ending the invite line with \`| sh -s -- --host <name>\``)
      try { roster.add(me, host, pem) } catch (e) { throw httpErr(507, errMsg(e)) }
      if (!roster.members.has(fp)) throw httpErr(500, 'could not add this machine')
      roster.save()
      log(`${host} joined the network (key ${shortFp(fp)})`)
    }
    q.useInvite.run(now(), sha256(d.token))
    setImmediate(rotate)          // after this reply: the last open invite's key goes once it's used
    setImmediate(helloAll)
    return { net: roster.net, records: roster.records, peers: shareablePeers(), host: cfg.host }
  }

  /**
   * The add records for `fp`, then for whoever signed that, and so on (at most a few), ending at a
   * current member: what an unknown client may submit before it has proved who it is.
   * @param {unknown} records @param {string} fp
   */
  function joinChain(records, fp) {
    /** @type {Map<unknown, any>} */
    const adds = new Map()
    for (const r of Array.isArray(records) ? records : []) if (r?.type === 'add' && !adds.has(r.fp)) adds.set(r.fp, r)
    const out = []
    for (let want = fp; out.length < MAX_JOIN_CHAIN && !roster.members.has(want);) {
      if (roster.removed.has(want) || roster.dropped.has(want)) return []   // a chain through a removed machine counts for nothing
      const r = adds.get(want)
      if (!r || typeof r.by !== 'string' || r.by === want) break
      out.push(r)
      want = r.by
    }
    return out.length && roster.members.has(String(out[out.length - 1].by)) ? out : []
  }

  // ---------- HTTPS ----------
  /** @type {WeakSet<import('node:net').Socket>} connections whose client passed the gate */
  const gated = new WeakSet()
  /** @type {WeakMap<import('node:net').Socket, string>} connection -> the client's proven key */
  const authed = new WeakMap()
  /** @param {Res} res @param {number} status @param {unknown} obj */
  function reply(res, status, obj) {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(obj))
  }

  let errorsLogged = 0, errorMinute = 0
  onRequest = (req, res) => handle(req, res).catch(err => {
    if (!res.headersSent) reply(res, err.status || 500, { error: err.status ? err.message : 'internal error' })
    else res.destroy()
    if (err.status) return
    if (now() - errorMinute > 60_000) { errorMinute = now(); errorsLogged = 0 }
    if (++errorsLogged <= LOG_ERRORS_PER_MIN) log('request error', req.method, (req.url || '').split('?')[0], errMsg(err))   // never log the query: it can hold an invite token
  })

  /** @param {http.IncomingMessage} req @param {Res} res */
  async function handle(req, res) {
    let u
    try { u = new URL(req.url || '/', 'https://x') } catch { return reply(res, 404, { error: 'not found' }) }   // like any unknown path
    const p = u.pathname
    const sock = /** @type {import('node:tls').TLSSocket} */ (req.socket)
    // ---- identity, step 1 (the gate): a client that holds a discovery key learns who we are ----
    // Anyone else gets the same 404 as for any unknown path.
    if (p === '/v1/auth') {
      const ekm = sock.getProtocol() === 'TLSv1.3' ? exporterOf(sock) : null
      if (!ekm || !gateOk(roster.gateDks(), ekm, req.headers['x-agentlink-gate'])) return reply(res, 404, { error: 'not found' })
      gated.add(sock)
      return reply(res, 200, { fp: me.fp, sig: proveAuth(me.key, 'server', ekm), proto: PROTO })
    }
    // ---- joining (an invite token is the credential) ----
    if (req.method === 'GET' && (p === '/join/install' || p === '/join/pkg.tgz' || p === '/join/app.zip')) {
      const t = u.searchParams.get('t')
      if (!t || !inviteValid(t)) return reply(res, 404, { error: 'this invite is not valid (already used, expired or revoked): run `natter invite` on a member for a new one' })
      if (p === '/join/install') {
        res.writeHead(200, { 'content-type': 'text/x-shellscript' })
        return res.end(installScript(req.headers.host, cfg, t, invite?.fp || ''))
      }
      const bundle = appBundle()
      if (p === '/join/app.zip' && !bundle) return reply(res, 404, { error: 'this machine does not run the nattermatic app' })
      let file, size
      try { file = await (p === '/join/app.zip' && bundle ? packApp(cfg.dir, bundle) : packTarball(cfg.dir)); size = (await fs.promises.stat(file)).size } catch (e) {
        log('could not pack nattermatic for an installing machine:', errMsg(e))
        return reply(res, 500, { error: 'package unavailable' })
      }
      const stream = fs.createReadStream(file)
      res.on('close', () => stream.destroy())     // an abandoned download mustn't keep the file open
      stream.on('error', () => { if (!res.headersSent) reply(res, 500, { error: 'package unavailable' }); else res.destroy() })
      stream.on('open', () => {
        res.writeHead(200, { 'content-type': p === '/join/app.zip' ? 'application/zip' : 'application/gzip', 'content-length': size })
        stream.pipe(res)
      })
      return
    }
    const joining = req.method === 'POST' && p === '/join'
    // request bodies are read only for joins (small) and for clients past the gate
    if (!joining && !gated.has(sock)) return reply(res, 404, { error: 'not found' })
    const body = req.method === 'POST' ? await readBody(req, joining ? MAX_JOIN_REQ : MAX_REQ) : ''
    /** @type {Record<string, any>} request body (untrusted: every field is checked where it's used) */
    let d = {}
    if (body) { try { d = JSON.parse(body) } catch { return reply(res, 400, { error: 'bad JSON' }) } }
    if (!d || typeof d !== 'object') d = {}
    if (joining) return reply(res, 200, join(d))

    // ---- identity, step 2: the client signs the same connection's exporter with its machine key ----
    let clientFp = authed.get(sock) || ''
    if (!clientFp) {
      const [fp = '', sig] = String(req.headers['x-agentlink-auth'] || '').split('.')
      // a machine that has just joined proves it with the records that add it (and those adding
      // whoever added it, if they are new too). Nothing else is taken before the signature checks out.
      if (p === '/v1/hello' && fp !== me.fp && !roster.members.has(fp)) {
        // it may be in a snapshot we haven't heard of, with no add left to show: one record, and only
        // the founder can have signed it
        mergeRoster(Array.isArray(d.records) ? d.records.filter((/** @type {any} */ r) => r?.type === 'snapshot').slice(-1) : [])
        if (!roster.members.has(fp)) mergeRoster(joinChain(d.records, fp))
      }
      const pub = fp === me.fp ? myPub : roster.members.get(fp)?.publicKey
      if (pub && checkAuth(pub, 'client', exporterOf(sock), sig)) { clientFp = fp; authed.set(sock, fp) }
    }
    const local = isLoopback(sock.remoteAddress) && clientFp === me.fp   // a process holding this machine's key, on this machine

    if (p === '/health') {
      if (!local) return reply(res, 404, { error: 'not found' })
      return reply(res, 200, { ok: true, host: cfg.host, net: cfg.net, fp: me.fp, version: VERSION, proto: PROTO, pid: process.pid })
    }

    if (p.startsWith('/local/')) {
      if (!local) return reply(res, 403, { error: 'local only' })
      return handleLocal(req, res, u, p, d)
    }
    if (!p.startsWith('/v1/')) return reply(res, 404, { error: 'not found' })
    // ---- node <-> node: the client's key must be a current member's ----
    const peer = roster.members.get(clientFp)
    if (!peer) return reply(res, 403, { error: 'not a member of this network' })
    if (peer.fp !== me.fp) notePeer(peer.host, sock.remoteAddress, req.headers['x-agentlink-port'])

    switch (`${req.method} ${p}`) {
      case 'POST /v1/deliver': {
        /** @type {Record<string, string>} */
        const results = {}
        /** @type {string[]} */
        const unknown = []
        /** @type {string[]} */
        const noRoom = []
        /** @type {Set<string>} */
        const toPump = new Set()    // offer each local recipient its new messages once, not per envelope
        const mine = new Set(Array.isArray(d.mine) ? d.mine.slice(0, 2000) : [])
        try {
          tx(() => {
            for (const e of Array.isArray(d.messages) ? d.messages.slice(0, 2000) : []) {
              const st = accept(e, toPump, mine.has(e?.id) ? peer.host : undefined)
              if (st === 'unknown-sender') unknown.push(e.id)
              else if (st === 'full') noRoom.push(e.id)
              else if (st) results[e.id] = st
            }
          })
        } catch (err) {
          // temporary storage failure: 503 makes the sender back off and retry the whole batch,
          // instead of marking messages permanently failed
          log('could not store delivered messages:', errMsg(err))
          throw httpErr(503, 'temporarily unable to store messages; retry later')
        }
        for (const n of toPump) pump(n)
        return reply(res, 200, { results, unknown, full: noRoom })
      }
      case 'POST /v1/hello': {
        if (peer.fp !== me.fp) {
          if (q.wake.run(peer.host).changes) kick()
          mergeRoster(d.records)
          learnPeers(d.peers)
          noteVersion(peer.host, d.version)
        }
        return reply(res, 200, { host: cfg.host, peers: shareablePeers(), records: roster.records, version: VERSION })
      }
      case 'GET /v1/sessions':
        return reply(res, 200, { host: cfg.host, sessions: [...sessions.keys()], sids: [...sessions.values()].map(s => sessionId(s.token)).filter(Boolean) })
      case 'POST /v1/lease':
        return reply(res, 200, remoteLease(peer.host, d))
    }
    return reply(res, 404, { error: 'not found' })
  }

  /** @param {http.IncomingMessage} req @param {Res} res @param {URL} u @param {string} p @param {Record<string, any>} d */
  async function handleLocal(req, res, u, p, d) {
    switch (`${req.method} ${p}`) {
      case 'GET /local/stream': {
        const want = sanitizeName(u.searchParams.get('name'))
        const token = String(u.searchParams.get('token') || '')
        let name = want
        const existing = sessions.get(want)
        // a reconnecting session (same token) replaces its own stale stream; anyone else gets a new name
        const reconnecting = existing && token && existing.token === token ? existing : null
        if (reconnecting) { reconnecting.res.end(); reconnecting.waiter?.end(); sessions.delete(want) }
        for (let i = 2; sessions.has(name); i++) name = `${want.slice(0, 47 - String(i).length)}-${i}`   // stays within the 48-char name limit
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        const s = {
          res, sent: new Set(), token, live: u.searchParams.get('mode') !== 'poll', owner: Number(u.searchParams.get('owner')) || 0, cwd: u.searchParams.get('cwd') || '',
          // told about already, so a session that doesn't read a message isn't woken for it again and again
          notified: reconnecting?.notified ?? new Set(), waiter: /** @type {Res | null} */ (null), more: false, draining: false,
          lastActive: reconnecting?.lastActive ?? 0,     // only the session's own actions count
        }
        sessions.set(name, s)
        sse(res, 'hello', { name, address: `${name}@${cfg.host}`, host: cfg.host })
        const ping = setInterval(() => res.write(': ping\n\n'), 20_000)
        res.on('close', () => { clearInterval(ping); s.waiter?.end(); if (sessions.get(name) === s) sessions.delete(name); leases.marks() })
        log(`session connected: ${name}`)
        leases.marks()
        // the same agent back under its name after its adapter restarted keeps its leases
        if (!reconnecting && token) leases.carryOver(name, sessionId(token), askAuthority).catch(e => log('lease carry-over:', errMsg(e)))
        pump(name)
        return
      }
      case 'GET /local/wake': {                 // the wait behind `natter wake`: answers once, when there's news
        const pids = String(u.searchParams.get('pids') || '').split(',').map(Number).filter(Boolean)
        // by process, nearest first: a Claude started from inside another Claude's session belongs to
        // the inner one. Codex starts every session's adapter from one shared app-server, so its waiter
        // also says which folder: the newest session there, if there are several
        const cwd = u.searchParams.get('cwd')
        const found = cwd ? [...sessions].reverse().find(([, x]) => pids.includes(x.owner) && x.cwd === cwd)
          : sessionOwnedBy(pids)
        if (!found) return reply(res, 404, { error: 'no session' })
        const [name, s] = found
        s.lastActive = now()                  // the hook waits again at each turn: the session is active
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        if (s.live) { sse(res, 'done', {}); return res.end() }   // a channel session is woken by the push itself
        if (s.waiter) { sse(s.waiter, 'done', {}); s.waiter.end() }
        s.waiter = res
        const ping = setInterval(() => res.write(': ping\n\n'), 20_000)
        res.on('close', () => { clearInterval(ping); if (s.waiter === res) s.waiter = null })
        nudge(name)
        return
      }
      case 'POST /local/lease':
        return reply(res, 200, await localLease(d))
      case 'GET /local/lease': {               // for tools that enforce leases: who holds this, if anyone
        return reply(res, 200, await localLease({ op: 'check', resource: u.searchParams.get('resource') }))
      }
      case 'POST /local/ack': {               // state 'pushed': shown in a channel session (no read receipt)
        const s = sessions.get(d.name)
        const mark = d.state === 'pushed' ? q.pushed : q.delivered
        // a message the session has now is done with: nothing need remember it for the session's life
        tx(() => { for (const id of Array.isArray(d.ids) ? d.ids : []) { mark.run(now(), String(id)); s?.sent.delete(String(id)); s?.notified.delete(String(id)) } })
        if (s) pump(d.name)
        return reply(res, 200, { ok: true })
      }
      case 'POST /local/told': {               // a session has read these; or not (a cancelled read), and it should hear of them again
        const s = sessions.get(d.name)
        for (const id of Array.isArray(d.ids) ? d.ids : []) { if (d.told) s?.notified.add(String(id)); else s?.notified.delete(String(id)) }
        if (s) nudge(d.name)
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
        const limit = Math.max(1, Math.min(Math.floor(Number(u.searchParams.get('limit'))) || 20, 200))
        const rows = q.history.all(sanitizeName(u.searchParams.get('name')), limit)
        return reply(res, 200, { messages: rows.map(r => ({ id: r.id, from: r.from_addr, body: r.body, sent_at: r.sent_at, state: r.state })) })
      }
      case 'GET /local/status':
        return reply(res, 200, {
          host: cfg.host, aliases: [...selfAliases], net: shortFp(cfg.net), fp: shortFp(me.fp), port: cfg.port, version: VERSION, pid: process.pid,
          member: roster.members.has(me.fp), removed: roster.removed.has(me.fp),
          roster: rosterStatus(),
          members: members(), sessions: [...sessions.keys()], counts: q.counts.all(), peers: allPeers(),
          pending: db.prepare(`SELECT id,to_addr,role,attempts,replicated,last_error FROM messages WHERE state='pending' ORDER BY sent_at LIMIT 20`).all(),
        })
      case 'POST /local/invite': {
        if (!roster.members.has(me.fp)) throw httpErr(409, 'this machine is not a member of its network, so it cannot invite others')
        const { token, fp } = newInvite()
        return reply(res, 200, { token, fp, host: cfg.host, port: cfg.port, tailscale: tailscale(), ip: localIPv4s().find(a => !a.startsWith('127.')), expires_at: now() + INVITE_TTL_MS })
      }
      case 'GET /local/invites':                // open invites (their tokens are stored hashed, so only times)
        return reply(res, 200, { invites: q.openInvites.all(now()) })
      case 'POST /local/invite/revoke': {
        const revoked = Number(q.revokeInvites.run().changes)
        rotate()
        return reply(res, 200, { revoked })
      }
      case 'POST /local/remove': {
        let host
        try { host = normHost(d.host) } catch { throw httpErr(400, `bad machine name "${d.host}"`) }
        const m = roster.byHost.get(host) || roster.byHost.get(peerRow(host)?.alias_of || '')
        if (!m) throw httpErr(404, `${host} is not a member of this network`)
        if (m.fp === me.fp) throw httpErr(400, 'to take this machine off the network, run `natter uninstall` (or remove it from another member)')
        if (!roster.members.has(me.fp)) throw httpErr(409, 'this machine is not a member of its network')
        if (!roster.canRemove(me.fp, m.fp)) {
          const earlier = [...roster.members.values()].filter(x => x.rank < m.rank).map(x => x.host)
          throw httpErr(403, `${m.host} joined the network before this machine, so only an earlier machine can remove it: ${earlier.join(', ')}`)
        }
        try { roster.remove(me, m.fp) } catch (e) { throw httpErr(507, `could not remove ${m.host}: ${errMsg(e)}`) }
        roster.save()
        log(`removed ${m.host} (key ${shortFp(m.fp)}) from the network`)
        discovery?.announce()
        setImmediate(helloAll)
        return reply(res, 200, { removed: m.host })
      }
      case 'POST /local/compact': {
        if (me.fp !== roster.net) throw httpErr(403, `only the founding machine can do this: ${roster.ranked.get(roster.net)?.host ?? 'the first machine on the network'}`)
        // what the others know first, from a round begun now: an add we haven't heard of would be lost
        const asked = now()
        const catchUp = async () => { await helloing; await helloAll(); return true }
        /** @type {NodeJS.Timeout | undefined} */
        let limit
        const caughtUp = await Promise.race([catchUp(), new Promise(res => { limit = setTimeout(() => res(false), COMPACT_WAIT_MS) })]).finally(() => clearTimeout(limit))
        const list = [...roster.members.values()].map(m => m.host)
        const offline = list.filter(h => h !== cfg.host && !(Number(reachedAt.get(h)) >= asked))
        if (!d.confirm) return reply(res, 200, { members: list, offline, caughtUp, ...rosterStatus() })
        if (req.socket.destroyed) return                       // the command was interrupted: that's a no
        if (!caughtUp && !d.force) throw httpErr(504, `not every machine could be checked in time, so nothing was changed. Not reached: ${offline.join(', ')}. Run it again, or add --force to go ahead without them`)
        const before = rosterStatus().bytes
        try { roster.compact(me) } catch (e) { throw httpErr(507, `could not compact: ${errMsg(e)}`) }
        roster.save()
        log(`compacted the member list: ${before} bytes to ${rosterStatus().bytes}`)
        discovery?.announce()
        setImmediate(helloAll)
        return reply(res, 200, { members: list, offline, before, ...rosterStatus() })
      }
      case 'POST /local/shutdown':
        reply(res, 200, { ok: true })
        return setTimeout(() => shutdown(), 50)
    }
    return reply(res, 404, { error: 'not found' })
  }

  log(`nattermatic node ${VERSION} up: ${cfg.host}:${cfg.port} (network ${shortFp(cfg.net)}, key ${shortFp(me.fp)}, pid ${process.pid})`)

  // ---------- discovery ----------
  const discovery = cfg.discovery ? startDiscovery(cfg, () => roster.gateDks(), ({ host, fp, addr }) => {
    const m = roster.members.get(fp)
    if (m && m.host === host && m.fp !== me.fp) probe(m.host, addr)   // beacons are only hints: the handshake verifies
  }, log) : null

  const timers = [
    setInterval(flush, 5000),
    setInterval(helloAll, HELLO_EVERY),
    setInterval(gc, 3600_000),
    setInterval(rotate, 60_000),   // an expired invite's key stops being presented
    setInterval(async () => {
      if (leaseBusy) return                 // a slow machine must not stack up passes
      leaseBusy = true
      try {
        await Promise.all([
          leases.sweep().catch(e => log('lease sweep:', errMsg(e))),
          leases.renewActive((auth, body) => askAuthority(auth, body)).catch(e => log('lease renewal:', errMsg(e))),
        ])
      } finally { leaseBusy = false }
    }, Number(process.env.NATTERMATIC_LEASE_SWEEP_MS) || 15_000),
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
    server.closeAllConnections?.()
    setTimeout(() => { try { db.close() } catch {}; process.exit(0) }, 300)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  return { server, shutdown }
}

/**
 * What another machine says its sessions are called, keeping only names as a node makes them: these
 * go straight to a session, so nothing else may ride along.
 * @param {unknown} list
 */
export const sessionNames = list => Array.isArray(list) ? list.filter(s => typeof s === 'string' && sanitizeName(s) === s).slice(0, 200) : []

/** @type {Promise<string> | null} */
let packingApp = null
/** Zip the app this node runs from, for a Mac joining through us. @param {string} dir @param {string} bundle */
function packApp(dir, bundle) {
  return packingApp ||= (async () => {
    const out = path.join(dir, 'dist', 'app')
    fs.mkdirSync(out, { recursive: true })
    const zip = path.join(out, 'nattermatic-app.zip')
    fs.rmSync(zip, { force: true })
    await execFileP('ditto', ['-c', '-k', '--keepParent', bundle, zip])
    return zip
  })().finally(() => setTimeout(() => { packingApp = null }, 60_000))
}

/** @type {Promise<string> | null} */
let packing = null
/** npm-pack this installation so another machine can install it from us. @param {string} dir @returns {Promise<string>} path of the tarball */
function packTarball(dir) {
  return packing ||= (async () => {
    const out = path.join(dir, 'dist', 'pkg')       // its own folder: the app's zip may be in use
    fs.rmSync(out, { recursive: true, force: true })
    fs.mkdirSync(out, { recursive: true })
    if (SEA) {   // the app carries the npm package it was built from
      const file = path.join(out, 'nattermatic.tgz')
      fs.writeFileSync(file, readAsset('nattermatic.tgz'))
      return file
    }
    // the npm that came with this node, if any: a private runtime is on no one's PATH
    const bin = path.dirname(process.execPath)
    const npm = fs.existsSync(path.join(bin, 'npm')) ? path.join(bin, 'npm') : 'npm'
    const { stdout } = await execFileP(npm, ['pack', '--silent', '--pack-destination', out], { cwd: PKG_ROOT, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
    return path.join(out, stdout.trim().split('\n').pop() || '')
  })().finally(() => setTimeout(() => { packing = null }, 60_000))
}

/**
 * install.sh preset to join this network through us: where to fetch the package, the key to pin
 * (the invite key), the invite token, and the network (so a member re-joining keeps its key).
 * @param {string | undefined} hostHeader @param {Pick<Config, 'host' | 'port' | 'net'>} cfg @param {string} token @param {string} pin
 */
export function installScript(hostHeader, cfg, token, pin) {
  const sh = shQuote
  // the name the joining machine used to reach us is, by definition, one that works for it
  const hh = String(hostHeader || '')
  const used = validAddr(hh) ? hh : validAddr(`${hh}:${cfg.port}`) ? `${hh}:${cfg.port}` : `${cfg.host}:${cfg.port}`
  // our own name too, unless that's the same machine name: its address would replace the one that worked
  const peer = parsePeer(used)?.host === cfg.host ? '' : ` --peer ${sh(`${cfg.host}:${cfg.port}`)}`
  const preset = [
    `NATTERMATIC_PKG=${sh(`https://${used}/join/pkg.tgz?t=${token}`)}`,
    // a Mac joining a machine that runs the app gets the same app (Apple silicon only)
    ...(appBundle() ? [`NATTERMATIC_APP_URL=${sh(`https://${used}/join/app.zip?t=${token}`)}`] : []),
    `NATTERMATIC_PIN=${sh(pin)}`,
    // the token is passed in the environment: setup's command line is visible to other users (ps)
    `NATTERMATIC_TOKEN=${sh(token)}; export NATTERMATIC_TOKEN`,
    // what the user added (`| sh -s -- --host <name>`) comes after: it's theirs, and it stays
    `set -- --join ${sh(used)} --pin ${sh(pin)} --net ${sh(cfg.net)}${peer} "$@"`,
  ].join('\n')
  return readAsset('install.sh').toString('utf8').replace('#@@PRESET@@', () => preset)   // no $-patterns
}

/** @param {http.ServerResponse} res @param {string} event @param {unknown} data */
function sse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
/** An error carrying the HTTP status to reply with. @param {number} status @param {string} message */
function httpErr(status, message) { return Object.assign(new Error(message), { status }) }
const isLoopback = (/** @type {string | undefined} */ a) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'

/** @param {http.IncomingMessage} req @returns {Promise<string>} */
function readBody(req, max = MAX_REQ) {
  return new Promise((resolve, reject) => {
    let size = 0
    /** @type {Buffer[]} */
    const chunks = []
    req.on('data', (/** @type {Buffer} */ c) => {
      size += c.length
      if (size > max) { reject(httpErr(413, 'request too large')); req.destroy() } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
