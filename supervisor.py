#!/usr/bin/env python3
"""Keep the bot's Claude Code session alive.

    python3 supervisor.py          # normally via scripts/start.sh (inside tmux)

* Runs `claude --dangerously-load-development-channels server:discord ...` in a
  pseudo-terminal. When started from a terminal (tmux) the session is passed
  through, so `tmux attach` shows the normal Claude Code UI.
* Answers the "Loading development channels" confirmation that Claude Code
  shows on every launch, so restarts need no human.
* Restarts claude when it exits, and when the channel server asks for it
  (state/control/restart.json, written after a self-update or `!bot restart`).
* Health check: after a self-update, the new channel server marks
  state/update.json as "ok" once it is connected. If that does not happen
  within BOT_HEALTH_TIMEOUT seconds (or claude keeps crashing), the live code is
  reset to the previous commit and restarted.

Python standard library only. Changes to this file take effect after a manual
restart of the supervisor (scripts/stop.sh && scripts/start.sh); self-updates
never restart the supervisor itself.
"""
import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time
import tty
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATE = Path(os.environ.get("BOT_STATE_DIR", ROOT / "state")).resolve()
CONTROL = STATE / "control"
RESTART_FILE = CONTROL / "restart.json"
STOP_FILE = CONTROL / "stop"
UPDATE_FILE = STATE / "update.json"
HISTORY_GIT = STATE / "history.git"
LOG_FILE = STATE / "logs" / "supervisor.log"
CONSOLE_LOG = STATE / "logs" / "console.log"
HEALTH_TIMEOUT = int(os.environ.get("BOT_HEALTH_TIMEOUT", "180"))
CRASHES_BEFORE_ROLLBACK = 3

ANSI = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]")
CURSOR_FORWARD = re.compile(rb"\x1b\[(\d*)C")


def log(*parts):
    line = time.strftime("%Y-%m-%d %H:%M:%S ") + " ".join(str(p) for p in parts)
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with LOG_FILE.open("a") as f:
        f.write(line + "\n")
    return line


def read_json(path):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return None


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
    os.replace(tmp, path)


def clean_env(environ, config_dir=None):
    """No inherited Claude Code session variables (tmux servers often carry them), no Discord token.
    config_dir: the Claude config dir (= account) the bot uses; None = ~/.claude."""
    env = {k: v for k, v in environ.items()
           if not k.startswith("CLAUDE") and k != "CLAUDECODE" and k != "DISCORD_BOT_TOKEN"}
    if config_dir:
        env["CLAUDE_CONFIG_DIR"] = str(config_dir)
    env.update(ENABLE_CLAUDEAI_MCP_SERVERS="false", BOT_SUPERVISED="1",
               BOT_ROOT=str(ROOT), BOT_STATE_DIR=str(STATE))
    env.setdefault("TERM", "xterm-256color")
    return env


def runtime_options(environ):
    cfg = read_json(ROOT / "config" / "bot.json") or {}
    rt = cfg.get("runtime") if isinstance(cfg.get("runtime"), dict) else {}
    config_dir = environ.get("BOT_CLAUDE_CONFIG_DIR") or rt.get("claudeConfigDir")
    return {"model": environ.get("BOT_MODEL") or rt.get("model"),
            "effort": environ.get("BOT_EFFORT") or rt.get("effort"),
            "config_dir": str(Path(config_dir).expanduser()) if config_dir else None}


def claude_cmd(resume, options, claude_bin="claude"):
    cmd = [claude_bin,
           "--dangerously-load-development-channels", "server:discord",
           "--mcp-config", str(ROOT / "config" / "mcp.json"), "--strict-mcp-config",
           # Only the bot's own settings: none of the owner's user/project permissions, hooks or plugins.
           "--setting-sources", "",
           "--settings", str(ROOT / "config" / "runtime-settings.json"),
           "--permission-mode", "dontAsk",
           # The persona/rules. CLAUDE.md is not auto-loaded with --setting-sources "", so inject it.
           "--append-system-prompt-file", str(ROOT / "CLAUDE.md"),
           # Re-render the system prompt on every launch so persona edits apply after --continue.
           "--system-prompt-snapshot", "off"]
    if options.get("model"):
        cmd += ["--model", str(options["model"])]
    if options.get("effort"):
        cmd += ["--effort", str(options["effort"])]
    if resume:
        cmd.append("--continue")
    return cmd


