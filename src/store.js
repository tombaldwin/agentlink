import { DatabaseSync } from 'node:sqlite'

/*
 * messages.role:
 *   outbox - we are the sender's node; must hand to the recipient's node
 *   held   - we are holding a copy for an offline machine; must hand to the recipient's node
 *   inbox  - recipient is on this machine; must push to the local session
 * messages.state:
 *   pending (outbox/held: still to hand over) -> forwarded
 *   queued  (inbox: waiting for session)      -> pushed (shown in a channel session; no read receipt)
 *                                             -> delivered (read with the inbox tool)
 *   expired | failed
 */
/** @param {string} file */
export function openStore(file) {
  const db = new DatabaseSync(file)
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS messages(
      id TEXT PRIMARY KEY,
      from_addr TEXT NOT NULL, to_addr TEXT NOT NULL, to_host TEXT NOT NULL, to_name TEXT NOT NULL,
      body TEXT NOT NULL, sent_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, sig TEXT NOT NULL,
      role TEXT NOT NULL, state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
      replicated INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS ix_due ON messages(state, next_attempt);
    CREATE INDEX IF NOT EXISTS ix_inbox ON messages(role, to_name, state);
    CREATE INDEX IF NOT EXISTS ix_expiry ON messages(state, expires_at);
    CREATE INDEX IF NOT EXISTS ix_waiting ON messages(to_host, to_name) WHERE state IN ('pending','queued');
    CREATE TABLE IF NOT EXISTS peers(
      host TEXT PRIMARY KEY, addr TEXT, last_seen INTEGER NOT NULL, configured INTEGER NOT NULL DEFAULT 0,
      alias_of TEXT);
    CREATE TABLE IF NOT EXISTS invites(
      hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
  `)
  try { db.exec(`ALTER TABLE peers ADD COLUMN alias_of TEXT`) } catch {}  // older databases
  return db
}
