// End-to-end test: nodes on localhost with distinct ports, plus MCP adapters.
// Members a..j (except d) share one network founded by a; d is on a network of its own.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import net from 'node:net'
import tls from 'node:tls'
import crypto from 'node:crypto'
import { spawn, execFileSync, execFile, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { newIdentity } from '../src/cert.js'
import { Roster } from '../src/roster.js'
import { signEnvelope, sealBeacon } from '../src/crypto.js'
import { authedRequest, peerCertificate } from '../src/tls.js'
import { Local } from '../src/local.js'
import { readIdentity } from '../src/config.js'

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agentlink.js')
const ROOT = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'agentlink-e2e-'))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const NODES = { a: 17771, b: 17772, c: 17773, d: 17774, e: 17775, f: 17776, g: 17777, h: 17778, i: 17779, j: 17780, k: 17781, l: 17782 }
const EXTRA_PORTS = [17790, 17791, 17792, 17793]
const routes = Object.fromEntries(Object.entries(NODES).map(([n, p]) => [`${n}.test`, `127.0.0.1:${p}`]))

// identities and the shared network (a founds it; t.test is this test process, acting as a member)
const IDS = Object.fromEntries(Object.keys(NODES).map(n => [n, newIdentity()]))
const TESTER = newIdentity()
const NET = Roster.genesis(IDS.a, 'a.test')
for (const n of ['b', 'c', 'e', 'f', 'g', 'h', 'j']) NET.add(IDS.a, `${n}.test`, IDS[n].cert)
NET.add(IDS.a, 't.test', TESTER.cert)
const OTHER_NET = Roster.genesis(IDS.d, 'd.test')

function home(n, conf = {}, roster = n === 'd' ? OTHER_NET : NET) {
  const dir = path.join(ROOT, n)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    host: `${n}.test`, port: NODES[n], discovery: false, routes, autoAliases: false,
    peers: ['a', 'b', 'c'].filter(x => x !== n).map(x => `${x}.test`), ...conf,
  }))
  fs.writeFileSync(path.join(dir, 'node.key'), IDS[n].key, { mode: 0o600 })
  fs.writeFileSync(path.join(dir, 'node.crt'), IDS[n].cert)
  fs.writeFileSync(path.join(dir, 'roster.json'), JSON.stringify({ net: roster.net, records: roster.records }))
  return dir
}
const envFor = n => ({ ...process.env, AGENTLINK_HOME: path.join(ROOT, n) })
const localOf = n => new Local({ identity: readIdentity(path.join(ROOT, n)), port: NODES[n], dir: path.join(ROOT, n) })

const procs = {}
async function startNode(n) {
  const out = fs.openSync(path.join(ROOT, n, 'node.log'), 'a')
  procs[n] = spawn(process.execPath, ['--no-warnings', BIN, 'node'], { env: envFor(n), stdio: ['ignore', out, out] })
  const local = localOf(n)
  for (let i = 0; i < 50; i++) {
    const h = await local.health()
    if (h && !h.foreign) return
    await sleep(100)
  }
  throw new Error(`node ${n} did not start`)
}
async function stopNode(n) {
  const p = procs[n]
  if (!p || p.exitCode !== null || p.signalCode !== null) return   // already gone (killed by a signal: exitCode stays null)
  const done = new Promise(r => p.once('exit', r))
  p.kill('SIGKILL')   // simulate a crash / machine dropping off
  await done
}
function cliAsync(n, ...args) {
  return new Promise((resolve, reject) => execFile(process.execPath, ['--no-warnings', BIN, ...args], { env: envFor(n), encoding: 'utf8' },
    (err, out) => err ? reject(err) : resolve(out.trim())))
}
function cli(n, ...args) {
  return execFileSync(process.execPath, ['--no-warnings', BIN, ...args], { env: envFor(n), encoding: 'utf8' }).trim()
}

// mode: false = channel session, true = --poll, 'plain' = a session without the channel enabled
async function adapter(n, name, poll = false) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--no-warnings', BIN, 'mcp', '--name', name, ...(poll === 'plain' ? [] : poll ? ['--poll'] : ['--channel'])],
    env: envFor(n), stderr: 'ignore',
  })
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} })
  const got = []
  client.fallbackNotificationHandler = async notif => {
    if (notif.method === 'notifications/claude/channel') got.push(notif.params)
  }
  await client.connect(transport)
  const call = async (tool, args = {}) => (await client.callTool({ name: tool, arguments: args })).content[0].text
  return { client, got, call, close: () => client.close(), instructions: client.getInstructions() }
}
async function waitFor(fn, ms = 8000, what = 'condition') {
  const t = Date.now()
  while (Date.now() - t < ms) { if (await fn()) return; await sleep(100) }
  throw new Error(`timed out waiting for ${what}`)
}

const running = n => procs[n] && procs[n].exitCode === null && procs[n].signalCode === null
async function ensureNode(n) { if (!running(n)) await startNode(n) }
/**
 * A request to node `n` as a member machine (`as`: an identity; the test is member t.test).
 * `dks`: the discovery keys we hold; `addr`: where to connect (default: n's port).
 */
