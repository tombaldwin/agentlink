import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { normHost, sanitizeName, parseAddr, parsePeer, validAddr, errMsg, errCode } from '../../src/config.js'
import { versionOf } from '../../src/local.js'
import { PROTO } from '../../src/tls.js'
import { signEnvelope, verifyEnvelope, sealBeacon, openBeacon, newDiscoveryKey, randomToken, gateTags, gateOk, proveAuth, checkAuth, signRecord } from '../../src/crypto.js'
import { newIdentity, fingerprint, certDer } from '../../src/cert.js'
import { Roster } from '../../src/roster.js'
import { invitePrompt } from '../../src/setup.js'

test('normHost adds .local to bare names and normalises case', () => {
  assert.equal(normHost('Laptop'), 'laptop.local')
  assert.equal(normHost('laptop.local.'), 'laptop.local')
  assert.equal(normHost('box.tail1234.ts.net'), 'box.tail1234.ts.net')
  assert.equal(normHost('localhost'), 'localhost')
  assert.throws(() => normHost(''))
})

test('sanitizeName keeps names safe and non-empty', () => {
  assert.equal(sanitizeName('My Project!'), 'my-project')
  assert.equal(sanitizeName('..'), 'agent')
  assert.equal(sanitizeName(''), 'agent')
  assert.equal(sanitizeName('a'.repeat(100)).length, 48)
})

test('parseAddr splits name@host and defaults to this machine', () => {
  assert.deepEqual(parseAddr('reviewer@laptop.local', 'me.local'), { name: 'reviewer', host: 'laptop.local' })
  assert.deepEqual(parseAddr('reviewer@laptop', 'me.local'), { name: 'reviewer', host: 'laptop.local' })
  assert.deepEqual(parseAddr('reviewer', 'me.local'), { name: 'reviewer', host: 'me.local' })
  assert.deepEqual(parseAddr('a@b@c.local', 'me.local'), { name: 'a-b', host: 'c.local' })
})

test('parsePeer handles host, host:port and IPs', () => {
  assert.deepEqual(parsePeer('laptop'), { host: 'laptop.local', addr: null })
  assert.deepEqual(parsePeer('laptop.local:7777'), { host: 'laptop.local', addr: 'laptop.local:7777' })
  assert.deepEqual(parsePeer('100.64.1.2:7777'), { host: '100.64.1.2', addr: '100.64.1.2:7777' })
  assert.equal(parsePeer('bad host'), null)
  assert.equal(parsePeer(''), null)
})

test('machine certificates parse, self-verify, and match the key fingerprint', () => {
  const id = newIdentity()
  const x = new crypto.X509Certificate(id.cert)
  assert.ok(x.verify(x.publicKey))
  assert.equal(fingerprint(x), id.fp)
  assert.equal(fingerprint(id.key), id.fp)
  assert.doesNotMatch(x.subject, /\.local|\.test/, 'the certificate does not name the machine')
  assert.notEqual(newIdentity().fp, id.fp)
})

const env = () => ({ id: 'id1', from: 'a@x.local', to: 'b@y.local', body: 'hi', sent_at: 1, expires_at: 2 })

test('envelopes verify only with the sender\'s key and unmodified fields', () => {
  const a = newIdentity(), b = newIdentity()
  const e = env()
  e.sig = signEnvelope(a.key, e)
  const pubA = crypto.createPublicKey(a.key), pubB = crypto.createPublicKey(b.key)
  assert.ok(verifyEnvelope(pubA, e))
  assert.ok(!verifyEnvelope(pubB, e), 'another machine\'s key does not verify it')
  for (const [k, v] of [['body', 'HI'], ['to', 'c@y.local'], ['from', 'z@x.local'], ['expires_at', 3]]) {
    assert.ok(!verifyEnvelope(pubA, { ...e, [k]: v }), `tampered ${k} must fail`)
  }
  assert.ok(!verifyEnvelope(pubA, { ...e, sig: undefined }))
  assert.ok(!verifyEnvelope(pubA, { ...e, sig: 'garbage' }))
})

test('beacons open only with a network discovery key, and reveal nothing in the clear', () => {
  const dk = newDiscoveryKey(), other = newDiscoveryKey()
  const b = { host: 'laptop.local', fp: 'abc', port: 7777, ts: 1, reply: false }
  const sealed = sealBeacon(dk, b)
  assert.ok(!sealed.includes('laptop'))
  assert.deepEqual(openBeacon([other, dk], sealed), b)
  assert.equal(openBeacon([other], sealed), null)
  const tampered = Buffer.from(sealed); tampered[20] ^= 1
  assert.equal(openBeacon([dk], tampered), null)
  assert.equal(openBeacon([dk], Buffer.from('{"host":"x"}')), null)
})

