# Changelog

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
