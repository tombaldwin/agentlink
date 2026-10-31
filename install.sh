#!/bin/sh
# agentlink installer — wake-on-message networking for AI agents (Claude Code and others)
#
#   New network:   curl -fsSL https://raw.githubusercontent.com/polyhub/agentlink/main/install.sh | sh
#   Join network:  paste the line printed by `agentlink invite` on a machine that's already set up
#
# Installs (no sudo): a private Node.js runtime if a recent one isn't present, the agentlink
# package, a background service, and agentlink for every Claude Code account on this machine.
set -e
#@@PRESET@@
PKG="${AGENTLINK_PKG:-agentlink}"
AGENTLINK_ORIG_PATH="$PATH"; export AGENTLINK_ORIG_PATH
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

node_ok() {
  command -v node >/dev/null 2>&1 &&
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null
}

PRIV="$HOME/.agentlink/node"
[ -x "$PRIV/bin/node" ] && export PATH="$PRIV/bin:$PATH"
if ! node_ok; then
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
  export PATH="$PRIV/bin:$PATH"
fi

case "$PKG" in
  http://*|https://*) curl -fsSL "$PKG" -o "$TMP/agentlink.tgz"; PKG="$TMP/agentlink.tgz" ;;
esac

echo "Installing agentlink..."
if npm install -g --silent --no-fund --no-audit "$PKG" >/dev/null 2>&1; then
  BINDIR="$(npm prefix -g)/bin"
else
  echo "(global npm install not permitted; installing to ~/.local)"
  npm install -g --silent --no-fund --no-audit --prefix "$HOME/.local" "$PKG" >/dev/null
  BINDIR="$HOME/.local/bin"
fi

AGENTLINK_BIN_DIR="$BINDIR" "$BINDIR/agentlink" setup "$@"
