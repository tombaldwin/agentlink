# Changelog

## 0.2.1 — 2026-11-12

Fixes to the move from agentlink, and to setup and uninstall, found in a review:

- A machine set up as agentlink that started a new network (`--new-network`), or joined another one,
  during the upgrade kept the old network's unused invites and its messages. An unused invite could
  then let a machine into the new network. Both are now cleared, as they are for any change of
  network.
- A `~/.agentlink` that is a link (to a folder on another disk, say) is now moved too: the data stays
  where the link leads, and `~/.nattermatic` leads there as well. Before, setup started a new network
  and the old background service kept the port.
- Upgrading with an invite line checks the invite before changing anything, so an invite that was used
  or has expired leaves the machine as it was.
- Sessions that were running when this machine started a new network or joined another one now pick
  up its new key, instead of reporting that something else is using the port.
- `natter uninstall` says so when it can't find Claude Code to remove nattermatic's MCP server, and
  gives the command to run.

## 0.2.0 — 2026-11-11

- **agentlink is now nattermatic.** The command is `natter`: `natter to api@desk "…"` sends a
  message and `natter who` shows who's online. `nattermatic` runs the same commands, and so do the
  old ones (`agentlink`, `send`, `peers`), so scripts keep working. The repo is
  `tombaldwin/nattermatic` (GitHub redirects the old address), the npm package is `nattermatic`,
  and the home page is https://nattermatic.com.
- Upgrading a machine set up as agentlink moves it across: `~/.agentlink` becomes `~/.nattermatic`
  (with a link left behind), the background service and `agentlink.app` are replaced, and Claude
  Code's and Codex's settings are rewritten, including your own permission rules for agentlink's
  tools. `AGENTLINK_*` settings still count. Old and new versions talk to each other, so machines can
  be upgraded one at a time. macOS asks once more for local network access, for the new app, and
  Codex asks you to trust the new hook.
- The Claude Code plugin is `nattermatic`. One installed as `agentlink` keeps working and updating.
- Agents can be addressed loosely: the `send` tool tells agents to match a name like `api@desk` or
  "the api agent on the desktop" against who's online.

## 0.1.3 — 2026-11-09

- Codex: if it's installed, `agentlink setup` adds agentlink to Codex's `config.toml`, with a hook
  that wakes idle Codex sessions when a message arrives (through `codex queue`, Codex 0.167 or
  newer). Codex asks you to trust the hook once. `--no-codex` skips it, and `agentlink uninstall`
  removes it.

## 0.1.2 — 2026-11-09

- Clearer tool descriptions for agents: when to use each tool, `peers` versus `network`, what
  `send` returns, and what `inbox` does in each kind of session.

## 0.1.1 — 2026-11-08

- `agentlink <command> --help` and `agentlink help <command>` show that command's usage and options.
- A mistyped command fails (exit 2) and suggests the nearest one, instead of printing the help.
- `agentlink completion zsh|bash` prints a tab-completion script: commands, options, and the
  addresses of online agents after `agentlink send`.
- Clearer main help, including how to add a machine.
- A Claude Code plugin: `/plugin install agentlink --marketplace tombaldwin/agentlink` adds a skill
  that sets agentlink up, adds machines and explains messaging.
- Listed in the official MCP Registry as `io.github.tombaldwin/agentlink`: publishing a release
  now publishes it there too.

## 0.1.0 — 2026-11-07

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
- A session can have 2,000 messages waiting and a store can reach 1 GB, both configurable. Past that,
  messages wait at the sending machine, and a send there fails with an error.
- Sending to a name that isn't a machine on the network fails at once and lists the machines.
  Configured peers (Tailscale names, IPs) are queued while offline.

### Machines and security

- Each machine has its own key, and the network is a signed member list that members exchange.
  Any member can invite a machine, and a machine can remove the ones that joined after it. A removed
  machine can come back with a new invite, which gives it a new key.
- `agentlink compact`, on the founding machine, replaces the member list's history with a signed
  snapshot of the current members, so it can't stay full.
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
