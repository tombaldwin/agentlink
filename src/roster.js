// Network membership: a set of signed records that members exchange and merge.
//
//   add    {host, fp, cert}  signed by a current member ("by"); the founding machine signs its own
//   remove {fp}              signed by a current member; carries the next discovery key
//
// Every member computes the same membership from the same set of records by replaying them in
// (at, sig) order: a record counts only if its signer is a member at that point. A removed key is
// gone for good (re-adding a machine means a new key). The set only grows, so merging converges in
// any order and offline machines catch up on their next hello.
import fs from 'node:fs'
import crypto from 'node:crypto'
import { signRecord, verifyRecord, newDiscoveryKey } from './crypto.js'
import { fingerprint, certDer } from './cert.js'
import { normHost } from './config.js'

const MAX_RECORDS = 5000
const MAX_FUTURE_MS = 3600_000     // a record stamped further ahead than this is refused (bad clock)

/** @typedef {import('./types.js').RosterRecord} RosterRecord */
/** @typedef {import('./types.js').Member} Member */

/** @param {any} r @returns {r is RosterRecord} */
function wellFormed(r) {
  if (!r || typeof r !== 'object') return false
  if (r.type !== 'add' && r.type !== 'remove') return false
  if (typeof r.fp !== 'string' || r.fp.length > 64 || typeof r.by !== 'string' || r.by.length > 64) return false
  if (typeof r.sig !== 'string' || r.sig.length > 200 || !Number.isSafeInteger(r.at) || r.at < 0) return false
  if (r.dk !== undefined && (typeof r.dk !== 'string' || r.dk.length > 64)) return false
  if (r.type === 'add' && (typeof r.host !== 'string' || r.host.length > 253 || typeof r.cert !== 'string' || r.cert.length > 4096)) return false
  return true
}

export class Roster {
  /**
   * @param {{ net: string, records: RosterRecord[] }} data
   * @param {string | null} [file] where save() writes
   */
  constructor(data, file = null) {
    this.net = data.net
    this.file = file
    /** @type {RosterRecord[]} */
    this.records = []
    /** @type {Set<string>} */
    this.sigs = new Set()
    /** @type {Set<string>} signatures already checked against their signer */
    this.verified = new Set()
    /** @type {Map<string, Member>} fp -> member */
    this.members = new Map()
    /** @type {Map<string, Member>} host -> member */
    this.byHost = new Map()
    /** @type {Map<string, { at: number, by: string }>} */
    this.removed = new Map()
    /** @type {string[]} discovery keys, oldest first */
    this.dks = []
    this.merge(data.records, { trustClock: true })
  }