def project_dir_name(path):
    """Claude Code keeps transcripts in <config>/projects/<path with non-alphanumerics as '-'>."""
    return re.sub(r"[^A-Za-z0-9]", "-", str(path))


def has_previous_session(config_dir=None, cwd=ROOT):
    """True if --continue has something to continue: an interactive transcript with a user turn
    (`claude -p` transcripts in the same directory cannot be continued interactively)."""
    config = Path(config_dir) if config_dir else Path.home() / ".claude"
    d = config / "projects" / project_dir_name(cwd)
    if not d.is_dir():
        return False
    for f in d.glob("*.jsonl"):
        try:
            with f.open("rb") as fh:
                for line in fh:
                    if b'"type":"user"' not in line:
                        continue
                    try:
                        entry = json.loads(line)
                    except ValueError:
                        continue
                    if entry.get("type") == "user" and not str(entry.get("entrypoint", "")).startswith("sdk"):
                        return True
        except OSError:
            continue
    return False


class AutoResponder:
    """Watches terminal output and answers known blocking prompts."""

    DEV_CHANNELS = b"Iamusingthisforlocaldevelopment"
    TRUST = b"Yes,Itrustthisfolder"
    LOGIN = b"Selectloginmethod"

    SETTLE = 1.5  # answer only after the dialog has been on screen this long (input handler attached)
    QUIET = 5.0  # output right after an answer is the dialog being torn down; ignore it

    def __init__(self, auto_trust=False):
        self.buf = b""
        self.auto_trust = auto_trust
        self.last_answer = float("-inf")
        self.last_kind = None
        self.pending = None  # (seen_at, keys, log message, kind)
        self.warned = set()

    @staticmethod
    def flatten(data):
        data = CURSOR_FORWARD.sub(b" ", data)
        data = ANSI.sub(b"", data)
        return re.sub(rb"\s+", b"", data)

    def feed(self, data, now=None):
        """Consume terminal output. Returns (bytes to type into the session, message to log or None)."""
        now = time.monotonic() if now is None else now
        self.buf = (self.buf + self.flatten(data))[-6000:]
        if now - self.last_answer < self.QUIET and self.last_kind:
            # Redraws of the dialog we just answered; a *different* dialog right after it is still answered.
            self.buf = self.buf.replace({"dev": self.DEV_CHANNELS, "trust": self.TRUST}[self.last_kind], b"")
        msg = None
        if self.pending is None:
            if self.DEV_CHANNELS in self.buf:
                self.pending = (now, b"\r", "confirmed the development-channels prompt", "dev")
            elif self.TRUST in self.buf:
                if self.auto_trust:
                    self.pending = (now, b"\x1b[B\r", "accepted the workspace trust prompt (BOT_AUTO_TRUST=1)", "trust")
                else:
                    msg = self._once("trust", "waiting at the workspace trust prompt: attach (tmux attach -t evocord) and accept it once")
            elif self.LOGIN in self.buf:
                msg = self._once("login", "claude is not logged in: attach and log in once")
        keys, answered = self.tick(now)
        return keys, answered or msg

    def tick(self, now=None):
        """Call periodically even without output: sends a pending answer once the dialog has settled."""
        now = time.monotonic() if now is None else now
        if self.pending and now - self.pending[0] >= self.SETTLE:
            _, keys, msg, kind = self.pending
            self.pending, self.buf, self.last_answer, self.last_kind = None, b"", now, kind
            return keys, msg
        return b"", None

    def _once(self, key, msg):
        if key in self.warned:
            return None
        self.warned.add(key)
        return msg


def update_verdict(update, launched_at, now, crashes):
    """Should the pending self-update be rolled back? Returns a reason or None."""
    if not update or update.get("status") != "pending" or update.get("kind") == "rollback":
        return None
    if launched_at < update.get("requested_at", 0) / 1000:
        return None  # the restart that loads the new code has not happened yet
    if crashes >= CRASHES_BEFORE_ROLLBACK:
        return f"claude exited {crashes} times right after the update"
    if now - launched_at > HEALTH_TIMEOUT:
        return f"the channel did not come up within {HEALTH_TIMEOUT}s"
    return None


