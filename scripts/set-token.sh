#!/usr/bin/env bash
# Save the Discord bot token (hidden input), verify it with Discord, print the invite link.
#   ./scripts/set-token.sh
set -euo pipefail
ENV_DIR="${BOT_ENV_DIR:-$HOME/.config/evocord}"
ENV_FILE="$ENV_DIR/.env"
# View Channels, Send Messages, Send Messages in Threads, Read Message History, Attach Files, Embed Links, Add Reactions
PERMISSIONS=274878024768

read -rsp "Paste the bot token (input is hidden), then press Enter: " TOKEN
echo
TOKEN="${TOKEN//[[:space:]]/}"
[[ -n "$TOKEN" ]] || { echo "no token entered"; exit 1; }

# The token reaches curl through a file descriptor, not the command line (visible in ps).
if ! info=$(curl -fsS -H @<(printf 'Authorization: Bot %s\n' "$TOKEN") https://discord.com/api/v10/applications/@me); then
  echo "❌ Discord rejected this token. Copy it again from Developer Portal → Bot → Reset Token."
  exit 1
fi

mkdir -p "$ENV_DIR"
chmod 700 "$ENV_DIR"
(umask 077; printf 'DISCORD_BOT_TOKEN=%s\n' "$TOKEN" > "$ENV_FILE")
echo "✅ Token is valid; saved to $ENV_FILE (mode 600)"

python3 - "$info" "$PERMISSIONS" <<'PY'
import json, sys
d = json.loads(sys.argv[1])
flags = d.get("flags", 0)
message_content = bool(flags & ((1 << 18) | (1 << 19)))  # GATEWAY_MESSAGE_CONTENT(_LIMITED)
print(f"Bot: {(d.get('bot') or {}).get('username', d.get('name'))}    application id: {d['id']}")
if message_content:
    print("Message Content Intent: ✅ enabled")
else:
    print("Message Content Intent: ❌ DISABLED → Developer Portal → Bot → Privileged Gateway Intents → "
          "enable MESSAGE CONTENT INTENT → Save. The bot cannot read messages without it.")
print(f"Invite link (open in a browser, pick your server, authorize):\n"
      f"https://discord.com/oauth2/authorize?client_id={d['id']}&scope=bot&permissions={sys.argv[2]}")
PY
