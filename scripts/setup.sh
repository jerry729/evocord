#!/usr/bin/env bash
# One-time install:  ./scripts/setup.sh [--no-voice] [--no-sandbox] [--no-browser]
# Installs Claude Code and Bun if missing, npm dependencies, the Whisper environment (+ model),
# the run_code sandbox image, the Playwright browser, and initializes the self-update history.
# Save the Discord token separately with ./scripts/set-token.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
ARGS=" $* "
need() { command -v "$1" >/dev/null 2>&1; }
want() { [[ "$ARGS" != *" --no-$1 "* ]]; }

need git || { echo "git is required"; exit 1; }
need python3 || { echo "python3 (>= 3.9) is required"; exit 1; }
need tmux || echo "!! tmux not found: scripts/start.sh needs it (apt install tmux), or use the systemd unit"
if ! need claude; then echo "==> Installing Claude Code"; curl -fsSL https://claude.ai/install.sh | bash; fi
if ! need bun; then echo "==> Installing Bun"; curl -fsSL https://bun.sh/install | bash; fi

echo "==> bun install"
bun install

if [[ ! -f config/bot.json ]]; then
  cp config/bot.example.json config/bot.json
  echo "==> Created config/bot.json — fill in admins (your Discord user ID) and channels (channel IDs)"
fi

if want voice; then
  echo "==> Voice transcription environment (.venv + faster-whisper)"
  need uv || curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
  [[ -x .venv/bin/python ]] || uv venv -q .venv --python 3.12
  uv pip install -q --python .venv/bin/python --only-binary av -r tools/requirements.txt
  model=$(python3 -c "import json;print((json.load(open('config/bot.json')).get('voice') or {}).get('model') or 'large-v3-turbo')")
  echo "==> Downloading Whisper model $model (large-v3-turbo is ~1.6 GB)"
  .venv/bin/python -c "import sys; from faster_whisper.utils import download_model; print(download_model(sys.argv[1]))" "$model"
fi

if want sandbox; then
  if need docker && docker info >/dev/null 2>&1; then
    echo "==> Building the run_code sandbox image evocord-sandbox:latest"
    docker build -q -t evocord-sandbox:latest sandbox
  else
    echo "!! Docker is not usable: run_code and self-update checks need it. Install Docker, add your user to the"
    echo "   docker group, and rerun this script — or set sandbox.enabled=false in config/bot.json."
  fi
fi

if want browser && need npx; then
  echo "==> Playwright Chromium (optional, for the browser tools)"
  # Must match the playwright version that config/mcp.json's @playwright/mcp depends on.
  npx -y playwright@1.66.0-alpha-2026-11-09 install chromium >/dev/null 2>&1 \
    || echo "   browser install failed; retry later with: npx -y playwright@1.66.0-alpha-2026-11-09 install chromium"
fi

echo "==> Initializing the self-update history (state/history.git)"
bun -e "import { ensureRepo } from './channel/evolve'; await ensureRepo()"

echo "==> Self-test"
if bun run check >/dev/null 2>&1 && bun test >/dev/null 2>&1 && python3 -m unittest discover -s tests -q >/dev/null 2>&1; then
  echo "   all tests passed"
else
  echo "   !! some tests failed — run: bun run check; bun test; python3 -m unittest discover -s tests"
fi
rm -rf tests/__pycache__ __pycache__

cat <<'MSG'

Done. Next:
  1) ./scripts/set-token.sh          save the Discord bot token, get the invite link
  2) edit config/bot.json            admins = your Discord user ID, channels = channel IDs
  3) ./scripts/start.sh && tmux attach -t evocord
     First start only: accept the "trust this folder" dialog, and /login if Claude Code asks.
MSG
