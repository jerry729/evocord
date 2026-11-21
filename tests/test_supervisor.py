import json
import os
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import supervisor as sv  # noqa: E402

_LOGS = tempfile.TemporaryDirectory()
sv.LOG_FILE = Path(_LOGS.name) / "supervisor.log"  # keep test output out of the live state/logs


class CleanEnvTest(unittest.TestCase):
    def test_drops_claude_session_vars_and_token(self):
        env = sv.clean_env({"PATH": "/bin", "CLAUDECODE": "1", "CLAUDE_CODE_SESSION_ID": "x",
                            "CLAUDE_CONFIG_DIR": "/elsewhere", "DISCORD_BOT_TOKEN": "t", "HOME": "/h"})
        self.assertNotIn("CLAUDECODE", env)
        self.assertNotIn("CLAUDE_CODE_SESSION_ID", env)
        self.assertNotIn("CLAUDE_CONFIG_DIR", env)
        self.assertNotIn("DISCORD_BOT_TOKEN", env)
        self.assertEqual(env["BOT_SUPERVISED"], "1")
        self.assertEqual(env["ENABLE_CLAUDEAI_MCP_SERVERS"], "false")

    def test_explicit_bot_config_dir(self):
        env = sv.clean_env({"CLAUDE_CONFIG_DIR": "/other"}, "/bot-cfg")
        self.assertEqual(env["CLAUDE_CONFIG_DIR"], "/bot-cfg")
        self.assertEqual(sv.runtime_options({"BOT_CLAUDE_CONFIG_DIR": "~/x"})["config_dir"], str(Path.home() / "x"))


class CommandTest(unittest.TestCase):
    def test_flags(self):
        cmd = sv.claude_cmd(True, {"model": "sonnet", "effort": None})
        self.assertIn("server:discord", cmd)
        self.assertIn("--strict-mcp-config", cmd)
        self.assertEqual(cmd[cmd.index("--setting-sources") + 1], "")
        self.assertTrue(cmd[cmd.index("--append-system-prompt-file") + 1].endswith("CLAUDE.md"))
        self.assertEqual(cmd[cmd.index("--permission-mode") + 1], "dontAsk")
        self.assertEqual(cmd[cmd.index("--model") + 1], "sonnet")
        self.assertNotIn("--effort", cmd)
        self.assertEqual(cmd[-1], "--continue")
        self.assertNotIn("--continue", sv.claude_cmd(False, {}))

    def test_has_previous_session_needs_a_user_turn(self):
        with tempfile.TemporaryDirectory() as cfg:
            env = cfg
            self.assertFalse(sv.has_previous_session(env, "/x/bot"))
            d = Path(cfg) / "projects" / "-x-bot"
            d.mkdir(parents=True)
            (d / "a.jsonl").write_text('{"type":"mode"}\n')
            self.assertFalse(sv.has_previous_session(env, "/x/bot"))
            (d / "a.jsonl").write_text('{"type":"mode"}\n{"type":"user","entrypoint":"sdk-cli","message":{}}\n')
            self.assertFalse(sv.has_previous_session(env, "/x/bot"))  # claude -p transcript
            (d / "b.jsonl").write_text('{"type":"mode"}\n{"type":"user","entrypoint":"cli","message":{}}\n')
            self.assertTrue(sv.has_previous_session(env, "/x/bot"))

    def test_project_dir_name(self):
        self.assertEqual(sv.project_dir_name("/home/a/bots/evocord"), "-home-a-bots-evocord")


