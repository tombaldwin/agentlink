import crypto from 'node:crypto'

/** @type {(secret: string, ...parts: string[]) => string} */
const hmac = (secret, ...parts) => crypto.createHmac('sha256', secret).update(parts.join('\n')).digest('base64url')
/** @param {string} s */
const sha = s => crypto.createHash('sha256').update(s).digest('base64url')

/** Constant-time string comparison; false unless both are strings. @param {unknown} a @param {unknown} b */
export function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

/** Envelope signature: end-to-end, so a message relayed via other nodes can't be altered by outsiders. */
/** @type {(secret: string, m: Omit<import('./types.js').Envelope, 'sig'>) => string} */
export const signEnvelope = (secret, m) =>
  hmac(secret, 'env', m.id, m.from, m.to, String(m.sent_at), String(m.expires_at), m.body)
/** @type {(secret: string, m: import('./types.js').Envelope) => boolean} */
export const verifyEnvelope = (secret, m) => safeEq(m.sig, signEnvelope(secret, m))

export const MAX_SKEW_MS = 5 * 60_000

/**
 * Per-request auth header: "<ts>.<nonce>.<hmac(ts, nonce, method, path, sha(body), nodeHeader)>".
 * The nonce makes each request single-use (see NonceCache); nodeHeader binds the sender's identity.
 */
/**
 * @param {string} secret
 * @param {string} method
 * @param {string} path
 */
export function authHeader(secret, method, path, body = '', nodeHeader = '') {
  const ts = String(Date.now())
  const nonce = crypto.randomBytes(12).toString('base64url')
  return `${ts}.${nonce}.${hmac(secret, 'req', ts, nonce, method, path, sha(body), nodeHeader)}`
}

/**
 * Returns true if valid (and, when a NonceCache is given, not seen before).
 * @param {string} secret
 * @param {unknown} header
 * @param {string} method
 * @param {string} path
 * @param {NonceCache | null} [nonces]
 */
export function checkAuth(secret, header, method, path, body = '', nodeHeader = '', nonces = null) {
  if (typeof header !== 'string') return false
  const parts = header.split('.')
  if (parts.length !== 3) return false
  const [ts, nonce, mac] = parts
  if (!/^\d{1,16}$/.test(ts) || Math.abs(Date.now() - Number(ts)) > MAX_SKEW_MS) return false
  if (!/^[\w-]{8,64}$/.test(nonce)) return false
  if (!safeEq(mac, hmac(secret, 'req', ts, nonce, method, path, sha(body), nodeHeader))) return false
  if (nonces && !nonces.add(nonce)) return false
  return true
}

/** Response signature, bound to the request it answers, so a fake node can't forge "delivered". */
/** @type {(secret: string, reqAuth: string, nodeHeader: string, body: string) => string} */
export const signResponse = (secret, reqAuth, nodeHeader, body) => hmac(secret, 'resp', reqAuth, nodeHeader || '', sha(body))
/** @type {(secret: string, reqAuth: string, nodeHeader: string, body: string, sig: string | null) => boolean} */
export const verifyResponse = (secret, reqAuth, nodeHeader, body, sig) => safeEq(sig, signResponse(secret, reqAuth, nodeHeader, body))

/** Remembers nonces for the auth window; add() returns false for a replay. */
export class NonceCache {
  constructor(ttl = MAX_SKEW_MS * 2, max = 200_000) {
    this.ttl = ttl
    this.max = max
    /** @type {Map<string, number>} nonce -> first seen */
    this.map = new Map()
  }
  /** @param {string} nonce */
  add(nonce) {
    const t = Date.now()
    if (this.map.has(nonce)) return false
    this.map.set(nonce, t)
    if (this.map.size > this.max || this.map.size % 1000 === 0) {
      for (const [k, at] of this.map) { if (t - at > this.ttl || this.map.size > this.max) this.map.delete(k); else break }
    }
    return true
  }
}

/** Beacon signature (LAN discovery). */
/** @type {(secret: string, b: { host: string, net: string, port: number, ts: number }) => string} */
export const signBeacon = (secret, b) => hmac(secret, 'beacon', b.host, b.net, String(b.port), String(b.ts))