test('the gate opens for any of the network\'s discovery keys, on that connection only', () => {
  const ekm = crypto.randomBytes(32), dks = [newDiscoveryKey(), newDiscoveryKey()]
  assert.ok(gateOk(dks, ekm, gateTags(dks, ekm)))
  assert.ok(gateOk(dks, ekm, gateTags(dks.slice(0, 1), ekm)), 'a client that missed a key rotation')
  assert.ok(gateOk(dks.slice(0, 1), ekm, gateTags(dks, ekm)), 'a server that missed a key rotation')
  assert.ok(!gateOk(dks, crypto.randomBytes(32), gateTags(dks, ekm)), 'bound to the connection')
  assert.ok(!gateOk(dks, ekm, gateTags([newDiscoveryKey()], ekm)), 'another network')
  assert.ok(!gateOk(dks, ekm, undefined) && !gateOk(dks, ekm, 'x'.repeat(1000)))
  assert.ok(!gateTags(dks, ekm).includes(dks[0]) && gateTags(dks, ekm) !== gateTags(dks, crypto.randomBytes(32)), 'tags reveal nothing stable')
})

test('identity proofs are bound to the connection and to a role', () => {
  const id = newIdentity(), pub = crypto.createPublicKey(id.key), ekm = crypto.randomBytes(32)
  const sig = proveAuth(id.key, 'server', ekm)
  assert.ok(checkAuth(pub, 'server', ekm, sig))
  assert.ok(!checkAuth(pub, 'client', ekm, sig), 'a server proof is not a client proof (no reflection)')
  assert.ok(!checkAuth(pub, 'server', crypto.randomBytes(32), sig), 'not valid on another connection')
  assert.ok(!checkAuth(crypto.createPublicKey(newIdentity().key), 'server', ekm, sig), 'only for its own key')
  assert.ok(!checkAuth(pub, 'server', ekm, 42))
})

test('roster: founder, adds, removals and the discovery key', () => {
  const a = newIdentity(), b = newIdentity(), c = newIdentity()
  const r = Roster.genesis(a, 'a.local')
  assert.deepEqual([...r.byHost.keys()], ['a.local'])
  const dk0 = r.dk
  r.add(a, 'b.local', b.cert)
  r.add(b, 'c.local', c.cert)               // any member can add
  assert.deepEqual([...r.byHost.keys()].sort(), ['a.local', 'b.local', 'c.local'])
  r.remove(a, c.fp)
  assert.ok(!r.members.has(c.fp) && r.removed.has(c.fp))
  assert.notEqual(r.dk, dk0, 'removal rotates the discovery key')
  // a removed key is gone for good: re-adding it does nothing; its own later records are ignored
  r.add(a, 'c.local', c.cert)
  assert.ok(!r.members.has(c.fp))
  const d = newIdentity()
  const fromRemoved = new Roster({ net: r.net, records: [] })
  fromRemoved.merge(r.records)
  const before = fromRemoved.records.length
  const rc = new Roster({ net: r.net, records: r.records })
  // forge: c (removed) signs an add for d, stamped after its removal
  const { signRecord } = { signRecord: (key, rec) => crypto.sign('sha256', Buffer.from(JSON.stringify(['agentlink-roster-1', rec.type, rec.host ?? '', rec.fp, rec.cert ?? '', rec.at, rec.by, rec.dk ?? ''])), key).toString('base64url') }
  const rec = { type: 'add', host: 'd.local', fp: d.fp, cert: certDer(d.cert), at: rc.nextAt(), by: c.fp }
  rc.merge([{ ...rec, sig: signRecord(c.key, rec) }])
  assert.ok(!rc.members.has(d.fp), 'a record signed by a removed machine after its removal does not count')
  assert.equal(fromRemoved.records.length, before)
})

