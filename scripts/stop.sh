#!/usr/bin/env bash
# Stop the supervisor and the bot session gracefully.
set -uo pipefail
cd "$(dirname "$0")/.."
SESSION="${BOT_TMUX_SESSION:-evocord}"
mkdir -p state/control
touch state/control/stop
for _ in $(seq 1 30); do
  flock -n state/supervisor.lock true 2>/dev/null && break
  sleep 1
done
tmux kill-session -t "$SESSION" 2>/dev/null || true
echo "stopped"
