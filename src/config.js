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
  const addr = m[2] ? `${host}:${m[2]}` : null
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
  if (process.platform === 'darwin') {
    try { return normHost(hostSafe(execFileSync('scutil', ['--get', 'LocalHostName']).toString())) } catch {}
  }
  return normHost(hostSafe(os.hostname().split('.')[0]))
}

/** Short public fingerprint of the secret: lets nodes recognise their own network on the LAN. */
export const networkId = (/** @type {string} */ secret) => crypto.createHash('sha256').update('agentlink-net:' + secret).digest('hex').slice(0, 12)

/** @returns {import('./types.js').Config} */
export function loadConfig() {
  /** @type {import('./types.js').ConfigFile} */
  let file = {}
  try { file = JSON.parse(fs.readFileSync(configPath(), 'utf8')) } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') throw new Error(`bad config ${configPath()}: ${errMsg(e)}`)
  }
  const secret = process.env.AGENTLINK_SECRET || file.secret
  if (!secret) throw new Error(`agentlink is not set up (no ${configPath()}). Run: agentlink setup <secret>`)
  const host = normHost(process.env.AGENTLINK_HOST || file.host || detectHost())
  const aliases = new Set([...(file.aliases || []).map(normHost), 'localhost'])
  try { aliases.add(normHost(os.hostname())) } catch {}   // skipped if the OS name isn't a valid host
  const autoAliases = process.env.AGENTLINK_AUTO_ALIASES ? process.env.AGENTLINK_AUTO_ALIASES !== '0' : file.autoAliases !== false
  if (autoAliases) for (const ip of localIPv4s()) aliases.add(ip)
  aliases.delete(host)
  return {
    dir: homeDir(),
    secret,
    net: networkId(secret),
    host,
    aliases: [...aliases],
    port: Number(process.env.AGENTLINK_PORT || file.port || 7777),
    peers: (file.peers || []).map(parsePeer).filter(p => p !== null),  // extra peers beyond LAN discovery (Tailscale names, IPs)
    routes: file.routes || {},                        // host -> "ip:port" overrides
    discoveryPort: Number(process.env.AGENTLINK_DISCOVERY_PORT || file.discoveryPort || 0) || undefined,
    discovery: process.env.AGENTLINK_DISCOVERY ? process.env.AGENTLINK_DISCOVERY !== '0' : file.discovery !== false,
    ttlMs: (file.ttlDays || 7) * 86400_000,
    autoAliases,
  }
}

/** Merge `obj` into config.json. @param {import('./types.js').ConfigFile} obj */
export function writeConfig(obj) {
  fs.mkdirSync(homeDir(), { recursive: true, mode: 0o700 })
  let cur = {}
  try { cur = JSON.parse(fs.readFileSync(configPath(), 'utf8')) } catch {}
  const next = { ...cur, ...obj }
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  return next
}

export const newSecret = () => crypto.randomBytes(24).toString('base64url')

/** The message of a caught value (which may not be an Error). @param {unknown} e */
export const errMsg = e => e instanceof Error ? e.message : String(e)
