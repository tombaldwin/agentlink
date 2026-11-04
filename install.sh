#!/bin/sh
# agentlink installer — wake-on-message networking for AI agents (Claude Code and others)
#
#   New network:   curl -fsSL https://raw.githubusercontent.com/tombaldwin/agentlink/main/install.sh | sh
#   Join network:  paste the one-time line printed by `agentlink invite` on a machine that's already set up
#
# Installs (no sudo): on Apple silicon Macs, agentlink.app in ~/Applications; elsewhere (or if the
# app can't be fetched) a private Node.js runtime if a recent one isn't present and the agentlink
# npm package. Then a background service, and agentlink for every Claude Code account here.
set -e
#@@PRESET@@
PKG="${AGENTLINK_PKG:-@tombaldwin/agentlink}"
AGENTLINK_ORIG_PATH="$PATH"; export AGENTLINK_ORIG_PATH
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# agentlink's home holds this machine's private key, messages and logs: private to this user from the start
AL="$HOME/.agentlink"
mkdir -p "$AL"
chmod 700 "$AL"

# The Apple Developer team that signs agentlink.app: the app is installed only with its signature
TEAM="${AGENTLINK_TEAM:-CZ63J37ULN}"
APPS="$HOME/Applications"
RELEASES=https://github.com/tombaldwin/agentlink/releases/latest/download

# Fetch from the inviting machine, pinned to its invite key (-k only skips CA checks; curl still
# refuses any key but the pinned one). The URL holds the invite token, so it goes to curl in a
# private file, not on the command line (where `ps` would show it).
fetch_invite() {
  printf 'url = "%s"\n' "$1" > "$TMP/curl.cfg"
  if [ -n "${AGENTLINK_PIN:-}" ]; then
    curl -fsSL -k --pinnedpubkey "sha256//$AGENTLINK_PIN" -K "$TMP/curl.cfg" -o "$2"
  else
    curl -fsSL -K "$TMP/curl.cfg" -o "$2"
  fi
}

# agentlink.app (Apple silicon): as a signed app, macOS asks for Local Network access by name and
# the permission covers agentlink only. From the inviting machine when it runs the app, else from
# the latest GitHub release. Returns 1 if no app is available (the npm install is used instead).
install_app() {
  [ "$(uname -s)-$(uname -m)" = Darwin-arm64 ] && [ "${AGENTLINK_APP:-1}" != 0 ] || return 1
  if [ -n "${AGENTLINK_APP_ZIP:-}" ]; then
    # a local build: asked for by name, so failing to read it is an error, not a reason to use npm
    cp "$AGENTLINK_APP_ZIP" "$TMP/app.zip" ||
      { echo "agentlink: cannot read $AGENTLINK_APP_ZIP (on macOS, the terminal may not be allowed into that folder: move the file elsewhere, e.g. your home folder) — aborting"; exit 1; }
  elif [ -n "${AGENTLINK_APP_URL:-}" ]; then
    echo "Fetching agentlink.app from the inviting machine..."
    fetch_invite "$AGENTLINK_APP_URL" "$TMP/app.zip" || return 1
  else
    curl -fsSL "$RELEASES/agentlink-macos-arm64.zip" -o "$TMP/app.zip" 2>/dev/null || return 1
    curl -fsSL "$RELEASES/agentlink-macos-arm64.zip.sha256" -o "$TMP/app.sha256" 2>/dev/null || return 1
    [ "$(awk '{print $1}' "$TMP/app.sha256")" = "$(shasum -a 256 "$TMP/app.zip" | awk '{print $1}')" ] ||
      { echo "agentlink: the app download failed its checksum — aborting"; exit 1; }
  fi
  mkdir -p "$TMP/app" && ditto -x -k "$TMP/app.zip" "$TMP/app" || return 1
  A="$TMP/app/agentlink.app"
  # a damaged or foreign app is an error, not a reason to fall back
  # the requirement checks the certificate Apple issued: the team a signature merely states can be anything
  codesign --verify --strict -R="anchor apple generic and certificate leaf[subject.OU] = \"$TEAM\"" "$A" 2>/dev/null ||
    { echo "agentlink: the app isn't validly signed by agentlink's team ($TEAM) — aborting"; exit 1; }
  mkdir -p "$APPS"
  rm -rf "$APPS/agentlink.app"
  ditto "$A" "$APPS/agentlink.app"
  mkdir -p "$AL/bin"
  ln -sf "$APPS/agentlink.app/Contents/MacOS/agentlink" "$AL/bin/agentlink"
  echo "Installed agentlink.app in $APPS"
}

if install_app; then
  AGENTLINK_BIN_DIR="$AL/bin" "$AL/bin/agentlink" setup "$@"
  exit
fi

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

# joining via an invite: the package comes from the inviting machine
case "$PKG" in
  https://*) fetch_invite "$PKG" "$TMP/agentlink.tgz"; PKG="$TMP/agentlink.tgz" ;;
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
