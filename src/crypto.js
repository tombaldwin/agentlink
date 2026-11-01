import crypto from 'node:crypto'

/** Constant-time string comparison; false unless both are strings. @param {unknown} a @param {unknown} b */
export function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

/** @param {string} s */
export const sha256 = s => crypto.createHash('sha256').update(s).digest('base64url')

/** @param {crypto.KeyLike} key @param {string} payload */
const sign = (key, payload) => crypto.sign('sha256', Buffer.from(payload), key).toString('base64url')
/** @param {crypto.KeyLike} pub @param {string} payload @param {unknown} sig */
function verify(pub, payload, sig) {
  if (typeof sig !== 'string' || sig.length > 200) return false
  try { return crypto.verify('sha256', Buffer.from(payload), pub, Buffer.from(sig, 'base64url')) } catch { return false }
}

/** @param {Omit<import('./types.js').Envelope, 'sig'>} m */
const envPayload = m => JSON.stringify(['agentlink-env-1', m.id, m.from, m.to, m.sent_at, m.expires_at, m.body])
/**
 * Envelope signature by the sending machine's key: end to end, so nobody relaying a message
 * (holders, other members) can alter it, and a member can't send as another machine.
 * @param {string} key PEM private key @param {Omit<import('./types.js').Envelope, 'sig'>} m
 */
export const signEnvelope = (key, m) => sign(key, envPayload(m))
/** @param {crypto.KeyLike} pub @param {import('./types.js').Envelope} m */
export const verifyEnvelope = (pub, m) => verify(pub, envPayload(m), m.sig)

/** @param {Omit<import('./types.js').RosterRecord, 'sig'>} r */
const recPayload = r => JSON.stringify(['agentlink-roster-1', r.type, r.host ?? '', r.fp, r.cert ?? '', r.at, r.by, r.dk ?? ''])
/** @param {string} key @param {Omit<import('./types.js').RosterRecord, 'sig'>} r */
export const signRecord = (key, r) => sign(key, recPayload(r))
/** @param {crypto.KeyLike} pub @param {import('./types.js').RosterRecord} r */
export const verifyRecord = (pub, r) => verify(pub, recPayload(r), r.sig)

/** A fresh discovery key (shared by members, only ever sent over member TLS connections). */
export const newDiscoveryKey = () => crypto.randomBytes(32).toString('base64')

/**
 * LAN discovery beacons are encrypted under the discovery key, so people on the same network
 * (a café) see opaque packets: no machine name, nothing stable to recognise a laptop by.
 * @param {string} dk base64 key @param {object} obj
 */
export function sealBeacon(dk, obj) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(dk, 'base64'), iv)
  const body = Buffer.concat([c.update(JSON.stringify(obj)), c.final()])
  return Buffer.concat([iv, body, c.getAuthTag()])
}
/** @param {string[]} dks keys to try @param {Buffer} buf @returns {any} the beacon, or null */
export function openBeacon(dks, buf) {
  if (buf.length < 29 || buf.length > 2048) return null
  for (const dk of dks) {
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(dk, 'base64'), buf.subarray(0, 12))
      d.setAuthTag(buf.subarray(buf.length - 16))
      return JSON.parse(Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]).toString('utf8'))
    } catch {}
  }
  return null
}

/** A random URL- and shell-safe token. */
export const randomToken = (bytes = 18) => {
  for (;;) { const s = crypto.randomBytes(bytes).toString('base64url'); if (!s.startsWith('-')) return s }
}
