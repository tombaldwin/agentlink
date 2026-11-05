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
import { signRecord, verifyRecord, newDiscoveryKey, recId, recKey } from './crypto.js'
import { fingerprint, certDer } from './cert.js'
import { normHost, writeAtomic } from './config.js'

// New records stop being taken in at this size, so that a roster always fits in one hello (4 MB):
// if it didn't, this node's removals would never reach anyone. The limit doesn't apply to loading our
// own file, so nothing already held is lost, or to a removal that must get in (see mustTake), so a
// full roster can always be cleaned up. Those are small and there is at most one per machine, so a
// roster at its very worst (some 2000 machines, each removed) comes to about 2.5 MB.
const MAX_ROSTER_BYTES = 1500 << 10
const MAX_FUTURE_MS = 3600_000     // a record stamped further ahead than this is refused (bad clock)
const MAX_SEEN = 4000                  // more than a full roster's adds, so no machine can make itself impossible to remove
const SEEN_SLACK = 8                   // ids a removal may list beyond the adds we hold, and still count as small
const MAX_DROPPED = 50                 // adds that didn't count, kept per removed machine (so their keys stay known as dropped)
// a replaced discovery key still opens other members' gates for this long, so a machine that was
// offline during a removal can catch up; after that it needs a new invite
export const DK_GRACE_MS = 14 * 86400_000

/** @typedef {import('./types.js').RosterRecord} RosterRecord */
/** @typedef {import('./types.js').Member} Member */

const ASCII_KEY = /^[\w+/=-]+$/        // fingerprints and signatures: base64, in either alphabet

