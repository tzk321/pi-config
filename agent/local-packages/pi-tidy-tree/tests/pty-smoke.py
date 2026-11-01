#!/usr/bin/env python3
"""PTY smoke test for the pi-tidy-tree fork.

Spawns a real `pi` under a pseudo-terminal in a throwaway agent dir (the real
~/.pi/agent is only *read* to copy a settings subset), then drives the TUI with
slash commands and asserts on the ANSI-stripped screen text.

Why a PTY: the renderer only runs when a TUI frame is actually drawn, so unit
tests on the pure functions cannot prove the extension was loaded and hooked.

Usage:
    python tests/pty-smoke.py              # run all checks
    python tests/pty-smoke.py -k tree      # only checks whose name contains "tree"

Exit code 0 = all checks passed. Artifacts (terminal log, temp agent dir) are
kept on failure and printed, removed on success.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import pty
import re
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import fcntl

PI_ROOT = pathlib.Path(os.environ.get("PI_CODING_AGENT_DIR", "~/.pi/agent")).expanduser()
NPM = PI_ROOT / "npm" / "node_modules"
PKG = pathlib.Path(__file__).resolve().parent.parent

ANSI = re.compile(
    r"\x1b\][^\x07]*(?:\x07|\x1b\\)"      # OSC (title, hyperlinks)
    r"|\x1b\[[0-?]*[ -/]*[@-~]"            # CSI
    r"|\x1b[()][A-Z0-9]"                   # charset
    r"|\x1b[@-_]"                          # other escapes
)


def strip_ansi(text: str) -> str:
    return ANSI.sub("", text)


def find_sdk() -> pathlib.Path:
    """Locate the installed pi-coding-agent package (version dirs move on upgrade)."""
    candidates = sorted((PI_ROOT / "install" / "releases").glob("*/node_modules/@earendil-works/pi-coding-agent"))
    if not candidates:
        sys.exit(f"pi-coding-agent not found under {PI_ROOT}/install/releases")
    return candidates[-1]


def extensions() -> list[str]:
    want = [
        NPM / "pi-powerline-footer" / "index.ts",
        PKG / "index.ts",
        NPM / "billion-context-pi" / "dist" / "index.js",
        PI_ROOT / "extensions" / "message-edit" / "index.ts",
    ]
    return [str(p) for p in want if p.exists()]


class Pi:
    def __init__(self, root: pathlib.Path, sdk: pathlib.Path, settings: dict):
        agent = root / "agent"
        agent.mkdir()
        settings = dict(settings)
        settings.setdefault("powerline", {})["welcome"] = False   # no splash in assertions
        (agent / "settings.json").write_text(json.dumps(settings))

        fixture = subprocess.check_output(
            ["node", "--input-type=module", "-e", f"""
import {{SessionManager}} from '{sdk}/dist/index.js';
const s = SessionManager.create({json.dumps(str(root))}, {json.dumps(str(root / 'sessions'))});
s.appendMessage({{role: 'user', content: 'PTY smoke fixture', timestamp: Date.now()}});
console.log(s.getSessionFile());
"""],
            text=True,
        ).strip()

        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 60, 110, 0, 0))
        env = dict(
            os.environ,
            PI_CODING_AGENT_DIR=str(agent),
            PI_OFFLINE="1",
            TERM="xterm-256color",
            PI_SKIP_VERSION_CHECK="1",
        )
        cmd = [
            "pi", "--offline", "--no-extensions", "--no-skills",
            "--no-prompt-templates", "--no-context-files", "--no-mcp",
            "--session", fixture,
        ]
        for ext in extensions():
            cmd += ["-e", ext]

        self.log = bytearray()
        self.text = ""            # cumulative ANSI-stripped screen, across all drains
        self.proc = subprocess.Popen(
            cmd, stdin=slave, stdout=slave, stderr=slave,
            cwd=root, env=env, start_new_session=True,
        )
        os.close(slave)

    def drain(self, seconds: float) -> str:
        out = bytearray()
        deadline = __import__("time").time() + seconds
        while __import__("time").time() < deadline:
            if select.select([self.master], [], [], 0.1)[0]:
                try:
                    data = os.read(self.master, 65536)
                except OSError:
                    break
                if not data:
                    break
                out.extend(data)
                self.log.extend(data)
        delta = strip_ansi(out.decode(errors="replace"))
        self.text += delta
        return delta

    def send(self, text: str, settle: float = 1.5) -> str:
        os.write(self.master, text.encode())
        return self.drain(settle)

    def close(self, root: pathlib.Path) -> None:
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        try:
            os.close(self.master)
        except OSError:
            pass
        (root / "terminal.log").write_bytes(self.log)


CHECKS = {}


def check(name):
    def register(fn):
        CHECKS[name] = fn
        return fn
    return register


@check("tree-tool-status")
def _(pi: Pi) -> None:
    """The renderer must report which tree-capable tools are actually registered."""
    screen = pi.send("/tidy-tree\r")
    assert "ls, find, grep active" in screen, f"/tidy-tree did not report active tools:\n{screen[-2000:]}"
    assert "not active" not in screen, f"tools unexpectedly missing:\n{screen[-2000:]}"


@check("tree-command-repeatable")
def _(pi: Pi) -> None:
    """Re-invoking the command must not double-register renderers or crash the TUI.

    The TUI redraws incrementally, so an identical second invocation may emit no
    new bytes; assert against the cumulative screen instead of the delta.
    """
    pi.send("/tidy-tree\r")
    pi.send("/tidy-tree\r")
    assert pi.proc.poll() is None, f"pi exited after repeat:\n{pi.text[-2000:]}"
    assert "ls, find, grep active" in pi.text, f"status line lost:\n{pi.text[-2000:]}"
    for bad in ("TypeError", "Cannot read", "already registered", "Unhandled"):
        assert bad not in pi.text, f"repeat invocation raised {bad!r}:\n{pi.text[-2000:]}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("-k", default="", help="substring filter on check names")
    args = ap.parse_args()

    sdk = find_sdk()
    settings = json.loads((PI_ROOT / "settings.json").read_text())
    subset = {k: settings[k] for k in ("defaultTools", "powerline", "workingVibe", "bashMode", "tidy") if k in settings}

    chosen = [(n, f) for n, f in CHECKS.items() if args.k in n]
    if not chosen:
        sys.exit(f"no checks match -k {args.k!r}; available: {', '.join(CHECKS)}")

    root = pathlib.Path(tempfile.mkdtemp(prefix="pi-pty-smoke-"))
    pi = Pi(root, sdk, subset)
    failed = []
    try:
        boot = pi.drain(7)
        assert pi.proc.poll() is None, f"pi exited during boot:\n{boot[-2000:]}"
        for name, fn in chosen:
            try:
                fn(pi)
            except AssertionError as exc:
                failed.append(f"FAIL {name}: {exc}")
            else:
                print(f"PASS {name}")
    finally:
        pi.close(root)

    if failed:
        print("\n".join(failed))
        print(f"artifacts: {root}")
        return 1
    shutil.rmtree(root, ignore_errors=True)
    print(f"\n{len(chosen)} check(s) passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
