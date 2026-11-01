# Changelog

## 0.1.0 — unreleased

First release.

- Per-machine node with durable SQLite store, store-and-forward delivery, retries, and
  replication to other online nodes while a recipient machine is offline.
- Claude Code channel adapter: incoming messages wake idle sessions. Tools: `send`, `peers`,
  `inbox`. Poll mode (`agentlink mcp --poll`) for agents without channel support.
- Per-machine keys and a signed, shared member list: TLS between machines, with each machine
  proving its key inside the connection (nothing is sent to an address unless the machine there
  proves who it is), messages signed by the sending machine, `agentlink remove <host>` (a machine can remove the ones
  that joined after it; a removal is final).
- Unlinkable keys: nodes present a throwaway certificate on each connection, so a machine's key
  can't be used to recognise it on different networks. While invites are open, the node presents
  an invite key instead. No SNI is sent.
- Zero-config LAN discovery (encrypted UDP beacons) and peer-list gossip.
- One-line install: private Node.js runtime if needed, background service (launchd/systemd),
  every Claude Code account on the machine enabled, `<alias>-link` launch aliases.
- Joining by one-time invite (expires in 24 hours) with the invite key pinned in the curl line;
  any member machine can invite and serves the installer.
- Tailscale-aware invites for machines off the LAN.
- Machines exchange a protocol version first: a machine running an incompatible version is
  reported as needing an upgrade, not as a stranger. Sessions restart a node left running from an
  older version.
- Sending to a name that isn't a machine on the network (a typo) fails at once and lists the
  machines, instead of queueing; configured peers (Tailscale names, IPs) are still queued while
  offline.
