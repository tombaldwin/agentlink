// Network membership: a set of signed records that members exchange and merge.
//
//   add    {host, fp, cert}  signed by a current member ("by"); the founding machine signs its own
//   remove {fp, seen}        signed by a member that joined before the one removed; carries the
//                            next discovery key, and lists the removed machine's records the
//                            remover had (`seen`)
//
// Every member computes the same membership from the same set of records by replaying them in
// (at, sig) order: a record counts only if its signer is a member at that point.
//
// Seniority: machines are ranked in the order they joined (the founder first), and a machine can
// remove only machines ranked after it. So two machines can never remove each other.
//
// A removal is final. Timestamps are chosen by the signer, so a removed machine could sign records
// dated before its removal; instead, a removed machine's records count only if its remover listed
// them in `seen`. Anything else it signs is void, whatever its date. A removed key is gone for good
// (re-adding a machine means a new key). The set of records only grows, so merging converges in any
// order and offline machines catch up on their next hello.
import fs from 'node:fs'
import crypto from 'node:crypto'
import { signRecord, verifyRecord, newDiscoveryKey, recId } from './crypto.js'
import { fingerprint, certDer } from './cert.js'
import { normHost } from './config.js'

const MAX_RECORDS = 5000
const MAX_FUTURE_MS = 3600_000     // a record stamped further ahead than this is refused (bad clock)
const MAX_SEEN = 2000
const MAX_PER_SIGNER = 500             // records kept per signing key (a removed machine can't flood the roster)
// a replaced discovery key still opens other members' gates for this long, so a machine that was
// offline during a removal can catch up; after that it needs a new invite
export const DK_GRACE_MS = 30 * 86400_000

/** @typedef {import('./types.js').RosterRecord} RosterRecord */
/** @typedef {import('./types.js').Member} Member */

