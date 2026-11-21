# Developing the bot

Read this before changing code — it is written for the self-update coding agent as much as for humans.

## How it runs

```
supervisor.py (pty, restarts, rollback)
└── claude --dangerously-load-development-channels server:discord
         --mcp-config config/mcp.json --strict-mcp-config
         --setting-sources "" --settings config/runtime-settings.json
         --permission-mode dontAsk [--continue]          (cwd = this directory)
    ├── CLAUDE.md                → the bot's persona and rules (--append-system-prompt-file; not auto-loaded)
    ├── MCP "discord"  = bun channel/server.ts   (Discord gateway + tools, Bun/TypeScript)
    │     ├── voice.ts    → .venv/bin/python tools/transcribe.py   (faster-whisper)
    │     ├── sandbox.ts  → docker run evocord-sandbox           (run_code)
    │     └── evolve.ts   → claude -p in a git worktree             (self_update)
    └── MCP "playwright" (headless browser)
```

The channel server pushes each Discord message into the session as a
`notifications/claude/channel` event (`content` = message text, `meta` = attributes such as
`chat_id`, `user_id`, `is_admin`, `voice`). Meta keys must be `[A-Za-z0-9_]+` or Claude Code drops
them. The model answers by calling the server's tools (`reply`, ...).

## Files

| Path | What |
| --- | --- |
| `CLAUDE.md` | Runtime persona/rules for the chat model. Edit for behavior changes. |
| `channel/server.ts` | Discord client, MCP tool definitions + handlers, inbound pipeline, admin `!bot` commands, self-update UI (buttons), boot announcements, catch-up after restarts. |
| `channel/config.ts` | Paths and `config/bot.json` schema/defaults (`normalize`). Add new config fields here with defaults. |
| `channel/gate.ts` | Who may reach the bot / where it may post (`gate`, `allowedChat`), `!bot` parsing. |
| `channel/text.ts` | Message splitting (Discord 2000 limit), meta sanitizing. |
| `channel/voice.ts` | Transcription queue around `tools/transcribe.py`. |
| `channel/sandbox.ts` | `run_code` Docker invocation, file allowlist for attachments. |
| `channel/evolve.ts` | Self-update pipeline: history repo, worktrees, agent run, checks, apply, rollback. |
| `channel/history.ts` | Helpers for `fetch_messages` / `search_messages`: message links, date → snowflake bounds, Search Guild Messages query, line format. |
| `channel/rotate.ts` | Daily handoff + fresh session: schedule decision (`decide`), `state/rotate.json`. Wiring (handoff/kickoff prompts, `session_handoff` tool, `!bot rotate`) is in `server.ts`. |
| `channel/control.ts` | Files shared with the supervisor (`state/update.json`, `state/control/restart.json`). |
| `channel/proc.ts` | Subprocess helper (no shell, timeouts), environment scrubbing. |
| `supervisor.py` | Process supervisor (stdlib only). Not restarted by self-updates. |
| `tools/transcribe.py`, `tools/requirements.txt` | Whisper transcription (Python venv in `.venv`). |
| `sandbox/Dockerfile` | Image for `run_code`. |
| `config/mcp.json` | MCP servers for the session. |
| `config/runtime-settings.json` | Permissions of the chat session. |
| `config/bot.json` | **Local, not versioned**: admins, channels, feature switches. Never edit from an update. |
| `scripts/post-update.sh` | Runs after an update/rollback is merged: installs deps / rebuilds the image when needed. |
| `memory/`, `workspace/`, `state/` | Data. Not versioned, never touched by updates or rollbacks. |

## Adding a tool for the chat model

1. Add its schema to `TOOLS` in `channel/server.ts` and a `case` in the `CallToolRequestSchema` handler.
   Put logic that does not need Discord in its own module with tests.
2. Validate every argument (ids are snowflakes; paths must pass `underAllowedRoot`). Tool input comes from
   a model that reads untrusted chat — treat it as untrusted.
3. If it acts on behalf of a user, take `chat_id` + `message_id` and check the *message author* (see
   `toolRunCode`, `toolSelfUpdate`), never a user id passed as an argument.
4. Document when to use it in `CLAUDE.md`.
5. New MCP servers go in `config/mcp.json` and need an allow rule (`mcp__<name>`) in
   `config/runtime-settings.json`.

New npm dependencies: edit `package.json` (post-update runs `bun install`). New Python deps for
transcription: `tools/requirements.txt`. New sandbox packages: `sandbox/Dockerfile` (post-update rebuilds).

## Testing

```bash
bun run check        # TypeScript type check
bun test             # unit tests (channel/*.test.ts)
python3 -m unittest discover -s tests   # supervisor tests
```

Both must pass; the self-update pipeline runs them on every proposal and shows the result to the admin.
Tests must not need Discord, a token, a GPU or network. `channel/smoke.test.ts` starts the real server with
`BOT_DISCORD_OFFLINE=1` (MCP only, no Discord login) and lists its tools over stdio, so a server that crashes
on startup fails the checks instead of reaching production.

## Security invariants

Keep these unless the admin's request explicitly asks to change them (then flag it in your summary):

- The chat session has no shell (`Bash` denied). Code runs only through `run_code` in Docker with no host
  mounts other than the per-chat work dir, `--cap-drop ALL`, `no-new-privileges`, resource limits.
- Access control lives in `config/bot.json` (outside version control). Code must not let chat messages
  change admins, channels or allowlists.
- Admin-only actions are verified by the server from Discord data (message author / button clicker),
  never from message text or tool arguments.
- `reply(files)` and `run_code(files)` only accept files under `state/inbox`, `state/sandbox`, `workspace`.
- The Discord token is read from `~/.config/evocord/.env` by the server only; it is removed from
  the environment of every child process (`cleanEnv`).
- Self-updates are proposals: they change a worktree, an admin reviews the diff and applies it. Requests may
  come from non-admins (`evolve.allow`); those agent runs get no shell at all, and every proposal's checks run
  inside the Docker sandbox image (worktree + read-only node_modules mounted, no network unless deps changed).
  Applying always requires an admin (button or `!bot apply`).
- Outbound messages never ping @everyone/@here or roles (`allowedMentions`).

## Self-update lifecycle (for reference)

1. `self_update` / `!bot evolve` → `createJob`: snapshot hand edits, `git worktree add` from HEAD
   into `~/.cache/evocord/evolve/<id>`, symlink `node_modules`.
2. `runAgent`: `claude -p` in the worktree (acceptEdits, limited Bash, no MCP, no user settings).
3. `commitAndDiff` + `runChecks` → proposal message with diff file and Apply/Discard buttons.
4. Apply → `git merge` into the live tree, `scripts/post-update.sh`, `state/update.json` = pending,
   restart request → supervisor restarts claude with `--continue`.
5. New server connects → marks the update `ok`, announces it, tells the model what changed.
   No `ok` within 180 s, or repeated crashes → supervisor resets to the previous commit and restarts.

History is a separate git dir (`state/history.git`, work tree = this directory), so the outer
repository is never touched. `!bot log` shows it; `!bot rollback [commit]` resets to a version.
