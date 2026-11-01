// Shared shapes, used from JSDoc in the plain-JS sources (type-checked by `npm run typecheck`).

/** A configured or command-line peer: a name, plus an explicit address if one was given. */
export interface PeerSpec { host: string; addr: string | null }

/** The loaded configuration (config.json merged with AGENTLINK_* environment overrides). */
export interface Config {
  dir: string
  secret: string
  /** Public fingerprint of the secret: identifies the network. */
  net: string
  /** This machine's name, e.g. "laptop.local". */
  host: string
  /** Other names that reach this machine (IPs, OS hostname, localhost). */
  aliases: string[]
  port: number
  peers: PeerSpec[]
  /** host -> "ip:port" overrides. */
  routes: Record<string, string>
  discoveryPort?: number
  discovery: boolean
  ttlMs: number
  autoAliases: boolean
}

/** A signed message as it travels between nodes. */
export interface Envelope {
  id: string
  /** "name@host" */
  from: string
  /** "name@host" */
  to: string
  body: string
  sent_at: number
  expires_at: number
  sig: string
}

export type MessageRole = 'outbox' | 'held' | 'inbox'
export type MessageState = 'pending' | 'forwarded' | 'queued' | 'pushed' | 'delivered' | 'expired' | 'failed'

/** A row of the messages table (see store.js). */
export interface MessageRow {
  id: string
  from_addr: string
  to_addr: string
  to_host: string
  to_name: string
  body: string
  sent_at: number
  expires_at: number
  sig: string
  role: MessageRole
  state: MessageState
  attempts: number
  next_attempt: number
  replicated: number
  last_error: string | null
  updated_at: number
}

/** A row of the peers table. */
export interface PeerRow {
  host: string
  addr: string | null
  last_seen: number
  configured: number
  /** Set when `host` is another name (IP, Tailscale name) for the node called alias_of. */
  alias_of: string | null
  /** 1 once a node has proved, with the secret, that it is `host`. */
  verified: number
}

/** What accept() did with an incoming envelope; null means rejected as invalid. */
export type AcceptResult = 'live' | 'queued' | 'held' | 'expired' | null

/** Health reply from a node's /health endpoint. */
export interface Health { ok: boolean; host: string; net: string; version: string; pid: number }

/** A Claude account on this machine ('' dir = the default account). */
export interface ClaudeAccount { dir: string; alias: string; aliasValue?: string }

/** config.json as written by setup / edited by hand (all optional). */
export interface ConfigFile {
  secret?: string
  host?: string
  aliases?: string[]
  autoAliases?: boolean
  port?: number
  peers?: string[]
  routes?: Record<string, string>
  discoveryPort?: number
  discovery?: boolean
  ttlDays?: number
}

/** A message pushed to a session over the local stream. */
export interface InboundMessage { id: string; from: string; to: string; body: string; sent_at: number }

/** Reply of the node's GET /local/peers. */
export interface PeersReply {
  self: string
  local: string[]
  remote: { host: string; online: boolean; sessions: string[] }[]
}
