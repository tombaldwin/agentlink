// LAN discovery by encrypted UDP broadcast beacons. Deliberately does NOT use mDNS/Bonjour, so it
// can never interfere with the OS's own hostname announcements.
import dgram from 'node:dgram'
import os from 'node:os'
import { sealBeacon, openBeacon } from './crypto.js'

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
 * onPeer({host, fp, addr}) is called for each beacon from another member. Beacons are encrypted
 * under the network's discovery key, so outsiders can neither read nor forge them; but a captured
 * beacon can be replayed and a member could lie, so callers treat addr as a hint and only route to
 * it once a TLS handshake there presents that member's key.
 * @param {import('./types.js').Config} cfg
 * @param {() => string[]} keys discovery keys to accept, current (used for sending) last
 * @param {(peer: { host: string, fp: string, addr: string }) => void} onPeer
 * @param {(...a: any[]) => void} log
 */
export function startDiscovery(cfg, keys, onPeer, log) {
  const port = cfg.discoveryPort || cfg.port
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  /** @param {boolean} reply */
  const beacon = reply => {
    const dk = keys().at(-1)
    return dk ? sealBeacon(dk, { host: cfg.host, fp: cfg.identity.fp, port: cfg.port, ts: Date.now(), reply }) : null
  }
  const announce = () => {
    const msg = beacon(false)
    if (msg) for (const a of broadcastAddrs()) sock.send(msg, port, a, () => {})
  }
  sock.on('message', (buf, rinfo) => {
    const b = openBeacon(keys(), buf)
    if (!b || typeof b.host !== 'string' || typeof b.fp !== 'string' || b.fp === cfg.identity.fp) return
    if (!Number.isFinite(b.ts) || Math.abs(Date.now() - b.ts) > MAX_SKEW) return
    if (!Number.isInteger(b.port) || b.port <= 0 || b.port >= 65536) return
    if (!b.reply) { const r = beacon(true); if (r) sock.send(r, port, rinfo.address, () => {}) }   // answer so discovery is instant both ways
    onPeer({ host: b.host, fp: b.fp, addr: `${rinfo.address}:${b.port}` })
  })
  sock.on('error', e => log('discovery socket error:', e.message))
  sock.bind(port, () => {
    sock.setBroadcast(true)
    announce()
  })
  const t = setInterval(announce, EVERY)
  return { announce, stop() { clearInterval(t); try { sock.close() } catch {} } }
}
