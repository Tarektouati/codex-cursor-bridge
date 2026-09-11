#!/usr/bin/env bash
# Start/stop the bridge detached from the calling shell, so it survives the
# session that launched it. Usage: scripts/bridge.sh start|stop|restart|status
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="${BRIDGE_PID_FILE:-/tmp/codex-cursor-bridge.pid}"
LOG_FILE="${BRIDGE_LOG_FILE:-/tmp/codex-cursor-bridge.log}"

is_running() {
  [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

start() {
  if is_running; then
    echo "already running (pid $(cat "$PID_FILE"))"
    return 0
  fi
  : >"$LOG_FILE"
  cd "$ROOT"
  nohup node --import tsx src/index.ts >>"$LOG_FILE" 2>&1 &
  local pid=$!
  disown "$pid" 2>/dev/null || true
  echo "$pid" >"$PID_FILE"

  for _ in $(seq 1 50); do
    if grep -q "listening" "$LOG_FILE" 2>/dev/null; then
      echo "started (pid $pid), log: $LOG_FILE"
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "failed to start; log follows:" >&2
      cat "$LOG_FILE" >&2
      return 1
    fi
    sleep 0.2
  done
  echo "started (pid $pid) but no listen line yet; log: $LOG_FILE"
}

stop() {
  if ! is_running; then
    echo "not running"
    rm -f "$PID_FILE"
    return 0
  fi
  local pid
  pid="$(cat "$PID_FILE")"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 25); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
  done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "stopped"
}

case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  restart)
    stop
    start
    ;;
  status)
    if is_running; then echo "running (pid $(cat "$PID_FILE"))"; else echo "stopped"; fi
    ;;
  *)
    echo "usage: $0 start|stop|restart|status" >&2
    exit 64
    ;;
esac
