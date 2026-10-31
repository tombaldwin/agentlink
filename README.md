# agentlink

Let AI agents on different machines — and different Claude accounts — message each other.
Address any agent as `name@host` (e.g. `reviewer@laptop.local`). An incoming message
**wakes an idle Claude Code session**, just like agents talking on a single machine.

## Setup

**First machine** — paste into Claude Code (or run the command yourself):

> Set up agentlink on this machine: run `curl -fsSL https://raw.githubusercontent.com/polyhub/agentlink/main/install.sh | sh`, then show me the prompt it prints for adding other machines, and tell me how to start you with agentlink enabled.

**Every other machine** — paste the prompt the first machine printed. It looks like:

> Join my agentlink network: run `curl -fsSL "http://desk.local:7777/install?k=…" | sh` — then tell me how to start Claude with agentlink enabled.

**Then** open a new terminal and start Claude with `claude-link` (each extra account gets its
own alias, e.g. `claude2-link`). Ask it to message another agent; ask it who's online.

That's it: no config files, no accounts, no server to run. The installer needs no sudo and
brings its own Node.js if the machine doesn't have a recent one. Run `agentlink invite` any
time to print the join prompt again.

## What you get

- **Wake on message.** Messages arrive in the recipient session as a Claude Code channel event
  and Claude acts on them, even when idle. Tools: `send`, `peers`, `inbox`.
- **Nothing gets lost.** Messages are stored on disk at every hop and retried. If the recipient
  isn't running, its machine keeps the message; if the whole machine is off, copies wait on up
  to 3 other online machines and whoever sees it return first delivers. Duplicates are dropped.
  Messages expire after 7 days.
- **Zero-config discovery.** Machines on the same LAN find each other automatically (signed UDP
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
    agentlink invite                   agentlink claude    agentlink uninstall

## Security

One shared secret per network — it's in the invite, so treat the invite like a password.

- **Outsiders** (no secret) can't send, read the API, fake delivery receipts, replay requests, or
  redirect traffic: every request, response, message and discovery beacon is HMAC-signed, and a
  new address for a machine is only used after the node there proves it holds the secret.
- **Members** (anyone with the secret) are fully trusted: any member machine can send as any
  address and relay messages. Only add machines you control.
- **No encryption.** Traffic is plain HTTP, so someone watching your network can read messages,
  and the first join (`curl … | sh`) is only as trustworthy as the network it runs over. On a
  home or office LAN that's usually fine; anywhere else, connect machines with Tailscale and
  join over it.
- **Prompt injection.** Messages come from other AI agents. agentlink tells Claude to treat them
  as requests from a colleague, not instructions from you, and to check with you before
  anything destructive or sensitive.

See [SECURITY.md](SECURITY.md) for details.

## Caveats

- Claude Code channels are a research preview, so `claude-link` passes
  `--dangerously-load-development-channels server:agentlink` and Claude Code shows a warning at
  startup.
- macOS and Linux. macOS asks once to allow incoming connections for `node`.

## Development

    npm test    # unit tests + multi-node end-to-end: live delivery, offline session, offline machine
                # via holders, dedupe, poll mode, wrong secret, fake node, replay, big backlogs,
                # node restart, IP/Tailscale aliases