test('roster: only earlier machines can remove, and a removed machine cannot fight back', () => {
  const [a, b, c, d, e] = Array.from({ length: 5 }, () => newIdentity())
  const r = Roster.genesis(a, 'a.local')
  r.add(a, 'b.local', b.cert); r.add(a, 'c.local', c.cert); r.add(a, 'd.local', d.cert)
  assert.deepEqual([a, b, c, d].map(x => r.members.get(x.fp)?.rank), [0, 1, 2, 3], 'ranked in the order they joined')
  assert.throws(() => r.remove(c, b.fp), /joined earlier/, 'a later machine cannot remove an earlier one')
  assert.throws(() => r.remove(b, a.fp), /joined earlier/, 'nobody can remove the founder')
  const rm = r.remove(b, c.fp)
  assert.ok(r.removed.has(c.fp) && r.members.has(d.fp))
  // c fights back with records dated just before its removal: removing b (earlier than c) and
  // adding a key it controls. Neither counts, in any order.
  const sign = rec => ({ ...rec, sig: signRecord(c.key, rec) })
  const attack = [
    sign({ type: 'remove', fp: b.fp, at: rm.at - 1, by: c.fp, dk: newDiscoveryKey(), seen: [] }),
    sign({ type: 'add', host: 'e.local', fp: e.fp, cert: certDer(e.cert), at: rm.at, by: c.fp }),
  ]
  for (const list of [attack, [...attack].reverse()]) {
    const x = new Roster({ net: r.net, records: [] })
    x.merge([...list, ...[...r.records].reverse()])
    assert.deepEqual([...x.byHost.keys()].sort(), ['a.local', 'b.local', 'd.local'], 'membership unchanged')
    assert.ok(x.removed.has(c.fp) && !x.members.has(e.fp) && x.dropped.has(e.fp))
    assert.equal(x.dk, r.dk, 'the discovery key is still the remover\'s')
  }
  // what the remover had seen of c (its records from before) still counts: no cascade
  const r2 = Roster.genesis(a, 'a.local')
  r2.add(a, 'b.local', b.cert); r2.add(a, 'c.local', c.cert); r2.add(c, 'e.local', e.cert)
  r2.remove(b, c.fp)
  assert.ok(r2.members.has(e.fp), 'machines the removed one added stay')
  // a replaced discovery key opens gates only for a while
  assert.deepEqual(r2.gateDks(), r2.dks)
  assert.deepEqual(r2.gateDks(Date.now() + 15 * 86400_000), [r2.dk])
})

test('roster: concurrent removals all stand, and the result never depends on arrival order', () => {
  const ids = Array.from({ length: 5 }, () => newIdentity())
  const [m0, m1, m2, m3, y] = ids
  const base = Roster.genesis(m0, 'm0.local')
  for (const [i, m] of [m1, m2, m3].entries()) base.add(m0, `m${i + 1}.local`, m.cert)
  const fork = () => new Roster({ net: base.net, records: base.records })
  // each removal made without seeing the one before it: m2 removes m3, m1 removes m2, m0 removes m1
  const c = fork().remove(m2, m3.fp), b = fork().remove(m1, m2.fp), a = fork().remove(m0, m1.fp)
  // and m1 adds y, which m0 hadn't seen when it removed m1
  const addY = fork().add(m1, 'y.local', y.cert)
  const extra = [a, b, c, addY]
  const all = [...base.records, ...extra]
  /** @param {unknown[]} list */
  const view = list => { const x = new Roster({ net: base.net, records: [] }); x.merge(list); return x }
  const ref = view(all)
  assert.deepEqual([...ref.byHost.keys()], ['m0.local'], 'every removal stands: removing a remover undoes nothing')
  assert.ok(ref.dropped.has(y.fp), 'an add the remover never saw does not count, and is known as dropped')
  assert.equal(ref.dk, a.dk, 'the current discovery key comes from a machine that is still a member')
  for (let i = 0; i < 20; i++) {
    const shuffled = [...all].sort(() => Math.random() - 0.5)
    const x = view(shuffled)
    assert.deepEqual([...x.byHost.keys()], [...ref.byHost.keys()])
    assert.equal(x.dk, ref.dk)
    // and in two parts (a node catching up). Nodes only ever send records whose signers are in
    // the network, so each part includes the adds of everyone who signed in it.
    const ex = [...extra].sort(() => Math.random() - 0.5)
    const h = view([...base.records, ...ex.slice(0, 2)]); h.merge(ex.slice(2))
    assert.deepEqual([...h.byHost.keys()], [...ref.byHost.keys()])
    assert.deepEqual(h.records.map(r => r.sig).sort(), ref.records.map(r => r.sig).sort(), 'the same records are kept')
    const rebuilt = view(x.records)
    assert.deepEqual([[...rebuilt.byHost.keys()], [...rebuilt.dropped], rebuilt.dks], [[...x.byHost.keys()], [...x.dropped], x.dks], 'rebuilding from what was kept changes nothing')
  }
})

test('roster: rebuilding from the records kept gives the same result (restarts, peers)', () => {
  const [A, M, T, X] = Array.from({ length: 4 }, () => newIdentity())
  const r = Roster.genesis(A, 'a.local')
  r.add(A, 'm.local', M.cert); r.add(A, 't.local', T.cert); r.add(T, 'x.local', X.cert)
  // M removes T twice: one removal saw T's add of X, the other (signed elsewhere) didn't
  const r1 = new Roster({ net: r.net, records: r.records }).remove(M, T.fp)
  const bare = { type: 'remove', fp: T.fp, at: r1.at + 1, by: M.fp, dk: newDiscoveryKey(), seen: [] }
  r.merge([r1, { ...bare, sig: signRecord(M.key, bare) }])
  r.remove(A, M.fp)
  const again = new Roster({ net: r.net, records: r.records })
  const sum = x => JSON.stringify([[...x.members.keys()].sort(), [...x.removed.keys()].sort(), [...x.dropped].sort(), x.dks])
  assert.equal(sum(again), sum(r))
  assert.ok(r.members.has(X.fp), 'the removal that counts (M\'s first) had seen the add of x')
})