/** @param {any} r @returns {r is RosterRecord} */
function wellFormed(r) {
  if (!r || typeof r !== 'object') return false
  if (r.type !== 'add' && r.type !== 'remove') return false
  if (typeof r.fp !== 'string' || r.fp.length > 64 || typeof r.by !== 'string' || r.by.length > 64) return false
  if (typeof r.sig !== 'string' || r.sig.length > 200 || !Number.isSafeInteger(r.at) || r.at < 0) return false
  if (r.dk !== undefined && (typeof r.dk !== 'string' || r.dk.length > 64)) return false
  if (r.seen !== undefined && (r.type !== 'remove' || !Array.isArray(r.seen) || r.seen.length > MAX_SEEN || !r.seen.every((/** @type {unknown} */ x) => typeof x === 'string' && x.length <= 32))) return false
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
    /** @type {number[]} when each discovery key was introduced */
    this.dkAt = []
    /** @type {Set<string>} keys added by a machine that was removed before the add was seen: never members */
    this.dropped = new Set()
    /** @type {Map<string, { host: string, pem: string, publicKey: crypto.KeyObject } | null>} parsed add records, by signature */
    this.parsed = new Map()
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

  /** Discovery keys that open this node's gate: the current one, and ones replaced recently. */
  gateDks(now = Date.now()) {
    return this.dks.filter((_, i) => i === this.dks.length - 1 || this.dkAt[i + 1] > now - DK_GRACE_MS)
  }

  /** May member `by` remove member `fp`? (only machines that joined after it) @param {string} by @param {string} fp */
  canRemove(by, fp) {
    const a = this.members.get(by), b = this.members.get(fp)
    return !!a && !!b && a.rank < b.rank
  }

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
      const clean = /** @type {RosterRecord} */ (/** @type {unknown} */ (Object.fromEntries(['type', 'host', 'fp', 'cert', 'at', 'by', 'dk', 'seen', 'sig'].filter(k => o[k] !== undefined).map(k => [k, o[k]]))))
      this.records.push(clean)
      this.sigs = new Set(this.sigs).add(clean.sig)
      added = true
    }
    if (!added) return false
    this.replay()
    return this.sigs.size !== before.size || [...this.sigs].some(s => !before.has(s))
  }

  /**
   * Recompute membership: a pure function of the set of records, so every node that holds the same
   * records agrees, whatever order they arrived in.
   *
   * Machines are settled in joining order. Whether a machine is removed depends only on records
   * signed by machines that joined before it (only they can remove it), and those are settled
   * first. So nothing is ever decided twice, and a single pass suffices.
   *
   * - A removal by an earlier machine always stands, even if its signer is removed too: a removal
   *   can't be undone by removing the remover (concurrent removals all stand).
   * - Any other record signed by a removed machine (an add) counts only if every removal of that
   *   machine lists it in `seen`. So a removed machine can't add machines, backdated or not.
   * - The discovery key is the newest one introduced by a machine that is still a member, so a
   *   key made by a removed machine is never current.
   *
   * Records signed by keys outside the network (no chain of adds from the founder) are dropped.
   * The rest are kept, even when they don't count, so a node that receives them later reaches the
   * same result; a key that isn't a member keeps at most MAX_PER_SIGNER of them.
   */
  replay() {
    this.records.sort((a, b) => a.at - b.at || (a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0))
    /** @param {crypto.KeyObject} pub @param {RosterRecord} r */
    const ok = (pub, r) => {
      if (this.verified.has(r.sig)) return true
      if (!verifyRecord(pub, r)) return false
      this.verified.add(r.sig)
      return true
    }
    /** @param {RosterRecord} r */
    const parse = r => {
      let c = this.parsed.get(r.sig)
      if (c === undefined) {
        c = null
        try {
          const x509 = new crypto.X509Certificate(Buffer.from(String(r.cert), 'base64'))
          const host = normHost(String(r.host))
          if (host === r.host && fingerprint(x509) === r.fp) c = { host, pem: x509.toString(), publicKey: x509.publicKey }
        } catch {}
        this.parsed.set(r.sig, c)
      }
      return c
    }

    /** @type {Map<string, RosterRecord[]>} target fp -> remove records naming it */
    const removesOf = new Map()
    for (const r of this.records) if (r.type === 'remove') { if (!removesOf.has(r.fp)) removesOf.set(r.fp, []); removesOf.get(r.fp)?.push(r) }

    /** @type {Map<string, Member>} every machine that joined (ranked), removed or not */
    const ranked = new Map()
    /** @type {Map<string, { removed: false } | { removed: true, at: number, by: string, seen: Set<string>[] }>} */
    const statusMemo = new Map()
    /** The removals that stand against `fp` (by machines ranked before it). @param {string} fp */
    const status = fp => {
      const known = statusMemo.get(fp)
      if (known) return known
      const m = ranked.get(fp)
      /** @type {RosterRecord[]} */
      const stand = []
      if (m) for (const r of removesOf.get(fp) || []) {
        const s = ranked.get(r.by)
        if (s && s.rank < m.rank && ok(s.publicKey, r)) stand.push(r)
      }
      const st = stand.length
        ? { removed: /** @type {const} */ (true), at: stand[0].at, by: stand[0].by, seen: stand.map(r => new Set(r.seen ?? [])) }
        : { removed: /** @type {const} */ (false) }
      statusMemo.set(fp, st)
      return st
    }
    /** Does `r`, signed by ranked machine `by`, count? @param {string} by @param {RosterRecord} r */
    const counts = (by, r) => {
      const st = status(by)
      return !st.removed || st.seen.every(seen => seen.has(recId(r.sig)))
    }

    /** @type {Map<string, Member>} host -> the machine holding that name */
    const nameHolder = new Map()
    /** @type {Set<string>} keys whose add didn't count because their adder was removed first */
    const dropped = new Set()
    /** @type {Set<string>} keys with a chain of adds from the founder (whether or not they count) */
    const chained = new Set()
    let rank = 0
    for (const r of this.records) {
      if (r.type !== 'add') continue
      const c = parse(r)
      if (!c) continue
      const genesis = r.by === r.fp
      if (genesis) {
        if (r.fp !== this.net || chained.size || !ok(c.publicKey, r)) continue
      } else {
        const s = ranked.get(r.by)
        if (!s || !ok(s.publicKey, r)) continue
      }
      chained.add(r.fp)
      if (ranked.has(r.fp)) continue
      if (!genesis && !counts(r.by, r)) { dropped.add(r.fp); continue }
      const holder = nameHolder.get(c.host)
      if (holder && !status(holder.fp).removed) continue            // the name is taken
      const m = { host: c.host, fp: r.fp, pem: c.pem, publicKey: c.publicKey, at: r.at, by: r.by, rank: rank++ }
      ranked.set(r.fp, m)
      nameHolder.set(c.host, m)
    }

    /** @type {Map<string, Member>} */
    const members = new Map()
    /** @type {Map<string, Member>} */
    const byHost = new Map()
    /** @type {Map<string, { at: number, by: string }>} */
    const removed = new Map()
    for (const m of ranked.values()) {
      const st = status(m.fp)
      if (st.removed) removed.set(m.fp, { at: st.at, by: st.by })
      else { members.set(m.fp, m); byHost.set(m.host, m) }
    }
    for (const fp of ranked.keys()) dropped.delete(fp)

    /** @type {string[]} */
    const dks = []
    /** @type {number[]} */
    const dkAt = []
    for (const r of this.records) {
      if (!r.dk || !members.has(r.by)) continue                    // never a key made by a removed machine
      const standing = r.type === 'add' ? r.by === r.fp && ranked.has(r.fp)
        : status(r.fp).removed && ranked.has(r.fp) && /** @type {Member} */ (ranked.get(r.by)).rank < /** @type {Member} */ (ranked.get(r.fp)).rank && this.verified.has(r.sig)
      if (standing) { dks.push(r.dk); dkAt.push(r.at) }
    }

    // keep what's signed by keys in the network; at most MAX_PER_SIGNER each from keys that are no
    // longer (or never became) members, so a removed machine can't flood the roster
    /** @type {Map<string, number>} */
    const per = new Map()
    const kept = this.records.filter(r => {
      if (!chained.has(r.by)) return false
      if (members.has(r.by)) return true
      const n = (per.get(r.by) || 0) + 1
      per.set(r.by, n)
      return n <= MAX_PER_SIGNER
    })
    Object.assign(this, { members, byHost, removed, dropped, dks, dkAt, records: kept, sigs: new Set(kept.map(r => r.sig)) })
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

  /**
   * Sign and merge a record removing `fp` (which must have joined after us); rotates the discovery
   * key, and lists the removed machine's records we have: nothing else it signs will count.
   * @param {import('./types.js').Identity} me @param {string} fp
   */
  remove(me, fp) {
    if (!this.canRemove(me.fp, fp)) throw new Error('only a machine that joined earlier can remove this one')
    /** @type {Omit<RosterRecord, 'sig'>} */
    const r = { type: 'remove', fp, at: this.nextAt(), by: me.fp, dk: newDiscoveryKey(), seen: this.records.filter(x => x.by === fp).map(x => recId(x.sig)) }
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
