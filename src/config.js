import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

export const VERSION = '0.1.0'

export function homeDir() {
  return process.env.AGENTLINK_HOME || path.join(os.homedir(), '.agentlink')
}
export const configPath = () => path.join(homeDir(), 'config.json')
/** This machine's key, certificate and the network's membership records. */
export const keyPath = (dir = homeDir()) => path.join(dir, 'node.key')
export const certPath = (dir = homeDir()) => path.join(dir, 'node.crt')
export const rosterPath = (dir = homeDir()) => path.join(dir, 'roster.json')

/** Create the agentlink home directory, private to this user even if something (an older installer,
 * a umask-created parent) made it before us: it holds this machine's private key, messages and logs. */
export function ensureHomeDir(dir = homeDir()) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { if ((fs.statSync(dir).mode & 0o077) !== 0) fs.chmodSync(dir, 0o700) } catch {}
  return dir
}

/** Longest a message may live, whatever the config says (keeps timestamps well inside SQLite/JS integer range). */
export const MAX_TTL_MS = 30 * 86400_000

/** Normalise a machine name (lowercase, `.local` for bare names); throws if invalid. @param {unknown} input @returns {string} */
export function normHost(input) {
  let h = String(input || '').trim().toLowerCase().replace(/\.$/, '')
  if (!h) throw new Error('empty host')
  // hostnames / IPv4 only: keeps addresses from being turned into arbitrary URLs
  if (!/^[a-z0-9]([a-z0-9-]{0,62})(\.[a-z0-9]([a-z0-9-]{0,62}))*$/.test(h) || h.length > 253) throw new Error(`invalid host "${h}"`)
  if (!h.includes('.') && h !== 'localhost') h += '.local'
  return h
}

/** A dialable "host:port" (hostname or IPv4, or [IPv6]) — anything else is refused. */
/** @param {unknown} a @returns {a is string} */
export function validAddr(a) {
  if (typeof a !== 'string') return false
  const m = a.match(/^(\[[0-9a-f:.]+\]|[a-z0-9.-]+):(\d{1,5})$/i)
  return !!m && Number(m[2]) > 0 && Number(m[2]) < 65536
}

/** @param {unknown} n */
export function sanitizeName(n) {
  const s = String(n || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 48)
  return s || 'agent'
}

/**
 * "name@host" | "name" -> {name, host}
 * @param {unknown} input
 * @param {string} selfHost
 * @returns {{ name: string, host: string }}
 */
export function parseAddr(input, selfHost) {
  const a = String(input || '').trim()
  const i = a.lastIndexOf('@')
  if (i < 0) return { name: sanitizeName(a), host: selfHost }
  return { name: sanitizeName(a.slice(0, i)), host: normHost(a.slice(i + 1)) }
}

/**
 * "host" | "host:port" | "1.2.3.4:7777" -> { host, addr|null }
 * @param {unknown} p
 * @returns {import('./types.js').PeerSpec | null}
 */
export function parsePeer(p) {
  const m = String(p || '').trim().toLowerCase().match(/^([^:\s]+)(?::(\d+))?$/)
  if (!m) return null
  let host
  try { host = normHost(m[1]) } catch { return null }
  if (/^\d+\.\d+\.\d+\.\d+\.local$/.test(host)) host = host.slice(0, -6)
  // with an explicit port, dial the name exactly as given: a bare name may be a MagicDNS/DNS short
  // name ("desk:7777") that only resolves without the ".local" we add for identity
  const literal = m[1].replace(/\.$/, '')
  const addr = m[2] ? `${/^[a-z0-9-]+$/.test(literal) ? literal : host}:${m[2]}` : null
  if (addr && !validAddr(addr)) return null
  return { host, addr }
}

export function localIPv4s() {
  const out = ['127.0.0.1']
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4') out.push(i.address)
  return out
}

/** This machine's Tailscale DNS name, if Tailscale is running. */
export function tailscaleName() {
  for (const bin of ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']) {
    try {
      const self = JSON.parse(execFileSync(bin, ['status', '--json'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })).Self
      if (self?.Online !== false && self?.DNSName) return normHost(self.DNSName)
    } catch {}
  }
  return null
}

/** @param {string} h */
const hostSafe = h => String(h).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'agentlink-host'

export function detectHost() {
  let h = null
  if (process.platform === 'darwin') {
    try { h = normHost(hostSafe(execFileSync('scutil', ['--get', 'LocalHostName']).toString())) } catch {}
  }
  h ||= normHost(hostSafe(os.hostname().split('.')[0]))
  // every node treats "localhost" as itself, so it can't be a machine's network identity
  if (isLocalhost(h)) throw new Error(`this machine's hostname is "${os.hostname()}", which can't identify it on the network; run: agentlink setup --host <name>`)
  return h
}
const isLocalhost = (/** @type {string} */ h) => h === 'localhost' || h.startsWith('localhost.')