test('roster: a removed machine cannot fill the roster with records that never count', () => {
  const [a, b, r, y] = Array.from({ length: 4 }, () => newIdentity())
  const ro = Roster.genesis(a, 'a.local')
  ro.add(a, 'b.local', b.cert); ro.add(a, 'r.local', r.cert)
  const rm = ro.remove(a, r.fp)
  const before = ro.records.length
  // r adds a throwaway key y (backdated), and y signs junk
  const addY = { type: 'add', host: 'y.local', fp: y.fp, cert: certDer(y.cert), at: rm.at, by: r.fp }   // unseen by the removal
  const junk = [{ ...addY, sig: signRecord(r.key, addY) }]
  for (let i = 0; i < 50; i++) {
    const z = newIdentity()
    const rec = { type: 'add', host: `z${i}.local`, fp: z.fp, cert: certDer(z.cert), at: rm.at + i, by: y.fp }
    junk.push({ ...rec, sig: signRecord(y.key, rec) })
  }
  ro.merge(junk)
  assert.equal(ro.records.length, before + 1, 'none of it is kept, apart from the add that marks y as dropped')
  assert.ok(ro.dropped.has(y.fp) && !ro.members.has(y.fp))
  const c = newIdentity()
  ro.add(b, 'c.local', c.cert)
  assert.ok(ro.members.has(c.fp), 'members can still add machines')
})

/** @param {any} id @param {any} o */
const signed = (id, o) => ({ ...o, sig: signRecord(id.key, o) })
const reload = (/** @type {any} */ r) => new Roster({ net: r.net, records: JSON.parse(JSON.stringify(r.records)) })

test('roster: a signature that was good for one record proves nothing about another', () => {
  const f = newIdentity(), t = newIdentity(), m = newIdentity(), x = newIdentity()
  const r = Roster.genesis(f, 'f.local')
  r.add(f, 't.local', t.cert)
  r.add(f, 'm.local', m.cert)
  r.merge([signed(m, { type: 'add', host: 'x.local', fp: x.fp, cert: certDer(x.cert), at: r.nextAt(), by: m.fp })])
  // x signs a record that gets checked and then dropped, leaving its signature free to reuse
  const used = signed(x, { type: 'add', host: 'q.local', fp: t.fp, cert: certDer(t.cert), at: r.nextAt(), by: x.fp })
  r.merge([used])
  r.merge([signed(m, { type: 'remove', fp: x.fp, at: r.nextAt(), by: m.fp, dk: newDiscoveryKey(), seen: [] })])
  assert.ok(!r.records.some(x => x.sig === used.sig))
  const dk = newDiscoveryKey()
  r.merge([{ type: 'remove', fp: t.fp, at: r.nextAt(), by: f.fp, dk, seen: [], sig: used.sig }])
  assert.ok(r.members.has(t.fp), 'a removal claiming the founder, with a reused signature, does nothing')
  assert.notEqual(r.dk, dk)
  assert.ok(!r.records.some(x => x.dk === dk))
})

test('roster: a removed machine cannot bring a key in by claiming another signer', () => {
  const f = newIdentity(), c = newIdentity(), j = newIdentity()
  const r = Roster.genesis(f, 'f.local')
  r.add(f, 'c.local', c.cert)
  const t = r.nextAt()
  const adds = Array.from({ length: 60 }, (_, i) => { const z = newIdentity(); return { z, rec: signed(c, { type: 'add', host: `z${i}.local`, fp: z.fp, cert: certDer(z.cert), at: t + i, by: c.fp }) } })
  r.merge(adds.map(a => a.rec))
  r.merge([signed(f, { type: 'remove', fp: c.fp, at: t + 100, by: f.fp, dk: newDiscoveryKey(), seen: [] })])
  const last = /** @type {any} */ (adds.at(-1))
  r.merge([{ type: 'add', host: 'j.local', fp: j.fp, cert: certDer(j.cert), at: t + 101, by: f.fp, sig: 'x'.repeat(86) }])
  r.merge([{ ...last.rec, by: f.fp, at: t + 102 }])
  assert.ok(!r.members.has(last.z.fp))
})

