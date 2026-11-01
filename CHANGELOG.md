# Changelog

## 0.1.0 — unreleased

First release.

- Per-machine node with durable SQLite store, store-and-forward delivery, retries, and
  replication to other online nodes while a recipient machine is offline.
- Claude Code channel adapter: incoming messages wake idle sessions. Tools: `send`, `peers`,
  `inbox`. Poll mode (`agentlink mcp --poll`) for agents without channel support.
- Per-machine keys and a signed, shared member list: TLS between machines pinned to members'
  keys (nothing is sent to an address unless the machine there proves who it is), messages
  signed by the sending machine, `agentlink remove <host>`.
- Zero-config LAN discovery (encrypted UDP beacons) and peer-list gossip.
- One-line install: private Node.js runtime if needed, background service (launchd/systemd),
  every Claude Code account on the machine enabled, `<alias>-link` launch aliases.
- Joining by one-time invite (expires in 24 hours) with the inviter's key pinned in the curl line;
  any member machine can invite and serves the installer.
- Tailscale-aware invites for machines off the LAN.
