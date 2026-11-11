#!/bin/sh
# nattermatic installer — wake-on-message networking for AI agents (Claude Code and others)
#
#   New network:   curl -fsSL https://nattermatic.com/install.sh | sh
#   Join network:  paste the one-time line printed by `natter invite` on a machine that's already set up
#
# Installs (no sudo): on Apple silicon Macs, nattermatic.app in ~/Applications; elsewhere (or if the
# app can't be fetched) a private Node.js runtime if a recent one isn't present and the nattermatic
# npm package. Then a background service, and nattermatic for every Claude Code account here.
set -e
#@@PRESET@@
# nattermatic was called agentlink until 0.2.0: AGENTLINK_* settings still count, unless the new name is set
for v in $(env | sed -n 's/^AGENTLINK_\([A-Z0-9_]*\)=.*/\1/p'); do
  eval "[ -n \"\${NATTERMATIC_$v+x}\" ] || { NATTERMATIC_$v=\"\$AGENTLINK_$v\"; export NATTERMATIC_$v; }"
done
PKG="${NATTERMATIC_PKG:-nattermatic}"
NATTERMATIC_ORIG_PATH="$PATH"; export NATTERMATIC_ORIG_PATH
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
trap 'exit 1' HUP INT TERM          # dash doesn't run the EXIT trap for these by itself

