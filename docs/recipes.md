# Recipes

Ways to use agentlink, each with the setup and what to type. They assume agentlink is set up on
the machines involved ([Setup](../README.md#setup)).

An agent's address is `<name>@<machine>.local`, where the name is the project folder's. To give a
session a name of its own, start it with `AGENTLINK_NAME=<name> claude`. Ask Claude "who's online
on agentlink?" to see every address.

The addresses below are written out in full, but you don't have to be exact. Leave off `.local`,
use a machine's Tailscale name, or just describe the agent ("the api session on my desktop"), and
Claude finds the address among the agents online.

## Ask the agent that knows

Two sessions work on different parts of a system, such as a web app on your laptop and its API on
your desktop. One needs a fact only the other's code holds.

> **You, to Claude in `web` on the laptop:** Ask api@desktop.local which endpoint returns a
> customer's orders, and what it returns. Then use it in the orders page.

The `api` session wakes, even if it was idle, checks its own code and replies. The `web` session
wakes with the answer and carries on. Nobody copies anything between terminals.

## A reviewer on another account

Keep a session on a second Claude account as a reviewer, so a fresh context checks the work and
the cost lands on a different plan. It needs the code, so push the branch somewhere it can fetch.

On the reviewing machine (or under the second account on the same one):

    cd ~/code/myapp && AGENTLINK_NAME=reviewer claude

Tell it once what its job is: "When someone asks you for a review, fetch their branch, review the
diff against main, and reply with what must change and what's optional." Then, from the session
doing the work:

> **You:** Push this branch, then ask reviewer@desktop.local to review it.

Its reply wakes the working session, which can act on the review straight away.

## Wake a session from a script

`agentlink send` works from any shell, so a CI job, cron entry or git hook can hand work to a live
session:

    agentlink send api@desktop.local "Nightly tests failed: https://ci.example.com/runs/1234. Find out why."

The `api` session wakes and starts investigating. The sender appears as `cli`, or pass
`--from nightly`. If the machine is off, the message waits for up to 7 days. If no session with
that name is running, the machine keeps it until one starts.

Only interactive sessions are woken. Keep one open (in tmux, say) where scripts should reach it.

## A nightly job that reports in the morning

A headless run (`claude -p`) isn't woken by messages, but it can send them. Run it from cron on a
server, and have it leave a summary for the session you open in the morning:

    0 2 * * *  cd ~/code/myapp && claude -p "Update the dependencies, run the tests, then use agentlink to send a summary to me@laptop.local."

Start your morning session on the laptop with `AGENTLINK_NAME=me claude`. The summary waits there
until that session starts, or wakes it if it's already open. For the job to send without anyone
approving it, allow agentlink's `send` tool for it, for example with
`--allowedTools mcp__agentlink__send` and whatever else the job needs.

## Two accounts on one machine

A work account and a personal one, or two plans, under one computer login can message each other,
which Claude Code's own messaging doesn't allow. Every account setup finds is on the network. A
bare name means this machine:

> **You, in the personal account's session:** Ask docs to summarise what changed in the API this
> week.

Run `agentlink setup` again after adding a new account, so it's included.

## Claude Code and Codex together

If Codex is installed when you run `agentlink setup`, its sessions join the network and are woken by
messages like Claude Code's. Trust agentlink's hook the first time Codex asks. A Codex session is
named after its folder, so with a Claude Code session already in `~/code/api`, a Codex session there
is `api-2` (ask either one who's online to check):

> **You, to Claude:** Ask api-2@desktop.local to review the migration in this branch, and fix what it
> finds.

Codex wakes, reviews it and replies, and its answer wakes Claude.

## A second opinion from Gemini

Any MCP agent can join. Add agentlink to Gemini CLI in poll mode, in `~/.gemini/settings.json`:

    { "mcpServers": { "agentlink": { "command": "agentlink", "args": ["mcp", "--poll", "--name", "gemini"] } } }

Then Claude can send it questions as `gemini@<machine>.local`, like any other agent. Gemini CLI
isn't woken by messages: it reads them when it next uses its `inbox` tool, so tell it to check its
agentlink inbox when you want it to answer.

## Fewer stalls at permission prompts

A woken session still stops at permission prompts, so an answer can wait until you're back. Setup
lets only `inbox` and `peers` run unattended. To let sessions reply by themselves too, allow
`send` in `~/.claude/settings.json`:

    { "permissions": { "allow": ["mcp__agentlink__send"] } }

Messages can then go out without you seeing them first. They only reach your own machines, but an
agent can be talked into sending something it shouldn't, so allow it only if you're happy with
that. Allow the other tools a woken session typically needs (reading files, running your tests)
the same way.
