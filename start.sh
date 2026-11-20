#!/usr/bin/env bash
# ⚓ Anchor K8s (uz.az.anchor.k8s) — runs in the background and survives closing the terminal.
#
#   ./start.sh              open SSH tunnels (if configured) and start (or just open the browser if running)
#   ./start.sh stop         stop the server and close the tunnels
#   ./start.sh restart      restart both
#   ./start.sh status       server and tunnel status
#   ./start.sh tunnel       (re)open only the SSH tunnels, e.g. after the network dropped
#   ./start.sh logs         follow the server log
#   ./start.sh install      start automatically at login (macOS LaunchAgent) and open the app
#   ./start.sh uninstall    turn start-at-login off
#
# Configuration: a .env file (see .env.example) or environment variables:
#   PORT=9000 ./start.sh
#   KUBECONFIG_FILE=~/.kube/dev.yaml:~/.kube/prod.yaml ./start.sh    several files are merged
#   SSH_TUNNELS="-D 1080 user@bastion; -L 6443:10.*.*.*:6443 user@jump" ./start.sh
# Without KUBECONFIG_FILE: $KUBECONFIG → ./kubeconfig.yaml → ~/.kube/config
set -euo pipefail

cd "$(dirname "$0")"

# local settings (gitignored); command-line variables win over .env
CLI_PORT="${PORT:-}"; CLI_KUBECONFIG_FILE="${KUBECONFIG_FILE:-}"; CLI_SSH_TUNNELS="${SSH_TUNNELS:-}"
if [ -f .env ]; then set -a; . ./.env; set +a; fi

PORT="${CLI_PORT:-${PORT:-9901}}"
KUBECONFIG_FILE="${CLI_KUBECONFIG_FILE:-${KUBECONFIG_FILE:-}}"
SSH_TUNNELS="${CLI_SSH_TUNNELS:-${SSH_TUNNELS:-}}"
URL="http://127.0.0.1:${PORT}"
PID_FILE=".anchor-k8s-${PORT}.pid"
LOG_FILE="anchor-k8s.log"

is_up() { curl -sf -o /dev/null --max-time 2 "$URL/api/health"; }
wait_up() { for _ in $(seq 1 30); do sleep 0.5; is_up && return 0; done; return 1; }

# the installed app window (Chrome "Install app" / Safari "Add to Dock") if there is one, else a browser tab
open_app() {
  local app
  for app in "$HOME/Applications/Chrome Apps.localized/Anchor K8s.app" "$HOME/Applications/Anchor K8s.app"; do
    if [ -d "$app" ]; then open "$app" 2>/dev/null && return 0; fi
  done
  open "$URL" 2>/dev/null || true
}

