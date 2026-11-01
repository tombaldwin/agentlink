import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normHost, sanitizeName, parseAddr, parsePeer, networkId, newSecret } from '../../src/config.js'
import { signEnvelope, verifyEnvelope, authHeader, checkAuth, MAX_SKEW_MS, NonceCache, signResponse, verifyResponse } from '../../src/crypto.js'
import { validAddr } from '../../src/config.js'

test('normHost adds .local to bare names and normalises case', () => {
  assert.equal(normHost('Anya'), 'anya.local')
  assert.equal(normHost('anya.local.'), 'anya.local')
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
  assert.deepEqual(parseAddr('buffy@anya.local', 'me.local'), { name: 'buffy', host: 'anya.local' })
  assert.deepEqual(parseAddr('buffy@anya', 'me.local'), { name: 'buffy', host: 'anya.local' })
  assert.deepEqual(parseAddr('buffy', 'me.local'), { name: 'buffy', host: 'me.local' })
  assert.deepEqual(parseAddr('a@b@c.local', 'me.local'), { name: 'a-b', host: 'c.local' })
})

test('parsePeer handles host, host:port and IPs', () => {
  assert.deepEqual(parsePeer('anya'), { host: 'anya.local', addr: null })
  assert.deepEqual(parsePeer('anya.local:7777'), { host: 'anya.local', addr: 'anya.local:7777' })
  assert.deepEqual(parsePeer('100.64.1.2:7777'), { host: '100.64.1.2', addr: '100.64.1.2:7777' })
  assert.equal(parsePeer('bad host'), null)
  assert.equal(parsePeer(''), null)
})

test('networkId is stable, short and secret-dependent', () => {
  assert.equal(networkId('x'), networkId('x'))
  assert.notEqual(networkId('x'), networkId('y'))
  assert.match(networkId('x'), /^[0-9a-f]{12}$/)
  assert.ok(newSecret().length >= 32)
})

const env = () => ({ id: 'id1', from: 'a@x.local', to: 'b@y.local', body: 'hi', sent_at: 1, expires_at: 2 })

test('envelopes verify only with the right secret and unmodified fields', () => {
  const e = env()
  e.sig = signEnvelope('s1', e)
  assert.ok(verifyEnvelope('s1', e))
  assert.ok(!verifyEnvelope('s2', e))
  for (const [k, v] of [['body', 'HI'], ['to', 'c@y.local'], ['from', 'z@x.local'], ['expires_at', 3]]) {
    assert.ok(!verifyEnvelope('s1', { ...e, [k]: v }), `tampered ${k} must fail`)
  }
  assert.ok(!verifyEnvelope('s1', { ...e, sig: undefined }))
})

test('request auth binds method, path and body, and rejects stale timestamps', () => {
  const h = authHeader('s', 'POST', '/v1/deliver', '{"a":1}')
  assert.ok(checkAuth('s', h, 'POST', '/v1/deliver', '{"a":1}'))
  assert.ok(!checkAuth('s', h, 'POST', '/v1/deliver', '{"a":2}'))
  assert.ok(!checkAuth('s', h, 'GET', '/v1/deliver', '{"a":1}'))
  assert.ok(!checkAuth('s', h, 'POST', '/v1/hello', '{"a":1}'))
  assert.ok(!checkAuth('other', h, 'POST', '/v1/deliver', '{"a":1}'))
  assert.ok(!checkAuth('s', undefined, 'POST', '/v1/deliver', ''))
  assert.ok(!checkAuth('s', 'garbage', 'POST', '/v1/deliver', ''))
  const stale = String(Date.now() - MAX_SKEW_MS - 1000) + h.slice(h.indexOf('.'))
  assert.ok(!checkAuth('s', stale, 'POST', '/v1/deliver', '{"a":1}'))
})

test('request auth binds the node identity header and rejects replays', () => {
  const h = authHeader('s', 'POST', '/v1/hello', '{}', 'a.local;net=x;port=1')
  assert.ok(checkAuth('s', h, 'POST', '/v1/hello', '{}', 'a.local;net=x;port=1'))
  assert.ok(!checkAuth('s', h, 'POST', '/v1/hello', '{}', 'evil.local;net=x;port=1'), 'identity header is signed')
  const nonces = new NonceCache()
  assert.ok(checkAuth('s', h, 'POST', '/v1/hello', '{}', 'a.local;net=x;port=1', nonces))
  assert.ok(!checkAuth('s', h, 'POST', '/v1/hello', '{}', 'a.local;net=x;port=1', nonces), 'replay rejected')
})

test('responses are bound to the request and the responder', () => {
  const sig = signResponse('s', 'req-auth', 'b.local;net=x', '{"ok":1}')
  assert.ok(verifyResponse('s', 'req-auth', 'b.local;net=x', '{"ok":1}', sig))
  assert.ok(!verifyResponse('s', 'other-req', 'b.local;net=x', '{"ok":1}', sig))
  assert.ok(!verifyResponse('s', 'req-auth', 'b.local;net=x', '{"ok":2}', sig))
  assert.ok(!verifyResponse('s', 'req-auth', 'c.local;net=x', '{"ok":1}', sig))
  assert.ok(!verifyResponse('other', 'req-auth', 'b.local;net=x', '{"ok":1}', sig))
  assert.ok(!verifyResponse('s', 'req-auth', 'b.local;net=x', '{"ok":1}', null))
})

test('only plain host:port addresses are dialable', () => {
  assert.ok(validAddr('anya.local:7777'))
  assert.ok(validAddr('100.64.1.2:7777'))
  assert.ok(validAddr('[fe80::1]:7777'))
  for (const bad of ['169.254.169.254:80/latest?', 'a.local', 'a.local:0', 'a.local:99999', 'user@a.local:1', 'a b:1', null]) {
    assert.ok(!validAddr(bad), `rejects ${bad}`)
  }
})

test('invite line encodes secrets with URL- and shell-special characters', async () => {
  const { installLine } = await import('../../src/setup.js')
  const secret = `a+b&c#d e"f$g!h'i%j(k)~0123456789abcdef`
  const line = installLine({ secret, port: 7777, host: 'h.local' })
  const url = line.match(/curl -fsSL "([^"]+)"/)[1]
  assert.match(url, /^[A-Za-z0-9:\/._?=%-]+$/)
  assert.equal(new URL(url).searchParams.get('k'), secret)
})