test('roster: only records with a good signature are kept, whoever they claim to be from', () => {
  const f = newIdentity(), z = newIdentity(), r = Roster.genesis(f, 'f.local')
  const n = r.records.length
  const dk = newDiscoveryKey()
  r.merge([
    { type: 'add', host: 'z.local', fp: z.fp, cert: certDer(z.cert), at: Date.now(), by: f.fp, dk, sig: 'x'.repeat(86) },
    { type: 'remove', fp: z.fp, at: Date.now(), by: f.fp, dk, seen: [], sig: 'y'.repeat(86) },
    { type: 'add', host: 'f.local', fp: f.fp, cert: certDer(f.cert), at: Date.now() + 1, by: f.fp, dk, sig: 'z'.repeat(86) },
  ])
  assert.equal(r.records.length, n)
  assert.notEqual(r.dk, dk)
})

test('roster: only the founder and standing removals bring in a discovery key', () => {
  const f = newIdentity(), m = newIdentity(), r = Roster.genesis(f, 'f.local')
  r.add(f, 'm.local', m.cert)
  const dk = r.dk, evil = newDiscoveryKey()
  // properly signed by a member: an add of itself, and a removal that doesn't apply to anything
  r.merge([
    signed(m, { type: 'add', host: 'm.local', fp: m.fp, cert: certDer(m.cert), at: r.nextAt(), by: m.fp, dk: evil }),
    signed(m, { type: 'remove', fp: f.fp, at: r.nextAt(), by: m.fp, dk: evil, seen: [] }),
  ])
  assert.equal(r.dk, dk)
  assert.deepEqual(r.gateDks(), [dk])
})

test('roster: a malformed discovery key is refused', () => {
  const f = newIdentity(), m = newIdentity(), r = Roster.genesis(f, 'f.local')
  r.add(f, 'm.local', m.cert)
  const n = r.records.length
  for (const dk of ['AAAA', 'not base64 at all, but forty-four chars long', 'A'.repeat(64)]) {
    r.merge([signed(f, { type: 'remove', fp: m.fp, at: r.nextAt(), by: f.fp, dk, seen: [] })])
  }
  assert.equal(r.records.length, n)
  assert.ok(r.members.has(m.fp))
})

/** Fill `r` with adds signed by `by` until it refuses more. @param {any} r @param {any} by */
function flood(r, by) {
  const t = r.nextAt(), z = newIdentity(), cert = certDer(z.cert), pad = `${'h'.repeat(60)}.${'h'.repeat(60)}.${'h'.repeat(60)}`
  r.merge(Array.from({ length: 2500 }, (_, i) => signed(by, { type: 'add', host: `${pad}.${i}.local`, fp: z.fp, cert, at: t + i, by: by.fp })))
}

test('roster: a copy of a record with its signature re-encoded is the same record', () => {
  const f = newIdentity(), b = newIdentity(), c = newIdentity(), z = newIdentity()
  const r = Roster.genesis(f, 'f.local')
  r.add(f, 'b.local', b.cert)
  r.add(f, 'c.local', c.cert)
  r.add(f, 'z.local', z.cert)
  const n = r.records.length, first = /** @type {any} */ (r.records[1])
  r.merge(Array.from({ length: 120 }, (_, i) => ({ ...first, sig: first.sig.slice(0, 10) + '!'.repeat(i + 1) + first.sig.slice(10) })))
  assert.equal(r.records.length, n, 'no copies are kept')
  assert.equal(r.members.size, 4, 'and nobody is pushed out')
  r.add(f, 'next.local', newIdentity().cert)
  assert.equal(r.members.size, 5, 'and the signer can still add machines')
})

test('roster: a removal lists a re-encoded record as the same record', () => {
  const f = newIdentity(), m = newIdentity(), x = newIdentity(), r = Roster.genesis(f, 'f.local')
  r.add(f, 'm.local', m.cert)
  const add = signed(m, { type: 'add', host: 'x.local', fp: x.fp, cert: certDer(x.cert), at: r.nextAt(), by: m.fp })
  r.merge([add])
  const removal = r.remove(f, m.fp)
  const other = Roster.genesis(f, 'f.local')
  other.merge(r.records.filter(x => x.sig !== add.sig && x.sig !== removal.sig))
  other.merge([{ ...add, sig: add.sig.slice(0, 10) + '!' + add.sig.slice(10) }, removal])
  assert.ok(other.members.has(x.fp), 'x stays on a node that only got the re-encoded copy')
})