pid_alive() { [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }

# ---------- SSH tunnels ----------
# SSH_TUNNELS holds ';'-separated ssh argument lists, one per tunnel. Each tunnel runs as a background
# ssh master with a control socket (.anchor-k8s-tunnel-N.sock), which is how it is checked and closed later.
TUNNELS=()
if [ -n "$SSH_TUNNELS" ]; then
  IFS=';' read -ra _parts <<<"$SSH_TUNNELS"
  for _t in "${_parts[@]}"; do
    _t="$(printf '%s' "$_t" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    [ -n "$_t" ] && TUNNELS+=("$_t")
  done
fi

tunnel_sock() { echo ".anchor-k8s-tunnel-$1.sock"; }
# with -S the host argument is not used; "anchor" is a placeholder
tunnel_alive() { [ -S "$(tunnel_sock "$1")" ] && ssh -S "$(tunnel_sock "$1")" -O check anchor >/dev/null 2>&1; }

tunnels_start() {
  [ ${#TUNNELS[@]} -eq 0 ] && return 0
  command -v ssh >/dev/null 2>&1 || { echo "ssh not found" >&2; exit 1; }
  local i=0 t
  for t in "${TUNNELS[@]}"; do
    i=$((i + 1))
    if tunnel_alive "$i"; then echo "🔗 Tunnel $i already open: ssh $t"; continue; fi
    rm -f "$(tunnel_sock "$i")"
    # -f: go to the background after authentication (password / passphrase prompts still work)
    # ExitOnForwardFailure: fail now if the local port is taken; ServerAlive*: drop a dead connection
    set -f  # the tunnel spec is split into words on purpose, but must not be glob-expanded
    # shellcheck disable=SC2086
    # SSH_BATCH (set when started at login): no terminal, so never wait for a password prompt
    if ssh -f -N -M -S "$(tunnel_sock "$i")" \
         -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ConnectTimeout=10 \
         ${SSH_BATCH:+-o BatchMode=yes} $t; then
      set +f
      echo "🔗 Tunnel $i open: ssh $t"
    else
      set +f
      echo "Tunnel $i failed: ssh $t" >&2
      return 1
    fi
  done
}

tunnels_stop() {
  local s n
  for s in .anchor-k8s-tunnel-*.sock; do
    [ -S "$s" ] || continue
    n="${s#.anchor-k8s-tunnel-}"; n="${n%.sock}"
    ssh -S "$s" -O exit anchor >/dev/null 2>&1 && echo "🔗 Tunnel $n closed"
    rm -f "$s"
  done
}

tunnels_status() {
  [ ${#TUNNELS[@]} -eq 0 ] && return 0
  local i=0 t
  for t in "${TUNNELS[@]}"; do
    i=$((i + 1))
    if tunnel_alive "$i"; then echo "🔗 Tunnel $i open: ssh $t"; else echo "🔗 Tunnel $i closed: ssh $t  (reopen: ./start.sh tunnel)"; fi
  done
}

# ---------- start at login (macOS LaunchAgent) ----------
# launchd runs `start.sh run` at login, keeps it alive (restarts it if it crashes) and writes to the log.
LABEL="uz.az.anchor.k8s"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
agent_installed() { [ -f "$PLIST" ]; }
agent_loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }
xml() { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'; }

do_install() {
  [ "$(uname)" = Darwin ] || { echo "Start at login is supported on macOS only (on Linux use a systemd user service)" >&2; exit 1; }
  local node env_extra=""
  node="$(command -v node)" || { echo "Node.js not found. Install it from https://nodejs.org (20.11+)" >&2; exit 1; }
  check_kubeconfigs
  [ -d node_modules ] || { echo "Installing dependencies..."; npm install --silent; }
  # a port given on the command line is kept; otherwise run mode reads .env each time it starts
  [ -n "$CLI_PORT" ] && env_extra="<key>PORT</key><string>$(xml "$CLI_PORT")</string>"
  # hand the port over from a copy started by hand
  if ! agent_loaded && is_up; then do_stop >/dev/null; sleep 1; fi
  mkdir -p "$(dirname "$PLIST")"
  cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$(xml "$PWD/start.sh")</string><string>run</string></array>
  <key>WorkingDirectory</key><string>$(xml "$PWD")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml "$(dirname "$node")"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    $env_extra
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$(xml "$PWD/$LOG_FILE")</string>
  <key>StandardErrorPath</key><string>$(xml "$PWD/$LOG_FILE")</string>
</dict>
</plist>
EOF
  plutil -lint "$PLIST" >/dev/null
  if agent_loaded; then launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true; sleep 1; fi
  launchctl bootstrap "$DOMAIN" "$PLIST"
  if wait_up; then
    echo "⚓ Start at login is on: Anchor K8s now starts with your Mac and opens $URL"
    echo "Turn it off with: ./start.sh uninstall"
  else
    echo "Installed, but the server did not answer yet. Log:" >&2
    tail -n 20 "$LOG_FILE" >&2
    exit 1
  fi
}

do_uninstall() {
  if agent_loaded; then launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true; fi
  if agent_installed; then rm -f "$PLIST"; echo "Start at login is off"; else echo "Start at login was not on"; fi
  rm -f "$PID_FILE"
  tunnels_stop
}

# foreground mode used by launchd: tunnels, open the app once per boot, then become the server process
do_run() {
  check_kubeconfigs
  SSH_BATCH=1 tunnels_start || echo "⚠ An SSH tunnel failed; starting the dashboard anyway" >&2
  if [ "${OPEN_ON_LOGIN:-1}" = 1 ]; then
    # /tmp is emptied at boot, so the app opens at login but not when launchd restarts a crashed server
    local mark="/tmp/anchor-k8s-opened-$(id -u)-$PORT"
    if [ ! -e "$mark" ]; then
      touch "$mark"
      ( wait_up && open_app ) &
    fi
  fi
  echo $$ >"$PID_FILE"
  echo "[$(date '+%F %T')] starting at login (launchd)"
  PORT="$PORT" exec node server.js ${KUBECONFIG_FILE:+"$KUBECONFIG_FILE"}
}

# ---------- server ----------
do_stop() {
  if agent_loaded; then
    # unload until the next login (or ./start.sh start); otherwise launchd would restart it at once
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    echo "Stopped (port $PORT); it starts again at next login"
    sleep 1
  elif pid_alive; then
    kill "$(cat "$PID_FILE")" && echo "Stopped (port $PORT)"
  else
    # no pid file: fall back to whatever process listens on this port
    local pid
    pid="$(lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$pid" ]; then kill $pid && echo "Stopped (port $PORT, pid $pid)"; else echo "Not running (port $PORT)"; fi
  fi
  rm -f "$PID_FILE"
  tunnels_stop
}

check_kubeconfigs() {
  [ -z "$KUBECONFIG_FILE" ] && return 0
  local f found=0
  IFS=':' read -ra _files <<<"$KUBECONFIG_FILE"
  for f in "${_files[@]}"; do
    f="${f/#\~/$HOME}"
    if [ -f "$f" ]; then found=1; else echo "Kubeconfig not found (skipped): $f" >&2; fi
  done
  [ "$found" -eq 1 ] || { echo "No kubeconfig file found in KUBECONFIG_FILE" >&2; exit 1; }
}

do_start() {
  # tunnels first: they are (re)opened even when the server is already running
  tunnels_start || exit 1
  if is_up; then
    echo "⚓ Anchor K8s is already running: $URL"
    open_app
    return
  fi
  # start at login is on: let launchd run it, so it is supervised the same way as after login
  if agent_installed; then
    if agent_loaded; then launchctl kickstart -k "$DOMAIN/$LABEL"; else launchctl bootstrap "$DOMAIN" "$PLIST"; fi
    if wait_up; then echo "⚓ Anchor K8s is running: $URL"; open_app; return; fi
    echo "Failed to start. Log:" >&2; tail -n 20 "$LOG_FILE" >&2; exit 1
  fi
  command -v node >/dev/null 2>&1 || { echo "Node.js not found. Install it from https://nodejs.org (20.11+)" >&2; exit 1; }
  check_kubeconfigs
  if [ ! -d node_modules ]; then echo "Installing dependencies..."; npm install --silent; fi

  # nohup + background: the server survives SIGHUP when the terminal closes
  PORT="$PORT" nohup node server.js ${KUBECONFIG_FILE:+"$KUBECONFIG_FILE"} >>"$LOG_FILE" 2>&1 </dev/null &
  echo $! >"$PID_FILE"
  disown 2>/dev/null || true

  for _ in $(seq 1 20); do
    sleep 0.5
    if is_up; then
      echo "⚓ Anchor K8s is running: $URL  (keeps running after you close the terminal)"
      echo "Stop it with: ./start.sh stop"
      open_app
      return
    fi
    pid_alive || break
  done
  echo "Failed to start. Log:" >&2
  tail -n 20 "$LOG_FILE" >&2
  rm -f "$PID_FILE"
  exit 1
}

case "${1:-start}" in
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_stop; sleep 1; do_start ;;
  status)
    if is_up; then echo "Running: $URL"; else echo "Not running (port $PORT)"; fi
    if agent_installed; then echo "Start at login: on"; else echo "Start at login: off (turn on: ./start.sh install)"; fi
    tunnels_status ;;
  tunnel)    tunnels_start ;;
  logs)      tail -n 100 -f "$LOG_FILE" ;;
  install)   do_install ;;
  uninstall) do_uninstall ;;
  run)       do_run ;;
  *)         echo "Usage: ./start.sh [start|stop|restart|status|tunnel|logs|install|uninstall]" >&2; exit 1 ;;
esac