async function memberPost(n, p, obj, as = TESTER, dks = NET.dks, addr = `127.0.0.1:${NODES[n]}`) {
  const r = await authedRequest({ addr, method: 'POST', path: p, body: JSON.stringify(obj), identity: as, accept: new Map([[IDS[n].fp, crypto.createPublicKey(IDS[n].key)]]), dks, timeout: 10_000 })
  return { status: r.status, data: JSON.parse(r.text) }
}
function envelope(to, body, extra = {}, key = TESTER.key) {
  const e = { id: crypto.randomUUID(), from: 'tester@t.test', to, body, sent_at: Date.now(), expires_at: Date.now() + 3600_000, ...extra }
  return { ...e, sig: signEnvelope(key, e) }
}
/** An HTTPS request with no client certificate (an outsider). */
function outsiderGet(port, p) {
  return new Promise(resolve => {
    const s = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
      s.write(`GET ${p} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)
    })
    let buf = ''
    s.on('data', c => { buf += c })
    s.on('end', () => resolve(Number(buf.match(/^HTTP\/1\.1 (\d+)/)?.[1] || 0)))
    s.on('error', () => resolve(0))
  })
}
const curlBin = ['/usr/bin/curl', '/bin/curl'].find(p => fs.existsSync(p)) || 'curl'

async function killPorts() {
  for (const p of [...Object.values(NODES), ...EXTRA_PORTS]) {
    let pids = ''
    try { pids = execFileSync('lsof', ['-ti', `tcp:${p}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim() } catch {}
    for (const pid of pids.split('\n').filter(Boolean)) try { process.kill(Number(pid)) } catch {}
  }
}

let passed = 0
async function step(name, fn) {
  process.stdout.write(`- ${name} ... `)
  await fn()
  passed++
  console.log('ok')
}

try {
  await killPorts()
  for (const n of ['a', 'b', 'c', 'd']) home(n)
  await Promise.all(['a', 'b', 'c'].map(startNode))

  let bob
  await step('adapter connects and learns its address', async () => {
    bob = await adapter('b', 'bob')
    assert.match(bob.instructions, /bob@b\.test/)
    const tools = (await bob.client.listTools()).tools.map(t => t.name).sort()
    assert.deepEqual(tools, ['inbox', 'peers', 'send'])
  })

  await step('live delivery wakes the session (channel notification)', async () => {
    const out = cli('a', 'send', 'bob@b.test', 'hello bob')
    assert.match(out, /pushed to bob@b\.test.s live session/)
    await waitFor(() => bob.got.length === 1, 5000, 'notification')
    assert.equal(bob.got[0].content, 'hello bob')
    assert.equal(bob.got[0].meta.from, 'cli@a.test')
    assert.ok(bob.got[0].meta.msg_id)
  })

  await step('peers lists remote sessions', async () => {
    const txt = await bob.call('peers')
    assert.match(txt, /You are bob@b\.test/)
    assert.match(txt, /b\.test \(this machine\): bob/)
    assert.match(txt, /a\.test: \(no agents connected\)/)
  })

  await step('session offline: stored on recipient node, delivered on connect', async () => {
    await bob.close()
    await sleep(300)
    const out = cli('a', 'send', 'bob@b.test', 'while you were out')
    assert.match(out, /stored on b\.test/)
    bob = await adapter('b', 'bob')
    await waitFor(() => bob.got.length === 1, 5000, 'queued notification')
    assert.equal(bob.got[0].content, 'while you were out')
  })

  await step('machine offline: copy held by another node, delivered when it returns (sender offline too)', async () => {
    await bob.close()
    await stopNode('b')
    const out = cli('a', 'send', 'bob@b.test', 'held for you')
    assert.match(out, /b\.test unreachable/)
    assert.match(out, /offering copies to other online machines/)
    await waitFor(() => JSON.parse(cli('a', 'status')).pending.some(p => p.replicated), 10000, 'copy handed to c')
    await stopNode('a')                     // the sender goes away too: only c has it now
    await startNode('b')                    // b says hello to c -> c delivers
    bob = await adapter('b', 'bob')
    await waitFor(() => bob.got.length === 1, 10000, 'held message via c')
    assert.equal(bob.got[0].content, 'held for you')
    assert.equal(bob.got[0].meta.from, 'cli@a.test')
  })

  await step('duplicates suppressed when sender also delivers later', async () => {
    await startNode('a')                    // a still has its outbox copy and retries
    await sleep(4000)
    assert.equal(bob.got.length, 1)
    const st = JSON.parse(cli('a', 'status'))
    assert.equal(st.pending.length, 0, 'a has nothing pending')
  })

  await step('poll-mode agent (no channels) sends/receives via tools', async () => {
    const carol = await adapter('c', 'carol', true)
    assert.equal(carol.got.length, 0)
    const out = await bob.call('send', { to: 'carol@c.test', message: 'hi carol, from bob' })
    assert.match(out, /stored on c\.test; carol will get it/, "a poll-mode session is not told it was pushed live")
    await sleep(300)
    const inbox = await carol.call('inbox')
    assert.match(inbox, /from bob@b\.test/)
    assert.match(inbox, /hi carol, from bob/)
    assert.equal(await carol.call('inbox'), 'No new messages.')
    const reply = await carol.call('send', { to: 'bob@b.test', message: 'hi bob' })
    assert.match(reply, /live/)
    await waitFor(() => bob.got.some(g => g.content === 'hi bob'), 5000, 'reply')
    await carol.close()
  })

  await step('local (same machine) messaging and history', async () => {
    const bob2 = await adapter('b', 'bob')   // name collision -> bob-2
    assert.match(bob2.instructions, /bob-2@b\.test/)
    await bob2.call('send', { to: 'bob', message: 'local hi' })
    await waitFor(() => bob.got.some(g => g.content === 'local hi' && g.meta.from === 'bob-2@b.test'), 5000, 'local msg')
    const hist = await bob.call('inbox', { limit: 50 })
    assert.match(hist, /held for you/)
    await bob2.close()
  })

  await step('a node from a different network, and outsiders, are refused', async () => {
    await startNode('d')
    for (const p of ['/v1/auth', '/v1/sessions', '/health', '/local/status']) assert.equal(await outsiderGet(NODES.b, p), 404, `${p} tells outsiders nothing`)
    await assert.rejects(memberPost('b', '/v1/hello', { records: OTHER_NET.records }, IDS.d, OTHER_NET.dks), /not the expected machine/, 'another network: not let through the gate')
    assert.equal((await memberPost('b', '/v1/hello', { records: OTHER_NET.records }, IDS.d)).status, 403, 'a non-member key, even holding the discovery key and its own records')
    const out = cli('d', 'send', 'bob@b.test', 'intruder')
    assert.match(out, /unreachable/)
    await sleep(500)
    assert.ok(!bob.got.some(g => g.content === 'intruder'))
  })

  await step('a node\'s key is not shown to anyone who connects, and identity proofs cannot be relayed', async () => {
    const one = await peerCertificate(`127.0.0.1:${NODES.b}`)
    await sleep(1100)
    const two = await peerCertificate(`127.0.0.1:${NODES.b}`)
    assert.notEqual(one.fp, two.fp, 'a different throwaway key each time')
    assert.ok(![one.fp, two.fp].includes(IDS.b.fp), 'never the machine key')
    // a relay in the middle (its own TLS session to each side) can't pass the proofs on, even
    // knowing the discovery key: they are bound to the TLS session they were made on
    const relay = tls.createServer({ key: TESTER.key, cert: TESTER.cert }, s => {
      const up = tls.connect({ host: '127.0.0.1', port: NODES.b, rejectUnauthorized: false })
      s.pipe(up).pipe(s)
      for (const x of [s, up]) x.on('error', () => { s.destroy(); up.destroy() })
    })
    await new Promise(r => relay.listen(EXTRA_PORTS[0], '127.0.0.1', r))
    await assert.rejects(memberPost('b', '/v1/sessions', {}, TESTER, NET.dks, `127.0.0.1:${EXTRA_PORTS[0]}`), /not the expected machine/)
    relay.close()
  })

  await step('a member cannot send as another machine, and relayed envelopes cannot be altered', async () => {
    const forged = envelope('bob@b.test', 'forged', { from: 'x@a.test' })           // signed by t.test, claims a.test
    const altered = { ...envelope('bob@b.test', 'original'), body: 'altered' }
    const r = await memberPost('b', '/v1/deliver', { messages: [forged, altered] })
    assert.equal(r.status, 200)
    assert.deepEqual(r.data.results, {})
    await sleep(300)
    assert.ok(!bob.got.some(g => g.content === 'forged' || g.content === 'altered'))
  })

  await step('node restarts transparently under a connected session', async () => {
    await stopNode('b')
    await startNode('b')
    await sleep(1500)                         // adapter reconnects (takeover keeps its name)
    cli('a', 'send', 'bob@b.test', 'after restart')
    await waitFor(() => bob.got.some(g => g.content === 'after restart'), 8000, 'post-restart delivery')
  })

  await step('laptop on a hostile network: strangers at stored addresses receive nothing', async () => {
    // a has b's stored address. b goes away and strangers take over that address: first an HTTPS
    // server (as another network's node would answer), then a plain TCP server. Everything they
    // receive is recorded: at most the gate step, which names nobody.
    await bob.close()
    await stopNode('b')
    const stranger = newIdentity()
    let plain = Buffer.alloc(0)
    const seen = []
    const SECRET_BODY = 'TOP-SECRET-CAFE-MESSAGE'
    const https = await import('node:https')
    const tlsImp = https.createServer({ key: stranger.key, cert: stranger.cert }, (req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => { seen.push(`${req.method} ${req.url} ${JSON.stringify(req.headers)} ${body}`); res.writeHead(404); res.end('{"error":"not found"}') })
    })
    tlsImp.on('tlsClientError', () => {})
    await new Promise(r => tlsImp.listen(NODES.b, '127.0.0.1', r))
    let out = await cliAsync('a', 'send', 'bob@b.test', SECRET_BODY)
    assert.match(out, /b\.test unreachable \(.*different machine/)
    await stopNode('a'); await startNode('a')            // startup: hello to every member, retry everything
    await sleep(3000)
    await new Promise(r => tlsImp.close(r))
    const plainImp = net.createServer(s => { s.on('data', c => { plain = Buffer.concat([plain, c]); s.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n{}') }); s.on('error', () => {}) })
    await new Promise(r => plainImp.listen(NODES.b, '127.0.0.1', r))
    await stopNode('a'); await startNode('a')
    out = await cliAsync('a', 'send', 'bob@b.test', SECRET_BODY)
    assert.match(out, /unreachable/)
    await sleep(3000)
    await new Promise(r => plainImp.close(r))
    assert.ok(seen.length > 0, 'a tried the address')
    for (const r of seen) {
      assert.match(r, /^GET \/v1\/auth /, 'only the gate step, never a request')
      for (const x of [SECRET_BODY, 'a.test', 'b.test', 'x-agentlink-auth', IDS.a.fp, IDS.b.fp]) assert.ok(!r.includes(x), `no "${x}" sent to the stranger`)
    }
    assert.ok(plain.length > 0 && plain[0] === 0x16, 'the plain stranger saw only TLS handshakes')
    for (const s of [SECRET_BODY, 'POST', 'GET', 'b.test', 'c.test', 'deliver', 'hello']) assert.ok(!plain.includes(s), `no "${s}" in what the stranger received`)
    const st = JSON.parse(cli('a', 'status'))
    assert.ok(st.pending.some(p => p.to_addr === 'bob@b.test'), 'still queued')
    // b returns: everything queued is delivered
    await startNode('b')
    bob = await adapter('b', 'bob')
    await waitFor(() => bob.got.filter(g => g.content === SECRET_BODY).length >= 1, 15000, 'delivery once b is back')
  })

  await step('peer configured by IP:port is mapped to its real name (internet/Tailscale joins)', async () => {
    home('e', { peers: [`127.0.0.1:${NODES.b}`], routes: {} })
    await startNode('e')
    await waitFor(() => JSON.parse(cli('e', 'status')).peers.some(p => p.host === 'b.test' && p.addr === `127.0.0.1:${NODES.b}`), 5000, 'b.test learned')
    const out = cli('e', 'send', 'bob@b.test', 'via ip alias')
    assert.match(out, /pushed to bob@b\.test.s live session/)
    await waitFor(() => bob.got.some(g => g.content === 'via ip alias'), 5000, 'alias delivery')
    const peers = cli('e', 'peers')
    assert.match(peers, /b\.test: bob/)
    assert.doesNotMatch(peers, /127\.0\.0\.1/)
  })

  await step('sending to an alias of the recipient machine is delivered', async () => {
    const out = cli('e', 'send', 'bob@127.0.0.1', 'to the alias')   // e knows 127.0.0.1 is b.test
    assert.match(out, /pushed to bob@b\.test.s live session/)
    await waitFor(() => bob.got.some(g => g.content === 'to the alias'), 5000, 'alias-addressed message')
  })

  await step('a machine reached under another of its names takes delivery itself', async () => {
    // from b, 127.0.0.1 dials b itself: it must learn that and deliver locally, not "forward" forever
    const out = cli('b', 'send', 'bob@127.0.0.1', 'to myself by IP')
    assert.match(out, /is this machine/)
    await waitFor(() => bob.got.some(g => g.content === 'to myself by IP'), 5000, 'self-alias delivery')
    assert.ok(JSON.parse(cli('b', 'status')).aliases.includes('127.0.0.1'))
  })

  await step('a configured machine whose address now reaches us is not mistaken for this machine', async () => {
    // f is configured with peer ghost.test at f's own port (think: DHCP reuse, or spoofed .local resolution)
    home('f', { peers: [`ghost.test:${NODES.f}`], routes: {} })
    await startNode('f')
    const fred = await adapter('f', 'x')
    await sleep(500)
    const out = cli('f', 'send', 'x@ghost.test', 'not for f')
    assert.match(out, /unreachable/)
    await sleep(1000)
    assert.ok(!fred.got.some(g => g.content === 'not for f'), 'must not be delivered locally')
    const st = JSON.parse(cli('f', 'status'))
    assert.ok(!st.aliases.includes('ghost.test'))
    await fred.close()
    await stopNode('f')
  })

  await step('a large backlog for an offline machine is delivered in size-limited batches', async () => {
    await bob.close()
    await stopNode('b')
    const big = 'x'.repeat(60_000)
    const N = 40                              // ~2.4 MB: more than one request may carry
    for (let i = 0; i < N; i++) cli('a', 'send', 'bob@b.test', `${i} ${big}`)
    await startNode('b')
    bob = await adapter('b', 'bob')
    await waitFor(() => bob.got.filter(g => g.content.endsWith(big)).length === N, 20000, 'all big messages')
  })

  await step('a session without the channel enabled keeps messages for its inbox tool', async () => {
    const dora = await adapter('b', 'dora', 'plain')
    assert.match(dora.instructions, /inbox tool/)
    cli('a', 'send', 'dora@b.test', 'pull me')
    await sleep(1000)
    assert.equal(dora.got.length, 0, 'not pushed into a session that would drop it')
    assert.match(await dora.call('inbox'), /pull me/)
    assert.equal(await dora.call('inbox'), 'No new messages.')
    await dora.close()
  })

  await step('beacons: outsiders\' are ignored, and a replayed one pointing elsewhere redirects nothing', async () => {
    home('g', { discovery: true, discoveryPort: 17787, peers: [], routes: {} })
    await startNode('g')
    const dgram = await import('node:dgram')
    const send = async buf => { const s = dgram.createSocket('udp4'); await new Promise(r => s.send(buf, 17787, '127.0.0.1', r)); s.close() }
    // an outsider's beacon (wrong key), and a member's beacon replayed to point at g's own port
    await send(sealBeacon(crypto.randomBytes(32).toString('base64'), { host: 'b.test', fp: IDS.b.fp, port: NODES.b, ts: Date.now(), reply: true }))
    await send(sealBeacon(NET.dk, { host: 'b.test', fp: IDS.b.fp, port: NODES.g, ts: Date.now(), reply: true }))
    await sleep(1500)
    let st = JSON.parse(cli('g', 'status'))
    assert.ok(!st.aliases.includes('b.test'), 'did not adopt b.test as its own name')
    assert.ok(!st.peers.some(p => p.host === 'b.test' && p.addr), 'neither beacon gave b.test an address')
    // control: a genuine beacon for b's real address is learned
    await send(sealBeacon(NET.dk, { host: 'b.test', fp: IDS.b.fp, port: NODES.b, ts: Date.now(), reply: true }))
    await waitFor(() => JSON.parse(cli('g', 'status')).peers.some(p => p.host === 'b.test' && p.addr === `127.0.0.1:${NODES.b}`), 5000, 'direct address learned')
    await stopNode('g')
  })

  await step('a stale route to another member is refused at the handshake', async () => {
    // h's route for c.test now reaches a.test (DHCP reuse)
    home('h', { peers: ['c.test'], routes: { ...routes, 'c.test': `127.0.0.1:${NODES.a}` } })
    await startNode('h')
    const out = cli('h', 'send', 'x@c.test', 'for c only')
    assert.doesNotMatch(out, /pushed to|stored on/)
    assert.match(out, /unreachable \(.*different machine/)
    const st = JSON.parse(cli('h', 'status'))
    assert.ok(!st.peers.find(p => p.host === 'c.test')?.alias_of, 'c.test is not recorded as an alias of a.test')
    await stopNode('h')
  })

  await step('a relay in the middle sees only ciphertext', async () => {
    await ensureNode('b')
    home('j', { peers: ['b.test'], routes: { 'b.test': '127.0.0.1:17791' } })
    let seen = Buffer.alloc(0)
    const relay = net.createServer(sock => {
      const up = net.connect(NODES.b, '127.0.0.1')
      sock.on('data', c => { seen = Buffer.concat([seen, c]) })
      sock.pipe(up).pipe(sock)
      up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy())
    })
    await new Promise(r => relay.listen(17791, '127.0.0.1', r))
    await startNode('j')
    const out = await cliAsync('j', 'send', 'bob@b.test', 'RELAYED-SECRET')
    assert.match(out, /pushed to bob@b\.test.s live session/)
    await waitFor(() => bob.got.some(g => g.content === 'RELAYED-SECRET'), 5000, 'relayed delivery')
    assert.ok(seen.length > 0 && !seen.includes('RELAYED-SECRET') && !seen.includes('bob@'), 'relay saw no plaintext')
    relay.close()
    await stopNode('j')
  })

  await step('an envelope with out-of-range timestamps is rejected and forwarding keeps working', async () => {
    await ensureNode('a'); await ensureNode('b')
    const bad = envelope('nobody@b.test', 'poison', { expires_at: 2 ** 60 })
    const r = await memberPost('a', '/v1/deliver', { messages: [bad] })
    assert.equal(r.status, 200)
    assert.deepEqual(r.data.results, {}, 'rejected')
    // a row stored by an older version is dropped at startup instead of halting the flush loop
    await stopNode('a')
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path.join(ROOT, 'a', 'agentlink.db'))
    db.prepare(`INSERT INTO messages (id,from_addr,to_addr,to_host,to_name,body,sent_at,expires_at,sig,role,state,next_attempt,updated_at)
      VALUES ('poison','x@a.test','y@b.test','b.test','y','p',1,?,'s','outbox','pending',0,1)`).run(2n ** 60n)
    db.close()
    await startNode('a')
    assert.match(fs.readFileSync(path.join(ROOT, 'a', 'node.log'), 'utf8'), /dropped 1 stored message/)
    assert.match(cli('a', 'send', 'bob@b.test', 'still flowing'), /pushed to bob@b\.test.s live session/)
    await waitFor(() => bob.got.some(g => g.content === 'still flowing'), 5000, 'delivery after poison')
  })

  await step('a large batch for a live session does not freeze the node', async () => {
    await ensureNode('b')
    const msgs = Array.from({ length: 2000 }, (_, i) => envelope('bob@b.test', `batch ${i}`))
    const t = Date.now()
    const r = await memberPost('b', '/v1/deliver', { messages: msgs })
    const took = Date.now() - t
    assert.equal(Object.keys(r.data.results).length, 2000)
    assert.ok(took < 5000, `batch handled in ${took} ms`)
    await waitFor(() => bob.got.filter(g => g.content.startsWith('batch ')).length === 2000, 15000, 'all batch messages pushed')
  })

  await step('a gossiped address is only used once the machine there proves who it is', async () => {
    await ensureNode('a'); await ensureNode('c')
    // a member tells a that laptop.test (not a member) and h.test (a member) are at c's address
    const r = await memberPost('a', '/v1/hello', { peers: [{ host: 'laptop.test', addr: `127.0.0.1:${NODES.c}` }, { host: 'h.test', addr: `127.0.0.1:${NODES.c}` }] })
    assert.equal(r.status, 200)
    await sleep(1000)
    const st = JSON.parse(cli('a', 'status'))
    assert.ok(!st.peers.some(p => p.host === 'laptop.test'), 'a non-member name is ignored')
    assert.ok(!st.peers.some(p => p.host === 'h.test' && p.addr === `127.0.0.1:${NODES.c}`), 'a wrong address for a member is not adopted')
    const out = cli('a', 'send', 'bob@laptop.test', 'for the laptop only')
    assert.doesNotMatch(out, /pushed to|stored on/, 'not handed to c.test')
  })

  // ---- setup, invites, joining, removal (real `agentlink setup`, nodes on ports i/k/l) ----
  const setupEnv = (n, extra = {}) => ({ ...process.env, AGENTLINK_HOME: path.join(ROOT, `s-${n}`), AGENTLINK_PORT: String(NODES[n]), AGENTLINK_HOST: `${n}.test`, AGENTLINK_DISCOVERY: '0', AGENTLINK_AUTO_ALIASES: '0', ...extra })
  const setup = (n, args = [], extra = {}) => spawnSync(process.execPath, ['--no-warnings', BIN, 'setup', ...args, '--no-service', '--no-claude', '--no-alias'], { env: setupEnv(n, extra), encoding: 'utf8', timeout: 60_000 })
  const scli = (n, ...args) => spawnSync(process.execPath, ['--no-warnings', BIN, ...args], { env: setupEnv(n), encoding: 'utf8', timeout: 30_000 })
  const sLocal = n => new Local({ identity: readIdentity(path.join(ROOT, `s-${n}`)), port: NODES[n], dir: path.join(ROOT, `s-${n}`) })
  const parseInvite = out => {
    const m = out.match(/curl -fsSL -k --pinnedpubkey "sha256\/\/([^"]+)" "https:\/\/[^/]+\/join\/install\?t=([^"]+)"/)
    assert.ok(m, `an invite line in:\n${out}`)
    return { pin: m[1], token: m[2] }
  }
  const joinArgs = (inv, port = NODES.i) => ['--join', `127.0.0.1:${port}`, '--pin', inv.pin, '--token', inv.token]

  let inv
  await step('setup creates a network and keeps it; --new-network starts over', async () => {
    let r = setup('i')
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /New network created/)
    inv = parseInvite(r.stdout)
    const fp1 = readIdentity(path.join(ROOT, 's-i')).fp
    assert.notEqual(inv.pin, fp1, 'the invite pins an invite key, not the machine key')
    assert.equal((await peerCertificate(`127.0.0.1:${NODES.i}`)).fp, inv.pin, 'presented while the invite is open')
    const first = inv
    r = setup('i')
    assert.equal(r.status, 0, r.stderr)
    assert.doesNotMatch(r.stdout, /New network created/)
    assert.equal(readIdentity(path.join(ROOT, 's-i')).fp, fp1, 'key kept')
    r = setup('i', ['--new-network'])
    assert.match(r.stdout, /New network created/)
    assert.notEqual(readIdentity(path.join(ROOT, 's-i')).fp, fp1, 'new key')
    const h = await sLocal('i').health()
    assert.equal(h.fp, readIdentity(path.join(ROOT, 's-i')).fp, 'the old node was stopped and the new one runs')
    inv = parseInvite(r.stdout)
    assert.notEqual(inv.pin, first.pin, 'a new network gets a new invite key')
    assert.equal(spawnSync(curlBin, ['-fsSL', '-k', `https://127.0.0.1:${NODES.i}/join/install?t=${first.token}`]).status, 22, 'the old network\'s invites are gone')
  })

  await step('the invite line works with real curl, and only with the right key', async () => {
    const url = `https://127.0.0.1:${NODES.i}/join/install?t=${inv.token}`
    const good = spawnSync(curlBin, ['-fsSL', '-k', '--pinnedpubkey', `sha256//${inv.pin}`, url], { encoding: 'utf8' })
    assert.equal(good.status, 0, good.stderr)
    assert.match(good.stdout, /AGENTLINK_PIN=/)
    assert.match(good.stdout, /--token/)
    const bad = spawnSync(curlBin, ['-fsSL', '-k', '--pinnedpubkey', `sha256//${newIdentity().fp}`, url], { encoding: 'utf8' })
    assert.notEqual(bad.status, 0, 'a different key (an impostor serving the installer) is refused')
    assert.equal(spawnSync(curlBin, ['-fsSL', '-k', `https://127.0.0.1:${NODES.i}/join/install?t=wrong-token`]).status, 22, 'a wrong token gets nothing')
  })

  await step('a machine joins with an invite; the invite is then spent', async () => {
    const r = setup('k', joinArgs(inv))
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /Joined the network via i\.test/)
    const iStatus = JSON.parse(scli('i', 'status').stdout)
    assert.deepEqual(iStatus.members.map(m => m.host).sort(), ['i.test', 'k.test'])
    assert.equal(iStatus.members.find(m => m.host === 'k.test').added_by, 'i.test')
    // the token is single-use
    const again = setup('l', joinArgs(inv))
    assert.notEqual(again.status, 0)
    assert.match(again.stderr, /not presenting this invite's key\. Either the invite was already used/)
    // the invite key went with the last open invite: back to throwaway keys
    const after = await peerCertificate(`127.0.0.1:${NODES.i}`)
    assert.ok(![inv.pin, readIdentity(path.join(ROOT, 's-i')).fp].includes(after.fp), 'neither the spent invite key nor the machine key')
    // k can message i (k learns i's address from the join address)
    await waitFor(() => JSON.parse(scli('k', 'status').stdout).peers.some(p => p.host === 'i.test' && p.addr), 8000, 'k knows where i is')
    assert.match(scli('k', 'send', 'x@i.test', 'hello from k').stdout, /stored on i\.test/)
  })

  await step('joining is refused for a wrong key, a taken name, and expired or revoked invites', async () => {
    // an invite whose pin doesn't match the machine at the address (someone in the middle)
    let fresh = parseInvite(scli('i', 'invite').stdout)
    let r = setup('l', joinArgs({ ...fresh, pin: newIdentity().fp }))
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /not presenting this invite's key/)
    // a name that's already a member
    r = setup('l', joinArgs(fresh), { AGENTLINK_HOST: 'k.test' })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /k\.test is already a member/)
    // revoked
    assert.match(scli('i', 'invite', '--revoke').stdout, /revoked [1-9]/)
    r = setup('l', joinArgs(fresh))
    assert.match(r.stderr, /not presenting this invite's key/, 'no invite open: its key is gone')
    // expired, while another invite is open (both pin the same invite key, so the token decides)
    fresh = parseInvite(scli('i', 'invite').stdout)
    const other = parseInvite(scli('i', 'invite').stdout)
    assert.equal(other.pin, fresh.pin, 'open invites share the invite key')
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path.join(ROOT, 's-i', 'agentlink.db'))
    db.prepare(`UPDATE invites SET expires_at=1 WHERE hash=?`).run(crypto.createHash('sha256').update(fresh.token).digest('base64url'))
    db.close()
    r = setup('l', joinArgs(fresh))
    assert.match(r.stderr, /not valid \(already used, expired or revoked\)/)
    scli('i', 'invite', '--revoke')
  })

  await step('a removed machine can neither send nor receive', async () => {
    const r = scli('i', 'remove', 'k.test')
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /removed k\.test/)
    const iStatus = JSON.parse(scli('i', 'status').stdout)
    assert.deepEqual(iStatus.members.map(m => m.host), ['i.test'])
    const out = scli('k', 'send', 'x@i.test', 'after removal').stdout
    assert.doesNotMatch(out, /pushed to|stored on/)
    assert.match(scli('i', 'send', 'x@k.test', 'to the removed').stdout, /removed from the network/)
    assert.match(scli('i', 'remove', 'i.test').stderr, /agentlink uninstall/)
  })

  await step('a member that was offline learns of a removal when it comes back', async () => {
    await ensureNode('a'); await ensureNode('c')
    await stopNode('c')
    assert.match(cli('a', 'remove', 'e.test'), /removed e\.test/)
    await startNode('c')
    await waitFor(() => !JSON.parse(cli('c', 'status')).members.some(m => m.host === 'e.test'), 8000, 'c learns e was removed')
    // and the removed machine (which doesn't know it was removed) is refused by c too
    await stopNode('e')
    home('e')
    await startNode('e')
    assert.doesNotMatch(cli('e', 'send', 'x@c.test', 'still here?'), /pushed to|stored on/)
    await stopNode('e')
  })

  await step('a standing-by node does not start after uninstall', async () => {
    const env = setupEnv('i')
    const standby = spawn(process.execPath, ['--no-warnings', BIN, 'node'], { env, stdio: 'ignore' })
    await sleep(1000)
    fs.writeFileSync(path.join(ROOT, 's-i', 'disabled'), '')        // what `agentlink uninstall` writes first
    await sLocal('i').req('POST', '/local/shutdown')
    const exited = await Promise.race([new Promise(r => standby.once('exit', () => r(true))), sleep(8000).then(() => false)])
    if (!exited) standby.kill('SIGKILL')
    assert.ok(exited, 'standby node exited instead of taking over')
    assert.equal(await sLocal('i').health(), null)
  })

  await step('setup: bad config, bad --host and old-style secrets never change the network', async () => {
    const dir = path.join(ROOT, 's-i')
    const cfgFile = path.join(dir, 'config.json')
    assert.equal(setup('i').status, 0)
    const fp = readIdentity(dir).fp
    // an old-style secret argument is refused with a pointer to invites
    let r = setup('i', ['some-old-shared-secret-0123456789'])
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /no longer uses a shared network secret/)
    // an invalid --host is refused before anything is written
    const before = fs.readFileSync(cfgFile, 'utf8')
    r = setup('i', ['--host', 'my_host'])
    assert.notEqual(r.status, 0)
    assert.equal(fs.readFileSync(cfgFile, 'utf8'), before)
    // a config with a syntax error stops setup instead of minting a new network
    fs.writeFileSync(cfgFile, before.replace(/\}\s*$/, ',}'))
    r = setup('i')
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /bad config/)
    assert.doesNotMatch(r.stdout, /New network created/)
    assert.equal(readIdentity(dir).fp, fp)
    fs.writeFileSync(cfgFile, before)
    // the home directory and key are private even if something created the directory world-readable first
    fs.chmodSync(dir, 0o755)
    assert.equal(setup('i').status, 0)
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
    assert.equal(fs.statSync(path.join(dir, 'node.key')).mode & 0o077, 0)
  })

  await step('a node started on demand exits when one is already running', async () => {
    assert.ok(await sLocal('i').health(), 'a node is running')
    const r = spawnSync(process.execPath, ['--no-warnings', BIN, 'node', '--on-demand'], { env: setupEnv('i'), encoding: 'utf8', timeout: 10_000 })
    assert.equal(r.status, 0, 'exited on its own')
    assert.match(r.stderr, /already running/)
  })

  await step('local clients refuse a process squatting on the node port', async () => {
    const id = readIdentity(path.join(ROOT, 'a'))
    const local = new Local({ identity: id, port: 17792, dir: path.join(ROOT, 'a') })
    // a plain HTTP squatter, then a TLS squatter with its own key
    const http = await import('node:http')
    const plain = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"pid":1}') })
    await new Promise(r => plain.listen(17792, '127.0.0.1', r))
    await assert.rejects(local.ensureNode(), /not this machine's agentlink node/)
    await assert.rejects(local.req('POST', '/local/send', { to: 'x', body: 'y' }), /not answered by this machine's agentlink node/)
    await new Promise(r => plain.close(r))
    const other = newIdentity()
    const https = await import('node:https')
    const tlsSq = https.createServer({ key: other.key, cert: other.cert }, (req, res) => { res.writeHead(200); res.end('{"ok":true,"pid":1}') })
    await new Promise(r => tlsSq.listen(17792, '127.0.0.1', r))
    await assert.rejects(local.ensureNode(), /not this machine's agentlink node/)
    await assert.rejects(local.req('POST', '/local/send', { to: 'x', body: 'y' }), /not answered by this machine's agentlink node/)
    await assert.rejects(local.stream('x', 't', () => {}), /not answered by this machine's agentlink node/)
    tlsSq.close()
  })

  await bob.close()
  console.log(`\nall ${passed} steps passed`)
} catch (e) {
  console.log('FAILED')
  console.error(e)
  for (const n of [...Object.keys(NODES), ...Object.keys(NODES).map(n => `s-${n}`)]) {
    try { console.error(`--- ${n}/node.log ---\n` + fs.readFileSync(path.join(ROOT, n, 'node.log'), 'utf8').slice(-2000)) } catch {}
  }
  process.exitCode = 1
} finally {
  for (const n of Object.keys(procs)) await stopNode(n)
  await killPorts()   // nodes auto-started by adapters and setup are not our children
  if (!process.exitCode) fs.rmSync(ROOT, { recursive: true, force: true })
  process.exit()   // don't wait on stray handles (a failed step may leave adapters or timers behind)
}
