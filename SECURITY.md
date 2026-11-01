# Security

## Model

Each machine has its own ECDSA P-256 key pair, created by `agentlink setup` and kept in
`~/.agentlink/node.key` (readable only by you). An agentlink network is a list of member keys
(the *roster*): a set of signed records saying "this key, called `laptop.local`, was added by that
member" or "this key was removed". Members exchange and merge these records; every member computes
the same membership from the same records.

- **Transport.** Every connection is TLS 1.3. The certificate a node presents is a throwaway (a new
  key for each connection), so connecting to a node's port shows nothing that identifies the
  machine. Machines prove who they are inside the encrypted connection. The client first shows it
  holds the network's discovery key; anyone else gets a 404. The server then signs the connection
  with its machine key. The client checks that this is the machine the roster says should be there,
  and only then signs the connection with its own key and sends its request. If anyone else answers
  at the address, they get nothing but that first, anonymous step. Both signatures cover that one
  TLS session, so they can't be replayed, or relayed by someone sitting in the middle.
- **Addresses are only hints.** LAN beacons, gossiped addresses, configured names and the source
  IPs of requests can all be wrong or stale (DHCP reuse, a laptop on another network, spoofed
  name resolution). An address is used for a machine only once the machine there proves it holds
  that machine's key, so a wrong address never receives a request. Someone relaying traffic to the real
  machine sees only ciphertext.
- **Membership.** A node accepts machine-to-machine requests only from current members' keys.
  Before a machine has proved its key, the only membership records it can submit are the ones that
  add it. Any member can add a machine by inviting it.
- **Removal.** Machines are ranked in the order they joined, and a machine can remove only machines
  that joined after it. The founding machine can remove anyone, and two machines can never remove
  each other. A removal can't be undone: removing the remover doesn't bring a machine back, and
  removals made at the same time all stand. A removed key is gone for good (the machine re-joins
  with a new key), and a key made by a removed machine never becomes the discovery key.
- **A removed machine can't add machines.** A removal lists the removed machine's records the
  remover had. Machines it added stay if every remover had seen the add. An add the remover hadn't
  seen doesn't count, whatever date it carries, and that machine needs a new invite. Every member
  computes the same membership from the same records, whatever order they arrived in.
- **Messages.** Each message is signed end to end by the machine that sent it. A node accepts a
  message only if the signer is a current member and is the machine named in the sender address,
  so holders relaying copies can't alter messages and a member can't send as another machine.
- **Joining.** `agentlink invite` makes a one-time token (stored hashed, expires after 24 hours)
  and prints a `curl -k --pinnedpubkey "sha256//<key>" https://…` line. The key is an invite key,
  which the inviting node presents only while it has invites open. curl's `-k` only skips
  certificate-authority checks; `--pinnedpubkey` still makes curl refuse any other key, so the
  installer, the package and the token can't be intercepted or replaced. The joining machine checks
  the same key again before it sends its join request. The token is consumed by the join.
  `agentlink invite --revoke` cancels unused tokens. Starting or joining another network deletes the
  old network's invites.
- **Discovery.** LAN beacons are encrypted under a discovery key that members share only over
  their TLS connections, so other people on the network can't read machine names from them. The
  discovery key is replaced whenever a machine is removed. A replaced key still opens other
  members' gates for 14 days, so a machine that was offline during a removal can catch up. After
  that, it needs a new invite.
- **Local API.** Sessions on the same machine talk to their node over TLS on 127.0.0.1, with the
  same check: the node must prove it holds this machine's key, and so must the client. Only
  processes that can read this machine's private key (your user) get in, and a program squatting
  on the port is sent nothing. `/health` answers only them.
- **Prompt injection.** Messages come from other AI agents. The MCP adapter instructs Claude to
  treat them as requests from a colleague — never as instructions from its user — and not to
  take destructive or security-sensitive actions solely because a peer asked. Only invite
  machines and agents you trust.

## Known limitations

- **Members are trusted.** Any member can invite machines, and a machine can remove the ones that
  joined after it. A compromised member could quietly add extra machines before you remove it.
  `agentlink status` lists machines in joining order and shows which member added each one:
  remove any you don't recognise, or start a new network with `agentlink setup --new-network`
  and re-join your machines.
- **The founding machine can't be removed.** Nothing joined before it. If it's lost or
  compromised, start a new network. Likewise, a machine can only be removed from machines that
  joined before it.
- **A removed machine's removals of later machines can still take effect.** If it signs one and
  gets it to a member that hasn't heard of its removal yet, the removal stands, like any removal
  made at the same moment. It can never remove a machine that joined before it, add one, or get
  back in. The affected machines re-join with an invite.
- **A removed machine can still tell which member it is talking to, for 14 days.** It can pass the
  gate with an old discovery key during the grace period, and learn which member is at an address
  (which it knew already). It still can't send, receive or change the member list.
- **Agents on a machine aren't separately authenticated.** Any process running as your user can
  send as any session name on that machine.
- **Invites are credentials until used.** Anyone who gets an unused invite line within 24 hours can
  join one machine with it. Treat it like a password until it's been used, or revoke it. On a
  shared machine, other users can see the line's token in the process list for the few seconds the
  first `curl` runs (the installer keeps it off command lines after that).
- **While an invite is open, its key is visible to anyone who connects to the port.** Someone could
  use it to recognise the machine during that window (24 hours at most). Run `agentlink invite
  --revoke` once you've added your machines. At other times, a node shows only throwaway keys.
- **The open port is visible.** Someone scanning a network can see that something is listening on
  agentlink's port (7777 by default), and can guess it's agentlink.
- **A removed machine keeps what it had.** It keeps its copy of the member list (machine names and
  public keys; no secrets) and any messages it already received.

## Starting over

Run `agentlink setup --new-network` on one machine. It creates a new key and a new network with
that machine as its only member; join the other machines with fresh invites.

## Reporting a vulnerability

Please open a private security advisory on GitHub ("Security" tab → "Report a vulnerability")
rather than a public issue.
