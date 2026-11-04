// Connections between agentlink machines.
//
// Nodes present a throwaway TLS certificate (a fresh key per connection), so someone who connects
// to a node's port learns nothing they could recognise the machine by later, on another network.
// Who is who is settled inside the encrypted connection instead (authedRaw): the client proves it
// belongs to the network, the server proves it is the machine expected, and only then does the
// client reveal itself and send its request. Each proof signs the connection's TLS exporter, so it
// is worthless on any other connection, and a relay in the middle (two TLS sessions) can't pass it on.
//
// Pinned TLS (pinnedRaw) is kept for joining: an invite names the key the inviting node presents
// while invites are open, and the joining machine (and curl) accept only that key.
import https from 'node:https'
import tls from 'node:tls'
import net from 'node:net'
import crypto from 'node:crypto'
import { fingerprint } from './cert.js'
import { gateTags, proveAuth, checkAuth } from './crypto.js'

/** Split "host:port" / "[v6]:port". @param {string} addr */
export function splitAddr(addr) {
  const m = addr.match(/^\[([0-9a-f:.]+)\]:(\d+)$/i) || addr.match(/^([^:]+):(\d+)$/)
  if (!m) throw new Error(`invalid address ${addr}`)
  return { host: m[1], port: Number(m[2]) }
}

export class PinError extends Error {}
/** The other machine speaks a different version of the protocol. */
export class ProtoError extends Error {
  /** @param {number} theirs */
  constructor(theirs) {
    super(`it runs ${theirs > PROTO ? 'a newer' : 'an older'} version of agentlink (protocol ${theirs}; this machine: ${PROTO}). Upgrade the older machine: re-run the installer, or \`npm install -g @tombaldwin/agentlink\` and \`agentlink setup\``)
    this.theirs = theirs
  }
}

/**
 * The version of the machine-to-machine protocol (the identity exchange, roster and message
 * formats). Machines exchange it first, so a mismatch is reported as such instead of looking like
 * a stranger. Bump it on any incompatible change.
 */
export const PROTO = 1
const notExpected = () => new PinError('not the expected machine (key mismatch)')

/** A connection's TLS exporter: the value both identity proofs sign. @param {tls.TLSSocket} sock */
export const exporterOf = sock => sock.exportKeyingMaterial(32, 'EXPORTER-agentlink-auth', Buffer.alloc(0))

/** @param {unknown} e */
function mapErr(e) {
  const code = /** @type {any} */ (e)?.code
  // the far end doesn't speak TLS (a plain HTTP server answers our handshake with garbage)
  if (code === 'EPROTO' || /^ERR_SSL_/.test(code || '')) return Object.assign(new Error('not an agentlink node (no TLS)'), { code: 'EPROTO' })
  return e
}

/** @param {import('node:http').IncomingMessage} res @param {number} max */
async function readAll(res, max) {
  if (Number(res.headers['content-length']) > max) { res.destroy(); throw new Error('response too large') }
  /** @type {Buffer[]} */
  const chunks = []
  let n = 0
  for await (const c of res) {
    n += c.length
    if (n > max) { res.destroy(); throw new Error('response too large') }
    chunks.push(c)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * @typedef {{
 *   addr: string, method?: 'GET' | 'POST', path: string, body?: string, headers?: Record<string, string>,
 *   identity: import('./types.js').Identity,
 *   accept: Map<string, crypto.KeyObject>, dks: string[], timeout?: number, signal?: AbortSignal,
 *   anyProto?: boolean,
 * }} AuthOpts
 * accept: the machines we are willing to be talking to (fingerprint -> public key)
 * dks: the network's discovery keys (oldest first), which open the gate
 * anyProto: talk to a node with a different protocol version (the local node after an upgrade, to
 *   stop it); otherwise that fails with ProtoError
 */

/**
 * A request to the machine at `addr`, which must prove it holds one of `accept`'s keys before we
 * reveal who we are or send a byte of the request. Resolves once the response headers arrive.
 * @param {AuthOpts} o
 * @returns {Promise<{ res: import('node:http').IncomingMessage, peerFp: string }>}
 */
export async function authedRaw(o) {
  const { host, port } = splitAddr(o.addr)
  // one connection for both steps; no SNI: it would show the machine's name to anyone watching
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1, rejectUnauthorized: false, minVersion: 'TLSv1.3' })
  const base = { host, port, agent, servername: '', signal: o.signal }
  try {
    // 1. the gate: show we belong to the network; the server answers with its signed identity
    /** @type {tls.TLSSocket | null} */
    let sock = null
    const r1 = await new Promise((resolve, reject) => {
      // the timeout option, not req.setTimeout: that one only starts once the connection is up, so a
      // silently dropped connect would wait out the OS's limit (over a minute)
      const req = https.request({ ...base, method: 'GET', path: '/v1/auth', headers: { 'x-agentlink-proto': String(PROTO) }, timeout: o.timeout || 4000 }, resolve)
      req.on('timeout', () => req.destroy(new Error('timed out')))
      req.on('error', e => reject(mapErr(e)))
      req.on('socket', s => {
        const t = /** @type {tls.TLSSocket} */ (s)
        t.once('secureConnect', () => {
          sock = t
          try { req.setHeader('x-agentlink-gate', gateTags(o.dks, exporterOf(t))); req.end() } catch (e) { req.destroy(/** @type {Error} */ (e)) }
        })
      })
    })
    const text = await readAll(r1, 4096)
    if (!sock) throw notExpected()
    const ekm = exporterOf(sock)
    /** @type {any} */
    let who = null
    try { who = JSON.parse(text) } catch {}
    // a member of our network running another version (the claim is only used for the message)
    if (r1.statusCode === 200 && Number.isSafeInteger(who?.proto) && who.proto !== PROTO && !o.anyProto) throw new ProtoError(who.proto)
    const key = r1.statusCode === 200 && typeof who?.fp === 'string' ? o.accept.get(who.fp) : undefined
    if (!key || !checkAuth(key, 'server', ekm, who.sig)) throw notExpected()
    const peerFp = String(who.fp)

    // 2. the request, carrying our own signed identity, on the same connection only
    const body = o.body ?? ''
    const proof = `${o.identity.fp}.${proveAuth(o.identity.key, 'client', ekm)}`
    const res = await new Promise((resolve, reject) => {
      const req = https.request({
        ...base, method: o.method || 'GET', path: o.path,
        headers: { ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}), ...o.headers, 'x-agentlink-auth': proof },
      }, resolve)
      req.setTimeout(o.timeout ?? 4000, () => req.destroy(new Error('timed out')))
      req.on('error', e => reject(mapErr(e)))
      // nothing is written until the request has the connection the server proved itself on
      req.on('socket', s => { if (s === sock) req.end(body); else req.destroy(new PinError('the connection was replaced before the request was sent')) })
    })
    res.once('close', () => agent.destroy())
    return { res, peerFp }
  } catch (e) {
    agent.destroy()
    throw e
  }
}