/** @param {any} r @returns {r is RosterRecord} */
function wellFormed(r) {
  if (!r || typeof r !== 'object') return false
  if (r.type !== 'add' && r.type !== 'remove') return false
  if (typeof r.fp !== 'string' || !ASCII_KEY.test(r.fp) || r.fp.length > 64 || typeof r.by !== 'string' || !ASCII_KEY.test(r.by) || r.by.length > 64) return false
  if (typeof r.sig !== 'string' || !ASCII_KEY.test(r.sig) || r.sig.length > 200 || !Number.isSafeInteger(r.at) || r.at < 0) return false
  if (r.dk !== undefined && (typeof r.dk !== 'string' || r.dk.length !== 44 || Buffer.from(r.dk, 'base64').length !== 32)) return false
  if (r.seen !== undefined && (r.type !== 'remove' || !Array.isArray(r.seen) || r.seen.length > MAX_SEEN || !r.seen.every((/** @type {unknown} */ x) => typeof x === 'string' && /^[\w-]{22}$/.test(x)))) return false
  // strict base64: the decoder skips anything else, so a good certificate could carry padding
  if (r.type === 'add' && (typeof r.host !== 'string' || r.host.length > 253 || typeof r.cert !== 'string' || r.cert.length > 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(r.cert))) return false
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
    /** @type {Set<string>} ids of the records held (see recId) */
    this.ids = new Set()
    /** @type {Set<string>} records whose signature checked out (see recKey) */
    this.verified = new Set()
    /** @type {Map<string, Member>} fp -> member */
    this.members = new Map()
    /** @type {Map<string, Member>} host -> member */
    this.byHost = new Map()
    /** @type {Map<string, Member>} every machine that joined, removed or not */
    this.ranked = new Map()
    /** @type {Map<string, { at: number, by: string }>} */
    this.removed = new Map()
    /** @type {string[]} discovery keys, oldest first */
    this.dks = []
    /** @type {number[]} when each discovery key was introduced */
    this.dkAt = []
    /** @type {Set<string>} keys added by a machine that was removed before the add was seen: never members */
    this.dropped = new Set()
    /** @type {Map<string, { host: string, pem: string, publicKey: crypto.KeyObject } | null>} parsed add records (see recKey) */
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
    writeAtomic(this.file, JSON.stringify({ net: this.net, records: this.records }, null, 1) + '\n', 0o600)
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
   * Must this removal get in even when the roster is full? It takes a current member off the network,
   * by a machine that joined before it, so refusing it would leave the machine on here and off
   * elsewhere, and a flooder could keep itself on. It must also be small: a real removal lists only
   * adds its target signed, while one padded with made-up ids would fill the roster past the limit.
   * @param {RosterRecord} r
   */
  mustTake(r) {
    const s = this.ranked.get(r.by), t = this.ranked.get(r.fp)
    if (r.type !== 'remove' || !s || !t || s.rank >= t.rank || !this.members.has(r.fp)) return false
    return (r.seen?.length ?? 0) <= this.records.filter(x => x.type === 'add' && x.by === r.fp).length + SEEN_SLACK
  }

  /**
   * Add records we were sent (or made). Returns true if the set of records changed.
   * @param {unknown} list @param {{ trustClock?: boolean }} [opts]
   */
  merge(list, { trustClock = false } = {}) {
    let added = false
    const before = this.ids
    let bytes = trustClock ? 0 : Buffer.byteLength(JSON.stringify(this.records))
    /** @type {Set<string>} machines taken off past the limit in this batch: once is enough */
    const over = new Set()
    for (const r of Array.isArray(list) ? list : []) {
      if (!wellFormed(r) || this.ids.has(recId(r))) continue
      if (!trustClock && r.at > Date.now() + MAX_FUTURE_MS) continue
      const o = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (r))
      const clean = /** @type {RosterRecord} */ (/** @type {unknown} */ (Object.fromEntries(['type', 'host', 'fp', 'cert', 'at', 'by', 'dk', 'seen', 'sig'].filter(k => o[k] !== undefined).map(k => [k, o[k]]))))
      const size = Buffer.byteLength(JSON.stringify(clean))
      if (!trustClock && bytes + size > MAX_ROSTER_BYTES) {
        if (over.has(clean.fp) || !this.mustTake(clean)) continue
        over.add(clean.fp)
      }
      bytes += size
      this.records.push(clean)
      added = true
    }
    if (!added) return false
    this.replay()
    return this.ids.size !== before.size || [...this.ids].some(s => !before.has(s))
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
   * Records are kept if they could ever count: everything signed by current members, and what
   * counts of what removed machines signed. Anything else can never count, whatever arrives later
   * (removals only accumulate), so every node reaches the same result.
   */
  replay() {
    // ties go by content: which encoding of a signature a node happened to get must not decide anything
    /** @type {Map<RosterRecord, string>} */
    const idOf = new Map(this.records.map(r => [r, recId(r)]))
    const tie = (/** @type {RosterRecord} */ a, /** @type {RosterRecord} */ b) => { const x = /** @type {string} */ (idOf.get(a)), y = /** @type {string} */ (idOf.get(b)); return x < y ? -1 : x > y ? 1 : 0 }
    this.records.sort((a, b) => a.at - b.at || tie(a, b))
    /** @param {crypto.KeyObject} pub @param {RosterRecord} r */
    const ok = (pub, r) => {
      const k = recKey(r)
      if (this.verified.has(k)) return true
      if (!verifyRecord(pub, r)) return false
      this.verified.add(k)
      return true
    }
    /** @param {RosterRecord} r */
    const parse = r => {
      const k = recKey(r)
      let c = this.parsed.get(k)
      if (c === undefined) {
        c = null
        try {
          const x509 = new crypto.X509Certificate(Buffer.from(String(r.cert), 'base64'))
          const host = normHost(String(r.host))
          if (host === r.host && fingerprint(x509) === r.fp) c = { host, pem: x509.toString(), publicKey: x509.publicKey }
        } catch {}
        this.parsed.set(k, c)
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
      /** @type {Set<string>} */
      const signers = new Set()
      // one removal per signer counts: its earliest (so signing more can't change the outcome)
      if (m) for (const r of removesOf.get(fp) || []) {
        const s = ranked.get(r.by)
        if (s && s.rank < m.rank && !signers.has(r.by) && ok(s.publicKey, r)) { stand.push(r); signers.add(r.by) }
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
      return !st.removed || st.seen.every(seen => seen.has(recId(r)))
    }

    /** @type {Map<string, Member>} host -> the machine holding that name */
    const nameHolder = new Map()
    /** @type {Set<string>} keys whose add didn't count because their adder was removed first */
    const dropped = new Set()
    let rank = 0
    for (const r of this.records) {
      if (r.type !== 'add') continue
      const c = parse(r)
      if (!c) continue
      const genesis = r.by === r.fp
      if (genesis) {
        if (r.fp !== this.net || ranked.size || !ok(c.publicKey, r)) continue
      } else {
        const s = ranked.get(r.by)
        if (!s || !ok(s.publicKey, r)) continue
      }
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

    // Only records whose signature checks out are kept, whoever they claim to be from. Of those: what
    // current members signed, and of what removed machines signed only what counts (adds every
    // remover had seen). Copies of a record (the same content, signed differently) are kept once. A removal is kept if it is the first by its signer for a
    // target it can remove. Nothing else from a removed or dropped key can ever count, whatever
    // arrives later, so dropping it keeps every node's result the same, and a removed machine can't
    // fill the roster. Adds that didn't count are kept too (at most MAX_DROPPED per removed machine),
    // so their keys stay known as dropped: messages from them are refused instead of retried.
    /** @type {Set<string>} */
    const firstRemove = new Set()
    /** @type {Map<string, number>} */
    const droppedKept = new Map()
    /** @type {Set<string>} */
    const copies = new Set()
    const once = (/** @type {RosterRecord} */ r) => { const id = recId(r); if (copies.has(id)) return false; copies.add(id); return true }
    const kept = this.records.filter(r => {
      const s = ranked.get(r.by)
      if (!s) {                                                                 // (the founder's genesis)
        const c = r.type === 'add' && r.by === r.fp && r.fp === this.net ? parse(r) : null
        return !!c && ok(c.publicKey, r) && once(r)
      }
      if (!ok(s.publicKey, r) || !once(r)) return false
      if (r.type === 'add') {
        if (!parse(r)) return false                                             // can never count
        if (members.has(r.by)) return true
        if (ranked.get(r.fp)?.by === r.by && counts(r.by, r)) return true
        if (!dropped.has(r.fp) || ranked.has(r.fp)) return false
        const n = (droppedKept.get(r.by) || 0) + 1
        droppedKept.set(r.by, n)
        return n <= MAX_DROPPED
      }
      // the removal that counts for this signer and target (the only one status() looks at)
      const t = ranked.get(r.fp)
      if (t && s.rank < t.rank) {
        if (firstRemove.has(`${r.by} ${r.fp}`)) return false
        firstRemove.add(`${r.by} ${r.fp}`)
        return true
      }
      // a machine it can't remove stays that way; one we haven't heard of yet may turn out otherwise
      return !t && members.has(r.by)
    })

    /** @type {string[]} */
    const dks = []
    /** @type {number[]} */
    const dkAt = []
    for (const r of kept) {
      const signer = members.get(r.by)
      if (!r.dk || !signer) continue                               // never a key made by a removed machine
      const target = ranked.get(r.fp)
      // the founder's first key, and the keys in removals that stand: no other record brings one in
      if (r.type === 'add' ? r.by === r.fp && r.fp === this.net : !!target && status(r.fp).removed && signer.rank < target.rank) {
        dks.push(r.dk)
        dkAt.push(r.at)
      }
    }
    this.parsed = new Map(kept.filter(r => r.type === 'add').map(r => [recKey(r), this.parsed.get(recKey(r)) ?? null]))
    Object.assign(this, { members, byHost, ranked, removed, dropped, dks, dkAt, records: kept, ids: new Set(kept.map(recId)) })
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
    if (!this.ids.has(recId(rec))) throw new Error('the network has reached its size limit: remove a machine that is flooding it, or start a new network')
    return rec
  }

  /**
   * Sign and merge a record removing `fp` (which must have joined after us); rotates the discovery
   * key, and lists the removed machine's records we have: nothing else it signs will count.
   * @param {import('./types.js').Identity} me @param {string} fp
   */
  remove(me, fp) {
    if (!this.canRemove(me.fp, fp)) throw new Error('only a machine that joined earlier can remove this one')
    // the adds that made machines, once each (records are in replay order, so the first is the one that counted)
    /** @type {Map<string, string>} */
    const made = new Map()
    for (const x of this.records) {
      if (x.by === fp && x.type === 'add' && !made.has(x.fp) && (this.members.get(x.fp)?.by === fp || this.removed.has(x.fp))) made.set(x.fp, recId(x))
    }
    /** @type {Omit<RosterRecord, 'sig'>} */
    const r = { type: 'remove', fp, at: this.nextAt(), by: me.fp, dk: newDiscoveryKey(), seen: [...made.values()] }
    const rec = { ...r, sig: signRecord(me.key, r) }
    this.merge([rec])
    if (!this.ids.has(recId(rec)) || this.members.has(fp)) throw new Error('the removal could not be recorded')
    return rec
  }

  /** A new network whose only member is `me`, called `host`. @param {import('./types.js').Identity} me @param {string} host */
  static genesis(me, host, /** @type {string | null} */ file = null) {
    /** @type {Omit<RosterRecord, 'sig'>} */
    const r = { type: 'add', host, fp: me.fp, cert: certDer(me.cert), at: Date.now(), by: me.fp, dk: newDiscoveryKey() }
    return new Roster({ net: me.fp, records: [{ ...r, sig: signRecord(me.key, r) }] }, file)
  }
}
