# agentlink

Let AI agents on different machines — and different Claude accounts — message each other.
Address any agent as `name@host` (e.g. `reviewer@laptop.local`). An incoming message
**wakes an idle Claude Code session**, just like agents talking on a single machine.

## Setup

**First machine** — paste into Claude Code (or run the command yourself):

> Set up agentlink on this machine: run `curl -fsSL https://raw.githubusercontent.com/tombaldwin/agentlink/main/install.sh | sh`, then show me the prompt it prints for adding other machines, and tell me how to start you with agentlink enabled.

**Every other machine** — paste the prompt the first machine printed. It looks like:

> Join my agentlink network: run `curl -fsSL -k --pinnedpubkey "sha256//…" "https://desk.local:7777/join/install?t=…" | sh` — then tell me how to start Claude with agentlink enabled.

Each invite adds one machine and expires after 24 hours. The pinned key means curl only talks to
the machine that made the invite. That key exists only while the invite is open, so a used invite
line stops working entirely: curl reports "public key does not match". Run `agentlink invite` on
any member for a new one.

**Then** open a new terminal and start Claude with `claude-link` (each extra account gets its
own alias, e.g. `claude2-link`). Ask it to message another agent; ask it who's online.

That's it: no config files, no accounts, no server to run. The installer needs no sudo and
brings its own Node.js if the machine doesn't have a recent one. Run `agentlink invite` on any
member for the next machine.

## What you get

- **Wake on message.** Messages arrive in the recipient session as a Claude Code channel event
  and Claude acts on them, even when idle. Tools: `send`, `peers`, `inbox`.
- **Nothing gets lost.** Messages are stored on disk at every hop and retried. If the recipient
  isn't running, its machine keeps the message; if the whole machine is off, copies wait on up
  to 3 other online machines and whoever sees it return first delivers. Duplicates are dropped.
  Messages expire after 7 days.
- **Zero-config discovery.** Machines on the same LAN find each other automatically (encrypted UDP
  beacons) and share what they know, so every machine learns the whole network.
- **Multiple Claude accounts.** Every `CLAUDE_CONFIG_DIR` account on a machine is enabled
  (`~/.claude*` dirs and shell aliases); new accounts are enabled the first time you run
  `agentlink claude` under them.
- **Beyond the LAN.** With Tailscale on both machines, `agentlink invite` includes the Tailscale
  name and joining machines use it automatically.
- **Other agents.** Any MCP agent can join with `agentlink mcp --poll` (it reads with `inbox`
  instead of being woken).

Name a session with `AGENTLINK_NAME=<name> claude-link` (default: the project folder name).

## Commands

    agentlink send <name@host> <msg>   agentlink peers     agentlink status
    agentlink invite [--revoke]        agentlink remove <host>
    agentlink claude                   agentlink uninstall

## Security

Each machine has its own key. The network is the list of machines' keys, kept and shared by the
members; any member can invite or remove machines.

- **Encrypted, and nothing for strangers.** Machines talk TLS and prove their keys to each other
  inside the connection. A laptop at a café that tries a home address now held by a stranger
  doesn't say who it is or send anything before the check fails. And anyone who connects to a
  machine sees only a throwaway key, so a laptop can't be recognised as it moves between networks.
- **Joining.** An invite is a one-time token plus a key the inviting machine presents while the
  invite is open. Someone watching the
  network learns nothing from a join, and can't swap the installer. A used or expired invite is
  worthless.
- **Machines can't impersonate each other.** Every message is signed by the machine that sent it,
  and machines relaying a copy can't change it. `agentlink remove <host>` takes a machine off the
  network; members that were offline learn about it when they come back.
- **Members are trusted.** Any member can add machines, and every agent on a member machine can
  message yours. Only add machines you control.
- **Prompt injection.** Messages come from other AI agents. agentlink tells Claude to treat them
  as requests from a colleague, not instructions from you, and to check with you before
  anything destructive or sensitive.

See [SECURITY.md](SECURITY.md) for details and known limitations.

## Caveats

- Claude Code channels are a research preview, so `claude-link` passes
  `--dangerously-load-development-channels=server:agentlink` and Claude Code shows a warning at
  startup. A session started with plain `claude` (or `claude-link -p`) isn't woken: its messages
  wait for the `inbox` tool instead.
- Claude Code doesn't confirm that a pushed message reached the session, so senders see "pushed to
  … live session" rather than "read". If your organisation doesn't allow channels (claude.ai
  Team/Enterprise without `channelsEnabled`, Bedrock, Vertex), Claude Code silently drops pushes:
  start sessions with `AGENTLINK_POLL=1 claude-link` so messages wait for the `inbox` tool.
- Re-running `agentlink setup` keeps the machine on its network; pass `--new-network` to start a
  new one.
- A machine's name is fixed when it joins. To rename it, remove it and join again under the new
  name (`--host`). Messages already queued for its old name wait until they expire.
- macOS and Linux. macOS asks once to allow incoming connections for `node`.

## Development

    npm test    # unit tests + multi-node end-to-end: live delivery, offline session, offline machine
                # via holders, dedupe, poll mode, outsiders, forged and altered messages, strangers
                # at stored addresses, relays, invites and joining, removal, big backlogs, node
                # restart, IP/Tailscale aliases