test('roster: a full roster refuses adds with an error, and still takes removals', () => {
  const f = newIdentity(), c = newIdentity(), r = Roster.genesis(f, 'f.local')
  r.add(f, 'c.local', c.cert)
  flood(r, c)
  assert.ok(JSON.stringify(r.records).length > 1200 << 10, 'it filled up')
  assert.ok(JSON.stringify({ peers: [], records: r.records }).length < 2 << 20, 'and still fits in a hello')
  assert.throws(() => r.add(f, 'late.local', newIdentity().cert), /size limit/)
  r.remove(f, c.fp)
  assert.ok(r.removed.has(c.fp), 'the removal goes in')
  assert.ok(JSON.stringify(r.records).length < 10_000, 'and what the flooder signed goes with it')
  r.add(f, 'late.local', newIdentity().cert)
})

test('roster: a machine that added more than a roster should hold can still be removed', () => {
  const f = newIdentity(), c = newIdentity(), r = Roster.genesis(f, 'f.local')
  r.add(f, 'c.local', c.cert)
  const t = r.nextAt(), ids = Array.from({ length: 1200 }, () => newIdentity())
  r.merge(ids.map((z, i) => signed(c, { type: 'add', host: `z${i}.local`, fp: z.fp, cert: certDer(z.cert), at: t + i, by: c.fp })))
  assert.equal(r.members.size, 1202)
  r.remove(f, c.fp)
  assert.ok(r.removed.has(c.fp))
  assert.equal(r.members.size, 1201, 'and the machines it added stay')
})

test('roster: loading never drops what is held, however full', () => {
  const f = newIdentity(), m = newIdentity(), r = Roster.genesis(f, 'f.local')
  r.add(f, 'm.local', m.cert)
  flood(r, m)
  // a late, early-dated removal that doesn't apply to anything sorts ahead of the genesis
  const dk = r.dk
  r.merge([signed(m, { type: 'remove', fp: 'f'.repeat(64), at: 1, by: m.fp, dk: newDiscoveryKey(), seen: [] })])
  const again = reload(r)
  assert.equal(again.records.length, r.records.length)
  assert.equal(again.members.size, r.members.size)
  assert.equal(again.dk, dk)
})

test('roster: a removal the same signer repeats changes nothing', () => {
  const f = newIdentity(), c = newIdentity(), r = Roster.genesis(f, 'f.local')
  r.add(f, 'c.local', c.cert)
  r.remove(f, c.fp)
  const dk = r.dk
  assert.equal(r.merge([signed(f, { type: 'remove', fp: c.fp, at: r.nextAt(), by: f.fp, dk: newDiscoveryKey(), seen: [] })]), false)
  assert.equal(r.dk, dk, 'the discovery key stays the one every member has')
})

test('roster: removing throws rather than report a removal that was not recorded', () => {
  const f = newIdentity(), c = newIdentity(), r = Roster.genesis(f, 'f.local')
  r.add(f, 'c.local', c.cert)
  r.merge = () => false
  assert.throws(() => r.remove(f, c.fp), /could not be recorded/)
})

test('roster: same records in any order give the same membership; junk is not kept', () => {
  const a = newIdentity(), b = newIdentity(), c = newIdentity(), x = newIdentity()
  const r = Roster.genesis(a, 'a.local')
  r.add(a, 'b.local', b.cert)
  r.add(b, 'c.local', c.cert)
  r.remove(b, c.fp)
  const shuffled = [...r.records].reverse()
  const r2 = new Roster({ net: r.net, records: [] })
  r2.merge(shuffled)
  assert.deepEqual([...r2.byHost.keys()].sort(), [...r.byHost.keys()].sort())
  assert.equal(r2.dk, r.dk)
  // an outsider's self-made records, a host-name grab and a future-dated record are all dropped
  const junk = Roster.genesis(x, 'b.local').records                 // x "founds" a network claiming b.local
  const grab = new Roster({ net: x.fp, records: junk }).add(x, 'a.local', x.cert)
  assert.ok(!r2.merge([...junk, grab]), 'nothing an outsider signs is kept')
  const late = new Roster({ net: r.net, records: r.records })
  const fut = { type: 'add', host: 'z.local', fp: x.fp, cert: certDer(x.cert), at: Date.now() + 2 * 3600_000, by: a.fp }
  fut.sig = crypto.sign('sha256', Buffer.from(JSON.stringify(['agentlink-roster-1', 'add', 'z.local', fut.fp, fut.cert, fut.at, fut.by, ''])), a.key).toString('base64url')
  assert.ok(!late.merge([fut]), 'a record from far in the future is refused')
  // two members adding different keys under one name: the same one wins everywhere
  const y = newIdentity(), z = newIdentity()
  const p = new Roster({ net: r.net, records: r.records }), q = new Roster({ net: r.net, records: r.records })
  const ry = p.add(a, 'n.local', y.cert), rz = q.add(b, 'n.local', z.cert)
  p.merge([rz]); q.merge([ry])
  assert.equal(p.byHost.get('n.local')?.fp, q.byHost.get('n.local')?.fp)
})

