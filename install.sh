#!/usr/bin/env bash
# Zen Proxy installer for Linux & macOS
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/jeffpecky/zen-proxy/main/install.sh | bash
#   # or, from a local checkout:
#   bash install.sh --local /path/to/zen-proxy
#
# Env options:
#   ZEN_PROXY_REPO   GitHub "owner/repo" (default: jeffpecky/zen-proxy)
#   ZEN_PROXY_DIR    install directory (default: ~/.zen-proxy)
#   ZEN_PROXY_PORT   default port (default: 8181)

set -euo pipefail

REPO="${ZEN_PROXY_REPO:-jeffpecky/zen-proxy}"
INSTALL_DIR="${ZEN_PROXY_DIR:-$HOME/.zen-proxy}"
PORT="${ZEN_PROXY_PORT:-8181}"
LOCAL_SRC=""
RESET_MODELS=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --local) LOCAL_SRC="${2:-}"; shift 2 ;;
    --reset-models) RESET_MODELS=1; shift ;;
    *) shift ;;
  esac
done

info()  { printf "\033[32m%s\033[0m\n" "$*"; }
warn()  { printf "\033[33m%s\033[0m\n" "$*"; }
die()   { printf "\033[31m%s\033[0m\n" "$*" >&2; exit 1; }

if [ -z "$INSTALL_DIR" ] || [ "$INSTALL_DIR" = "/" ]; then
  die "Refusing to install into '$INSTALL_DIR'"
fi

command -v curl >/dev/null 2>&1 || die "curl is required. Install it first."
command -v node >/dev/null 2>&1 || die "Node.js >= 20 is required. See https://nodejs.org"

NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 20 ]; then die "Node.js >= 20 is required (found $(node -v)). See https://nodejs.org"; fi