/**
 * This machine's identity, or null if setup hasn't created one.
 * @returns {import('./types.js').Identity | null}
 */
export function readIdentity(dir = homeDir()) {
  let key, cert
  try { key = fs.readFileSync(keyPath(dir), 'utf8'); cert = fs.readFileSync(certPath(dir), 'utf8') } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return null
    throw e
  }
  const pub = crypto.createPublicKey(key)
  const x = new crypto.X509Certificate(cert)
  if (!x.publicKey.equals(pub)) throw new Error(`${certPath(dir)} does not match ${keyPath(dir)} — run agentlink setup --new-network to start over`)
  return { key, cert, fp: crypto.createHash('sha256').update(pub.export({ type: 'spki', format: 'der' })).digest('base64') }
}

/** @param {import('./types.js').Identity} id */
export function writeIdentity(id, dir = homeDir()) {
  ensureHomeDir(dir)
  fs.writeFileSync(keyPath(dir), id.key, { mode: 0o600 })
  fs.writeFileSync(certPath(dir), id.cert, { mode: 0o644 })
}

/** The network this machine belongs to (the founding machine's fingerprint), or null. */
export function readNet(dir = homeDir()) {
  try { return String(JSON.parse(fs.readFileSync(rosterPath(dir), 'utf8')).net) } catch { return null }
}

/** @returns {import('./types.js').Config} */
export function loadConfig() {
  /** @type {import('./types.js').ConfigFile} */
  const file = readConfigFile() || {}
  const identity = readIdentity()
  const net = readNet()
  if (!identity || !net) throw new Error(`agentlink is not set up on this machine. Run: agentlink setup`)
  const explicit = process.env.AGENTLINK_HOST || file.host
  const host = normHost(explicit || detectHost())
  if (isLocalhost(host)) throw new Error(`"${host}" can't identify this machine on the network; run: agentlink setup --host <name>`)
  const aliases = new Set([...(file.aliases || []).map(normHost), 'localhost'])
  const autoAliases = process.env.AGENTLINK_AUTO_ALIASES ? process.env.AGENTLINK_AUTO_ALIASES !== '0' : file.autoAliases !== false
  if (autoAliases) {
    for (const ip of localIPv4s()) aliases.add(ip)
    // the OS hostname is only one of our names when we use it for identity: a machine given its own
    // name (e.g. a clone renamed with --host) must not answer for its twin's hostname
    if (!explicit) try { const o = normHost(os.hostname()); if (!isLocalhost(o)) aliases.add(o) } catch {}   // skipped if not a valid host
  }
  aliases.delete(host)
  return {
    dir: homeDir(),
    identity,
    net,
    host,
    aliases: [...aliases],
    port: Number(process.env.AGENTLINK_PORT || file.port || 7777),
    peers: (file.peers || []).map(parsePeer).filter(p => p !== null),  // extra peers beyond LAN discovery (Tailscale names, IPs)
    routes: file.routes || {},                        // host -> "ip:port" overrides
    discoveryPort: Number(process.env.AGENTLINK_DISCOVERY_PORT || file.discoveryPort || 0) || undefined,
    discovery: process.env.AGENTLINK_DISCOVERY ? process.env.AGENTLINK_DISCOVERY !== '0' : file.discovery !== false,
    ttlMs: Math.min(Number(file.ttlDays) > 0 ? Number(file.ttlDays) * 86400_000 : 7 * 86400_000, MAX_TTL_MS),
    autoAliases,
  }
}

/** Merge `obj` into config.json. @param {import('./types.js').ConfigFile} obj */
export function writeConfig(obj) {
  ensureHomeDir()
  const next = { ...readConfigFile(), ...obj }
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  return next
}

/** config.json's contents, or null if there is none; a file that exists but can't be read or parsed
 * throws (never treated as empty, which would silently change this machine's settings). */
/** @returns {import('./types.js').ConfigFile | null} */
export function readConfigFile() {
  let text
  try { text = fs.readFileSync(configPath(), 'utf8') } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return null
    throw new Error(`cannot read ${configPath()}: ${errMsg(e)}`)
  }
  try {
    const v = JSON.parse(text)
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not a JSON object')
    return v
  } catch (e) { throw new Error(`bad config ${configPath()}: ${errMsg(e)} — fix the file (or delete it to start over)`) }
}

/** The message of a caught value (which may not be an Error), with a network cause code if any. @param {unknown} e */
export const errMsg = e => {
  if (!(e instanceof Error)) return String(e)
  const code = /** @type {any} */ (e).cause?.code
  return code && !e.message.includes(code) ? `${e.message} (${code})` : e.message
}
