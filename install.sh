#!/bin/sh
# agentlink installer — wake-on-message networking for AI agents (Claude Code and others)
#
#   New network:   curl -fsSL https://raw.githubusercontent.com/tombaldwin/agentlink/main/install.sh | sh
#   Join network:  paste the line printed by `agentlink invite` on a machine that's already set up
#
# Installs (no sudo): a private Node.js runtime if a recent one isn't present, the agentlink
# package, a background service, and agentlink for every Claude Code account on this machine.
set -e
#@@PRESET@@
PKG="${AGENTLINK_PKG:-@tombaldwin/agentlink}"
AGENTLINK_ORIG_PATH="$PATH"; export AGENTLINK_ORIG_PATH
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# agentlink's home holds the network secret, messages and logs: private to this user from the start
AL="$HOME/.agentlink"
mkdir -p "$AL"
chmod 700 "$AL"

node_ok() {
  [ "${AGENTLINK_PRIVATE_NODE:-}" != 1 ] &&
  command -v node >/dev/null 2>&1 &&
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null
}

PRIV="$AL/node"
USE_PRIV=0
if ! node_ok && [ -x "$PRIV/bin/node" ] && "$PRIV/bin/node" -e 0 2>/dev/null; then
  export PATH="$PRIV/bin:$PATH"; USE_PRIV=1
fi
if [ "$USE_PRIV" = 0 ] && ! node_ok; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) P=darwin-arm64 ;; Darwin-x86_64) P=darwin-x64 ;;
    Linux-x86_64) P=linux-x64 ;; Linux-aarch64|Linux-arm64) P=linux-arm64 ;;
    *) echo "agentlink: no prebuilt Node.js for $(uname -sm); install Node 22.13+ and run this again."; exit 1 ;;
  esac
  echo "Installing a private Node.js runtime in $PRIV (your system Node, if any, is untouched)..."
  DIST=https://nodejs.org/dist/latest-v24.x
  curl -fsSL "$DIST/SHASUMS256.txt" -o "$TMP/SUMS"
  FILE=$(awk '{print $2}' "$TMP/SUMS" | grep -E "^node-v[0-9.]+-$P\.tar\.gz$" | head -1)
  [ -n "$FILE" ] || { echo "agentlink: could not find a Node.js download for $P"; exit 1; }
  curl -fsSL "$DIST/$FILE" -o "$TMP/$FILE"
  WANT=$(awk -v f="$FILE" '$2==f {print $1}' "$TMP/SUMS")
  GOT=$( (shasum -a 256 "$TMP/$FILE" 2>/dev/null || sha256sum "$TMP/$FILE") | awk '{print $1}')
  [ "$WANT" = "$GOT" ] || { echo "agentlink: Node.js download failed its checksum — aborting"; exit 1; }
  rm -rf "$PRIV"; mkdir -p "$PRIV"
  tar xzf "$TMP/$FILE" -C "$PRIV" --strip-components=1
  export PATH="$PRIV/bin:$PATH"; USE_PRIV=1
fi

case "$PKG" in
  http://*|https://*) curl -fsSL "$PKG" -o "$TMP/agentlink.tgz"; PKG="$TMP/agentlink.tgz" ;;
esac

# npm install into a prefix, showing npm's own error output if it fails
npm_install() {
  npm install -g --no-fund --no-audit --loglevel=error "$@" "$PKG" >"$TMP/npm.log" 2>&1 && return 0
  return 1
}
npm_failed() { cat "$TMP/npm.log" >&2; echo "agentlink: installing $PKG with npm failed (npm's output is above)" >&2; exit 1; }

echo "Installing agentlink..."
if [ "$USE_PRIV" = 1 ]; then
  # Keep the private runtime off the user's PATH (it would shadow their own node/npm): install the
  # package in its own prefix and put a single wrapper, run by the private node, in $AL/bin.
  npm_install --prefix "$AL/pkg" || npm_failed
  JS=$(node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$AL/pkg/bin/agentlink")
  BINDIR="$AL/bin"
  mkdir -p "$BINDIR"
  q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
  # shellcheck disable=SC2016 # "$@" is meant literally: it's the wrapper's own arguments
  printf '#!/bin/sh\nexec %s --no-warnings %s "$@"\n' "$(q "$PRIV/bin/node")" "$(q "$JS")" > "$BINDIR/agentlink"
  chmod 755 "$BINDIR/agentlink"
elif npm_install; then
  BINDIR="$(npm prefix -g)/bin"
elif grep -qE 'EACCES|EPERM' "$TMP/npm.log"; then
  echo "(global npm install not permitted; installing to ~/.local)"
  npm_install --prefix "$HOME/.local" || npm_failed
  BINDIR="$HOME/.local/bin"
else
  npm_failed
fi

AGENTLINK_BIN_DIR="$BINDIR" "$BINDIR/agentlink" setup "$@"
