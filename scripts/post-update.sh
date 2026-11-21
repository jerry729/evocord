#!/usr/bin/env bash
# Runs in the bot directory after an update or rollback was applied:
#   scripts/post-update.sh <old-commit> <new-commit>
# Installs what the change needs. A non-zero exit makes the server revert the update.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
changed=$(git --git-dir="${BOT_HISTORY_GIT:-state/history.git}" --work-tree=. diff --name-only "$1" "$2")
printf 'changed files:\n%s\n' "$changed"

if grep -qxE 'package\.json|bun\.lock' <<<"$changed"; then
  echo "==> bun install"
  bun install
fi
if grep -qx 'tools/requirements.txt' <<<"$changed" && [[ -x .venv/bin/python ]]; then
  echo "==> python requirements"
  uv pip install -q --python .venv/bin/python --only-binary av -r tools/requirements.txt
fi
if grep -q '^sandbox/' <<<"$changed" && command -v docker >/dev/null; then
  echo "==> rebuilding sandbox image"
  docker build -q -t "${BOT_SANDBOX_IMAGE:-evocord-sandbox:latest}" sandbox
fi
