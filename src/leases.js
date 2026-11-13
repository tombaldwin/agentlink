// Leases: an agent's claim on a shared resource outside git (a test database, a checkout, a port, a
// deploy), so other agents can see it's in use and wait for it instead of colliding.
//
// A resource is named like an agent, `testdb@buffy.local`, and the node of the machine it names is
// the only one that keeps its leases ("the authority"). Nothing is replicated and nothing needs a
// consensus: one node decides each claim, one at a time. If that machine is offline its resources
// can't be claimed, which is fine: nobody can use them either. Leases are advisory: a tool that
// wants to enforce them asks the node (GET /local/lease) before acting.
//
// A lease ends at whichever comes first:
//   - its holder releases it
//   - it isn't renewed in time (its ttl). A renewal only ever extends a lease that still exists: a
//     lease that has ended is never taken again except by a new claim. A session's lease is renewed
//     by its node while the session itself is active (its heartbeat after each tool call, its turns,
//     its own claims), and a `natter lease run` lease while its command runs
//   - its hard cap, set when it was taken, whatever renews it
//   - its holder's session has gone: the authority asks the holder's machine, and if that machine
//     can't be reached the lease is kept until its ttl (it fails safe). A session that comes back
//     under the same name on the same machine, before then, keeps its leases (an adapter restart)
//   - a person breaks it (`natter lease break`, never an agent tool); the holder is told
//
// A session's lease is held by the session (its id), not just its name: a new session in the same
// folder can't renew or release it without saying it's taking it over. A terminal's claims and
// `lease run`'s are held by processes, which never count as the same holder as a session. Times are
// kept on the authority's clock and reported as seconds left, so clocks that disagree don't matter,
// and expiry is worked out when a lease is read, so a machine that sleeps needs no timers to fire.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { normHost, sanitizeName } from './config.js'

export const DEFAULT_TTL_MS = 15 * 60_000
export const MAX_TTL_MS = 4 * 3600_000
export const MAX_CAP_MS = 4 * 3600_000
// with a session missing from its machine's list for this long, its leases end (a reconnect is quicker)
export const GONE_GRACE_MS = Number(process.env.NATTERMATIC_LEASE_GRACE_MS) || 60_000
// the shortest ttl (the end-to-end tests make it shorter, to watch leases run out)
export const MIN_TTL_MS = Number(process.env.NATTERMATIC_LEASE_MIN_MS) || 60_000
const MAX_HELD = 64                   // leases one holder may have on one machine
const MAX_WAITERS = 50                // agents waiting to hear one resource is free
export const MAX_NOTE = 500
export const MAX_RESOURCE = 200
const RETRY_MS = 60_000               // an authority that couldn't be reached is asked again after this
export const SID = /^[\w-]{16,64}$/

/** @typedef {{ host: string, name: string, sid: string, kind: 'session' | 'process' }} Holder */
/**
 * @typedef {{ resource: string, holder_host: string, holder_name: string, holder_sid: string, kind: string,
 *   note: string, id: string, acquired_at: number, expires_at: number, cap_at: number, ttl_ms: number }} LeaseRow
 */
/** @typedef {{ authority: string, resource: string, name: string, sid: string, kind: string, ttl_ms: number, renewed_at: number }} HeldRow */

/** A session's id as leases know it: never its token, which reclaims its name. @param {string} token */
export const sessionId = token => token ? crypto.createHash('sha256').update(`nattermatic-session:${token}`).digest('base64url').slice(0, 22) : ''

/**
 * "testdb@buffy" | "testdb" -> { name, host }. Resource names keep a few more characters than agent
 * names (a path or a port: `checkout:web-site`, `port:5432`), and are compared lower-cased.
 * @param {unknown} input @param {string} selfHost
 */
export function parseResource(input, selfHost) {
  const a = String(input ?? '').trim()
  if (a.length > MAX_RESOURCE + 300) throw new Error(`resource names are at most ${MAX_RESOURCE} characters`)
  const i = a.lastIndexOf('@')
  const name = (i < 0 ? a : a.slice(0, i)).toLowerCase().replace(/[^a-z0-9._:/+-]+/g, '-').replace(/^[-.:/]+/, '').replace(/[-.:/]+$/, '')
  if (!name) throw new Error('a resource name is needed, such as testdb or testdb@laptop.local')
  if (name.length > MAX_RESOURCE) throw new Error(`resource names are at most ${MAX_RESOURCE} characters`)
  return { name, host: i < 0 ? selfHost : normHost(a.slice(i + 1)) }
}