# Rosetta's shells call an Apple silicon Mac x86_64
PLATFORM="$(uname -s)-$(uname -m)"
if [ "$PLATFORM" = Darwin-x86_64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then
  PLATFORM=Darwin-arm64
fi

# what nattermatic needs: found out before anything is changed
MIN_CLAUDE=2.1.318                 # WAKE_MIN_CLAUDE in src/claude.js
check_prereqs() {
  [ -n "${NATTERMATIC_SKIP_CHECKS:-}" ] && return 0
  if [ "$PLATFORM" = Darwin-x86_64 ]; then
    echo "nattermatic: Intel Macs aren't supported yet (macOS may stop it reaching your other machines)." >&2
    echo "To install it anyway: NATTERMATIC_SKIP_CHECKS=1" >&2
    exit 1
  fi
  C=$(command -v claude 2>/dev/null || true)
  for f in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude"; do
    if [ -z "$C" ] && [ -x "$f" ]; then C=$f; fi
  done
  if [ -z "$C" ]; then
    # run by Claude Code itself: it's there, just not on this shell's PATH
    [ -n "${CLAUDECODE:-}" ] && return 0
    echo "nattermatic: Claude Code isn't installed. Install it first: https://claude.com/claude-code" >&2
    echo "(For another MCP agent, set NATTERMATIC_SKIP_CHECKS=1.)" >&2
    exit 1
  fi
  V=$("$C" --version 2>/dev/null | sed -n 's/^\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -n 1)
  [ -n "$V" ] || return 0
  OLD=$(printf '%s\n%s\n' "$V" "$MIN_CLAUDE" | awk -F. 'NR==1 { a=$1; b=$2; c=$3 } NR==2 { print (a<$1 || (a==$1 && (b<$2 || (b==$2 && c<$3)))) ? 1 : 0 }')
  if [ "$OLD" = 1 ]; then
    echo "nattermatic: needs Claude Code $MIN_CLAUDE or newer, and this is $V. Update it (claude update), then run this again." >&2
    exit 1
  fi
}
check_prereqs

# nattermatic's home holds this machine's private key, messages and logs: private to this user from the start
AL="${NATTERMATIC_HOME:-$HOME/.nattermatic}"
mkdir -p "$AL"
chmod 700 "$AL"

# The Apple Developer team that signs nattermatic.app: the app is installed only with its signature
TEAM="${NATTERMATIC_TEAM:-CZ63J37ULN}"
APPS="$HOME/Applications"
RELEASES=https://github.com/tombaldwin/nattermatic/releases/latest/download

# Fetch from the inviting machine, pinned to its invite key (-k only skips CA checks; curl still
# refuses any key but the pinned one). The URL holds the invite token, so it goes to curl in a
# private file, not on the command line (where `ps` would show it).
fetch_invite() {
  printf 'url = "%s"\n' "$1" > "$TMP/curl.cfg"
  if [ -n "${NATTERMATIC_PIN:-}" ]; then
    curl -fsSL -k --pinnedpubkey "sha256//$NATTERMATIC_PIN" -K "$TMP/curl.cfg" -o "$2"
  else
    curl -fsSL -K "$TMP/curl.cfg" -o "$2"
  fi
}

# nattermatic.app (Apple silicon): as a signed app, macOS asks for Local Network access by name and
# the permission covers nattermatic only. From the inviting machine when it runs the app, else from
# the latest GitHub release. Returns 1 if no app is available (the npm install is used instead).
# This function runs as an if condition, where set -e is off, so each step says what happens if it fails.
APP_EXE="$APPS/nattermatic.app/Contents/MacOS/nattermatic"
no_app() {
  echo "nattermatic: could not download nattermatic.app ($1)."
  if [ -x "$APP_EXE" ]; then
    echo "Keeping the one already in $APPS."
    return 0
  fi
  echo "Installing with npm instead: macOS may stop that reaching your other machines. Run this again later for the app."
  return 1
}
# the command is natter; nattermatic and agentlink (its name before the rename) run it too
CMDS="natter nattermatic agentlink"
link_app() {
  mkdir -p "$AL/bin"
  for c in $CMDS; do rm -f "$AL/bin/$c"; ln -s "$APP_EXE" "$AL/bin/$c"; done
}
install_app() {
  [ "$PLATFORM" = Darwin-arm64 ] && [ "${NATTERMATIC_APP:-1}" != 0 ] || return 1
  if [ -n "${NATTERMATIC_APP_ZIP:-}" ]; then
    # a local build: asked for by name, so failing to read it is an error, not a reason to use npm
    cp "$NATTERMATIC_APP_ZIP" "$TMP/app.zip" ||
      { echo "nattermatic: cannot read $NATTERMATIC_APP_ZIP (on macOS, the terminal may not be allowed into that folder: move the file elsewhere, e.g. your home folder) — aborting"; exit 1; }
  elif [ -n "${NATTERMATIC_APP_URL:-}" ]; then
    echo "Fetching nattermatic.app from the inviting machine..."
    if ! fetch_invite "$NATTERMATIC_APP_URL" "$TMP/app.zip"; then
      no_app "the inviting machine didn't send it" && link_app && return 0
      return 1
    fi
  else
    if ! curl -fsSL "$RELEASES/nattermatic-macos-arm64.zip" -o "$TMP/app.zip" ||
       ! curl -fsSL "$RELEASES/nattermatic-macos-arm64.zip.sha256" -o "$TMP/app.sha256"; then
      no_app "from the latest release" && link_app && return 0
      return 1
    fi
    [ "$(awk '{print $1}' "$TMP/app.sha256")" = "$(shasum -a 256 "$TMP/app.zip" | awk '{print $1}')" ] ||
      { echo "nattermatic: the app download failed its checksum — aborting"; exit 1; }
  fi
  # a damaged or foreign app is an error, not a reason to fall back
  mkdir -p "$TMP/app"
  ditto -x -k "$TMP/app.zip" "$TMP/app" || { echo "nattermatic: the app archive is damaged — aborting"; exit 1; }
  A="$TMP/app/nattermatic.app"
  # the requirement checks the certificate Apple issued: the team a signature merely states can be anything
  codesign --verify --strict -R="anchor apple generic and certificate leaf[subject.OU] = \"$TEAM\"" "$A" 2>/dev/null ||
    { echo "nattermatic: the app isn't validly signed by nattermatic's team ($TEAM) — aborting"; exit 1; }
  mkdir -p "$APPS"
  # beside the old app first, then swapped by renaming: whatever fails, a whole app is left in place.
  # (mv into a directory that's still there would put it inside, so nothing here may be left over.)
  NEW="$APPS/.nattermatic.app.new"
  OLD="$APPS/.nattermatic.app.old"
  rm -rf "$NEW" "$OLD"
  if [ -e "$NEW" ] || [ -e "$OLD" ]; then echo "nattermatic: could not clear $NEW and $OLD — aborting"; exit 1; fi
  ditto "$A" "$NEW" || { echo "nattermatic: could not copy the app to $APPS — aborting"; exit 1; }
  if [ -e "$APPS/nattermatic.app" ]; then
    mv "$APPS/nattermatic.app" "$OLD" || { echo "nattermatic: could not replace the app in $APPS — aborting"; exit 1; }
  fi
  if ! mv "$NEW" "$APPS/nattermatic.app"; then
    [ ! -e "$OLD" ] || mv "$OLD" "$APPS/nattermatic.app"
    echo "nattermatic: could not put the app in $APPS — aborting"
    exit 1
  fi
  rm -rf "$OLD" || true
  link_app
  echo "Installed nattermatic.app in $APPS"
}

if install_app; then
  NATTERMATIC_BIN_DIR="$AL/bin" "$AL/bin/natter" setup "$@"
  exit
fi

node_ok() {
  [ "${NATTERMATIC_PRIVATE_NODE:-}" != 1 ] &&
  command -v node >/dev/null 2>&1 &&
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>23||(a===23&&b>=4)||(a===22&&b>=13)?0:1)' 2>/dev/null
}

PRIV="$AL/node"
USE_PRIV=0
if node_ok; then
  :
elif [ -x "$PRIV/bin/node" ] && "$PRIV/bin/node" -e 0 2>/dev/null; then
  export PATH="$PRIV/bin:$PATH"; USE_PRIV=1
else
  case "$PLATFORM" in
    Darwin-arm64) P=darwin-arm64 ;; Darwin-x86_64) P=darwin-x64 ;;
    Linux-x86_64) P=linux-x64 ;; Linux-aarch64|Linux-arm64) P=linux-arm64 ;;
    *) echo "nattermatic: no prebuilt Node.js for $(uname -sm); install Node 22.13+ and run this again."; exit 1 ;;
  esac
  # nodejs.org's Linux builds need glibc
  if [ "$(uname -s)" = Linux ] && ls /lib/ld-musl-* >/dev/null 2>&1; then
    echo "nattermatic: no prebuilt Node.js for this Linux (it uses musl): install Node 22.13+ with your package manager (on Alpine: apk add nodejs npm) and run this again."
    exit 1
  fi
  echo "Installing a private Node.js runtime in $PRIV (your system Node, if any, is untouched)..."
  DIST=https://nodejs.org/dist/latest-v24.x
  curl -fsSL "$DIST/SHASUMS256.txt" -o "$TMP/SUMS"
  FILE=$(awk '{print $2}' "$TMP/SUMS" | grep -E "^node-v[0-9.]+-$P\.tar\.gz$" | head -1)
  [ -n "$FILE" ] || { echo "nattermatic: could not find a Node.js download for $P"; exit 1; }
  curl -fsSL "$DIST/$FILE" -o "$TMP/$FILE"
  WANT=$(awk -v f="$FILE" '$2==f {print $1}' "$TMP/SUMS")
  GOT=$( (shasum -a 256 "$TMP/$FILE" 2>/dev/null || sha256sum "$TMP/$FILE") | awk '{print $1}')
  [ "$WANT" = "$GOT" ] || { echo "nattermatic: Node.js download failed its checksum — aborting"; exit 1; }
  rm -rf "$PRIV"; mkdir -p "$PRIV"
  tar xzf "$TMP/$FILE" -C "$PRIV" --strip-components=1
  export PATH="$PRIV/bin:$PATH"; USE_PRIV=1
