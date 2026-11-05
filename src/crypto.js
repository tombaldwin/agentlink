import crypto from 'node:crypto'

/** Constant-time string comparison; false unless both are strings. @param {unknown} a @param {unknown} b */
function safeEq(a, b) {
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
const recPayload = r => JSON.stringify(['agentlink-roster-1', r.type, r.host ?? '', r.fp, r.cert ?? '', r.at, r.by, r.dk ?? '',
  ...(r.type === 'remove' ? [(r.seen ?? []).join(',')] : r.type === 'snapshot' ? [JSON.stringify(r.list), JSON.stringify(r.keys)] : [])])
/**
 * A short id for a roster record (what a remove record lists in `seen`): of its content, not its
 * signature. A signature can be re-encoded by anyone and still verify, so it can't say which record
 * this is, and a copy with a different signature is the same record.
 * @param {Omit<import('./types.js').RosterRecord, 'sig'>} r
 */
export const recId = r => { let id = ids.get(r); if (!id) ids.set(r, id = sha256(recPayload(r)).slice(0, 22)); return id }
// records aren't changed once made, and replaying a roster asks for each one's id several times
/** @type {WeakMap<object, string>} */
const ids = new WeakMap()
/**
 * What a check of a record is remembered under: its whole content and signature. Never the signature
 * alone, or a signature that was good for one record would pass for any other record carrying it.
 * @param {import('./types.js').RosterRecord} r
 */
export const recKey = r => sha256(JSON.stringify([recPayload(r), r.sig]))
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

// ---- in-band identity (see docs/design/unlinkable-keys.md) ----
// A node's TLS certificate is a throwaway, so the handshake itself proves nothing. Instead, on each
// connection, the client first proves it holds a discovery key (the "gate": a stranger gets a 404
// like any other path), the server then signs the connection's TLS exporter with its machine key,
// and only then does the client sign it with its own and send its request. Both signatures are
// bound to that one TLS session, so they can't be replayed or relayed onto another connection.

/** @param {string} dk */
const gateKey = dk => crypto.createHmac('sha256', Buffer.from(dk, 'base64')).update('agentlink-gate-1').digest()
/** @param {string} dk @param {Buffer} ekm */
const gateTag = (dk, ekm) => crypto.createHmac('sha256', gateKey(dk)).update(ekm).digest('base64url')
const GATE_TAGS = 4

/**
 * Tags proving we hold the network's discovery key, for one connection (`ekm`: its TLS exporter).
 * The newest few keys, so a node that missed a removal (and its key rotation) still recognises us.
 * @param {string[]} dks oldest first @param {Buffer} ekm
 */
export const gateTags = (dks, ekm) => dks.slice(-GATE_TAGS).reverse().map(dk => gateTag(dk, ekm)).join(',')

/**
 * Does `header` hold a tag for one of `dks`? Old keys count too: they only let a client learn which
 * member it is talking to, and anyone who ever held one already has the member list.
 * @param {string[]} dks @param {Buffer} ekm @param {unknown} header
 */
export function gateOk(dks, ekm, header) {
  if (typeof header !== 'string' || header.length > 64 * GATE_TAGS) return false
  const tags = header.split(',').slice(0, GATE_TAGS)
  return dks.some(dk => { const want = gateTag(dk, ekm); return tags.some(t => safeEq(t, want)) })
}

/** @param {'server' | 'client'} role @param {Buffer} ekm */
const authPayload = (role, ekm) => JSON.stringify(['agentlink-auth-1', role, ekm.toString('base64')])
/** Sign this connection's exporter as `role`. @param {string} key PEM @param {'server' | 'client'} role @param {Buffer} ekm */
export const proveAuth = (key, role, ekm) => sign(key, authPayload(role, ekm))
/** @param {crypto.KeyLike} pub @param {'server' | 'client'} role @param {Buffer} ekm @param {unknown} sig */
export const checkAuth = (pub, role, ekm, sig) => verify(pub, authPayload(role, ekm), sig)
