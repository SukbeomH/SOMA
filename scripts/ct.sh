#!/usr/bin/env bash
# Native SOMA deployment in an unprivileged Ubuntu CT; never runs on the PVE host.
set -Eeuo pipefail
umask 077
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
NODE_VERSION=24.22.2
NODE_SHA256=48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75
CODEX_VERSION=0.167.0
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'HELP'
Usage: bash scripts/ct.sh COMMAND [--fem]
  prepare       CT root: install Ubuntu 24.04 packages and create user soma
  install       Normal user: install private Node/Python/Codex, build and test
  run           Foreground server (Ctrl+C to stop)
  stop          Stop only the server recorded by the foreground wrapper
  check         Run typecheck, web isolation and headless CAD/PTY tests
  status        Check HTTP and actual loopback listener
  login         Interactive Codex device login, as the service user
  unit          Print a systemd unit; does not register/start/enable it
  help          Show this help (no environment requirements)

install --fem adds constrained gmsh/pyamg. It does not run an FEM study.
SOMA_CT_PORT defaults to 8765; install stores it for run/unit/status.
SOMA_CT_LAN_HOST=<CT IPv4> at install also serves that address to the LAN, without login:
anyone who can reach it gets the terminal and Codex account. Install with SOMA_CT_LAN_HOST= to remove.
SOMA_CT_TAILSCALE_HOST=<name>.<tailnet>.ts.net at install accepts that name, served by root with
`tailscale serve --bg --https=443 http://127.0.0.1:<port>` (tailnet only, same no-login trust).
Ubuntu 24.04 x86_64 unprivileged LXC only. No Docker/display/security changes.
HELP
}
command=${1:-help}
case "$command" in help|--help|-h) usage; exit 0;; prepare|install|run|stop|check|status|login|unit) ;; *) fail "Unknown command: $command";; esac
fem=0
if [[ ${2:-} == --fem && $command == install ]]; then fem=1
elif [[ $# -gt 1 ]]; then fail 'Only install accepts --fem'; fi
[[ $# -le 2 ]] || fail 'Too many arguments'
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || fail 'Requires Linux x86_64; this machine was not modified'
[[ -r /etc/os-release ]] || fail 'Missing /etc/os-release'
# shellcheck disable=SC1091
. /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || fail 'Automatic setup supports Ubuntu 24.04 only'
[[ $(systemd-detect-virt --container 2>/dev/null || true) == lxc ]] || fail 'Requires an LXC system CT; refuses host/VM/Docker'
awk '$1 == 0 && $2 != 0 { ok=1 } END { exit !ok }' /proc/self/uid_map || fail 'Root UID is not remapped; requires an unprivileged CT'

if [[ $command == prepare ]]; then
  [[ $EUID == 0 ]] || fail 'prepare must run as CT root'
  printf '%s\n' 'Installing guest build/CAD packages and preparing soma user (no service or SSH changes).'
  # libgmsh in the x86_64 gmsh wheel (install --fem) links these X11/font client libraries.
  # They are shared libraries only; no X server or display is installed.
  apt-get update
  apt-get install -y --no-install-recommends git bash ca-certificates build-essential python3.12 python3.12-venv python3.12-dev libgl1 libglu1-mesa libgomp1 libxrender1 libxext6 procps curl xz-utils iproute2 \
    libxcursor1 libxft2 libfontconfig1 libxinerama1
  if ! id soma >/dev/null 2>&1; then
    [[ ! -e /home/soma ]] || fail '/home/soma already exists without soma user; inspect manually'
    useradd --create-home --shell /bin/bash soma
  fi
  [[ $(getent passwd soma | cut -d: -f6) == /home/soma && $(id -u soma) != 0 ]] || fail 'Existing soma account has unexpected home/UID'
  printf '%s\n' 'Prepared. Clone the repository as soma, then run: bash scripts/ct.sh install'
  exit 0
fi
[[ $EUID != 0 ]] || fail 'Run as the normal service user, not root'
account_home=$(getent passwd "$(id -u)" | cut -d: -f6)
[[ $HOME == "$account_home" && -O $ROOT ]] || fail 'Use a login shell with the correct HOME and an owned checkout'
# Keep generated systemd paths literal and unambiguous (no quoting/specifier expansion).
[[ $ROOT =~ ^/[a-zA-Z0-9_./-]+$ && $HOME =~ ^/[a-zA-Z0-9_./-]+$ ]] || fail 'Home/checkout path must contain only letters, digits, slash, dot, underscore or hyphen'
STATE="$ROOT/.ct-runtime"
NODE_HOME="$HOME/.local/share/soma-node/v$NODE_VERSION"
CODEX_HOME_DIR="$HOME/.local/share/soma-codex/$CODEX_VERSION"
export PATH="$CODEX_HOME_DIR/bin:$ROOT/.venv/bin:$NODE_HOME/bin:/usr/local/bin:/usr/bin:/bin"
export SOMA_CONTAINER=0 SOMA_WEB=1 SOMA_USER_DATA="$HOME/data" SOMA_PYTHON="$ROOT/.venv/bin/python" SHELL=/bin/bash
export LOCAL_GIT_DIRECTORY=/usr GIT_EXEC_PATH
GIT_EXEC_PATH=$(git --exec-path)
export PYTHONDONTWRITEBYTECODE=1
unset DISPLAY WAYLAND_DISPLAY CODEX_HOME
port=${SOMA_CT_PORT:-8765}
if [[ -f $STATE/port && ( $command != install || -z ${SOMA_CT_PORT:-} ) ]]; then port=$(cat "$STATE/port"); fi
[[ $port =~ ^[1-9][0-9]{3,4}$ ]] && (( port >= 1024 && port <= 65535 )) || fail 'Invalid SOMA_CT_PORT (1024..65535)'
export SOMA_WEB_PORT=$port
lan_host=${SOMA_CT_LAN_HOST-}
if [[ -f $STATE/lan_host && ( $command != install || -z ${SOMA_CT_LAN_HOST+x} ) ]]; then lan_host=$(cat "$STATE/lan_host"); fi
[[ -z $lan_host || $lan_host =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || fail 'Invalid SOMA_CT_LAN_HOST (IPv4 address of this CT)'
ts_host=${SOMA_CT_TAILSCALE_HOST-}
if [[ -f $STATE/ts_host && ( $command != install || -z ${SOMA_CT_TAILSCALE_HOST+x} ) ]]; then ts_host=$(cat "$STATE/ts_host"); fi
[[ -z $ts_host || $ts_host =~ ^[a-z0-9-]+(\.[a-z0-9-]+)+\.ts\.net$ ]] || fail 'Invalid SOMA_CT_TAILSCALE_HOST (MagicDNS name ending in .ts.net)'

free_port() { [[ -z $(ss -H -ltn "sport = :$1") ]] || fail "Port $1 is already listening; stop the owning service before continuing"; }
checks() {
  free_port 18766
  npm --prefix "$ROOT/app" run typecheck
  npm --prefix "$ROOT/app" run test:web
  npm --prefix "$ROOT/app" run test:headless
  printf '%s\n' 'Automated checks passed. Codex in test:headless is a stub; real login/model editing and browser checks remain.'
}
ready() { [[ -f $STATE/ready && -f $ROOT/app/dist/web/server.js ]] || fail 'No successful install recorded. Run install and resolve failures first'; }

case "$command" in
  install)
    [[ -f $ROOT/app/package-lock.json && -f $ROOT/python/requirements-web.txt ]] || fail 'Incomplete checkout'
    free_port "$port"
    mkdir -p "$STATE"
    mkdir "$STATE/install.lock" 2>/dev/null || fail 'Install lock exists; ensure no installer is running before removing it'
    staging=''
    trap 'result=$?; [[ -z $staging ]] || rm -rf -- "$staging"; rmdir "$STATE/install.lock"; exit "$result"' EXIT
    trap 'printf "Installation failed at line %s; no success marker was written.\n" "$LINENO" >&2' ERR
    rm -f "$STATE/ready"
    printf '%s\n' "$port" > "$STATE/port"
    if [[ -n $lan_host ]]; then printf '%s\n' "$lan_host" > "$STATE/lan_host"; else rm -f "$STATE/lan_host"; fi
    if [[ -n $ts_host ]]; then printf '%s\n' "$ts_host" > "$STATE/ts_host"; else rm -f "$STATE/ts_host"; fi
    if [[ ! -d $NODE_HOME ]]; then
      mkdir -p "$(dirname "$NODE_HOME")"
      staging=$(mktemp -d "$(dirname "$NODE_HOME")/.download.XXXXXX")
      archive="node-v$NODE_VERSION-linux-x64.tar.xz"
      curl --fail --show-error --location --proto '=https' --tlsv1.2 --retry 3 "https://nodejs.org/dist/v$NODE_VERSION/$archive" -o "$staging/$archive"
      (cd "$staging"; printf '%s  %s\n' "$NODE_SHA256" "$archive" | sha256sum --check -)
      tar -xJf "$staging/$archive" -C "$staging"
      mv "$staging/node-v$NODE_VERSION-linux-x64" "$NODE_HOME"
      rm -rf -- "$staging"; staging=''
    fi
    [[ $(node --version) == "v$NODE_VERSION" ]] || fail 'Private Node version mismatch'
    if [[ ! -d $ROOT/.venv ]]; then python3.12 -m venv "$ROOT/.venv"; fi
    "$SOMA_PYTHON" -c 'import sys; assert sys.version_info[:2] == (3,12), "Expected Python 3.12 venv"'
    "$SOMA_PYTHON" -m pip install -r "$ROOT/python/requirements-web.txt"
    "$SOMA_PYTHON" -m pip install "$ROOT/python"
    if (( fem )); then
      "$SOMA_PYTHON" -m pip install -c "$ROOT/python/requirements-base.txt" gmsh pyamg
      "$SOMA_PYTHON" -c 'import gmsh, pyamg; gmsh.initialize(); gmsh.finalize()'
    fi
    npm --prefix "$ROOT/app" ci --ignore-scripts
    npm_config_nodedir="$NODE_HOME" npm --prefix "$ROOT/app" rebuild node-pty
    npm --prefix "$ROOT/app" run build:web
    npm install --global --prefix "$CODEX_HOME_DIR" --ignore-scripts "@openai/codex@$CODEX_VERSION"
    codex --version
    mkdir -p "$SOMA_USER_DATA"
    checks
    # Record package versions only; never dump environment, credentials or sessions.
    "$SOMA_PYTHON" -m pip freeze > "$STATE/python-installed.txt"
    npm --prefix "$ROOT/app" ls --depth=0 --json > "$STATE/npm-installed.json"
    { git -C "$ROOT" rev-parse HEAD; node --version; "$SOMA_PYTHON" --version; codex --version; printf 'port=%s\nlan_host=%s\nts_host=%s\nfem_requested=%s\n' "$port" "$lan_host" "$ts_host" "$fem"; } > "$STATE/versions.txt"
    date -u '+%Y-%m-%dT%H:%M:%SZ' > "$STATE/ready"
    printf 'Installed. Run: bash scripts/ct.sh login\nThen: bash scripts/ct.sh run\nURL: http://127.0.0.1:%s/\n' "$port"
    [[ -z $lan_host ]] || printf 'LAN URL (no login): http://%s:%s/\n' "$lan_host" "$port"
    [[ -z $ts_host ]] || printf 'Tailscale URL (no login, needs tailscale serve): https://%s/\n' "$ts_host"
    ;;
  run) ready; free_port "$port"; SOMA_WEB_LAN_HOST=$lan_host SOMA_WEB_TAILSCALE_HOST=$ts_host exec node "$ROOT/app/scripts/start-web.mjs";;
  stop) ready; exec node "$ROOT/app/scripts/stop-web.mjs";;
  check) ready; checks;;
  login) ready; exec codex login --device-auth;;
  status)
    ready
    listeners=$(ss -H -ltn "sport = :$port")
    [[ -n $listeners ]] || fail 'No listening service'
    expected="127.0.0.1:$port"; [[ -z $lan_host ]] || expected="0.0.0.0:$port"
    awk -v expected="$expected" '$4 != expected { bad=1 } END { exit bad }' <<< "$listeners" || fail "Unexpected listener (expected only $expected)"
    curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:$port/" -o /dev/null
    if [[ -n $lan_host ]]; then
      curl --fail --silent --show-error --max-time 5 "http://$lan_host:$port/" -o /dev/null
      printf 'LAN access enabled without login: http://%s:%s/\n' "$lan_host" "$port"
    fi
    if [[ -n $ts_host ]]; then
      curl --fail --silent --show-error --max-time 5 -H "Host: $ts_host" "http://127.0.0.1:$port/" -o /dev/null
      printf 'Tailscale name accepted without login: https://%s/ (tailscale serve not checked)\n' "$ts_host"
    fi
    printf '%s\nHTTP OK (not a browser or Codex test)\n' "$listeners"
    ;;
  unit)
    ready
    cat <<UNIT
