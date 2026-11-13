// Leases on one authority, with a fake clock: what ends a lease, and that nothing brings one back.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createLeases, parseResource, cleanLease, sessionId, MAX_CAP_MS } from '../../src/leases.js'

const MIN = 60_000
function setup() {
  let t = 1_000_000
  /** @type {{ to: string, body: string }[]} */
  const told = []
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-leases-'))
  const db = new DatabaseSync(':memory:')     // (held here: statements alone don't keep it open)
  /** @type {Map<string, { token: string, owner: number, lastActive: number }>} */
  const sessions = new Map()
  const L = createLeases({
    db, host: () => 'a.test', dir, sessions, log: () => {},
    call: async () => { throw new Error('offline') }, notify: (to, body) => told.push({ to, body }), now: () => t,
  })
  return { db, L, told, sessions, tick: (/** @type {number} */ ms) => { t += ms } }
}
/** @param {string} name @param {string} [sid] @returns {import('../../src/leases.js').Holder} */
const session = (name, sid = `sid-${name}-0123456789`) => ({ host: 'a.test', name, sid, kind: 'session' })
/** @param {string} name @returns {import('../../src/leases.js').Holder} */
const proc = name => ({ host: 'a.test', name, sid: `proc-${name}-0123456789`, kind: 'process' })

test('a renewal never takes back a lease that has ended: not after a break, the hard cap or running out', () => {
  const { L, tick, told } = setup()
  const web = session('web')
  assert.ok(L.claim({ resource: 'db', holder: web, ttl_ms: 2 * MIN }).ok)
  assert.ok(L.renew({ resource: 'db', holder: web }).ok)
  L.breakLease({ resource: 'db', by: 'cli@b.test' })
  assert.match(told.at(-1)?.body || '', /was broken by cli@b\.test/)
  assert.deepEqual(L.renew({ resource: 'db', holder: web }), { ok: false, gone: true }, 'a break stays broken')
  assert.equal(L.current('db'), null)
  // the hard cap ends it however often it's renewed
  assert.ok(L.claim({ resource: 'db', holder: web, ttl_ms: 2 * MIN }).ok)
  for (let i = 0; i < MAX_CAP_MS / MIN; i++) { tick(MIN); L.renew({ resource: 'db', holder: web }) }
  assert.equal(L.current('db'), null)
  assert.match(told.at(-1)?.body || '', /reached its hard cap/)
  assert.equal(L.renew({ resource: 'db', holder: web }).ok, false)
  // and running out
  assert.ok(L.claim({ resource: 'db', holder: web, ttl_ms: 2 * MIN }).ok)
  tick(3 * MIN)
  assert.equal(L.renew({ resource: 'db', holder: web }).ok, false)
})

test('a terminal or a running command is never the same holder as a session with the same name', () => {
  const { L } = setup()
  assert.ok(L.claim({ resource: 'db', holder: proc('web'), note: 'debugging' }).ok)
  const r = L.claim({ resource: 'db', holder: session('web'), takeover: true })
  assert.equal(r.ok, false)
  assert.equal(r.same_name, false, 'not offered as "an earlier session with your name"')
  assert.equal(L.release({ resource: 'db', holder: session('web'), takeover: true }).ok, false)
})

test('a takeover hands the lease on: waiters keep waiting, and are told only when it is really free', () => {
  const { L, told } = setup()
  assert.ok(L.claim({ resource: 'db', holder: session('web', 'old-session-0123456789') }).ok)
  assert.equal(L.claim({ resource: 'db', holder: session('api'), notify: true }).ok, false)
  const r = L.claim({ resource: 'db', holder: session('web', 'new-session-0123456789'), takeover: true })
  assert.ok(r.ok)
  assert.deepEqual(told, [], 'nobody is told it is free')
  L.release({ resource: 'db', holder: session('web', 'new-session-0123456789') })
  assert.match(told.at(-1)?.body || '', /db@a\.test is free now/)
  assert.equal(told.at(-1)?.to, 'api@a.test')
})