# The free tier fingerprints the client's TLS ClientHello: Node's native stack
# is bucketed `429 FreeUsageLimitError` even for perfectly agent-shaped
# requests. wreq-js (a prebuilt BoringSSL addon) supplies Bun 1.3.14's exact
# ClientHello from inside the process, so the anonymous tier works under node
# too. It is optional at runtime — a failed install degrades to native fetch
# (BYOK only), it does not break the proxy.
#
# This runs AFTER the copy, not before: it used to sit above `mkdir` and the
# file copy, so `cd "$INSTALL_DIR"` failed on a fresh machine, `npm` never ran,
# and every new install silently started without the TLS transport.
install_tls_transport() {
  if ! command -v npm >/dev/null 2>&1; then
    warn "npm not found — install wreq-js by hand for anonymous access: cd \"$INSTALL_DIR\" && npm install wreq-js"
    return
  fi
  info "Installing the TLS transport (wreq-js)…"
  # `npm ci` when the lockfile shipped with this tree: it installs exactly the
  # wreq-js build the project was tested against, so two installs a week apart
  # cannot end up on different native addons. Falls back to `npm install` for a
  # tree without a lockfile (an older checkout, or a hand-copied directory).
  if [ -f "$INSTALL_DIR/package-lock.json" ] \
      && ( cd "$INSTALL_DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error ); then
    return
  fi
  ( cd "$INSTALL_DIR" && npm install --omit=dev --no-audit --no-fund --loglevel=error ) \
    || warn "wreq-js install failed — anonymous free-tier requests will be 429'd; rerun: cd \"$INSTALL_DIR\" && npm install wreq-js"
}

if ! command -v bun >/dev/null 2>&1; then
  info "NOTE: bun not found. Not required any more (wreq-js carries the ClientHello),"
  info "      but it keeps the proxy's own HTTP server on the same BoringSSL stack."
fi

mkdir -p "$INSTALL_DIR"
info "Installing zen-proxy to $INSTALL_DIR"

# Preserve an existing config across the wipe/copy below.
CFG_BAK="$(mktemp)"
if [ -f "$INSTALL_DIR/zen-proxy.json" ]; then
  cp "$INSTALL_DIR/zen-proxy.json" "$CFG_BAK"
fi

if [ -n "$LOCAL_SRC" ]; then
  [ -d "$LOCAL_SRC" ] || die "Local source not found: $LOCAL_SRC"
  # Clear the tree first (the config is preserved separately below), then copy
  # with exclusions rather than copying and deleting after: copying .git from the
  # source tree fails outright, and a publish mirror named zen-proxy/ would
  # collide with the zen-proxy launcher this script installs.
  find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 ! -name zen-proxy.json -exec rm -rf {} + 2>/dev/null || true
  ( cd "$LOCAL_SRC" && tar -cf - \
      --exclude=./.git --exclude=./node_modules --exclude=./.mimocode \
      --exclude=./zen-proxy --exclude=./zen-proxy.json . ) \
    | ( cd "$INSTALL_DIR" && tar -xf - )
  rm -f "$INSTALL_DIR/zen-proxy.json.tmp"
  info "Copied from local source: $LOCAL_SRC"
else
  TARBALL="https://codeload.github.com/$REPO/tar.gz/refs/heads/main"
  info "Downloading $TARBALL …"
  TMP="$(mktemp -d)"
  curl -fsSL "$TARBALL" -o "$TMP/repo.tar.gz"
  tar -xzf "$TMP/repo.tar.gz" -C "$TMP"
  rm -rf "$INSTALL_DIR"/*
  cp -r "$TMP"/*/. "$INSTALL_DIR/"
  rm -rf "$TMP"
  info "Downloaded and extracted $REPO"
fi

if [ -s "$CFG_BAK" ]; then
  cp "$CFG_BAK" "$INSTALL_DIR/zen-proxy.json"
fi
rm -f "$CFG_BAK"

if [ ! -f "$INSTALL_DIR/zen-proxy.mjs" ]; then
  die "zen-proxy.mjs not found after install — check ZEN_PROXY_REPO"
fi

# Now that the tree exists. See install_tls_transport() for why this is here.
install_tls_transport

if [ ! -f "$INSTALL_DIR/zen-proxy.json" ]; then
  printf '{ "host": "127.0.0.1", "port": %s }\n' "$PORT" > "$INSTALL_DIR/zen-proxy.json"
  info "Created default config with port $PORT"
elif [ "$RESET_MODELS" = "1" ]; then
  # Drop a model list that an older build may have trimmed, keeping every other
  # setting (keys, port, aliases) untouched.
  if command -v node >/dev/null 2>&1; then
    node -e '
      const fs = require("fs");
      const p = process.argv[1];
      const c = JSON.parse(fs.readFileSync(p, "utf8"));
      delete c.fallbackModels;
      fs.writeFileSync(p, JSON.stringify(c, null, 2));
    ' "$INSTALL_DIR/zen-proxy.json" && info "Reset model list to defaults (keys preserved)"
  fi
fi

cat > "$INSTALL_DIR/zen-proxy" <<EOF
#!/usr/bin/env bash
# Bun only when it is already there (same BoringSSL stack for the proxy's own
# server); the outbound ClientHello comes from wreq-js either way.
if command -v bun >/dev/null 2>&1; then
  exec bun "$INSTALL_DIR/zen-proxy.mjs" "\$@"
fi
exec node "$INSTALL_DIR/zen-proxy.mjs" "\$@"
EOF
chmod +x "$INSTALL_DIR/zen-proxy"

ln -sf "$INSTALL_DIR/zen-proxy" "$HOME/.local/bin/zen-proxy" 2>/dev/null || {
  mkdir -p "$HOME/.local/bin"
  ln -sf "$INSTALL_DIR/zen-proxy" "$HOME/.local/bin/zen-proxy"
}

# zen-claude: launch Claude Code already pointed at this proxy, one command.
# It has to pass --settings because Claude Code reads env from
# ~/.claude/settings.json, which wins over anything exported in your shell.
#
# The command is zen-claude (the script is bin/claude-zen); link both names so an
# install that predates the rename keeps working.
if [ -f "$INSTALL_DIR/bin/claude-zen" ]; then
  mkdir -p "$HOME/.local/bin"
  ln -sf "$INSTALL_DIR/bin/claude-zen" "$HOME/.local/bin/zen-claude"
  ln -sf "$INSTALL_DIR/bin/claude-zen" "$HOME/.local/bin/claude-zen"
fi

info ""
info "✓ zen-proxy installed!"
info "  Dashboard: http://127.0.0.1:$PORT"
info ""
info "Run it:            zen-proxy"
info "Or add PATH:       export PATH=\"\$HOME/.local/bin:\$PATH\""
info ""
# Verify the commands actually resolve. A shell that was already open before the
# install has a stale PATH, which is the usual reason someone gets
# "zen-claude: command not found" straight after a successful install - say so
# here instead of leaving them to guess.
PATH_OK=1
for cmd in zen-proxy zen-claude; do
  if command -v "$cmd" >/dev/null 2>&1; then
    info "  $cmd is ready"
  else
    PATH_OK=0
    warn "  '$cmd' is installed but not on this shell's PATH."
    warn "  Fix for this terminal:  export PATH=\"\$HOME/.local/bin:\$PATH\""
    warn "  Make it permanent:      echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc"
    warn "                         (use ~/.bashrc instead of ~/.zshrc for bash)"
  fi
done
if [ "$PATH_OK" = "1" ] && command -v claude >/dev/null 2>&1; then
  info ""
  info "Claude Code:       zen-claude        (starts the proxy and Claude Code together)"
fi
info ""
info "Point your AI agent at:"
info "  baseURL = http://127.0.0.1:$PORT/v1"
info "  apiKey  = <the client key printed at first boot, or Settings → API key>"
info "  model   = space-bunny-free   (or any model listed in the dashboard)"

if command -v systemctl >/dev/null 2>&1 && [ -w /etc/systemd/system ]; then
  info ""
  read -r -p "Install as a systemd service (auto-start)? [y/N] " ans || true
  if [[ "$ans" =~ ^[Yy]$ ]]; then
    # Bun when present (same BoringSSL stack for the proxy's server); wreq-js
    # supplies the ClientHello on the outbound leg either way.
    SYSTEM_RUNNER=$(command -v bun || command -v node)
cat > /etc/systemd/system/zen-proxy.service <<SVC
[Unit]
Description=Zen Proxy
After=network.target

[Service]
ExecStart=$SYSTEM_RUNNER $INSTALL_DIR/zen-proxy.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
SVC
    systemctl daemon-reload
    systemctl enable --now zen-proxy
    info "systemd service zen-proxy started."
  fi
fi