def git(*args):
    return subprocess.run(["git", f"--git-dir={HISTORY_GIT}", f"--work-tree={ROOT}", *args],
                          cwd=ROOT, capture_output=True, text=True, timeout=120)


def rollback(update, reason):
    prev, bad = update["prev"], update["new"]
    log(f"rolling back {update.get('id')}: {reason}; {bad[:8]} -> {prev[:8]}")
    r = git("reset", "-q", "--hard", prev)
    if r.returncode != 0:
        log("git reset failed:", r.stderr.strip())
    subprocess.run(["bash", str(ROOT / "scripts" / "post-update.sh"), bad, prev], cwd=ROOT,
                   env={**os.environ, "BOT_HISTORY_GIT": str(HISTORY_GIT), "BOT_ROOT": str(ROOT)},
                   capture_output=True, timeout=1200)
    write_json(UPDATE_FILE, {**update, "status": "rolled_back", "rollback_reason": reason, "announced": False})
    (STATE / "evolve").mkdir(parents=True, exist_ok=True)
    with (STATE / "evolve" / "history.jsonl").open("a") as f:
        f.write(json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%S"), "event": "auto_rollback",
                            "id": update.get("id"), "from": bad, "to": prev, "reason": reason}) + "\n")


class Session:
    """One claude process on a pty, optionally mirrored to our own terminal."""

    def __init__(self, cmd, env, attached):
        self.attached = attached
        self.pid, self.fd = pty.fork()
        if self.pid == 0:  # child
            try:
                os.chdir(ROOT)
                os.execvpe(cmd[0], cmd, env)
            finally:
                os._exit(127)
        self.started = time.monotonic()
        self.launched_at = time.time()
        self.exit_status = None
        self.resize()

    def resize(self, *_):
        rows, cols = 50, 200
        if self.attached:
            try:
                rows, cols = struct.unpack("hhhh", fcntl.ioctl(sys.stdin.fileno(), termios.TIOCGWINSZ, b"\0" * 8))[:2]
            except OSError:
                pass
        try:
            fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("hhhh", rows, cols, 0, 0))
            os.kill(self.pid, signal.SIGWINCH)
        except OSError:
            pass

    def poll(self):
        if self.exit_status is None:
            try:
                pid, status = os.waitpid(self.pid, os.WNOHANG)
            except ChildProcessError:
                pid, status = self.pid, 0
            if pid:
                self.exit_status = status
        return self.exit_status

    def terminate(self, timeout=15):
        for sig in (signal.SIGTERM, signal.SIGKILL):
            if self.poll() is not None:
                break
            try:
                os.kill(self.pid, sig)
            except ProcessLookupError:
                break
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline and self.poll() is None:
                self.pump(0.2)
        try:  # MCP servers etc. left in the session's process group
            os.killpg(self.pid, signal.SIGTERM)
        except OSError:
            pass

    def pump(self, timeout, responder=None, console=None):
        """Move bytes between the pty and our terminal for up to `timeout` seconds."""
        fds = [self.fd] + ([sys.stdin.fileno()] if self.attached else [])
        try:
            ready, _, _ = select.select(fds, [], [], timeout)
        except InterruptedError:
            return
        data = b""
        if self.fd in ready:
            try:
                data = os.read(self.fd, 65536)
            except OSError as e:
                if e.errno != errno.EIO:
                    raise
            if data:
                if self.attached:
                    os.write(sys.stdout.fileno(), data)
                elif console:
                    console.write(ANSI.sub(b"", data))
        if responder:
            answer, msg = responder.feed(data) if data else responder.tick()
            if msg:
                log(msg)
            if answer:
                os.write(self.fd, answer)
        if self.attached and sys.stdin.fileno() in ready:
            data = os.read(sys.stdin.fileno(), 65536)
            if data:
                os.write(self.fd, data)


