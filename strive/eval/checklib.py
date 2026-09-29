"""What every task's check.py uses: a scratch copy of the agent's workspace
with the project's harness put back, ways to run things in it, and the
verdict line.

A check never trusts the workspace's own tests and tools: the agent could
have edited them. It copies the workspace, restores the harness (tools/,
./dev and, unless the task has the agent write tests, tests/) from the
template plus the task's setup, and runs that. The verdict is the exit code
(0 pass, 1 fail); the last stdout line is JSON with the reasons and any
signals (for example whether the lesson was followed).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

EVAL = Path(__file__).resolve().parent
TEMPLATE = EVAL / "project"
TIMEOUT = 120


class Workspace:
    def __init__(self, workspace: str, task_dir: str, restore_tests: bool = True) -> None:
        self.source = Path(workspace).resolve()
        self.task = Path(task_dir).resolve()
        self._tmp = tempfile.mkdtemp(prefix="tally-check-")
        self.root = Path(self._tmp) / "ws"
        shutil.copytree(self.source, self.root, symlinks=True,
                        ignore=shutil.ignore_patterns("__pycache__", "fsmonitor--daemon.ipc"))
        self._restore(restore_tests)
        self.results: list[tuple[str, bool, str]] = []
        self.signals: dict[str, object] = {}

    def _restore(self, restore_tests: bool) -> None:
        harness = ["dev", "tools"]
        if restore_tests:
            harness.append("tests")
        for rel in harness:
            dst = self.root / rel
            if dst.is_dir():
                shutil.rmtree(dst)
            elif dst.exists():
                dst.unlink()
            src = TEMPLATE / rel
            if src.is_dir():
                shutil.copytree(src, dst, ignore=shutil.ignore_patterns("__pycache__"))
            else:
                shutil.copy2(src, dst)
        setup = self.task / "setup"
        if setup.is_dir():
            for f in setup.rglob("*"):
                rel = f.relative_to(setup)
                if f.is_file() and rel.parts[0] in harness:
                    (self.root / rel).parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(f, self.root / rel)
        if not restore_tests:
            # The agent writes tests here, but the helpers they rely on stay the project's.
            shutil.copy2(TEMPLATE / "tests" / "support.py", self.root / "tests" / "support.py")

    def env(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        e = {k: v for k, v in os.environ.items() if not k.startswith(("TALLY_", "STRIVE_", "ANTHROPIC_"))}
        e["PYTHONDONTWRITEBYTECODE"] = "1"
        e["PYTHONPATH"] = str(self.root)
        e.update(extra or {})
        return e

    def run(self, argv: list[str], env: dict[str, str] | None = None) -> tuple[bool, str]:
        try:
            r = subprocess.run(argv, cwd=self.root, env=self.env(env), capture_output=True, text=True, timeout=TIMEOUT)
        except subprocess.TimeoutExpired:
            return False, f"{' '.join(argv)}: timed out after {TIMEOUT}s"
        return r.returncode == 0, (r.stdout + r.stderr)[-4000:]

    def dev(self, *args: str, env: dict[str, str] | None = None) -> tuple[bool, str]:
        return self.run([sys.executable, "dev", *args], env)

    def py(self, code: str, env: dict[str, str] | None = None) -> tuple[bool, str]:
        """Runs `code` with the workspace importable; it passes if it exits 0."""
        return self.run([sys.executable, "-c", code], env)

    def read(self, rel: str) -> str:
        p = self.root / rel
        return p.read_text() if p.exists() else ""

    def changed_since_start(self) -> list[str]:
        """Paths that differ from the workspace's first commit (the task as
        set up), untracked ones included, whatever the agent committed since."""
        first = subprocess.run(
            ["git", "rev-list", "--max-parents=0", "HEAD"], cwd=self.root, capture_output=True, text=True
        ).stdout.split()
        if not first:
            return []
        diff = subprocess.run(
            ["git", "diff", "--name-only", first[-1]], cwd=self.root, capture_output=True, text=True
        ).stdout.split()
        untracked = subprocess.run(
            ["git", "ls-files", "--others", "--exclude-standard"], cwd=self.root, capture_output=True, text=True
        ).stdout.split()
        return sorted(set(diff) | set(untracked))

    def check(self, name: str, ok: bool, detail: str = "") -> bool:
        self.results.append((name, ok, detail.strip()[-1500:]))
        return ok

    def verdict(self) -> None:
        passed = all(ok for _, ok, _ in self.results) and bool(self.results)
        failed = [{"check": n, "detail": d} for n, ok, d in self.results if not ok]
        print(json.dumps({"pass": passed, "failed": failed, "signals": self.signals}))
        shutil.rmtree(self._tmp, ignore_errors=True)
        sys.exit(0 if passed else 1)


def main(body) -> None:
    """Runs a check: `body(ws)` records checks on the workspace in argv[1]."""
    if len(sys.argv) != 2:
        sys.exit("usage: check.py <workspace>")
    ws = Workspace(sys.argv[1], str(Path(sys.argv[0]).resolve().parent), restore_tests=getattr(body, "restore_tests", True))
    try:
        body(ws)
    except Exception as e:  # a check that crashes is a failed check, with the reason
        ws.check("the check ran", False, f"{type(e).__name__}: {e}")
    ws.verdict()


SNAKE = re.compile(r"^[a-z][a-z0-9]*(_[a-z0-9]+)*$")
CAMEL = re.compile(r"^[a-z][a-zA-Z0-9]*$")
