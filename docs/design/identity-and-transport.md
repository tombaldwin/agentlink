# Design: per-machine identity and pinned TLS

Status: implemented, for 0.1.0 (before first public release). §2 (transport) has been superseded by
[unlinkable-keys.md](unlinkable-keys.md): nodes no longer present their machine key in the handshake.

## Why

Today an agentlink network is one shared secret, and machines talk plain HTTP. Three problems:

1. **Joining leaks the network secret.** The invite is `curl "http://host:7777/install?k=<secret>"`.
   Anyone passively watching the network during any join captures the secret and is a permanent,
   fully trusted member (they can send as any agent: prompt injection into every session). An
   active attacker can also swap the installer and get code execution on the joining machine.
2. **Message contents are readable on the wire.** Requests are HMAC-signed, but bodies are plaintext.
3. **One compromised machine compromises the network.** Any member can impersonate any other machine,
   and there is no way to remove a machine short of re-creating the network.

And the case that makes this a release blocker: **a laptop that moves to a public network.**
Stored peer addresses (`192.168.1.20:7777`, `desk.local`) now belong to strangers. `request()` sends
the request body before it can check the response signature, so the retry loop hands queued
messages, in plaintext, to whoever holds that address — repeatedly — and every `hello` sends them
the network's host/address list. The laptop also broadcasts beacons and answers `/health` with its
hostname and network id to everyone in the café.

0.1.0 is unreleased, so there is nothing to migrate: we can change the trust model outright.

## Goals

- No secret ever crosses the network in a form an observer can use.
- Nothing (message, peer list, request) is sent to an address until the machine there has proved,
  inside the TLS handshake, that it holds the expected key.
- Each machine has its own identity; a member cannot send as another machine; a machine can be
  removed without touching the others.
- Keep the UX: one pasted line to join, no accounts, no server, no new runtime dependencies.

Non-goals (unchanged, documented): per-agent identity *within* a machine (any process of that user
can use any session name); protection against a compromised member's own messages; hiding that a
machine runs agentlink on its open port.

## Design

### 1. Machine identity

- `setup` generates an ECDSA P-256 key pair (`~/.agentlink/node.key`, 0600) and a self-signed X.509
  certificate for it (`node.crt`). Kept across re-runs of setup and re-installs.
- A machine's identity is its **key fingerprint**: `sha256(SPKI DER)`, base64. The human address
  (`laptop.local`) is bound to the fingerprint by the roster (§3).
- P-256 rather than Ed25519: certificate support in macOS's stock curl/LibreSSL and older OpenSSL
  is the constraint (confirm in the spike).
- Node can sign but not build certificates, so `src/cert.js` holds a minimal DER encoder for one
  fixed self-signed certificate shape (~60 lines); tests parse it with `crypto.X509Certificate`.
  No dependency.

### 2. Transport: mutual TLS, pinned to roster keys

- The node listens with `https` (TLS 1.3 only) on the same port. `requestCert: true`,
  `rejectUnauthorized: false` at the socket; authorisation is per route:
  - `/v1/*` (node↔node): the client certificate's fingerprint must be a current roster member,
    and that member's host is the caller's identity. Replaces the HMAC request header, nonce cache,
    5-minute clock window and response signatures.
  - `/local/*`: loopback only, authenticated as today but with a per-machine `local.key` (0600)
    instead of the network secret. Local clients pin the node's own certificate (read from disk),
    so a process squatting on the port is refused at the handshake.
  - `/join/*`: a valid invite token (§4).
  - `/health`: loopback only. Remote callers get nothing — no hostname, no network id.
- Outgoing node requests move from `fetch` to `https.request` with an agent that pins: the only
  acceptable server certificate is the one the roster holds for the host being dialled, checked
  during the handshake. **On mismatch the connection is torn down before a single request byte is
  written.** (Implementation note: pass the expected certificate as the sole `ca` and override
  `checkServerIdentity` to compare fingerprints; the spike confirms no bytes leave before the check.)
- Consequence: addresses become pure hints. An address is usable for host H iff the TLS handshake
  there presents H's key. A TCP relay can't read or alter anything, so the `at=` /
  `reachedDirectly` relay check, much of the alias/stale-address logic in `request()` and `probe()`,
  and the "only use an address after an authenticated exchange" dance all collapse into that rule.
  This also fixes the coffee-shop leak with no special casing.

### 3. Roster (membership)

- The roster is a set of signed records, stored in a new `members` table and exchanged in `hello`:
  - `add {host, fingerprint, cert, added_at}` signed by an existing member's key
    (the founding machine signs its own).
  - `remove {fingerprint, at}` signed by any member.
