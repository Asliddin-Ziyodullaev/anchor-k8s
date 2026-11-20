#!/usr/bin/env bash
# ⚓ Anchor K8s (uz.az.anchor.k8s) — runs in the background and survives closing the terminal.
#
#   ./start.sh              open SSH tunnels (if configured) and start (or just open the browser if running)
#   ./start.sh stop         stop the server and close the tunnels
#   ./start.sh restart      restart both
#   ./start.sh status       server and tunnel status
#   ./start.sh tunnel       (re)open only the SSH tunnels, e.g. after the network dropped
#   ./start.sh logs         follow the server log
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
    if ssh -f -N -M -S "$(tunnel_sock "$i")" \
         -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ConnectTimeout=10 \
         $t; then
      set +f
      echo "🔗 Tunnel $i open: ssh $t"
    else
      set +f
      echo "Tunnel $i failed: ssh $t" >&2
      exit 1
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

# ---------- server ----------
do_stop() {
  if pid_alive; then
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
  tunnels_start
  if is_up; then
    echo "⚓ Anchor K8s is already running: $URL"
    open "$URL" 2>/dev/null || true
    return
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
      open "$URL" 2>/dev/null || true
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
  status)  if is_up; then echo "Running: $URL"; else echo "Not running (port $PORT)"; fi; tunnels_status ;;
  tunnel)  tunnels_start ;;
  logs)    tail -n 100 -f "$LOG_FILE" ;;
  *)       echo "Usage: ./start.sh [start|stop|restart|status|tunnel|logs]" >&2; exit 1 ;;
esac
