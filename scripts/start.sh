#!/usr/bin/env bash
# ./scripts/start.sh          start the supervisor in tmux session "evocord" (attach if already running)
# ./scripts/start.sh --new    same, but start a fresh conversation (memory files are kept)
# ./scripts/start.sh --fg     run the supervisor in this terminal (used by the systemd unit)
set -euo pipefail
cd "$(dirname "$0")/.."
SESSION="${BOT_TMUX_SESSION:-evocord}"
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
fresh=0 fg=0
for a in "$@"; do
  case $a in --new) fresh=1 ;; --fg) fg=1 ;; *) echo "unknown option $a"; exit 2 ;; esac
done
if (( fg )); then
  BOT_FRESH=$fresh exec python3 supervisor.py
fi
if tmux has-session -t "$SESSION" 2>/dev/null; then
  exec tmux attach -t "$SESSION"
fi
# Pass PATH and BOT_* settings explicitly: a long-running tmux server keeps the environment it was started with.
# (supervisor.py scrubs inherited CLAUDE* variables itself.)
envs=(-e "PATH=$PATH" -e "BOT_FRESH=$fresh")
while IFS='=' read -r name _; do
  [[ $name == BOT_* && $name != BOT_FRESH ]] && envs+=(-e "$name=${!name}")
done < <(env)
tmux new-session -d -s "$SESSION" -x 220 -y 50 -c "$PWD" "${envs[@]}" \
  "python3 '$PWD/supervisor.py'; echo 'supervisor exited — press Enter'; read"
echo "Started in tmux session '$SESSION'. Watch it: tmux attach -t $SESSION (Ctrl-b d detaches without stopping)"
echo "Logs: state/logs/supervisor.log  state/logs/channel.log"
