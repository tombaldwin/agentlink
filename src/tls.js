// Pinned TLS: every connection we open accepts only specific, known keys, checked inside the
// handshake. On a mismatch the connection is torn down before a single request byte is written,
// so a stranger holding a stored address (a café network reusing a home IP) learns nothing.
import https from 'node:https'
import tls from 'node:tls'
import net from 'node:net'
import crypto from 'node:crypto'
import { fingerprint } from './cert.js'

/** Split "host:port" / "[v6]:port". @param {string} addr */
export function splitAddr(addr) {
  const m = addr.match(/^\[([0-9a-f:.]+)\]:(\d+)$/i) || addr.match(/^([^:]+):(\d+)$/)
  if (!m) throw new Error(`invalid address ${addr}`)
  return { host: m[1], port: Number(m[2]) }
}

export class PinError extends Error {}

/**
 * @typedef {{ pem: string, fp: string }} Trusted
 * @typedef {{
 *   addr: string, method?: 'GET' | 'POST', path: string, body?: string, headers?: Record<string, string>,
 *   identity: import('./types.js').Identity, trust: Trusted[], timeout?: number, signal?: AbortSignal,
 * }} PinnedOpts
 */

/**
 * Open a request whose server must present one of `trust` (and to which we present our own
 * certificate). Resolves with the response once its headers arrive.
 * @param {PinnedOpts} o
 * @returns {Promise<{ res: import('node:http').IncomingMessage, peerFp: string }>}
 */
export function pinnedRaw(o) {
  const { host, port } = splitAddr(o.addr)
  const allowed = new Set(o.trust.map(t => t.fp))
  const body = o.body ?? ''
  return new Promise((resolve, reject) => {
    let pinFailed = false
    const req = https.request({
      host, port, method: o.method || 'GET', path: o.path, agent: false,
      headers: { ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}), ...o.headers },
      key: o.identity.key, cert: o.identity.cert,
      ca: o.trust.map(t => t.pem),               // only these certificates can validate
      minVersion: 'TLSv1.3',
      // ...and of those, only the ones we expect here (the CA list may hold several members)
      checkServerIdentity: (_h, c) => {
        if (allowed.has(fingerprint(new crypto.X509Certificate(c.raw)))) return undefined
        pinFailed = true
        return new PinError('not the expected machine (key mismatch)')
      },
      signal: o.signal,
    }, res => {
      const x = /** @type {import('node:tls').TLSSocket} */ (res.socket).getPeerX509Certificate()
      resolve({ res, peerFp: x ? fingerprint(x) : '' })
    })
    req.setTimeout(o.timeout ?? 4000, () => req.destroy(new Error('timed out')))
    req.on('error', e => {
      const code = /** @type {any} */ (e).code
      // a server whose certificate isn't one of ours fails CA validation before the identity check
      if (pinFailed || e instanceof PinError || /SELF_SIGNED|UNABLE_TO_VERIFY|CERT_/.test(code || '')) reject(new PinError('not the expected machine (key mismatch)'))
      else if (code === 'EPROTO') reject(Object.assign(new Error('not an agentlink node (no TLS)'), { code }))
      else reject(e)
    })
    req.end(body)
  })
}

/**
 * A pinned request that reads the (bounded) response body.
 * @param {PinnedOpts} o @param {number} [max] largest response body accepted
 * @returns {Promise<{ status: number, text: string, peerFp: string }>}
 */
export async function pinnedRequest(o, max = 2 << 20) {
  const { res, peerFp } = await pinnedRaw(o)
  if (Number(res.headers['content-length']) > max) { res.destroy(); throw new Error('response too large') }
  /** @type {Buffer[]} */
  const chunks = []
  let n = 0
  for await (const c of res) {
    n += c.length
    if (n > max) { res.destroy(); throw new Error('response too large') }
    chunks.push(c)
  }
  return { status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8'), peerFp }
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