fi

# joining via an invite: the package comes from the inviting machine
case "$PKG" in
  https://*) fetch_invite "$PKG" "$TMP/nattermatic.tgz"; PKG="$TMP/nattermatic.tgz" ;;
esac

# npm install into a prefix, showing npm's own error output if it fails
npm_install() {
  npm install -g --no-fund --no-audit --loglevel=error "$@" "$PKG" >"$TMP/npm.log" 2>&1 && return 0
  return 1
}
npm_failed() { cat "$TMP/npm.log" >&2; echo "nattermatic: installing $PKG with npm failed (npm's output is above)" >&2; exit 1; }

echo "Installing nattermatic..."
if [ "$USE_PRIV" = 1 ]; then
  # Keep the private runtime off the user's PATH (it would shadow their own node/npm): install the
  # package in its own prefix and put a single wrapper, run by the private node, in $AL/bin.
  npm_install --prefix "$AL/pkg" || npm_failed
  JS=$(node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$AL/pkg/bin/natter")
  BINDIR="$AL/bin"
  mkdir -p "$BINDIR"
  q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
  for c in $CMDS; do
    rm -f "$BINDIR/$c"      # it may be the link to an earlier app: writing through it would replace the app
    # shellcheck disable=SC2016 # "$@" is meant literally: it's the wrapper's own arguments
    printf '#!/bin/sh\nexec %s --no-warnings %s "$@"\n' "$(q "$PRIV/bin/node")" "$(q "$JS")" > "$BINDIR/$c"
    chmod 755 "$BINDIR/$c"
  done
elif { npm uninstall -g --loglevel=error @tombaldwin/agentlink >/dev/null 2>&1; npm_install; }; then   # agentlink: its name before the rename
  BINDIR="$(npm prefix -g)/bin"
elif grep -qE 'EACCES|EPERM' "$TMP/npm.log"; then
  echo "(global npm install not permitted; installing to ~/.local)"
  npm uninstall -g --prefix "$HOME/.local" --loglevel=error @tombaldwin/agentlink >/dev/null 2>&1 || true
  npm_install --prefix "$HOME/.local" || npm_failed
  BINDIR="$HOME/.local/bin"
else
  npm_failed
fi

NATTERMATIC_BIN_DIR="$BINDIR" "$BINDIR/natter" setup "$@"
