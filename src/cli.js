// The command line's help, suggestions for mistyped commands, and shell completion.
// bin/agentlink.js runs the commands; this describes them.

/**
 * @typedef {{ name: string, args?: string, summary: string, help?: string,
 *             flags?: [string, string][], plumbing?: boolean, hidden?: boolean }} Command
 */

/** @type {Command[]} */
export const COMMANDS = [
  {
    name: 'setup', args: '[options]', summary: 'set up this machine, or update it after an upgrade',
    help: `Starts a new network if this machine has none, and keeps its network if it has one.
To add a machine to an existing network, don't run this: run \`agentlink invite\` on a machine
that's already a member, and run the line it prints on the new one.
Also enables agentlink for every Claude Code account on this machine, and for Codex if it's installed.`,
    flags: [
      ['--new-network', 'leave this machine\'s network and start a new one'],
      ['--host <name>', 'the name other machines use for this one (default: its .local name)'],
      ['--no-service', 'don\'t install the background service'],
      ['--no-claude', 'don\'t enable agentlink in Claude Code'],
      ['--no-codex', 'don\'t enable agentlink in Codex'],
    ],
  },
  {
    name: 'invite', args: '[--list | --revoke]', summary: 'print a one-time line that adds another machine',
    help: `Prints a line to run on the new machine (or paste into Claude Code there). It lets one
machine join and expires in 24 hours.`,
    flags: [
      ['--list', 'show unused invites'],
      ['--revoke', 'cancel all unused invites'],
    ],
  },
  {
    name: 'send', args: '<name@host> <message...>', summary: 'send a message to an agent',
    help: `Everything after the address is the message. A bare name means this machine.
Prints whether it was delivered, is waiting in an inbox, or is held until the machine is back.
Example: agentlink send reviewer@laptop.local "the build is green"`,
    flags: [['--from <name>', 'the sender name to show (default: cli)']],
  },
  { name: 'peers', summary: 'show which agents are online, here and on other machines' },
  { name: 'status', summary: 'show this machine\'s node status as JSON' },
  {
    name: 'remove', args: '<host>', summary: 'remove a machine from the network',
    help: `The machine can no longer send or receive. Run it on a machine that joined the network
before the one you're removing: a machine can only remove machines that joined after it.`,
  },
  {
    name: 'compact', args: '[--yes]', summary: 'shrink the member list (founding machine only)',
    help: `Shows which machines a fresh member list would keep. Run it again with --yes to go ahead.
Only needed if the list nears its size limit after many machines have come and gone.`,
    flags: [
      ['--yes', 'go ahead'],
      ['--force', 'go ahead even if some machines couldn\'t be checked in time'],
    ],
  },
  {
    name: 'claude', args: '[claude args...]', summary: 'start Claude Code with messages pushed into the session',
    help: `Optional: ordinary \`claude\` sessions already get messages, and are woken by them.
This starts Claude Code with agentlink as a channel, so messages appear in the session as they
arrive. Arguments are passed to claude.`,
  },
  { name: 'uninstall', summary: 'remove the background service and the Claude Code and Codex setup' },
  {
    name: 'completion', args: '<zsh | bash>', summary: 'print a shell completion script',
    help: `zsh: add this line to ~/.zshrc (after compinit, if you call it):
  eval "$(agentlink completion zsh)"
bash: add this line to ~/.bashrc:
  eval "$(agentlink completion bash)"`,
  },
  { name: 'version', summary: 'print the version' },
  { name: 'help', args: '[command]', summary: 'show help for agentlink or one command' },
  {
    name: 'node', summary: 'run the node (normally run by the background service)', plumbing: true,
    flags: [['--on-demand', 'exit if a node is already running, instead of standing by']],
  },
  {
    name: 'mcp', args: '[--poll | --channel] [--name <name>]', summary: 'run the MCP adapter (normally run by your agent)', plumbing: true,
    help: `Any MCP agent can join with this as a stdio server. --poll: the agent reads with the inbox
tool rather than being woken (use this for agents other than Claude Code).`,
    flags: [
      ['--poll', 'read messages with the inbox tool'],
      ['--channel', 'push messages as a Claude Code channel'],
      ['--name <name>', 'this agent\'s name (default: the working folder\'s name)'],
    ],
  },
  { name: 'wake', summary: 'run by the Claude Code hook', hidden: true },
  { name: 'codex-hook', summary: 'run by the Codex hook', hidden: true },
  { name: 'codex-wake', summary: 'started by the Codex hook', hidden: true },
  { name: '__complete', summary: 'used by the completion scripts', hidden: true },
]

const byName = new Map(COMMANDS.map(c => [c.name, c]))
export const findCommand = (/** @type {string} */ name) => byName.get(name)

const ALIASES = { '--version': 'version', '-v': 'version', '--help': 'help', '-h': 'help' }
/** The command a first argument names, following aliases. */
export const resolve = (/** @type {string | undefined} */ a) => a === undefined ? 'help' : /** @type {Record<string,string>} */ (ALIASES)[a] || a

const line = (/** @type {Command} */ c) => {
  const left = `  agentlink ${c.name}${c.args ? ` ${c.args}` : ''}`
  return left.length < 40 ? left.padEnd(40) + c.summary : `${left}\n${' '.repeat(40)}${c.summary}`
}

