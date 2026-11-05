# Security

## Model

Each machine has its own ECDSA P-256 key pair, created by `agentlink setup` and kept in
`~/.agentlink/node.key` (readable only by you). An agentlink network is a list of member keys
(the *roster*): a set of signed records saying "this key, called `laptop.local`, was added by that
member" or "this key was removed". Members exchange and merge these records; every member computes
the same membership from the same records.

- **Transport.** Connections between machines are TLS 1.3. (The installer download also accepts TLS
  1.2, for macOS's curl; that's protected by the key pinned in the invite line.) The certificate a
  node presents is a throwaway (a new key for each connection, or each second at the most), so
  connecting to a node's port shows nothing that identifies the machine, unless an invite is open:
  see *Known limitations*. Machines prove who they are inside the encrypted connection. The client first shows it
  holds the network's discovery key; without it, other paths get a 404 (the join paths answer
  separately, see *The open port is visible*). The server then signs the connection
  with its machine key. The client checks that this is the machine the roster says should be there,
  and only then signs the connection with its own key and sends its request. If anyone else answers
  at the address, they get nothing but that first, anonymous step, which has a time limit however
  slowly they answer. Both signatures cover that one TLS session, so they can't be replayed, or
  relayed by someone sitting in the middle.
- **Addresses are only hints.** LAN beacons, gossiped addresses, configured names and the source
  IPs of requests can all be wrong or stale (DHCP reuse, a laptop on another network, spoofed
  name resolution). An address is used for a machine only once the machine there proves it holds
  that machine's key, so a wrong address never receives a request. Someone relaying traffic to the real
  machine sees only ciphertext.
- **Membership.** A node accepts machine-to-machine requests only from current members' keys.
  Before a machine has proved its key, the only membership records it can submit are the ones that
  add it and one snapshot, which only the founding machine can have signed. Any member can add a machine by inviting it. A record counts, and is kept and passed on,
  only if its signature checks out against the signer it names. A roster stops taking new records
  at 1 MB, apart from the founder's snapshots and removals of a current member by a machine that joined before it, one per
  machine, which may be as big as a removal has any reason to be: an entry for each machine the
  target really added, and otherwise no bigger than what it clears. So a roster always fits in the
  one request (8 MB) that carries it between machines, and a member can't stay on by filling one.
- **Removal.** Machines are ranked in the order they joined, and a machine can remove only machines
  that joined after it. The founding machine can remove anyone, and two machines can never remove
  each other. Removing the remover doesn't bring a machine back, and removals made at the same time
  all stand. A removed key can't come back on its own (the machine isn't told, and re-joins with an
  invite and a new key), with the exceptions in *Known limitations*. A key made by a removed machine
  never becomes the discovery key.
- **Snapshots.** `agentlink compact`, on the founding machine, signs a list of the current members
  in joining order, with the discovery keys still in use and a new one. Any machine can check it
  against the network's ID, and it replaces all the records before it. After a snapshot, an add dated
  before it counts for nothing, nor does anything signed by a machine that isn't in it. A removal
  between two machines in it still counts if it's dated after that machine was added, so a removal
  made at the same moment isn't lost, and one from before a machine was let back in doesn't apply.
- **A removed machine can't add machines.** A removal lists the removed machine's records the
  remover had. Machines it added stay if every remover had seen the add. An add the remover hadn't
  seen doesn't count, whatever date it carries, and that machine needs a new invite. Every member
  computes the same membership from the same records, whatever order they arrived in.
- **Messages.** Each message is signed by the machine that sent it. A node accepts a message only
  if the signer is a current member and is the machine named in the sender address, so holders
  relaying copies can't alter messages and a member can't send as another machine. A sender address
  must be exactly `name@host` as a node writes it, so nothing can be hidden in it. Messages are
  encrypted between machines but not end to end: see *Known limitations*.
- **Joining.** `agentlink invite` makes a one-time token (stored hashed, expires after 24 hours)
  and prints a `curl -k --pinnedpubkey "sha256//<key>" https://…` line. The key is an invite key,
  which the inviting node presents only while it has invites open. curl's `-k` only skips
  certificate-authority checks; `--pinnedpubkey` still makes curl refuse any other key, so the
  installer, the package and the token can't be intercepted or replaced. The joining machine checks
  the same key again before it sends its join request. The token is consumed by the join.
  `agentlink invite --revoke` cancels unused tokens. Starting or joining another network deletes the
  old network's invites and all its messages, and setup stops rather than start the node if it can't.
- **Discovery.** LAN beacons are encrypted under a discovery key that members share only over
  their TLS connections, so other people on the network can't read machine names from them. The
  discovery key is replaced whenever a machine is removed. A replaced key still opens other
  members' gates, and gets beacons answered, for 14 days, so a machine that was offline during a
  removal can catch up. After that, it needs a new invite.
- **Local API.** Sessions on the same machine talk to their node over TLS on 127.0.0.1, with the
  same check: the node must prove it holds this machine's key, and so must the client. Only
  processes that can read this machine's private key (your user) get in, and a program squatting
  on the port is sent nothing. `/health` answers only them.
