// LAN discovery by signed UDP broadcast beacons. Deliberately does NOT use mDNS/Bonjour, so it
// can never interfere with the OS's own hostname announcements.
import dgram from 'node:dgram'
import os from 'node:os'
import { signBeacon, safeEq } from './crypto.js'

const EVERY = 30_000
const MAX_SKEW = 5 * 60_000


function broadcastAddrs() {
  const out = new Set(['255.255.255.255'])
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal || !i.netmask) continue
      const ip = i.address.split('.').map(Number), mask = i.netmask.split('.').map(Number)
      out.add(ip.map((o, k) => (o | (~mask[k] & 255)) >>> 0).join('.'))
    }
  }
  return [...out]
}

/**
 * onPeer({host, addr}) is called for each valid beacon from another node on our network.
 * Beacons can be replayed by anyone on the LAN, so callers must treat addr as a hint and
 * verify it (authenticated hello) before routing traffic to it.
 * @param {import('./types.js').Config} cfg
 * @param {(peer: { host: string, addr: string }) => void} onPeer
 * @param {(...a: any[]) => void} log
 */
export function startDiscovery(cfg, onPeer, log) {
  const port = cfg.discoveryPort || cfg.port
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  /** @param {boolean} reply */
  const beacon = reply => {
    const b = { host: cfg.host, net: cfg.net, port: cfg.port, ts: Date.now(), reply }
    return Buffer.from(JSON.stringify({ ...b, sig: signBeacon(cfg.secret, b) }))
  }
  const announce = () => {
    const msg = beacon(false)
    for (const a of broadcastAddrs()) sock.send(msg, port, a, () => {})
  }
  sock.on('message', (buf, rinfo) => {
    let b
    try { b = JSON.parse(buf.toString('utf8')) } catch { return }
    if (!b || b.net !== cfg.net || typeof b.host !== 'string' || b.host === cfg.host) return
    if (!Number.isFinite(b.ts) || Math.abs(Date.now() - b.ts) > MAX_SKEW) return
    if (!Number.isInteger(b.port) || !safeEq(b.sig, signBeacon(cfg.secret, b))) return
    if (!b.reply) sock.send(beacon(true), port, rinfo.address, () => {})   // answer so discovery is instant both ways
    onPeer({ host: b.host, addr: `${rinfo.address}:${b.port}` })
  })
  sock.on('error', e => log('discovery socket error:', e.message))
  sock.bind(port, () => {
    sock.setBroadcast(true)
    announce()
  })
  const t = setInterval(announce, EVERY)
  return { stop() { clearInterval(t); try { sock.close() } catch {} } }
}
