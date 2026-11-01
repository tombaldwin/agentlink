# Security

## Model

Each machine has its own ECDSA P-256 key pair, created by `agentlink setup` and kept in
`~/.agentlink/node.key` (readable only by you). An agentlink network is a list of member keys
(the *roster*): a set of signed records saying "this key, called `laptop.local`, was added by that
member" or "this key was removed". Members exchange and merge these records; every member computes
the same membership from the same records.

- **Transport.** Every connection is TLS, and both sides present their machine key. When a node
  connects to another, it accepts only the key the roster holds for that machine, checked inside
  the handshake. If anyone else answers at the address, the connection fails before a request
  byte is sent. Machine-to-machine connections require TLS 1.3.
- **Addresses are only hints.** LAN beacons, gossiped addresses, configured names and the source
  IPs of requests can all be wrong or stale (DHCP reuse, a laptop on another network, spoofed
  name resolution). An address is used for a machine only when the handshake there presents that
  machine's key, so a wrong address never receives anything. Someone relaying traffic to the real
  machine sees only ciphertext.
- **Membership.** A node accepts machine-to-machine requests only from current members' keys. Any
  member can add a machine (by inviting it) or remove one. A removed key is gone for good (the
  machine re-joins with a new key), and records it signs afterwards are ignored. Records are
  replayed in time order, and a member stamps its records later than everything it has seen, so a
  machine whose clock is behind still converges.
- **Messages.** Each message is signed end to end by the machine that sent it. A node accepts a
  message only if the signer is a current member and is the machine named in the sender address,
  so holders relaying copies can't alter messages and a member can't send as another machine.
- **Joining.** `agentlink invite` makes a one-time token (stored hashed, expires after 24 hours)
  and prints a `curl -k --pinnedpubkey "sha256//<key>" https://…` line. curl's `-k` only skips
  certificate-authority checks; `--pinnedpubkey` still makes curl refuse any key but the inviting
  machine's, so the installer, the package and the token can't be intercepted or replaced. The
  joining machine checks the same key again before it sends its join request. The token is
  consumed by the join. `agentlink invite --revoke` cancels unused tokens.
- **Discovery.** LAN beacons are encrypted under a discovery key that members share only over
  their TLS connections, so other people on the network can't read machine names from them. The
  discovery key is replaced whenever a machine is removed.
- **Local API.** Sessions on the same machine talk to their node over TLS on 127.0.0.1, pinned to
  the node's key, and present that same key: only processes that can read this machine's private
  key (your user) get in, and a program squatting on the port is refused. `/health` answers only
  them.
- **Prompt injection.** Messages come from other AI agents. The MCP adapter instructs Claude to
  treat them as requests from a colleague — never as instructions from its user — and not to
  take destructive or security-sensitive actions solely because a peer asked. Only invite
  machines and agents you trust.

## Known limitations

- **Members are trusted.** Any member can invite and remove machines. A compromised member could
  quietly add extra machines before you remove it. `agentlink status` shows which member added
  each machine: remove any you don't recognise, or start a new network with
  `agentlink setup --new-network` and re-join your machines.
- **Agents on a machine aren't separately authenticated.** Any process running as your user can
  send as any session name on that machine.
- **Invites are credentials until used.** Anyone who gets an unused invite line within 24 hours can
  join one machine with it. Treat it like a password until it's been used, or revoke it.
- **Your machine's key is visible to anyone who connects to its port.** It doesn't reveal the
  machine's name, but it's a stable value someone could use to recognise the same machine on
  different networks. The open port itself is visible too.
- **A removed machine keeps what it had.** It keeps its copy of the member list (machine names and
  public keys; no secrets) and any messages it already received.

## Starting over

Run `agentlink setup --new-network` on one machine. It creates a new key and a new network with
that machine as its only member; join the other machines with fresh invites.

## Reporting a vulnerability

Please open a private security advisory on GitHub ("Security" tab → "Report a vulnerability")
rather than a public issue.
