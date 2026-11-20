#!/usr/bin/env bash
# ⚓ Anchor K8s (uz.az.anchor.k8s) — runs in the background and survives closing the terminal.
#
#   ./start.sh              start (or just open the browser if already running)
#   ./start.sh stop         stop
#   ./start.sh restart      restart
#   ./start.sh status       is it running?
#   ./start.sh logs         follow the server log
#
# Configuration: a .env file (see .env.example) or environment variables:
#   PORT=9000 ./start.sh      KUBECONFIG_FILE=~/.kube/dev.yaml ./start.sh
# Without KUBECONFIG_FILE: $KUBECONFIG → ./kubeconfig.yaml → ~/.kube/config
set -euo pipefail

cd "$(dirname "$0")"

# local settings (gitignored); command-line variables win over .env
CLI_PORT="${PORT:-}"; CLI_KUBECONFIG_FILE="${KUBECONFIG_FILE:-}"
if [ -f .env ]; then set -a; . ./.env; set +a; fi

PORT="${CLI_PORT:-${PORT:-8888}}"
KUBECONFIG_FILE="${CLI_KUBECONFIG_FILE:-${KUBECONFIG_FILE:-}}"
URL="http://127.0.0.1:${PORT}"
PID_FILE=".anchor-k8s-${PORT}.pid"
LOG_FILE="anchor-k8s.log"

is_up() { curl -s -o /dev/null --max-time 2 "$URL/api/info"; }

pid_alive() { [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }

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
}

do_start() {
  if is_up; then
    echo "⚓ Anchor K8s is already running: $URL"
    open "$URL" 2>/dev/null || true
    return
  fi
  command -v node >/dev/null 2>&1 || { echo "Node.js not found. Install it from https://nodejs.org (20.11+)" >&2; exit 1; }
  if [ -n "$KUBECONFIG_FILE" ] && [ ! -f "$KUBECONFIG_FILE" ]; then echo "Kubeconfig not found: $KUBECONFIG_FILE" >&2; exit 1; fi
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
  status)  if is_up; then echo "Running: $URL"; else echo "Not running (port $PORT)"; fi ;;
  logs)    tail -n 100 -f "$LOG_FILE" ;;
  *)       echo "Usage: ./start.sh [start|stop|restart|status|logs]" >&2; exit 1 ;;
esac