[Unit]
Description=SOMA local web service
After=network.target

[Service]
Type=simple
User=$(id -un)
Group=$(id -gn)
WorkingDirectory=$ROOT/app
Environment=HOME=$HOME
Environment=PATH=$PATH
Environment=SOMA_WEB=1
Environment=SOMA_CONTAINER=0
Environment=SOMA_USER_DATA=$SOMA_USER_DATA
Environment=SOMA_PYTHON=$SOMA_PYTHON
Environment=SOMA_WEB_PORT=$port
$([[ -z $lan_host ]] || printf 'Environment=SOMA_WEB_LAN_HOST=%s' "$lan_host")
$([[ -z $ts_host ]] || printf 'Environment=SOMA_WEB_TAILSCALE_HOST=%s' "$ts_host")
Environment=SHELL=/bin/bash
Environment=LOCAL_GIT_DIRECTORY=/usr
Environment=GIT_EXEC_PATH=$GIT_EXEC_PATH
Environment=PYTHONDONTWRITEBYTECODE=1
UnsetEnvironment=DISPLAY WAYLAND_DISPLAY CODEX_HOME
ExecStart=$NODE_HOME/bin/node $ROOT/app/dist/web/server.js
UMask=0077
Restart=no
KillMode=control-group
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
UNIT
    ;;
esac