  /** @param {string} file */
  static load(file) {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!d || typeof d.net !== 'string' || !Array.isArray(d.records)) throw new Error(`bad roster ${file}`)
    return new Roster(d, file)
  }

  save() {
    if (!this.file) return
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ net: this.net, records: this.records }, null, 1) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }

  /** The current discovery key. */
  get dk() { return this.dks[this.dks.length - 1] }

  /**
   * Add records we were sent (or made). Returns true if the set of records changed.
   * @param {unknown} list @param {{ trustClock?: boolean }} [opts]
   */
  merge(list, { trustClock = false } = {}) {
    let added = false
    const before = this.sigs
    for (const r of Array.isArray(list) ? list : []) {
      if (!wellFormed(r) || this.sigs.has(r.sig) || this.records.length >= MAX_RECORDS) continue
      if (!trustClock && r.at > Date.now() + MAX_FUTURE_MS) continue
      const o = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (r))
      const clean = /** @type {RosterRecord} */ (/** @type {unknown} */ (Object.fromEntries(['type', 'host', 'fp', 'cert', 'at', 'by', 'dk', 'sig'].filter(k => o[k] !== undefined).map(k => [k, o[k]]))))
      this.records.push(clean)
      this.sigs = new Set(this.sigs).add(clean.sig)
      added = true
    }
    if (!added) return false
    this.replay()
    return this.sigs.size !== before.size || [...this.sigs].some(s => !before.has(s))
  }

  /** Recompute membership. Only records that take effect are kept, so nobody can fill the roster
   * with records that don't count (from outsiders, or naming non-members). */
  replay() {
    this.records.sort((a, b) => a.at - b.at || (a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0))
    /** @type {Map<string, Member>} */
    const members = new Map()
    /** @type {Map<string, Member>} */
    const byHost = new Map()
    /** @type {Map<string, { at: number, by: string }>} */
    const removed = new Map()
    /** @type {string[]} */
    const dks = []
    /** @param {crypto.KeyObject} pub @param {RosterRecord} r */
    const ok = (pub, r) => {
      if (this.verified.has(r.sig)) return true
      if (!verifyRecord(pub, r)) return false
      this.verified.add(r.sig)
      return true
    }
    /** @type {RosterRecord[]} */
    const applied = []
    for (const r of this.records) {
      if (r.type === 'add') {
        if (!r.host || !r.cert || members.has(r.fp) || removed.has(r.fp)) continue
        let x509, host
        try { x509 = new crypto.X509Certificate(Buffer.from(r.cert, 'base64')); host = normHost(r.host) } catch { continue }
        if (host !== r.host || fingerprint(x509) !== r.fp || byHost.has(host)) continue
        const genesis = r.by === r.fp
        if (genesis && (r.fp !== this.net || members.size || removed.size)) continue
        const signer = genesis ? x509.publicKey : members.get(r.by)?.publicKey
        if (!signer || !ok(signer, r)) continue
        const m = { host, fp: r.fp, pem: x509.toString(), publicKey: x509.publicKey, at: r.at, by: r.by }
        members.set(r.fp, m)
        byHost.set(host, m)
        if (genesis && r.dk) dks.push(r.dk)
        applied.push(r)
      } else {
        const signer = members.get(r.by)
        const target = members.get(r.fp)
        if (!signer || !target || !ok(signer.publicKey, r)) continue
        members.delete(r.fp)
        byHost.delete(target.host)
        removed.set(r.fp, { at: r.at, by: r.by })
        if (r.dk) dks.push(r.dk)
        applied.push(r)
      }
    }
    Object.assign(this, { members, byHost, removed, dks, records: applied, sigs: new Set(applied.map(r => r.sig)) })
  }

  /** A timestamp later than every record we hold, so our records sort after what we've seen
   * even if our clock is behind the machine that added us. */
  nextAt() {
    return Math.max(Date.now(), ...this.records.map(r => r.at + 1))
  }

  /**
   * Sign and merge a record adding `host` (whose certificate is `pem`).
   * @param {import('./types.js').Identity} me @param {string} host @param {string} pem
   */
  add(me, host, pem) {
    /** @type {Omit<RosterRecord, 'sig'>} */
    const r = { type: 'add', host, fp: fingerprint(pem), cert: certDer(pem), at: this.nextAt(), by: me.fp }
    const rec = { ...r, sig: signRecord(me.key, r) }
    this.merge([rec])
    return rec
  }

  /** Sign and merge a record removing `fp`; rotates the discovery key. @param {import('./types.js').Identity} me @param {string} fp */
  remove(me, fp) {
    /** @type {Omit<RosterRecord, 'sig'>} */
    const r = { type: 'remove', fp, at: this.nextAt(), by: me.fp, dk: newDiscoveryKey() }
    const rec = { ...r, sig: signRecord(me.key, r) }
    this.merge([rec])
    return rec
  }

  /** A new network whose only member is `me`, called `host`. @param {import('./types.js').Identity} me @param {string} host */
  static genesis(me, host, /** @type {string | null} */ file = null) {
    /** @type {Omit<RosterRecord, 'sig'>} */
    const r = { type: 'add', host, fp: me.fp, cert: certDer(me.cert), at: Date.now(), by: me.fp, dk: newDiscoveryKey() }
    return new Roster({ net: me.fp, records: [{ ...r, sig: signRecord(me.key, r) }] }, file)
  }
}