class AutoResponderTest(unittest.TestCase):
    def test_answers_dev_channel_prompt_once(self):
        r = sv.AutoResponder()
        # Spaces drawn as cursor moves and colors must not hide the text.
        out, msg = r.feed(b"\x1b[1mI\x1b[1Cam using this\x1b[3Cfor local\r\n development\x1b[0m", now=10)
        self.assertEqual(out, b"")  # not yet: let the dialog settle
        self.assertEqual(r.tick(now=10.5), (b"", None))
        out, msg = r.tick(now=11.6)
        self.assertEqual(out, b"\r")
        self.assertTrue(msg)
        self.assertEqual(r.feed(b"I am using this for local development", now=12), (b"", None))  # teardown redraw
        self.assertEqual(r.tick(now=14), (b"", None))
        self.assertEqual(r.feed(b"nothing", now=20), (b"", None))
        self.assertEqual(r.tick(now=30), (b"", None))

    def test_trust_prompt(self):
        r = sv.AutoResponder()
        self.assertEqual(r.feed(b"Yes, I trust this folder", now=0)[0], b"")
        self.assertEqual(r.tick(now=9)[0], b"")
        r = sv.AutoResponder(auto_trust=True)
        r.feed(b"Yes, I trust this folder", now=0)
        self.assertEqual(r.tick(now=2)[0], b"\x1b[B\r")

    def test_trust_then_dev_channel_prompt_back_to_back(self):
        r = sv.AutoResponder(auto_trust=True)
        r.feed(b"Yes, I trust this folder", now=0)
        self.assertEqual(r.tick(now=2)[0], b"\x1b[B\r")
        r.feed(b"Yes, I trust this folder", now=2.1)  # teardown redraw of the trust dialog: ignored
        r.feed(b"I am using this for local development", now=2.5)  # next dialog, inside the quiet window
        self.assertEqual(r.tick(now=4.1)[0], b"\r")
        self.assertEqual(r.tick(now=20)[0], b"")  # nothing stale left to re-answer

    def test_prompt_split_across_reads(self):
        r = sv.AutoResponder()
        self.assertEqual(r.feed(b"I am using this for lo", now=0)[0], b"")
        r.feed(b"cal development", now=0)
        self.assertEqual(r.tick(now=2)[0], b"\r")


class UpdateVerdictTest(unittest.TestCase):
    def setUp(self):
        self.u = {"status": "pending", "kind": "evolve", "requested_at": 1000 * 1000, "prev": "a", "new": "b"}

    def test_waits_for_the_restart(self):
        self.assertIsNone(sv.update_verdict(self.u, launched_at=999, now=5000, crashes=0))

    def test_timeout(self):
        self.assertIsNone(sv.update_verdict(self.u, launched_at=1001, now=1001 + 10, crashes=0))
        self.assertIn("did not come up", sv.update_verdict(self.u, 1001, 1001 + sv.HEALTH_TIMEOUT + 1, 0))

    def test_crash_loop(self):
        self.assertIn("exited", sv.update_verdict(self.u, 1001, 1002, sv.CRASHES_BEFORE_ROLLBACK))

    def test_ignores_ok_and_rollbacks(self):
        self.assertIsNone(sv.update_verdict({**self.u, "status": "ok"}, 1001, 99999, 9))
        self.assertIsNone(sv.update_verdict({**self.u, "kind": "rollback"}, 1001, 99999, 9))
        self.assertIsNone(sv.update_verdict(None, 1001, 99999, 9))


class SessionTest(unittest.TestCase):
    def test_pty_session_gets_prompt_answered(self):
        with tempfile.TemporaryDirectory() as d:
            fake = Path(d) / "fake_claude.py"
            fake.write_text(textwrap.dedent("""
                import sys
                print("WARNING: Loading development channels")
                print("  1. I am using this for local development", flush=True)
                line = sys.stdin.readline()
                print("ANSWERED", repr(line), flush=True)
                sys.exit(3)
            """))
            s = sv.Session([sys.executable, str(fake)], dict(os.environ), attached=False)
            r = sv.AutoResponder()
            got = []

            class Sink:
                def write(self, b):
                    got.append(b)

            deadline = time.monotonic() + 10
            while s.poll() is None and time.monotonic() < deadline:
                s.pump(0.2, r, Sink())
            for _ in range(5):
                s.pump(0.05, r, Sink())
            self.assertEqual(os.waitstatus_to_exitcode(s.exit_status), 3)
            self.assertIn(b"ANSWERED", b"".join(got))


if __name__ == "__main__":
    unittest.main()