/** @param {number} ms */
export function fmtLeft(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 90) return `${s}s`
  const m = Math.round(s / 60)
  return m < 90 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`
}

/**
 * A lease as another machine described it, rebuilt from checked parts: what another machine writes
 * must not reach a session as nattermatic's own words. Its note is the holder's own text, shown
 * quoted and marked as theirs. null if it doesn't add up.
 * @param {any} l @param {string} authority
 */
export function cleanLease(l, authority) {
  if (!l || typeof l !== 'object') return null
  let res, holder
  try {
    res = parseResource(String(l.resource ?? ''), authority)
    const h = String(l.holder ?? ''), at = h.lastIndexOf('@')
    if (at < 1) return null
    holder = `${sanitizeName(h.slice(0, at))}@${normHost(h.slice(at + 1))}`
  } catch { return null }
  const n = (/** @type {unknown} */ v) => Number.isSafeInteger(v) && /** @type {number} */ (v) >= 0 ? /** @type {number} */ (v) : 0
  return {
    resource: `${res.name}@${authority}`, holder, kind: l.kind === 'process' ? 'process' : 'session',
    note: String(l.note ?? '').slice(0, MAX_NOTE), left_s: n(l.left_s), cap_s: n(l.cap_s), held_s: n(l.held_s), ttl_s: n(l.ttl_s),
  }
}

/** @param {any} l */
export function formatLease(l) {
  return `held by ${l.holder}${l.kind === 'process' ? ' (a terminal or a running command)' : ''} for ${fmtLeft(l.held_s * 1000)}, ${fmtLeft(l.left_s * 1000)} left unless renewed${l.note ? `; the holder's note: ${JSON.stringify(l.note)}` : ''}`
}
/** @param {any} r */
export function formatLeases(r) {
  const lines = r.leases?.length ? r.leases.map((/** @type {any} */ l) => `- ${l.resource}: ${formatLease(l)}`) : [`No leases on ${r.host}'s resources.`]
  if (r.held?.length) lines.push('', 'Held by agents on this machine:', ...r.held.map((/** @type {any} */ h) => `- ${h.resource} (${h.holder})`))
  return lines.join('\n')
}