- Merge is a two-phase set: union of all valid records; a removed fingerprint is gone forever
  (re-adding a machine means a new key). Records signed by a removed key are ignored from then on.
  Converges regardless of order, so offline machines catch up on their next `hello`.
- A host name maps to at most one live fingerprint; a join claiming a taken name is refused
  (remove the old machine first).
- Peer *addresses* stay out of the roster: they're still gossiped as hints and verified by §2.

### 4. Joining

- `agentlink invite` mints a one-time token (128-bit random, stored hashed, expires in 24h) and prints:

  ```
  curl -fsSL --pinnedpubkey "sha256//<inviter fingerprint>" -k \
       "https://desk.local:7777/join/<token>/install" | sh
  ```

  `-k` only skips CA validation; curl still enforces the pinned key, so a MITM can't serve the
  installer or learn the token.
- The served installer is preset with the inviter's address, pin and token, and fetches the package
  (`/join/<token>/pkg.tgz`) with the same pinned curl. It then runs
  `agentlink setup --join <addr> --pin <fp> --token <t>`, which generates this machine's key and
  POSTs `/join/<token>` (pinned) with its host name and certificate. The inviter consumes the token,
  signs an `add` record, and returns the roster and the discovery key (§5).
- A token that leaks after use, or after 24h, is worthless. `agentlink invite --revoke` drops
  outstanding tokens. The Tailscale variant is the same line with the Tailscale name.
- The first machine (`setup` with no `--join`) creates a new roster with itself as sole member.

### 5. Discovery

- Beacons carry `{host, fingerprint, port, ts}`, signed with the node key, and are encrypted
  (AES-256-GCM) under a network **discovery key** that is only ever sent over member TLS
  connections. Outsiders see opaque UDP packets: no hostname, no network id, nothing to track
  a laptop with. A forged or replayed beacon is still just a hint (§2).
- The discovery key is rotated when a member is removed (the new key travels with the `remove`
  record to remaining members over TLS).

### 6. Messages

- Envelopes are signed by the origin machine's key (replacing the shared-key HMAC). A receiver or
  holder accepts an envelope only if the signer is a current member **and** the signer's host equals
  the host in `from`. Holders still can't alter what they relay, and a member can no longer send as
  another machine.

### 7. Commands

- `agentlink remove <host>` — sign and gossip a `remove` record.
- `agentlink invite [--revoke]` — as above.
- `agentlink status` / `peers` — show members with short fingerprints and which member added each.
- `setup --new-network` — new roster and key (the only "reset").

## What goes away

Network secret, `networkId`, `AGENTLINK_SECRET`, HMAC request auth + nonces + response signatures for
`/v1`, the 5-minute clock requirement between machines, `?k=` install URLs, relay detection (`at=`),
and the address-verification special cases in `request()`/`probe()`.

## Tests (e2e additions)

1. **Laptop moves to a hostile network.** Node A has a stored address for B. Stop B; start an
   impostor on B's address (a) a TLS server with its own key, (b) a plain HTTP server; both record
   every byte. Queue a message A→B and wait for several retries and a hello cycle. Assert the
   impostor received no application data (no HTTP request line, no message body, no peer list),
   and the message is still pending. Bring B back on a new address; assert delivery.
2. Sniffed invite: re-using a consumed token, an expired token, and a revoked token all fail.
3. Installer MITM: a server with the wrong key on the invite address — the pinned curl fails and
   nothing runs.
4. Removal: after `remove C`, C can neither send nor receive; a member offline during the removal
   learns it on return; records signed by C afterwards are ignored.
5. Forgery: a member sending an envelope with another machine's host in `from` is rejected;
   a holder that alters a relayed envelope is rejected.
6. Discovery: beacons from a non-member key, and replayed beacons, never cause traffic beyond a
   failed handshake; captured beacon bytes contain no hostname.
7. `/health` from a non-loopback address returns nothing identifying.
8. Local squatter: a process on the node port without the node's certificate is refused by the CLI
   and MCP adapter.
9. Name collision on join is refused; re-running setup on a member keeps its key and membership.

Existing e2e tests are kept, with config fixtures switched from a shared secret to pre-generated
keys and a pre-built roster.

## Plan

0. **Spike** (first, it can change the design): DER cert generator → `X509Certificate` parses it;
   mutual pinned TLS between two Node processes with proof that no request bytes are written on a
   pin mismatch; `curl --pinnedpubkey sha256//… -k` against it on stock macOS curl and Ubuntu curl.
1. Identity: `cert.js`, key/cert generation in setup.
2. Transport: TLS server, pinned client agent, `request()` rewrite, local API over pinned TLS with
   `local.key`; route authorisation.