- **Prompt injection.** Messages come from other AI agents. The MCP adapter instructs Claude to
  treat them as requests from a colleague — never as instructions from its user — and not to
  take destructive or security-sensitive actions solely because a peer asked. Each message is framed
  with a tag made for that read, so its text can't pass for another message from someone else. Nothing
  else another machine writes reaches a session: a session name must be one a node could have made, and
  a machine's error text is dropped for its status code. Only invite machines and agents you trust.
- **Waking a session.** Setup adds a Claude Code hook that waits in the background and wakes an idle
  session when a message arrives. What it shows Claude is fixed text saying a message is waiting:
  nothing another agent wrote comes through the hook. Claude reads the message with the `inbox` tool,
  so it arrives as a tool result from a named sender. Setup lets `inbox` and `peers` run without a
  prompt; `send` keeps the session's normal permission rules. A woken session is still acting on
  another agent's request, with whatever permissions the session has, so take care with sessions
  running in a mode that skips permission prompts.

## Known limitations

- **Members are trusted.** Any member can invite machines, and a machine can remove the ones that
  joined after it. A compromised member could quietly add extra machines before you remove it.
  `agentlink status` lists machines in joining order and shows which member added each one:
  remove any you don't recognise, or start a new network with `agentlink setup --new-network`
  and re-join your machines. One thing it won't show: a member can sign a second key under its own
  name. That key never becomes a member, and it's dropped when the member is removed.
- **A member can fill a machine's message store.** A session can have 2,000 messages waiting, but a
  member can write to made-up names, or to a session reading as fast as they arrive. A store stops at
  1 GB, so the disk is safe, but then that machine takes no new messages from anyone until old ones
  expire, even after the member is removed. Messages sent to it wait at their senders until then.
- **A member can undo a removal made by a machine that joined after it.** It signs a backdated add of
  the removed key, dated before the remover joined, so that the remover no longer ranks above it, and
  the machine is back under its old key. A removal by a machine that joined before that member stands.
  If you suspect a member, remove it first, from the earliest machine you can. A snapshot ends this
  for everything before it, because adds can't be dated before a snapshot.
- **A snapshot forgets removed keys.** A removed machine can then come back under its old key, but
  only if a member adds it: with an invite, as any new machine would. Sending to it after that says
  it isn't a machine on the network, not that it was removed.
- **A snapshot can drop a machine.** One added just before it, which the founding machine hadn't
  heard of, isn't in it and needs a new invite. `agentlink compact` catches up first, and shows who
  will be kept and who it couldn't reach.
- **A snapshot goes by what the founding machine knows.** If it hasn't heard of a removal yet, two
  things can go against the rules above. A machine that was removed by a machine that's now gone
  too comes back, as the removal counts for nothing without its signer. And a machine added by a
  removed one stays, if the founding machine heard of the add first. So make a snapshot with your
  machines online, and check the list `agentlink compact` shows.
- **A backdated removal can cut a machine off until someone reaches it.** A member can sign a removal
  dated before a snapshot that's over 14 days old, which brings in a new key and leaves no grace period
  for the snapshot's. A machine that hasn't heard is refused at the gate until another member reaches
  it, and then it catches up.
- **Only the founding machine can make a snapshot.** If it's lost, the way out of a full member list
  is a new network.
- **Messages aren't end-to-end encrypted.** While the recipient's machine is off, copies wait on
  other members, which can read them until they're handed over. They can't alter them. Don't send
  anything through agentlink that you wouldn't want your other machines to hold.
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
- **Two removals at the same moment can leave a removed machine holding the current discovery key.**
  If one machine removes another that has already heard of a third's removal, the removed machine has
  the key that removal brought in, until the next removal by a current member, or a snapshot, replaces
  it. It can pass the gate as above, for that long.
- **A member can flood the roster.** Until you remove it, a compromised member can fill the roster
  so that no new machine can join, and machines may disagree about the last records to arrive.
  Removing it clears what it signed, apart from machines it really added and its removals of machines
  that had joined. Those stay until the next snapshot, so a roster can stay full once the member has
  gone: remove the machines it added, then run `agentlink compact` on the founding machine. While
  a roster is full, two kinds of removal wait until there's room, so machines can disagree until
  then: a second removal of a machine already removed, and one listing dozens of machines a full node
  has never heard of, if what fills that node was signed by someone else. Remove that machine first.
  `agentlink remove` says so if it's this machine's own roster that has no room.
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
  agentlink's port (7777 by default), and the join paths answer in a way that shows it's agentlink.
- **Looking up `.local` names is visible.** Connections themselves don't reveal a machine's name,
  but a laptop trying to reach `desk.local` asks for it by name, by multicast, on whatever network
  it's on. Someone there can see the names of your machines.
- **A removed machine keeps what it had.** It keeps its copy of the member list (machine names and
  public keys; no secrets) and any messages it already received.

## Starting over

Run `agentlink setup --new-network` on one machine. It creates a new key and a new network with
that machine as its only member; join the other machines with fresh invites.

## Reporting a vulnerability

Please open a private security advisory on GitHub ("Security" tab → "Report a vulnerability")
rather than a public issue.
