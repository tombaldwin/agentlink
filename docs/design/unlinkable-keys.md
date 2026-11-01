# Design: unlinkable keys (identity inside the connection)

Status: implemented, for 0.1.0 (before first public release). Replaces §2 (transport) of
[identity-and-transport.md](identity-and-transport.md); the roster, envelopes, discovery and
invite tokens are unchanged.

## Why

With pinned TLS, a node presented its machine certificate to anyone who connected. The key didn't
name the machine, but it was a stable value: someone who probed a laptop's port at a café and
again somewhere else could tell it was the same laptop. Clients didn't leak (a pinned client aborts
before sending its certificate); only the listening side did.

We can't just rotate the certificate: TLS shows the server's certificate before the client proves
anything, and pinning needs a stable value to check. So identity moves inside the connection.

## Design

**Certificates are throwaways.** The node presents a freshly generated P-256 certificate, made
new for each connection (at most once a second, since generating one costs about 1 ms). While any
invite is open it presents the **invite key** instead (below). Clients don't present a certificate.

**Identity exchange**, on one keep-alive TLS 1.3 connection (`authedRaw` in `src/tls.js`). `ekm` is
the connection's TLS exporter (`EXPORTER-agentlink-auth`, 32 bytes):

1. **Gate.** `GET /v1/auth` with `x-agentlink-gate`, which carries tags `HMAC(HMAC(dk, "agentlink-gate-1"), ekm)`
   for the client's newest four discovery keys. A server that finds a tag for any discovery key it
   has ever held replies `{fp, sig}`, where `sig` is its machine key signing
   `["agentlink-auth-1","server",ekm]`. Without a matching tag, it gives the same 404 as any unknown path.
2. **Check.** The client accepts only the fingerprint(s) it expected (for `call`, the member the
   roster names for the host it's dialling; for `identify`, any member) with a valid signature.
   Otherwise it closes the connection: the stranger has received one gate request and nothing else.
3. **Request.** The client sends the real request on the **same socket** (checked before a byte of
   it is written), with `x-agentlink-auth: <fp>.<sig>`, where `sig` signs
   `["agentlink-auth-1","client",ekm]`. The server verifies it against the roster (merging a
   hello's records first, so a machine that has just joined can prove itself) and caches the result
   for the connection.

Properties:

- **No stable value for strangers.** They see throwaway certificates, opaque gate tags (different
  for each connection) and 404s.
- **Nothing sent to the wrong machine.** As before, the client reveals its identity and sends a
  request only to the machine it meant to reach.
- **No replay or relaying.** Both proofs sign this TLS session's exporter. A relay in the middle
  runs two sessions with two exporters, so it can't pass proofs from one side to the other, even if
  it holds a discovery key. Role labels stop a server proof being reflected back as a client proof.
- **Old discovery keys still open the gate.** A machine that was offline during a removal (and
  missed the key rotation) can still get in. This is safe: passing the gate only tells a client
  which member it is talking to, and anyone who ever held a discovery key already has the member
  list. Membership is checked in step 3 as before, so a removed machine still gets 403.
- **Cost:** one extra round trip per connection. No SNI is sent, so a passive observer doesn't see
  the name being dialled either.

**Local API.** It uses the same exchange, expecting the machine's own key in both directions.
`Local` reads the discovery keys from `roster.json`. `/health` and `/local/*` require the
client's proven key to be the machine's own, and the connection to be from loopback.

**Invite key.** `agentlink invite` creates `~/.agentlink/invite.key` (0600) when no invite is
open; all open invites share it, and it survives restarts. The curl line, `AGENTLINK_PIN` and
`--pin` name it. It is deleted once no invite is open (used, revoked or expired; checked on every
connection and every minute), and the node goes back to throwaway keys. While an invite is open,
someone probing the port can recognise the machine for that window, at most 24 hours.

The install script also passes `--net <network id>`, so a machine already in that network keeps its
key when re-joining. A machine joining a different network always gets a new key, so its key is
never carried from one network to another. Changing network (`--new-network`, or joining another)
deletes the old network's invites.

## Usability

- **Same commands.** Invite lines, joining, sending and removing work exactly as before.
- **A spent invite now fails on the key, not the token.** Once the last open invite is used, its key
  is gone, so re-running the line fails in curl (exit 90, "public key does not match"). `setup
  --join` then says the invite was used, expired or revoked, or something else is at the address.
  It can't tell which.
- **No pinning by hand.** You can't point `curl --pinnedpubkey` at a node to check its identity.
  `agentlink status` shows the keys instead.

## Tests

- Unit: gate tags work for old and new discovery keys, are tied to one connection, and reveal
  nothing stable. Auth proofs are tied to one connection, one role and one key.
- e2e: strangers get 404 on every path; another network fails the gate; a non-member that holds the
  discovery key gets 403; two connections see different throwaway keys, never the machine key; a
  TLS relay in the middle can't pass the proofs on; a stranger at a stored address (HTTPS and plain
  TCP) receives only gate requests, with no names, keys or message bodies; the invite key is
  presented only while an invite is open, open invites share it, and it changes with a new network;
  the old network's invites stop working.