test('invite line pins the key and carries a URL- and shell-safe token', async () => {
  const { installLine } = await import('../../src/setup.js')
  const fp = newIdentity().fp
  const line = installLine({ token: randomToken(), fp, port: 7777 }, 'h.local')
  assert.match(line, /^curl -fsSL -k --pinnedpubkey "sha256\/\/[A-Za-z0-9+/=]+" "https:\/\/h\.local:7777\/join\/install\?t=[A-Za-z0-9_-]+" \| sh$/)
  assert.ok(line.includes(fp))
  for (let i = 0; i < 2000; i++) assert.ok(!randomToken().startsWith('-'))
})

test('only plain host:port addresses are dialable', () => {
  assert.ok(validAddr('laptop.local:7777'))
  assert.ok(validAddr('100.64.1.2:7777'))
  assert.ok(validAddr('[fe80::1]:7777'))
  for (const bad of ['169.254.169.254:80/latest?', 'a.local', 'a.local:0', 'a.local:99999', 'user@a.local:1', 'a b:1', null]) {
    assert.ok(!validAddr(bad), `rejects ${bad}`)
  }
})

test('peers given with a port are dialed by the name as written (MagicDNS short names)', () => {
  assert.deepEqual(parsePeer('desk:7777'), { host: 'desk.local', addr: 'desk:7777' })
  assert.deepEqual(parsePeer('desk'), { host: 'desk.local', addr: null })
  assert.deepEqual(parsePeer('desk.tail1.ts.net:7777'), { host: 'desk.tail1.ts.net', addr: 'desk.tail1.ts.net:7777' })
  assert.deepEqual(parsePeer('10.0.0.5:7777'), { host: '10.0.0.5', addr: '10.0.0.5:7777' })
})

test('the channel is only considered enabled for interactive sessions that load it', async () => {
  const { channelArgs } = await import('../../src/mcp.js')
  assert.ok(channelArgs('claude --dangerously-load-development-channels=server:agentlink'))
  assert.ok(channelArgs('claude --dangerously-load-development-channels server:agentlink fix it'))
  assert.ok(!channelArgs('claude'))
  assert.ok(!channelArgs('claude --dangerously-load-development-channels=server:agentlink -p "say hi"'))
  assert.ok(!channelArgs('claude --print --dangerously-load-development-channels=server:agentlink'))
  assert.ok(!channelArgs('claude --dangerously-load-development-channels=server:agentlinkx'))
})

/** Run a snippet with HOME and AGENTLINK_HOME in a fresh temp dir; returns its JSON output. */
async function inSandbox(files, code, env = {}) {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path')
  const { execFileSync } = await import('node:child_process')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlink-unit-'))
  try {
    for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(home, f)), { recursive: true }); fs.writeFileSync(path.join(home, f), text) }
    const src = new URL('../../src/', import.meta.url).href
    const out = execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code.replaceAll('SRC/', src)],
      { env: { ...process.env, HOME: home, AGENTLINK_HOME: path.join(home, '.agentlink'), ...env }, encoding: 'utf8' })
    return { home, out: JSON.parse(out) }
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
}

test('account aliases are read as the shell sees them, including escaped quotes', async () => {
  const rc = [
    `alias claude2='CLAUDE_CONFIG_DIR="$HOME/.claude2" claude'`,
    `alias work='echo it'\\''s work; CLAUDE_CONFIG_DIR=$HOME/.work claude'`,
    `alias dq="CLAUDE_CONFIG_DIR=\\"$HOME/.dq\\" claude"`,
  ].join('\n') + '\n'
  const { home, out } = await inSandbox({ '.zshrc': rc },
    `import { claudeAccounts } from 'SRC/claude.js'; console.log(JSON.stringify(claudeAccounts()))`, { SHELL: '/bin/zsh' })
  const by = Object.fromEntries(out.map(a => [a.alias, a]))
  assert.equal(by.claude2.dir, `${home}/.claude2`)
  assert.equal(by.work.dir, `${home}/.work`)
  assert.equal(by.work.aliasValue, `echo it's work; CLAUDE_CONFIG_DIR=$HOME/.work claude`)
  assert.equal(by.dq.dir, `${home}/.dq`)
  assert.equal(by.dq.aliasValue, `CLAUDE_CONFIG_DIR="$HOME/.dq" claude`)
})