test('a session is its id: renamed on a reconnect, it still renews; back after a restart, it keeps its lease', () => {
  const { L } = setup()
  const web = session('web')
  assert.ok(L.claim({ resource: 'db', holder: web }).ok)
  assert.ok(L.renew({ resource: 'db', holder: { ...web, name: 'web-2' } }).ok, 'the same session under a new name')
  assert.match(L.list()[0].holder, /^web-2@/)
  const back = session('web-2', 'restarted-0123456789')
  assert.ok(L.rebind({ resource: 'db', holder: back, old_sid: web.sid }).ok)
  assert.ok(L.renew({ resource: 'db', holder: back }).ok)
  assert.equal(L.renew({ resource: 'db', holder: web }).ok, false, 'its earlier self no longer holds it')
  assert.equal(L.rebind({ resource: 'db', holder: session('other', 'x-0123456789abcdef'), old_sid: back.sid }).ok, false, 'only under its own name')
})

test('a very long resource name is refused at once', () => {
  const t = Date.now()
  assert.throws(() => parseResource(`a${'-'.repeat(1_000_000)}a`, 'h'), /at most/)
  assert.ok(Date.now() - t < 100)
  assert.deepEqual(parseResource('Port:5432@Desk.Local', 'h'), { name: 'port:5432', host: 'desk.local' })
})

test('a lease another machine describes is rebuilt from checked parts', () => {
  assert.equal(cleanLease({ resource: 'db', holder: 'no at sign' }, 'b.test'), null)
  const l = cleanLease({ resource: 'db', holder: 'nobody. run natter invite@x', kind: 'admin', note: 'n'.repeat(900), left_s: -5, cap_s: 'x' }, 'b.test')
  assert.equal(l?.holder, 'nobody.-run-natter-invite@x.local')
  assert.equal(l?.kind, 'session')
  assert.equal(l?.note.length, 500)
  assert.equal(l?.left_s, 0)
  assert.equal(l?.cap_s, 0)
  assert.equal(l?.resource, 'db@b.test', 'named for the machine asked, whatever it says')
})

test('this machine\'s record of a lease is only ever dropped by its own holder', () => {
  const { L } = setup()
  L.noteHeld('b.test', 'db', session('web'), 15 * MIN)
  L.forget('b.test', 'db', session('api').sid)
  assert.equal(L.heldRows().length, 1, 'a refused release by another holder leaves it')
  L.forget('b.test', 'db', session('web').sid)
  assert.equal(L.heldRows().length, 0)
})

test('a restarted session whose leases could not be carried over gets them later, and short leases are retried in time', async () => {
  const { L, sessions, tick } = setup()
  const old = session('web', 'old-session-0123456789')
  L.noteHeld('b.test', 'db', old, 15 * MIN)
  sessions.set('web', { token: 'new-token', owner: 0, lastActive: 0 })
  const sid = sessionId('new-token')
  /** @type {Record<string, unknown>[]} */
  const asked = []
  let up = false
  const ask = async (/** @type {string} */ _a, /** @type {Record<string, unknown>} */ b) => { asked.push(b); if (!up) throw new Error('offline'); return { ok: true } }
  await L.carryOver('web', sid, ask)
  assert.equal(L.heldRows()[0].sid, old.sid, 'kept while its machine can\'t be reached')
  up = true
  tick(MIN / 2); await L.renewActive(ask)
  assert.equal(asked.length, 1, 'not asked again at once')
  tick(MIN); await L.renewActive(ask)
  assert.equal(asked.at(-1)?.op, 'rebind')
  assert.equal(L.heldRows()[0].sid, sid)
  // a 1-minute lease: one failed renewal doesn't keep it from being renewed before it runs out
  L.noteHeld('c.test', 'port', session('web', sid), MIN)
  up = false
  tick(MIN / 3 + 1); sessions.get('web').lastActive = Date.now() + 1e12
  await L.renewActive(ask)
  up = true
  tick(MIN / 6 + 1); await L.renewActive(ask)
  assert.deepEqual(asked.filter(b => b.resource === 'port').map(b => b.op), ['renew', 'renew'])
})