/** @param {import('node:sqlite').DatabaseSync} db */
export function leaseTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS leases(
      resource TEXT PRIMARY KEY, holder_host TEXT NOT NULL, holder_name TEXT NOT NULL, holder_sid TEXT NOT NULL,
      kind TEXT NOT NULL, note TEXT NOT NULL, id TEXT NOT NULL,
      acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, cap_at INTEGER NOT NULL, ttl_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS lease_waiters(
      resource TEXT NOT NULL, host TEXT NOT NULL, name TEXT NOT NULL, added_at INTEGER NOT NULL,
      PRIMARY KEY(resource, host, name));
    CREATE TABLE IF NOT EXISTS held(
      authority TEXT NOT NULL, resource TEXT NOT NULL, name TEXT NOT NULL, sid TEXT NOT NULL, kind TEXT NOT NULL,
      ttl_ms INTEGER NOT NULL, renewed_at INTEGER NOT NULL, PRIMARY KEY(authority, resource));
  `)
}

/**
 * The lease side of a node.
 * @param {{
 *   db: import('node:sqlite').DatabaseSync, host: () => string, dir: string,
 *   sessions: Map<string, { token: string, owner: number, lastActive: number }>,
 *   call: (host: string, method: string, p: string, obj?: unknown, o?: { timeout?: number }) => Promise<any>,
 *   notify: (to: string, body: string) => void,
 *   log: (...a: unknown[]) => void, now?: () => number,
 * }} o
 */
export function createLeases({ db, host, dir, sessions, call, notify, log, now = Date.now }) {
  leaseTables(db)
  const q = {
    get: db.prepare(`SELECT * FROM leases WHERE resource=?`),
    all: db.prepare(`SELECT * FROM leases ORDER BY resource`),
    put: db.prepare(`INSERT OR REPLACE INTO leases(resource,holder_host,holder_name,holder_sid,kind,note,id,acquired_at,expires_at,cap_at,ttl_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)`),
    renew: db.prepare(`UPDATE leases SET expires_at=?, ttl_ms=?, note=?, holder_name=? WHERE resource=? AND id=?`),
    rebind: db.prepare(`UPDATE leases SET holder_sid=?, holder_name=? WHERE resource=? AND holder_host=? AND holder_sid=?`),
    del: db.prepare(`DELETE FROM leases WHERE resource=? AND id=?`),
    count: db.prepare(`SELECT COUNT(*) AS n FROM leases WHERE holder_host=? AND holder_name=?`),
    wait: db.prepare(`INSERT OR IGNORE INTO lease_waiters(resource,host,name,added_at) VALUES (?,?,?,?)`),
    waiters: db.prepare(`SELECT host, name FROM lease_waiters WHERE resource=?`),
    nWaiters: db.prepare(`SELECT COUNT(*) AS n FROM lease_waiters WHERE resource=?`),
    unwait: db.prepare(`DELETE FROM lease_waiters WHERE resource=?`),
    hold: db.prepare(`INSERT OR REPLACE INTO held(authority,resource,name,sid,kind,ttl_ms,renewed_at) VALUES (?,?,?,?,?,?,?)`),
    renewed: db.prepare(`UPDATE held SET renewed_at=?, ttl_ms=? WHERE authority=? AND resource=? AND sid=?`),
    reheld: db.prepare(`UPDATE held SET sid=?, name=? WHERE sid=?`),
    heldOne: db.prepare(`SELECT * FROM held WHERE authority=? AND resource=?`),
    held: db.prepare(`SELECT * FROM held`),
    unhold: db.prepare(`DELETE FROM held WHERE authority=? AND resource=?`),
    unholdBy: db.prepare(`DELETE FROM held WHERE authority=? AND resource=? AND sid=?`),
  }
  /** @type {Map<string, number>} lease id -> when its holder's session was first found missing */
  const missing = new Map()
  /** @type {Map<string, number>} authority -> when it last couldn't be reached */
  const unreachable = new Map()

  // ---------------- the authority: leases on this machine's resources ----------------

  /** The lease on `resource`, ending it first if its time is up. @param {string} resource */
  function current(resource) {
    const row = /** @type {LeaseRow | undefined} */ (q.get.get(resource))
    if (!row) return null
    const t = now()
    if (t < row.expires_at && t < row.cap_at) return row
    end(row, t >= row.cap_at ? 'reached its hard cap' : 'ran out (it was not renewed)')
    return null
  }

  /** @param {LeaseRow} row */
  const view = row => ({
    resource: `${row.resource}@${host()}`, holder: `${row.holder_name}@${row.holder_host}`, kind: row.kind, note: row.note,
    left_s: Math.max(0, Math.round((Math.min(row.expires_at, row.cap_at) - now()) / 1000)),
    cap_s: Math.max(0, Math.round((row.cap_at - now()) / 1000)), held_s: Math.round((now() - row.acquired_at) / 1000),
    ttl_s: Math.round(row.ttl_ms / 1000),
  })

  /** Is `h` the holder of `row`? A session is its id (its name may change on a reconnect); a process its name and id. @param {LeaseRow} row @param {Holder} h */
  const holds = (row, h) => row.holder_host === h.host && row.kind === h.kind && row.holder_sid === h.sid && (h.kind === 'session' || row.holder_name === h.name)
  /** An earlier session of the same name, on the same machine. @param {LeaseRow} row @param {Holder} h */
  const earlierSelf = (row, h) => h.kind === 'session' && row.kind === 'session' && row.holder_host === h.host && row.holder_name === h.name && row.holder_sid !== h.sid

  /**
   * End a lease and tell whoever should hear: its holder (unless it let go) and anyone waiting for
   * it. @param {LeaseRow} row @param {string} why @param {{ tellHolder?: boolean }} [o]
   */
  function end(row, why, { tellHolder = true } = {}) {
    if (!q.del.run(row.resource, row.id).changes) return
    missing.delete(row.id)
    const res = `${row.resource}@${host()}`
    log(`lease on ${res} (${row.holder_name}@${row.holder_host}) ended: it ${why}`)
    if (tellHolder && row.kind === 'session') {
      notify(`${row.holder_name}@${row.holder_host}`, `nattermatic: your lease on ${res} has ended: it ${why}. You no longer hold it: if you still need ${res}, claim it again before using it, and check nothing changed meanwhile.`)
    }
    const waiters = /** @type {{ host: string, name: string }[]} */ (q.waiters.all(row.resource))
    q.unwait.run(row.resource)
    for (const w of waiters) notify(`${w.name}@${w.host}`, `nattermatic: ${res} is free now (${row.holder_name}@${row.holder_host}'s lease ${why}). It isn't yours yet: claim it if you still need it.`)
  }

  /**
   * A claim on one of this machine's resources. Claiming what you hold renews it.
   * @param {{ resource: string, holder: Holder, note?: unknown, ttl_ms?: unknown, cap_ms?: unknown, notify?: unknown, takeover?: unknown }} d
   */
  function claim(d) {
    const { resource, holder } = d
    const t = now()
    const ttl = clamp(d.ttl_ms, DEFAULT_TTL_MS, MIN_TTL_MS, MAX_TTL_MS)
    const note = String(d.note ?? '').slice(0, MAX_NOTE)
    const row = current(resource)
    if (row && holds(row, holder)) {
      q.renew.run(Math.min(t + ttl, row.cap_at), ttl, note || row.note, holder.name, resource, row.id)
      return { ok: true, renewed: true, lease: view(/** @type {LeaseRow} */ (q.get.get(resource))) }
    }
    if (row && !(earlierSelf(row, holder) && d.takeover === true)) {
      if (d.notify === true && Number(/** @type {any} */ (q.nWaiters.get(resource)).n) < MAX_WAITERS) q.wait.run(resource, holder.host, holder.name, t)
      return { ok: false, lease: view(row), same_name: earlierSelf(row, holder), notify: d.notify === true }
    }
    if (!row && Number(/** @type {any} */ (q.count.get(holder.host, holder.name)).n) >= MAX_HELD) throw Object.assign(new Error(`${holder.name}@${holder.host} already holds ${MAX_HELD} leases here`), { status: 429 })
    const cap = clamp(d.cap_ms, MAX_CAP_MS, MIN_TTL_MS, MAX_CAP_MS)
    // a takeover hands the lease on as it is (its cap, and anyone waiting for it, stay)
    const id = row?.id ?? crypto.randomUUID(), acquired = row?.acquired_at ?? t, capAt = row?.cap_at ?? t + cap
    q.put.run(resource, holder.host, holder.name, holder.sid, holder.kind, note, id, acquired, Math.min(t + ttl, capAt), capAt, ttl)
    missing.delete(id)
    log(`lease on ${resource}@${host()} ${row ? 'taken over' : 'taken'} by ${holder.name}@${holder.host}`)
    return { ok: true, renewed: false, lease: view(/** @type {LeaseRow} */ (q.get.get(resource))) }
  }

  /**
   * A renewal: extends the holder's lease if it still has it, and never takes one that has ended.
   * @param {{ resource: string, holder: Holder, ttl_ms?: unknown }} d
   */
  function renew({ resource, holder, ttl_ms }) {
    const row = current(resource)
    if (!row || !holds(row, holder)) return { ok: false, gone: true }
    const ttl = clamp(ttl_ms, row.ttl_ms, MIN_TTL_MS, MAX_TTL_MS)
    q.renew.run(Math.min(now() + ttl, row.cap_at), ttl, row.note, holder.name, resource, row.id)
    return { ok: true, lease: view(/** @type {LeaseRow} */ (q.get.get(resource))) }
  }

  /**
   * A session that came back under the same name after its adapter restarted keeps its leases, if
   * its earlier self has gone. @param {{ resource: string, holder: Holder, old_sid: string }} d
   */
  function rebind({ resource, holder, old_sid }) {
    const row = current(resource)
    if (!row || row.kind !== 'session' || row.holder_host !== holder.host || row.holder_name !== holder.name || row.holder_sid !== old_sid) return { ok: false }
    q.rebind.run(holder.sid, holder.name, resource, holder.host, old_sid)
    missing.delete(row.id)
    return { ok: true, lease: view(/** @type {LeaseRow} */ (q.get.get(resource))) }
  }

  /** @param {{ resource: string, holder: Holder, takeover?: unknown }} d */
  function release({ resource, holder, takeover }) {
    const row = current(resource)
    if (!row) return { ok: true, released: false }
    if (!holds(row, holder) && !(earlierSelf(row, holder) && takeover === true)) return { ok: false, lease: view(row), same_name: earlierSelf(row, holder) }
    end(row, 'was released', { tellHolder: false })
    return { ok: true, released: true }
  }

  /** A person, from a terminal on some machine of the network. @param {{ resource: string, by: string }} d */
  function breakLease({ resource, by }) {
    const row = current(resource)
    if (!row) return { ok: true, broken: false }
    end(row, `was broken by ${by}`)
    return { ok: true, broken: true, lease: view(row) }
  }

  function list() {
    return /** @type {LeaseRow[]} */ (q.all.all()).filter(r => current(r.resource)).map(view)
  }

  /**
   * End leases whose time is up, and those whose holder's session has gone. A holder's machine that
   * can't be reached keeps its leases until their ttl.
   */
  async function sweep() {
    const rows = /** @type {LeaseRow[]} */ (q.all.all()).filter(r => current(r.resource))
    /** @type {Map<string, LeaseRow[]>} */
    const byHost = new Map()
    for (const r of rows) if (r.kind === 'session') byHost.set(r.holder_host, [...(byHost.get(r.holder_host) || []), r])
    await Promise.all([...byHost].map(async ([h, rs]) => {
      /** @type {Set<string> | null} */
      let live = null
      if (h === host()) live = new Set([...sessions.values()].map(s => sessionId(s.token)))
      else {
        try {
          const r = await call(h, 'GET', '/v1/sessions', undefined, { timeout: 3000 })
          if (Array.isArray(r?.sids)) live = new Set(r.sids.map(String))
        } catch {}
      }
      if (!live) return
      for (const r of rs) {
        if (live.has(r.holder_sid)) { missing.delete(r.id); continue }
        const since = missing.get(r.id) ?? now()
        missing.set(r.id, since)
        if (now() - since < GONE_GRACE_MS) continue
        const still = current(r.resource)
        // its holder is told, by name: if it's back under that name (a restart), it hears
        if (still && still.id === r.id) end(still, 'ended because its session had gone')
      }
    }))
  }

  // ---------------- the holder side: leases this machine's sessions hold, anywhere ----------------

  /** Remember a lease one of this machine's holders has. @param {string} authority @param {string} resource @param {Holder} holder @param {number} ttl */
  function noteHeld(authority, resource, holder, ttl) {
    q.hold.run(authority, resource, holder.name, holder.sid, holder.kind, ttl, now())
    marks()
  }
  /** Forget a lease held here: `sid`'s, if given (another holder here may have it now). @param {string} authority @param {string} resource @param {string} [sid] */
  function forget(authority, resource, sid) { if (sid) q.unholdBy.run(authority, resource, sid); else q.unhold.run(authority, resource); marks() }
  /** @param {string} authority @param {string} resource @param {string} sid @param {number} ttl */
  function noteRenewed(authority, resource, sid, ttl) { q.renewed.run(now(), ttl, authority, resource, sid) }
  const heldRows = () => /** @type {HeldRow[]} */ (q.held.all())

  /**
   * Renew the leases of sessions that have themselves been active since they were last renewed, a
   * third of the way through their ttl. A lease the authority no longer has is forgotten, and so is
   * one whose holder has been gone longer than its ttl. `lease run` renews its own.
   * @param {(authority: string, body: Record<string, unknown>) => Promise<any>} ask
   */
  async function renewActive(ask) {
    const bySid = new Map([...sessions].map(([name, s]) => [sessionId(s.token), { name, s }]))
    for (const h0 of heldRows()) {
      // read again: it may have been released while an earlier renewal waited
      const h = /** @type {HeldRow | undefined} */ (q.heldOne.get(h0.authority, h0.resource))
      if (!h || h.sid !== h0.sid) continue
      // after a failed try, wait before asking that machine again: never so long a short lease runs out
      const waiting = now() - (unreachable.get(h.authority) ?? 0) < Math.min(RETRY_MS, h.ttl_ms / 6)
      const found = h.kind === 'session' ? bySid.get(h.sid) : null
      if (!found) {
        // its session restarted under the same name, and carrying it over failed then: try again
        const again = h.kind === 'session' ? sessions.get(h.name) : null
        if (again && !waiting) { await rebindRow(h, h.name, sessionId(again.token), ask); continue }
        if (now() - h.renewed_at > h.ttl_ms) forget(h.authority, h.resource, h.sid)
        continue
      }
      if (!(found.s.lastActive > h.renewed_at) || now() - h.renewed_at < h.ttl_ms / 3 || waiting) continue
      try {
        const r = await ask(h.authority, { op: 'renew', resource: h.resource, name: found.name, sid: h.sid, kind: 'session', ttl_ms: h.ttl_ms })
        unreachable.delete(h.authority)
        if (r?.ok) noteRenewed(h.authority, h.resource, h.sid, h.ttl_ms)
        else forget(h.authority, h.resource, h.sid)
      } catch (e) {
        unreachable.set(h.authority, now())
        log(`could not renew the lease on ${h.resource}@${h.authority}: ${/** @type {any} */ (e)?.message || e}`)
      }
    }
  }

  /**
   * A session connected with a new id under a name whose earlier session held leases and has gone:
   * the same agent, its adapter restarted. Its leases move to it.
   * @param {string} name @param {string} sid
   * @param {(authority: string, body: Record<string, unknown>) => Promise<any>} ask
   */
  async function carryOver(name, sid, ask) {
    const live = new Set([...sessions.values()].map(s => sessionId(s.token)))
    for (const h of heldRows()) {
      if (h.kind !== 'session' || h.name !== name || h.sid === sid || live.has(h.sid)) continue
      await rebindRow(h, name, sid, ask)
    }
    marks()
  }

  /**
   * Move one held lease to a session's new id. If its machine can't be reached, the row stays as it
   * is and renewActive tries again (until the lease would have run out).
   * @param {HeldRow} h @param {string} name @param {string} sid
   * @param {(authority: string, body: Record<string, unknown>) => Promise<any>} ask
   */
  async function rebindRow(h, name, sid, ask) {
    try {
      const r = await ask(h.authority, { op: 'rebind', resource: h.resource, name, sid, kind: 'session', old_sid: h.sid })
      unreachable.delete(h.authority)
      if (r?.ok) {
        q.unholdBy.run(h.authority, h.resource, h.sid)
        q.hold.run(h.authority, h.resource, name, sid, 'session', h.ttl_ms, h.renewed_at)
        log(`${name}'s lease on ${h.resource}@${h.authority} carried over to its new session`)
        marks()
      } else forget(h.authority, h.resource, h.sid)
    } catch (e) {
      unreachable.set(h.authority, now())
      log(`could not carry over the lease on ${h.resource}@${h.authority}: ${/** @type {any} */ (e)?.message || e}`)
    }
  }

  /**
   * One file per session process that holds a lease (`hold-<pid>`), so the heartbeat hook can tell
   * in a shell test, without starting anything, whether there's a lease to keep alive.
   */
  function marks() {
    const sids = new Set(heldRows().filter(h => h.kind === 'session').map(h => h.sid))
    const want = new Set([...sessions.values()].filter(s => s.owner && sids.has(sessionId(s.token))).map(s => `hold-${s.owner}`))
    try {
      for (const f of fs.readdirSync(dir)) if (/^hold-\d+$/.test(f) && !want.has(f)) fs.rmSync(path.join(dir, f), { force: true })
      for (const f of want) if (!fs.existsSync(path.join(dir, f))) fs.writeFileSync(path.join(dir, f), '', { mode: 0o600 })
    } catch {}
  }

  return { db, claim, renew, rebind, release, breakLease, list, current, view, sweep, noteHeld, noteRenewed, forget, heldRows, renewActive, carryOver, marks }
}

/** @param {unknown} v @param {number} dflt @param {number} lo @param {number} hi */
function clamp(v, dflt, lo, hi) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt
}