test('config: bad files throw, ttl is capped, and "localhost" is never an identity', async () => {
  const load = `import { loadConfig } from 'SRC/config.js'
    let r; try { const c = loadConfig(); r = { ttlDays: c.ttlMs / 86400000, host: c.host, aliases: c.aliases } } catch (e) { r = { error: e.message } }
    console.log(JSON.stringify(r))`
  const id = newIdentity()
  const ident = { '.agentlink/node.key': id.key, '.agentlink/node.crt': id.cert, '.agentlink/roster.json': JSON.stringify({ net: id.fp, records: Roster.genesis(id, 'box.local').records }) }
  let { out } = await inSandbox({ ...ident, '.agentlink/config.json': '{"host": "s",}' }, load)
  assert.match(out.error, /bad config/)
  ;({ out } = await inSandbox({ '.agentlink/config.json': JSON.stringify({ host: 'box', ttlDays: 1e9 }), ...ident }, load))
  assert.equal(out.ttlDays, 30)
  ;({ out } = await inSandbox({ '.agentlink/config.json': JSON.stringify({ host: 'localhost' }), ...ident }, load))
  assert.match(out.error, /can't identify this machine/)
  // a machine given its own name doesn't answer for the OS hostname
  ;({ out } = await inSandbox({ '.agentlink/config.json': JSON.stringify({ host: 'renamed-clone' }), ...ident }, load))
  const os = await import('node:os')
  assert.ok(!out.aliases.includes(normHost(os.hostname())), 'OS hostname is not an alias')
  // no key or roster: not set up
  ;({ out } = await inSandbox({ '.agentlink/config.json': JSON.stringify({ host: 'box' }) }, load))
  assert.match(out.error, /not set up/)
})

test('a machine running another protocol version is reported as such, not as a stranger', async () => {
  const https = await import('node:https')
  const { authedRequest, ProtoError, PROTO } = await import('../../src/tls.js')
  const srv = newIdentity(), me = newIdentity()
  const server = https.createServer({ key: srv.key, cert: srv.cert }, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ fp: srv.fp, sig: 'x', proto: PROTO + 1 }))
  })
  await new Promise(r => server.listen(0, '127.0.0.1', () => r(undefined)))
  const addr = `127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`
  const o = { addr, path: '/v1/sessions', identity: me, accept: new Map([[srv.fp, crypto.createPublicKey(srv.key)]]), dks: [newDiscoveryKey()] }
  try {
    await assert.rejects(authedRequest(o), e => e instanceof ProtoError && /newer version of agentlink/.test(e.message))
    await assert.rejects(authedRequest({ ...o, anyProto: true }), /not the expected machine/, 'anyProto goes on to the identity check')
  } finally { server.close() }
})

test('connection errors to several addresses are readable', () => {
  const at = (/** @type {string} */ code) => Object.assign(new Error(`connect ${code}`), { code })
  const agg = new AggregateError([at('EHOSTUNREACH'), at('ETIMEDOUT')])
  assert.equal(errMsg(agg), 'connect EHOSTUNREACH, ETIMEDOUT (tried 2 addresses)')
  assert.equal(errMsg(new Error('fetch failed', { cause: agg })), 'fetch failed: connect EHOSTUNREACH, ETIMEDOUT (tried 2 addresses)')
  assert.equal(errMsg(new AggregateError([at('EHOSTUNREACH')])), 'connect EHOSTUNREACH')
  assert.equal(errCode(agg), 'EHOSTUNREACH')
  assert.equal(errMsg(new Error('x', { cause: at('ECONNREFUSED') })), 'x (ECONNREFUSED)')
})

test('only an older node is replaced; a newer one means this process is out of date', () => {
  const h = (/** @type {string} */ version, /** @type {number | undefined} */ proto) => ({ ok: true, host: 'h', net: 'n', fp: 'f', pid: 1, version, proto })
  const v = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version
  assert.deepEqual(versionOf(h(v, PROTO)), { differs: false, newer: false })
  assert.deepEqual(versionOf(h(v, undefined)), { differs: true, newer: false }, 'from before protocol numbers')
  assert.deepEqual(versionOf(h(v, PROTO + 1)), { differs: true, newer: true })
  assert.deepEqual(versionOf(h('999.0.0', PROTO)), { differs: true, newer: true })
  assert.deepEqual(versionOf(h('0.0.1', PROTO)), { differs: true, newer: false })
  assert.deepEqual(versionOf(h('999.0.0', PROTO - 1)), { differs: true, newer: false }, 'the protocol decides first')
})

test('invites offer an IP for machines that cannot look up .local names, unless Tailscale is there', () => {
  const inv = { token: 't', fp: 'f', host: 'desk.local', port: 7777 }
  assert.match(invitePrompt({ ...inv, ip: '192.168.1.20' }), /https:\/\/192\.168\.1\.20:7777\/join\/install/)
  assert.doesNotMatch(invitePrompt({ ...inv, ip: '192.168.1.20', tailscale: 'desk.ts.net' }), /192\.168/)
  assert.doesNotMatch(invitePrompt(inv), /can't be found/)
})
