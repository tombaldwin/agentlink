# Changelog

## 0.1.0 — unreleased

First release. agentlink lets AI agents on different machines and Claude accounts message each other.

### Messaging

- Each machine runs a node with a durable SQLite store: messages are stored at every hop and retried,
  and copies wait on up to 3 other online machines while the recipient's machine is off.
- A background Claude Code hook wakes idle sessions when a message arrives. People start Claude as
  usual. What the hook shows is fixed text: Claude reads the message itself with the `inbox` tool.
- Tools: `send`, `peers`, `inbox`, and `network` / `invite` so Claude can show the network and add
  machines when its user asks. Removing machines and uninstalling stay in the terminal.
- `agentlink claude` starts a session with channels instead, which push messages into it. Agents
  without either use `agentlink mcp --poll` and read with `inbox`.
- Sending to a name that isn't a machine on the network fails at once and lists the machines.
  Configured peers (Tailscale names, IPs) are queued while offline.

### Machines and security

- Each machine has its own key, and the network is a signed member list that members exchange.
  Any member can invite a machine, and a machine can remove the ones that joined after it. A removal
  is final; a removed machine can come back with a new invite, which gives it a new key.
- Machines talk TLS and prove their keys inside the connection, so nothing is sent to an address
  until the machine there proves who it is. Every message is signed by the machine that sent it.
- A node shows only throwaway keys to anyone who connects, so a laptop can't be recognised as it moves
  between networks. While an invite is open it presents the invite key instead.
- Joining is by one-time invite (expires in 24 hours), with the invite key pinned in the curl line.
  Any member can invite, and serves the installer.
- LAN discovery uses encrypted UDP beacons, and machines share the addresses they know. Invites include
  a Tailscale name, or an IP where there is none. A machine whose address stops answering is found
  again at its other addresses.

### Install

- One line installs agentlink, a background service (launchd or systemd), and the hook for every
  Claude Code account on the machine. It checks what's needed before it changes anything.
- On Apple silicon Macs, agentlink is a signed, notarized app in `~/Applications`, so macOS asks for
  Local Network access by name. Elsewhere it's the npm package, with a private Node.js if needed.
- A running session joins with `/reload-plugins`. New sessions join by themselves.
- `agentlink peers` and the `network` tool say why a machine is offline, and machines running
  incompatible versions are reported as needing an upgrade.
