# Changelog

## 0.1.0 — unreleased

First release.

- Per-machine node with durable SQLite store, store-and-forward delivery, retries, and
  replication to other online nodes while a recipient machine is offline.
- Claude Code channel adapter: incoming messages wake idle sessions. Tools: `send`, `peers`,
  `inbox`. Poll mode (`agentlink mcp --poll`) for agents without channel support.
- Zero-config LAN discovery (signed UDP beacons) and peer-list gossip.
- One-line install: private Node.js runtime if needed, background service (launchd/systemd),
  every Claude Code account on the machine enabled, `<alias>-link` launch aliases.
- Joining by invite: any member machine serves the installer to new machines.
- Tailscale-aware invites for machines off the LAN.
