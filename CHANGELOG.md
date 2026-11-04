# Changelog

## 0.1.0 — unreleased

First release.

### Fixed before release, from the release review

- A roster record now counts only if its own signature checks out. A check was remembered by
  signature alone, so a good signature could be reused on a forged record; records that merely
  claimed a member signer were also kept and passed on.
- Discovery keys come only from the founder and from removals that stand, and malformed ones are
  refused. Local clients read them through the roster's rules.
- Records are identified by content, so a re-encoded signature can't pass as a new record.
- A full roster still takes removals, and loading never drops records. `remove` reports an error
  instead of success if the removal wasn't recorded.
- Timeouts cover connecting, so an address that silently drops packets fails in seconds, not after
  more than a minute (which also made `peers` and `send` fail when one machine was away).
- A machine whose stored address stops answering is found again at its other addresses.
- Setup refuses to replace a key when the member list is missing or unreadable, and the list is
  flushed to disk before it replaces the old one.
- The installer checks the certificate behind the app's signature, not the team it states.
- The app carries the licence notices of Node.js and the packages it bundles.
- The app has an icon.
- A background Claude Code hook wakes idle sessions, so people start Claude as usual: no launch
  alias, no development-channels warning, and it works where channels are turned off.
- Invites offer an IP address where there's no Tailscale name, for machines that can't look up
  `.local` names.

- Per-machine node with durable SQLite store, store-and-forward delivery, retries, and
  replication to other online nodes while a recipient machine is offline.
- Claude Code channel adapter: incoming messages wake idle sessions. Tools: `send`, `peers`,
  `inbox`, and `network` / `invite` so Claude can show the network and add machines (only when
  its user asks; removal and uninstall stay in the terminal). Poll mode (`agentlink mcp --poll`) for agents without channel support.
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
- `agentlink peers` (and the `peers` / `network` tools) say why a machine is offline, with a hint
  when macOS Local Network privacy is the likely cause; the node log records when a machine stops
  or starts answering. Connection errors to names with several addresses are readable.
- `agentlink invite --list` (and the `invite` tool's `list`) shows unused invites. Commands
  reject unknown options instead of ignoring them. A machine that has just joined no longer opens
  an invite of its own.
- Setup and `agentlink claude` check that Claude Code can start the adapter (e.g. a git clone
  without `npm install`), and setup says how to start Claude in the current terminal, before the
  new aliases are loaded.
- A session left running across an upgrade asks to be restarted instead of replacing the newer
  node with its own version.
- On Apple silicon Macs, agentlink installs as a signed app (`~/Applications/agentlink.app`), so
  macOS asks for Local Network access by name and the permission covers agentlink only. A Mac
  joining through a machine that runs the app gets the same app over the pinned invite
  connection; otherwise it comes from the latest GitHub release. The installer checks the app's
  signature and team, and falls back to the npm install only if no app is available.
- Sending to a name that isn't a machine on the network (a typo) fails at once and lists the
  machines, instead of queueing; configured peers (Tailscale names, IPs) are still queued while
  offline.