def main():
    STATE.mkdir(parents=True, exist_ok=True)
    CONTROL.mkdir(parents=True, exist_ok=True)
    lock = (STATE / "supervisor.lock").open("w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("another supervisor is already running for this bot", file=sys.stderr)
        return 1
    STOP_FILE.unlink(missing_ok=True)

    attached = sys.stdin.isatty() and sys.stdout.isatty()
    claude_bin = os.environ.get("BOT_CLAUDE_BIN", "claude")
    resume = os.environ.get("BOT_FRESH") != "1" and has_previous_session(runtime_options(os.environ)["config_dir"])
    responder = AutoResponder(auto_trust=os.environ.get("BOT_AUTO_TRUST") == "1")
    stopping = False
    crashes = 0  # quick exits since the last pending update was applied

    def on_term(*_):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, on_term)
    signal.signal(signal.SIGHUP, on_term)
    if not attached:
        signal.signal(signal.SIGINT, on_term)

    saved_tty = termios.tcgetattr(sys.stdin.fileno()) if attached else None
    console = None
    try:
        while not stopping:
            options = runtime_options(os.environ)
            env = clean_env(os.environ, options["config_dir"])
            cmd = claude_cmd(resume, options, claude_bin)
            log("claude config dir (account):", options["config_dir"] or "~/.claude")
            print(log("starting:", " ".join(cmd)), flush=True)
            if not attached:
                CONSOLE_LOG.parent.mkdir(parents=True, exist_ok=True)
                if CONSOLE_LOG.exists() and CONSOLE_LOG.stat().st_size > 5_000_000:
                    os.replace(CONSOLE_LOG, CONSOLE_LOG.with_suffix(".log.1"))
                console = CONSOLE_LOG.open("ab", buffering=0)
            session = Session(cmd, env, attached)
            if attached:
                tty.setraw(sys.stdin.fileno())
                signal.signal(signal.SIGWINCH, session.resize)
            responder.warned.clear()
            fresh_requested = False
            restart_reason = None
            while session.poll() is None:
                session.pump(0.5, responder, console)
                if stopping or STOP_FILE.exists():
                    stopping = True
                    restart_reason = "stop requested"
                    break
                req = read_json(RESTART_FILE)
                if req is not None:
                    RESTART_FILE.unlink(missing_ok=True)
                    fresh_requested = bool(req.get("fresh"))
                    restart_reason = req.get("reason", "restart requested")
                    break
                verdict = update_verdict(read_json(UPDATE_FILE), session.launched_at, time.time(), crashes)
                if verdict:
                    rollback(read_json(UPDATE_FILE), verdict)
                    restart_reason = "rollback"
                    break
            if session.poll() is None:
                session.terminate()
            if attached:
                termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, saved_tty)
                signal.signal(signal.SIGWINCH, signal.SIG_DFL)
                os.write(sys.stdout.fileno(), b"\x1b[?1049l\x1b[?25h\x1b[0m")  # leave alt screen, show cursor
            if console:
                console.close()
            ran = time.monotonic() - session.started
            print("\r\n" + log(f"claude exited after {ran:.0f}s ({restart_reason or f'status {session.exit_status}'})"), flush=True)
            if stopping:
                break

            if restart_reason:
                crashes = 0
                resume = not fresh_requested and has_previous_session(runtime_options(os.environ)["config_dir"])
                time.sleep(1)
                continue
            # Unrequested exit: crash, /exit typed in the terminal, or --continue with nothing to continue.
            update = read_json(UPDATE_FILE)
            crashes = crashes + 1 if ran < 60 else 0
            verdict = update_verdict(update, session.launched_at, time.time(), crashes)
            if verdict:
                rollback(update, verdict)
                crashes = 0
            if ran < 15 and resume:
                resume = False  # maybe nothing to continue; next try starts fresh
            else:
                resume = has_previous_session(options["config_dir"])
            delay = 5 if ran >= 60 else min(60, 5 * (crashes + 1))
            print(log(f"restarting in {delay}s (Ctrl-C to stop)"), flush=True)
            time.sleep(delay)
    except KeyboardInterrupt:
        pass
    finally:
        if saved_tty is not None:
            termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, saved_tty)
        STOP_FILE.unlink(missing_ok=True)
        log("supervisor stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
