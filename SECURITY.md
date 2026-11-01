# Security

## Model

An agentlink network is defined by one shared secret, created on the first machine and
included in the invite. Anyone holding the secret is a full member of the network.

- **Authentication.** Every node-to-node and session-to-node request carries an HMAC of
  method, path, body and timestamp (5-minute window). Requests without a valid signature are
  rejected. LAN discovery beacons are signed the same way.
- **Integrity.** Each message envelope is HMAC-signed end to end, so outsiders cannot alter a
  message in transit. All members share one key, so a member *can* forge or alter messages —
  membership is full trust.
- **Responses** are signed and bound to the request they answer, so a machine without the secret
  cannot fake a delivery receipt. **Replays** are rejected (each request carries a single-use
  nonce, and the sender's identity header is covered by the signature).
- **Addresses.** Discovery beacons and request source IPs are only hints: a new address for a
  machine is used only after an authenticated exchange with the node at that address.
  Addresses are restricted to plain `host:port`, so message routing can't be turned into
  requests to arbitrary URLs.
- **No encryption.** Traffic is plain HTTP. Message contents are visible to anyone who can
  observe your network. On untrusted networks, connect machines over Tailscale (or another
  VPN) — agentlink then runs over its encrypted tunnel.
- **Local API.** `/local/*` endpoints (used by sessions on the same machine) only accept
  loopback connections, in addition to the signature check.
- **Installer endpoint.** `/install` and `/pkg.tgz` are served only to requests that present the
  secret, so the invite line works as a capability. Treat it like a password. The join runs over
  plain HTTP: someone who can intercept traffic on your network during a join could serve a
  malicious installer. Join over a network you trust, or over Tailscale.
- **Prompt injection.** Messages come from other AI agents. The MCP adapter instructs Claude to
  treat them as requests from a colleague — never as instructions from its user — and not to
  take destructive or security-sensitive actions solely because a peer asked. Only invite
  machines and agents you trust.

## Known limitations

- One shared key: no per-machine identity or revocation short of rotating the secret.
- `/health` is unauthenticated (used locally to find the node); it reveals the hostname,
  version and a network id derived from the secret. Secrets you supply must be ≥ 24 characters;
  generated ones are 32 random characters.

## Rotating the secret

Run `agentlink setup --new-network` on one machine to create a new network with a fresh secret,
then join each of the other machines with the new invite (on each of them, run the invite line;
it replaces the old secret). Machines still on the old secret can no longer talk to the new
network. (Plain `agentlink setup` keeps the existing secret, so it does not rotate anything.)

## Reporting a vulnerability

Please open a private security advisory on GitHub ("Security" tab → "Report a vulnerability")
rather than a public issue.
