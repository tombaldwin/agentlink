// End-to-end test: three nodes (a, b, c) on localhost with distinct ports, plus MCP adapters.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawn, execFileSync, execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agentlink.js')
const ROOT = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'agentlink-e2e-'))
const SECRET = 'test-secret-0123456789abcdef0123456789'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const NODES = { a: 17771, b: 17772, c: 17773, d: 17774, e: 17775, f: 17776, g: 17777, h: 17778, i: 17779 }
const routes = Object.fromEntries(Object.entries(NODES).map(([n, p]) => [`${n}.test`, `127.0.0.1:${p}`]))

function home(n, secret = SECRET) {
  const dir = path.join(ROOT, n)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    secret, host: `${n}.test`, port: NODES[n], discovery: false, routes, autoAliases: false,
    peers: Object.keys(NODES).filter(x => ['a', 'b', 'c'].includes(x) && x !== n).map(x => `${x}.test`),
  }))
  return dir
}
const envFor = n => ({ ...process.env, AGENTLINK_HOME: path.join(ROOT, n) })

const procs = {}
async function startNode(n) {
  const out = fs.openSync(path.join(ROOT, n, 'node.log'), 'a')
  procs[n] = spawn(process.execPath, ['--no-warnings', BIN, 'node'], { env: envFor(n), stdio: ['ignore', out, out] })
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${NODES[n]}/health`)).ok) return } catch {}
    await sleep(100)
  }
  throw new Error(`node ${n} did not start`)
}
async function stopNode(n) {
  const p = procs[n]
  if (!p || p.exitCode !== null) return
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

async function killPorts() {
  for (const p of Object.values(NODES)) {
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
  for (const n of ['a', 'b', 'c', 'd']) home(n, n === 'd' ? 'some-other-network-secret-xxxxxxxxxx' : SECRET)
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
    assert.match(out, /delivered to bob@b\.test \(live\)/)
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
    assert.match(out, /handing copies to other online nodes/)
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
    assert.match(out, /delivered to carol@c\.test/)
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

  await step('node from a different network is rejected', async () => {
    await startNode('d')
    const r = await fetch(`http://127.0.0.1:${NODES.b}/v1/sessions`)
    assert.equal(r.status, 401)
    const out = cli('d', 'send', 'bob@b.test', 'intruder')
    assert.match(out, /unreachable|FAILED|unauthorized/)
    await sleep(500)
    assert.ok(!bob.got.some(g => g.content === 'intruder'))
  })

  await step('node restarts transparently under a connected session', async () => {
    await stopNode('b')
    await startNode('b')
    await sleep(1500)                         // adapter reconnects (takeover keeps its name)
    cli('a', 'send', 'bob@b.test', 'after restart')
    await waitFor(() => bob.got.some(g => g.content === 'after restart'), 8000, 'post-restart delivery')
  })

  await step('peer configured by IP:port is mapped to its real name (internet/Tailscale joins)', async () => {
    const dir = path.join(ROOT, 'e')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      secret: SECRET, host: 'e.test', port: NODES.e, discovery: false, autoAliases: false, peers: [`127.0.0.1:${NODES.b}`],
    }))
    await startNode('e')
    await sleep(800)                          // startup hello learns 127.0.0.1:17772 is b.test
    const out = cli('e', 'send', 'bob@b.test', 'via ip alias')
    assert.match(out, /delivered to bob@b\.test \(live\)/)
    await waitFor(() => bob.got.some(g => g.content === 'via ip alias'), 5000, 'alias delivery')
    const peers = cli('e', 'peers')
    assert.match(peers, /b\.test: bob/)
    assert.doesNotMatch(peers, /127\.0\.0\.1/)
  })

  await step('sending to an alias of the recipient machine is delivered', async () => {
    const out = cli('e', 'send', 'bob@127.0.0.1', 'to the alias')   // e knows 127.0.0.1 is b.test
    assert.match(out, /delivered to bob@b\.test \(live\)/)
    await waitFor(() => bob.got.some(g => g.content === 'to the alias'), 5000, 'alias-addressed message')
  })

  await step('a machine reached under another of its names takes delivery itself', async () => {
    // from b, 127.0.0.1 dials b itself: it must learn that and deliver locally, not "forward" forever
    const out = cli('b', 'send', 'bob@127.0.0.1', 'to myself by IP')
    assert.match(out, /is this machine/)
    await waitFor(() => bob.got.some(g => g.content === 'to myself by IP'), 5000, 'self-alias delivery')
    assert.ok(JSON.parse(cli('b', 'status')).aliases.includes('127.0.0.1'))
  })

  await step('a known machine whose address now reaches us is not mistaken for this machine', async () => {
    // f is configured with peer ghost.test at f's own port (think: DHCP reuse, or spoofed .local resolution)
    const dir = path.join(ROOT, 'f')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      secret: SECRET, host: 'f.test', port: NODES.f, discovery: false, autoAliases: false, peers: [`ghost.test:${NODES.f}`],
    }))
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

  await step('a fake node without the secret cannot claim delivery', async () => {
    const http = await import('node:http')
    const fake = http.createServer((req, res) => {
      let b = ''
      req.on('data', c => { b += c })
      req.on('end', () => {
        const ids = (() => { try { return JSON.parse(b).messages.map(m => m.id) } catch { return [] } })()
        res.writeHead(200, { 'content-type': 'application/json', 'x-agentlink-node': 'fake.test;net=whatever;port=1' })
        res.end(JSON.stringify({ results: Object.fromEntries(ids.map(id => [id, 'live'])), host: 'fake.test' }))
      })
    })
    await new Promise(r => fake.listen(17790, r))
    const cfgPath = path.join(ROOT, 'a', 'config.json')
    const conf = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    conf.routes['fake.test'] = '127.0.0.1:17790'
    fs.writeFileSync(cfgPath, JSON.stringify(conf))
    await stopNode('a'); await startNode('a')
    const out = await cliAsync('a', 'send', 'x@fake.test', 'secret stuff')   // async: the fake server runs in this process
    assert.doesNotMatch(out, /delivered|stored on/)
    assert.match(out, /not an agentlink node/)
    fake.close()
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

  await step('a replayed beacon pointing at our own address does not change our identity', async () => {
    const dir = path.join(ROOT, 'g')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      secret: SECRET, host: 'g.test', port: NODES.g, discovery: true, discoveryPort: 17787, autoAliases: false, peers: [],
    }))
    await startNode('g')
    // a signed beacon for victim.test, "sent" from 127.0.0.1 and naming g's own port: probing it reaches g
    const { signBeacon } = await import('../src/crypto.js')
    const { networkId } = await import('../src/config.js')
    const b = { host: 'victim.test', net: networkId(SECRET), port: NODES.g, ts: Date.now(), reply: true }
    b.sig = signBeacon(SECRET, b)
    const dgram = await import('node:dgram')
    const sock = dgram.createSocket('udp4')
    await new Promise(r => sock.send(Buffer.from(JSON.stringify(b)), 17787, '127.0.0.1', r))
    sock.close()
    await sleep(1500)
    const st = JSON.parse(cli('g', 'status'))
    assert.ok(!st.aliases.includes('victim.test'), 'did not adopt victim.test as its own name')
    await stopNode('g')
  })

  await step('a known machine whose address now reaches a different member is not aliased to it', async () => {
    // h first learns c.test (a separate, verified node), then c's route starts pointing at a
    const dir = path.join(ROOT, 'h')
    fs.mkdirSync(dir, { recursive: true })
    const conf = { secret: SECRET, host: 'h.test', port: NODES.h, discovery: false, autoAliases: false, peers: ['c.test'], routes: { 'c.test': `127.0.0.1:${NODES.c}` } }
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(conf))
    await startNode('h')
    await waitFor(() => JSON.parse(cli('h', 'status')).peers.some(p => p.host === 'c.test' && p.verified), 5000, 'c.test verified')
    await stopNode('h')
    conf.routes['c.test'] = `127.0.0.1:${NODES.a}`          // stale: now reaches a.test
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(conf))
    await startNode('h')
    const out = cli('h', 'send', 'x@c.test', 'for c only')
    assert.doesNotMatch(out, /delivered|stored on/)
    assert.match(out, /unreachable/)
    const st = JSON.parse(cli('h', 'status'))
    assert.ok(!st.peers.find(p => p.host === 'c.test')?.alias_of, 'c.test is not recorded as an alias of a.test')
    await stopNode('h')
  })

  await step('re-running setup keeps the network; joining another network restarts the node on it', async () => {
    const dir = path.join(ROOT, 'i')
    const env = { ...process.env, AGENTLINK_HOME: dir, AGENTLINK_PORT: String(NODES.i), AGENTLINK_HOST: 'i.test', AGENTLINK_DISCOVERY: '0', AGENTLINK_AUTO_ALIASES: '0' }
    const setup = (...a) => execFileSync(process.execPath, ['--no-warnings', BIN, 'setup', ...a, '--no-service', '--no-claude', '--no-alias'], { env, encoding: 'utf8' })
    const secretNow = () => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).secret
    const health = async () => (await fetch(`http://127.0.0.1:${NODES.i}/health`)).json()
    let out = setup()
    assert.match(out, /New network created/)
    const s1 = secretNow()
    out = setup()
    assert.doesNotMatch(out, /New network created/)
    assert.equal(secretNow(), s1, 'secret kept')
    const odd = 'joined+network&with#odd chars!0123456789'
    out = setup(odd)
    assert.equal(secretNow(), odd)
    const { networkId } = await import('../src/config.js')
    assert.equal((await health()).net, networkId(odd), 'old node was stopped and a node on the new network is running')
    // the printed invite works even though the secret has URL/shell-special characters
    const url = out.match(/curl -fsSL "([^"]+)"/)[1]
    assert.equal((await fetch(url.replace('i.test', '127.0.0.1'))).status, 200)
  })

  await step('a standing-by node does not start after uninstall', async () => {
    const dir = path.join(ROOT, 'i')
    const env = { ...process.env, AGENTLINK_HOME: dir, AGENTLINK_PORT: String(NODES.i), AGENTLINK_HOST: 'i.test', AGENTLINK_DISCOVERY: '0', AGENTLINK_AUTO_ALIASES: '0' }
    const standby = spawn(process.execPath, ['--no-warnings', BIN, 'node'], { env, stdio: 'ignore' })
    await sleep(1000)
    fs.writeFileSync(path.join(dir, 'disabled'), '')        // what `agentlink uninstall` writes first
    const conf = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))
    const { authHeader } = await import('../src/crypto.js')
    await fetch(`http://127.0.0.1:${NODES.i}/local/shutdown`, { method: 'POST', body: '', headers: { 'x-agentlink-auth': authHeader(conf.secret, 'POST', '/local/shutdown', '') } })
    const exited = await Promise.race([new Promise(r => standby.once('exit', () => r(true))), sleep(8000).then(() => false)])
    if (!exited) standby.kill('SIGKILL')
    assert.ok(exited, 'standby node exited instead of taking over')
    await assert.rejects(fetch(`http://127.0.0.1:${NODES.i}/health`, { signal: AbortSignal.timeout(1000) }))
  })

  await bob.close()
  console.log(`\nall ${passed} steps passed`)
} catch (e) {
  console.log('FAILED')
  console.error(e)
  for (const n of Object.keys(NODES)) {
    try { console.error(`--- ${n}/node.log ---\n` + fs.readFileSync(path.join(ROOT, n, 'node.log'), 'utf8').slice(-2000)) } catch {}
  }
  process.exitCode = 1
} finally {
  for (const n of Object.keys(procs)) await stopNode(n)
  await killPorts()   // nodes auto-started by adapters are not our children
  if (!process.exitCode) fs.rmSync(ROOT, { recursive: true, force: true })
}