/** @param {string} version */
export function mainHelp(version) {
  const shown = COMMANDS.filter(c => !c.hidden)
  return `agentlink ${version} — lets AI agents on your machines message each other

Usage: agentlink <command> [options]

${shown.filter(c => !c.plumbing).map(line).join('\n')}

Run by your agent or the service, not usually by hand:
${shown.filter(c => c.plumbing).map(line).join('\n')}

agentlink help <command> (or agentlink <command> --help) shows a command's options.
https://github.com/tombaldwin/agentlink`
}

/** @param {Command} c */
export function commandHelp(c) {
  const flags = c.flags?.length
    ? `\n\nOptions:\n${c.flags.map(([f, d]) => `  ${f.padEnd(18)}${d}`).join('\n')}` : ''
  return `Usage: agentlink ${c.name}${c.args ? ` ${c.args}` : ''}

${c.summary[0].toUpperCase()}${c.summary.slice(1)}.${c.help ? `\n\n${c.help}` : ''}${flags}`
}

/** Edit distance counting a swap of neighbouring letters as one edit, for suggesting a command. */
function distance(/** @type {string} */ a, /** @type {string} */ b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => i || j))
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  }
  return d[a.length][b.length]
}

/** The visible command closest to a mistyped one, if any is close enough. */
export function suggest(/** @type {string} */ typed) {
  const t = typed.toLowerCase()
  let best = '', bestD = Infinity
  for (const c of COMMANDS) {
    if (c.hidden) continue
    const d = c.name.startsWith(t) && t.length >= 2 ? 0 : distance(t, c.name)
    if (d < bestD) { best = c.name; bestD = d }
  }
  return bestD <= Math.max(1, Math.floor(best.length / 3)) ? best : undefined
}

const visible = () => COMMANDS.filter(c => !c.hidden).map(c => c.name)
/** Option names a command takes, for completion (--flag only, without the value placeholder). */
const flagNames = (/** @type {Command} */ c) => (c.flags || []).map(([f]) => f.split(' ')[0])

/** @param {string} shell */
export function completionScript(shell) {
  const cases = COMMANDS.filter(c => !c.hidden && c.flags?.length && c.name !== 'send')   // send completes addresses instead
  if (shell === 'zsh') {
    return `#compdef agentlink
# agentlink completion for zsh. Load it with:  eval "$(agentlink completion zsh)"
_agentlink() {
  local -a cmds
  cmds=(${COMMANDS.filter(c => !c.hidden).map(c => `'${c.name}:${c.summary.replace(/'/g, `'\\''`).replace(/:/g, '\\:')}'`).join(' ')})
  if (( CURRENT == 2 )); then
    _describe -t commands 'agentlink command' cmds
    return
  fi
  case $words[2] in
    send)
      if (( CURRENT == 3 )); then
        local -a addrs; addrs=(\${(f)"$(agentlink __complete addresses 2>/dev/null)"})
        compadd -- $addrs
      fi ;;
    remove)
      if (( CURRENT == 3 )); then
        local -a hosts; hosts=(\${(f)"$(agentlink __complete hosts 2>/dev/null)"})
        compadd -- $hosts
      fi ;;
    help|completion)
      if (( CURRENT == 3 )); then
        if [[ $words[2] == help ]]; then compadd -- ${visible().join(' ')}; else compadd -- zsh bash; fi
      fi ;;
    claude) ;;
${cases.map(c => `    ${c.name}) compadd -- ${flagNames(c).join(' ')} --help ;;`).join('\n')}
    *) compadd -- --help ;;
  esac
}
if (( $+functions[compdef] )); then compdef _agentlink agentlink; else autoload -Uz compinit && compinit && compdef _agentlink agentlink; fi
`
  }
  if (shell === 'bash') {
    return `# agentlink completion for bash. Load it with:  eval "$(agentlink completion bash)"
_agentlink() {
  local cur=\${COMP_WORDS[COMP_CWORD]} words=""
  if [ "$COMP_CWORD" -eq 1 ]; then
    words="${visible().join(' ')}"
  elif [ "$COMP_CWORD" -eq 2 ]; then
    case \${COMP_WORDS[1]} in
      send) words=$(agentlink __complete addresses 2>/dev/null) ;;
      remove) words=$(agentlink __complete hosts 2>/dev/null) ;;
      help) words="${visible().join(' ')}" ;;
      completion) words="zsh bash" ;;
      claude) return ;;
${cases.map(c => `      ${c.name}) words="${flagNames(c).join(' ')} --help" ;;`).join('\n')}
      *) words="--help" ;;
    esac
  else
    case \${COMP_WORDS[1]} in
${cases.map(c => `      ${c.name}) words="${flagNames(c).join(' ')}" ;;`).join('\n')}
    esac
  fi
  local IFS=$'\\n'
  COMPREPLY=($(IFS=$' \\n' compgen -W "$words" -- "$cur"))
}
complete -o default -F _agentlink agentlink
`
  }
  throw new Error('usage: agentlink completion <zsh | bash>')
}
