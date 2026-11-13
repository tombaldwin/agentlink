import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fingerprint } from './cert.js'

export const VERSION = '0.3.1'

export function homeDir() {
  return process.env.NATTERMATIC_HOME || path.join(os.homedir(), '.nattermatic')
}
const configPath = () => path.join(homeDir(), 'config.json')
/** This machine's key, certificate and the network's membership records. */
export const keyPath = (dir = homeDir()) => path.join(dir, 'node.key')
export const certPath = (dir = homeDir()) => path.join(dir, 'node.crt')
export const rosterPath = (dir = homeDir()) => path.join(dir, 'roster.json')

export const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms))
/** Single-quote for sh. @param {unknown} v */
export const shQuote = v => `'${String(v).replace(/'/g, `'\\''`)}'`
/** Compare dotted versions numerically. @param {string} a @param {string} b */
export function cmpVersion(a, b) {
  const x = String(a).split(/[.-]/).map(Number), y = String(b).split(/[.-]/).map(Number)
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0)
  return 0
}

/**
 * Replace `file` in one step, on disk before the rename: a crash or a full disk leaves the old file
 * or the new one, never part of one.
 * @param {string} file @param {string | Buffer} data @param {number} mode
 */
export function writeAtomic(file, data, mode) {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    const fd = fs.openSync(tmp, 'w', mode)
    // writeFileSync, not writeSync: writeSync can write part of the data and report no error
    try { fs.fchmodSync(fd, mode); fs.writeFileSync(fd, data); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    fs.renameSync(tmp, file)
  } catch (e) { fs.rmSync(tmp, { force: true }); throw e }
}

/** Create the nattermatic home directory, private to this user even if something (an older installer,
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
  const s = String(n || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 48).replace(/[-.]+$/, '')
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
  const s = String(p || '').trim().toLowerCase()
  // an IPv6 address has no name: this one stands for it until the machine there says who it is
  const v6 = s.match(/^\[([0-9a-f:.]+)\]:\d+$/)
  if (v6) return validAddr(s) ? { host: `ipv6-${v6[1].replace(/[:.]/g, '-').replace(/^-+|-+$/g, '')}.local`, addr: s } : null
  const m = s.match(/^([^:\s]+)(?::(\d+))?$/)
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
  if (isLocalhost(h)) throw new Error(`this machine's hostname is "${os.hostname()}", which can't identify it on the network; run: natter setup --host <name>`)
  return h
}
const isLocalhost = (/** @type {string} */ h) => h === 'localhost' || h.startsWith('localhost.')
/**
 * Can this (normalised) name identify a machine? Every node takes "localhost" for itself, and an IP
 * address says where a machine is, not which one it is.
 * @param {string} h
 */
export const machineName = h => !isLocalhost(h) && !/^\d+(\.\d+){3}$/.test(h)

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
  if (!x.publicKey.equals(pub)) throw new Error(`${certPath(dir)} does not match ${keyPath(dir)}: restore the right file, or run natter setup --new-network to start over`)
  return { key, cert, fp: fingerprint(key) }
}

/** @param {import('./types.js').Identity} id */
export function writeIdentity(id, dir = homeDir()) {
  ensureHomeDir(dir)
  writeAtomic(keyPath(dir), id.key, 0o600)
  writeAtomic(certPath(dir), id.cert, 0o644)
}

/** The network this machine belongs to (the founding machine's fingerprint), or null. */
function readNet(dir = homeDir()) {
  try { return String(JSON.parse(fs.readFileSync(rosterPath(dir), 'utf8')).net) } catch { return null }
}

/** @returns {import('./types.js').Config} */
export function loadConfig() {
  /** @type {import('./types.js').ConfigFile} */
  const file = readConfigFile() || {}
  const identity = readIdentity()
  const net = readNet()
  if (!identity || !net) throw new Error(`nattermatic is not set up on this machine. Run: natter setup`)
  const explicit = process.env.NATTERMATIC_HOST || file.host
  const host = normHost(explicit || detectHost())
  if (isLocalhost(host)) throw new Error(`"${host}" can't identify this machine on the network; run: natter setup --host <name>`)
  const aliases = new Set([...(file.aliases || []).map(normHost), 'localhost'])
  const autoAliases = process.env.NATTERMATIC_AUTO_ALIASES ? process.env.NATTERMATIC_AUTO_ALIASES !== '0' : file.autoAliases !== false
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
    port: Number(process.env.NATTERMATIC_PORT || file.port || 7777),
    peers: (file.peers || []).map(parsePeer).filter(p => p !== null),  // extra peers beyond LAN discovery (Tailscale names, IPs)
    routes: file.routes || {},                        // host -> "ip:port" overrides
    discoveryPort: Number(process.env.NATTERMATIC_DISCOVERY_PORT || file.discoveryPort || 0) || undefined,
    discovery: process.env.NATTERMATIC_DISCOVERY ? process.env.NATTERMATIC_DISCOVERY !== '0' : file.discovery !== false,
    ttlMs: Math.min(Number(file.ttlDays) > 0 ? Number(file.ttlDays) * 86400_000 : 7 * 86400_000, MAX_TTL_MS),
    autoAliases,
    maxWaiting: Number(file.maxWaiting) > 0 ? Number(file.maxWaiting) : 2000,      // unread messages for one session
    maxStoreBytes: (Number(file.maxStoreMB) > 0 ? Number(file.maxStoreMB) : 1024) * 2 ** 20,
  }
}

/** Merge `obj` into config.json. @param {import('./types.js').ConfigFile} obj */
export function writeConfig(obj) {
  ensureHomeDir()
  const next = { ...readConfigFile(), ...obj }
  writeAtomic(configPath(), JSON.stringify(next, null, 2) + '\n', 0o600)
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

/**
 * The message of a caught value (which may not be an Error), with a network cause code if any.
 * A connection to a name with several addresses fails with an AggregateError whose own message is
 * empty: report the codes of the attempts instead.
 * @param {unknown} e
 */
export const errMsg = e => {
  if (!(e instanceof Error)) return String(e)
  const cause = /** @type {any} */ (e).cause
  const agg = e instanceof AggregateError ? e : cause instanceof AggregateError ? cause : null
  if (agg && agg.errors.length) {
    const codes = [...new Set(agg.errors.map(x => x?.code || (x instanceof Error ? x.message : String(x))))]
    const desc = `connect ${codes.join(', ')}${agg.errors.length > 1 ? ` (tried ${agg.errors.length} addresses)` : ''}`
    return e === agg ? (e.message ? `${e.message}: ${desc}` : desc) : `${e.message}: ${desc}`
  }
  const code = cause?.code
  return code && !e.message.includes(code) ? `${e.message} (${code})` : e.message
}

/** The network error code behind a caught value (its own, its cause's, or the first attempt's). @param {unknown} e @returns {string} */
export const errCode = e => {
  const x = /** @type {any} */ (e)
  if (!x || typeof x !== 'object') return ''
  if (typeof x.code === 'string') return x.code
  if (x instanceof AggregateError) return errCode(x.errors[0])
  return x.cause ? errCode(x.cause) : ''
}

/**
 * A hint for errors with a well-known local cause: on macOS, a process without Local Network
 * permission gets EHOSTUNREACH for every machine on the LAN.
 * @param {unknown} e
 */
export const netHint = e => {
  const code = errCode(e)
  if (process.platform === 'darwin' && (code === 'EHOSTUNREACH' || code === 'ENETUNREACH'))
    return ' (if that machine is on, macOS may be blocking nattermatic from the local network: check System Settings → Privacy & Security → Local Network)'
  return ''
}
