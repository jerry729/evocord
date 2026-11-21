# Changelog

## v0.2.1 — 2026-11-21

- **Security fix: file search could reach outside the bot directory.** The chat session's settings
  (`config/runtime-settings.json`) allowed the `Grep` and `Glob` tools without a path restriction. A model talked
  into it by a chat message could search, and so read, files anywhere your user account can read: other projects in
  your home directory, documents, and so on. The token, `config/bot.json`, `~/.ssh`, `~/.claude*` and `~/.config`
  were already denied and stayed protected. Both rules are removed, so file search now works only inside the bot
  directory, with the existing deny rules still applied.
- A new test fails if an unrestricted `Read`, `Grep` or `Glob` rule comes back.

**Upgrade:** pull, then restart the session (`!bot restart`); the settings are read when the session starts. If
you edited `config/runtime-settings.json` yourself, delete the `"Glob"` and `"Grep"` entries from `allow` by hand.

## v0.2.0 — 2026-11-21

- **Daily handoff and fresh session.** Once a day (default after 04:00, once the bot has been idle for 30 minutes;
  new messages postpone it) the bot saves what matters to memory, writes a handoff note and restarts with a fresh
  session that opens with that note. The context no longer grows without bound, so per-message cost stays flat.
  - New admin command `!bot rotate` runs it on demand; `!bot reset` still starts fresh without a handoff.
  - `!bot status` shows when the session last started fresh.
  - New config section `rotate` (`enabled`, `at`, `idleMin`, `handoffTimeoutMin`).
- **Searchable chat history.** New `search_messages` tool built on Discord's Search Guild Messages API (keywords,
  author, date range, attachment type). `fetch_messages` can now load the conversation around a message, page
  through history by message id or date, and open message links. Memory entries and handoff notes keep message ids
  so details can be reloaded later.
- **Stricter memory rules** in `CLAUDE.md`: save only what will still matter in a week (nicknames, preferences,
  conventions, promises); skip small talk, games, weather, prices and one-off questions.

## v0.1.0 — 2026-11-21

First public release.

- Custom Claude Code channel server for Discord:
  - per-channel access control;
  - mention-only or "read everything and decide when to speak" modes;
  - catch-up of messages missed during restarts.
- Tools for the chat model: `reply`, `react`, `edit_message`, `fetch_messages`, `download_attachment`.
- Voice messages transcribed locally with faster-whisper (GPU when available); `transcribe` for other audio and
  video.
- `run_code`: Python / bash / Node in a locked-down Docker sandbox with a persistent per-channel work directory;
  generated files are posted back.
- Self-evolution (`self_update`, `!bot evolve`):
  - a coding agent works in a git worktree;
  - checks run in the Docker sandbox;
  - proposals come with a diff and Apply/Discard buttons;
  - admin-only apply, automatic rollback if the new version doesn't start;
  - optional proposals from non-admins (no shell for their agent runs, daily limit).
- Supervisor: runs Claude Code in a pty, answers startup prompts, resumes the conversation, handles restart
  requests and rollbacks.
- Admin commands: `!bot status / restart / reset / evolve / jobs / diff / apply / discard / log / rollback`.
- Optional dedicated Claude account for the bot (`runtime.claudeConfigDir`).