/**
 * authedRaw, reading the (bounded) response body.
 * @param {AuthOpts} o @param {number} [max] largest response body accepted
 * @returns {Promise<{ status: number, text: string, peerFp: string }>}
 */
export async function authedRequest(o, max = 2 << 20) {
  const { res, peerFp } = await authedRaw(o)
  return { status: res.statusCode || 0, text: await readAll(res, max), peerFp }
}

/**
 * A request whose server must present one of `trust`, checked inside the handshake: on a mismatch
 * nothing is sent. Used to join through an invite (which names the key to expect).
 * @param {{ addr: string, method?: 'GET' | 'POST', path: string, body?: string, trust: { pem: string, fp: string }[], timeout?: number }} o
 * @param {number} [max]
 * @returns {Promise<{ status: number, text: string, peerFp: string }>}
 */
export async function pinnedRequest(o, max = 2 << 20) {
  const { host, port } = splitAddr(o.addr)
  const allowed = new Set(o.trust.map(t => t.fp))
  const body = o.body ?? ''
  let pinFailed = false
  const res = await new Promise((resolve, reject) => {
    const req = https.request({
      host, port, method: o.method || 'GET', path: o.path, agent: false,
      headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {},
      timeout: o.timeout ?? 4000,                // covers connecting too (see authedRaw)
      ca: o.trust.map(t => t.pem),               // only these certificates can validate
      minVersion: 'TLSv1.2',
      checkServerIdentity: (_h, c) => {
        if (allowed.has(fingerprint(new crypto.X509Certificate(c.raw)))) return undefined
        pinFailed = true
        return notExpected()
      },
    }, resolve)
    req.on('timeout', () => req.destroy(new Error('timed out')))
    req.on('error', e => {
      const code = /** @type {any} */ (e).code
      // a server whose certificate isn't one of ours fails CA validation before the identity check
      if (pinFailed || e instanceof PinError || /SELF_SIGNED|UNABLE_TO_VERIFY|CERT_/.test(code || '')) reject(notExpected())
      else reject(mapErr(e))
    })
    req.end(body)
  })
  return { status: res.statusCode || 0, text: await readAll(res, max), peerFp: '' }
}

/**
 * The certificate the server at `addr` presents, without sending it anything (used to check an
 * invite's pinned fingerprint before talking to the inviting machine).
 * @param {string} addr @returns {Promise<{ pem: string, fp: string }>}
 */
export function peerCertificate(addr, timeout = 5000) {
  const { host, port } = splitAddr(addr)
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, rejectUnauthorized: false, minVersion: 'TLSv1.2', ...(net.isIP(host) ? {} : { servername: host }) }, () => {
      const x = sock.getPeerX509Certificate()
      sock.destroy()
      if (!x) return reject(new Error(`${addr} presented no certificate`))
      resolve({ pem: x.toString(), fp: fingerprint(x) })
    })
    sock.setTimeout(timeout, () => sock.destroy(new Error(`timed out connecting to ${addr}`)))
    sock.on('error', reject)
  })
}