3. Roster: table, signed records, merge, enforcement in `/v1` and envelope checks.
4. Join: tokens, `/join/*`, installer preset and pinned curl, `setup --join`, invite output.
5. Envelope signatures by node key.
6. Discovery: encrypted beacons, discovery key and rotation.
7. `remove`, status/peers output.
8. Delete the shared-secret code paths; update README, SECURITY.md, CHANGELOG.
9. Tests above, CI install-smoke updated to the new invite.

## Decisions

1. **Any member may add machines; a machine may remove only machines that joined after it**
   (revised after review: see "Removal" below). Removal does not cascade. Known weakness,
   documented in SECURITY.md: a compromised machine could add hidden keys before it's removed;
   those must be removed too (status shows who added each machine), or the network re-created with
   `setup --new-network`.
2. **Invite tokens are single-use and expire after 24h.** No `--uses N`.
3. **ECDSA P-256 keys** (final: see spike results).

## Removal (revised after review)

The first version let any member remove any other, with records replayed in timestamp order. A
review found that a removed machine could sign a removal of its remover, dated just before its own
removal: replay applied it first, so the removed machine was back in and the remover was out.
Signer-chosen timestamps can't settle this. With no central authority, a removed machine can
always claim it acted at the same moment as its remover, and if each could remove the other, every
way of settling that claim is bad.

So:

- **Seniority.** Members are ranked in the order their adds take effect (the founder first). A
  remove counts only if its signer ranks before its target, so two machines can never remove each
  other.
- **Single pass, in rank order.** Whether a machine is removed depends only on removes signed by
  higher-ranked machines, so each machine is settled exactly once, after everything that can
  affect it. Membership is a pure function of the record set: every node holding the same records
  agrees, whatever order they arrived in. Nothing is voided and then reconsidered. (A first version
  iterated "void, then replay" to a fixpoint. A second review showed that removing a remover could
  bring its target back, and that results depended on arrival order.)
- **Removals always stand** once their signer outranks the target, even if the signer is removed
  too. Concurrent removals therefore all take effect, and removing a remover never undoes its
  removals. The cost: a removed machine can still remove machines ranked after it, if it gets the
  record to a member before that member hears of its removal. It can never remove a higher-ranked
  machine or add one, and its new discovery keys are never used (the current key is the newest one
  introduced by a machine that is still a member).
- **Adds by a removed machine count only if every removal of it lists them in `seen`** (`recId`
  ids of the target's records the remover had). Backdated or concurrent adds don't count, and
  their keys are marked `dropped`: messages from them are rejected rather than retried.
- **Records are kept only if they could ever count.** That means everything signed by current
  members (who are trusted), and of what removed machines signed, only what counts: adds every
  remover had seen, and the first standing removal per target. Nothing else from a removed or
  dropped key can ever count, whatever arrives later (removals only accumulate), so discarding it
  doesn't make nodes disagree, and a removed machine can't fill the roster. Up to 50 adds per
  removed machine that didn't count are also kept, so those keys stay known as dropped.
- **Before authentication,** a client can submit only a chain of adds that ends at a current
  member and passes through no removed or dropped key.
- **Trade-offs.** The founding machine can't be removed, so if it's lost, start a new network. A
  compromised machine could backdate the adds it makes while still a member, giving those machines
  an earlier rank, but only up to its own: every machine ranked before it can still remove them.

## Spike results (2026-11-01, macOS, Node 23.6, stock curl 8.7.1)

- The ~50-line DER builder makes self-signed P-256 and Ed25519 certificates that
  `crypto.X509Certificate` parses and verifies, and that `openssl x509` reads.
- Mutual TLS works: the server reads the client's key fingerprint from `getPeerX509Certificate()`.
- Pinning with the expected certificate as the sole `ca` plus a fingerprint check in
  `checkServerIdentity` blocks impostors **before any request bytes are sent**: a TLS impostor with
  its own key got 0 application bytes; a plain-TCP impostor got only the TLS ClientHello (no request
  line, no body). The request fails with an error the node can log and retry on.
- `curl -k --pinnedpubkey sha256//<fp>` accepts the right key and refuses a wrong one
  (`(90) public key does not match pinned public key`) on stock macOS curl with both its LibreSSL
  (default) and SecureTransport backends, with a P-256 key.
- **Ed25519 fails on stock macOS curl** (LibreSSL 3.3.6: handshake failure), so P-256 is final.
- **SecureTransport has no TLS 1.3**, so the server accepts TLS 1.2+ (curl's installer fetch);
  node-to-node clients require TLS 1.3.
- Not yet checked: Ubuntu's stock curl (OpenSSL 3, expected to work). Docker wasn't responding
  locally; CI's install-smoke job on ubuntu-latest covers it once the installer uses the pinned curl.
