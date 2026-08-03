"""HUD episode for one pinned SWE-bench Lite task and three intent arms."""

from __future__ import annotations

import asyncio
import contextlib
import json
import secrets
import socket
import subprocess
from dataclasses import dataclass
from pathlib import Path

from fastmcp import FastMCP
from hud.capabilities import Capability
from hud.environment import Environment
from hud.graders import EvaluationResult

INSTANCE_ID = "django__django-11099"
BASE_COMMIT = "d26b2424437dabeeca94d7900b37d2df4410da0c"
WORKSPACE = Path("/testbed")
ALLOWED_PATHS = frozenset(
    {
        "django/contrib/auth/validators.py",
        "tests/auth_tests/test_validators.py",
    }
)
PROBLEM = """UsernameValidator allows trailing newline in usernames

ASCIIUsernameValidator and UnicodeUsernameValidator use the regex
r'^[\\w.@+-]+$'. Python's `$` also matches before a trailing newline, so these
validators accept usernames ending in a newline. Change both validators to use
absolute string boundaries so trailing newlines are rejected. Keep their
allowed character set and help text behavior unchanged, and run focused tests."""
TEST_PATCH = (
    "diff --git a/tests/auth_tests/test_validators.py "
    "b/tests/auth_tests/test_validators.py\n"
    r"""--- a/tests/auth_tests/test_validators.py
+++ b/tests/auth_tests/test_validators.py
@@ -237,7 +237,7 @@ def test_unicode_validator(self):
         invalid_usernames = [
             "o'connell", "عبد ال",
             "zerowidth\u200Bspace", "nonbreaking\u00A0space",
-            "en\u2013dash",
+            "en\u2013dash", 'trailingnewline\u000A',
         ]
         v = validators.UnicodeUsernameValidator()
         for valid in valid_usernames:
@@ -250,7 +250,7 @@ def test_ascii_validator(self):
 
     def test_ascii_validator(self):
         valid_usernames = ['glenn', 'GLEnN', 'jean-marc']
-        invalid_usernames = ["o'connell", 'Éric', 'jean marc', "أحمد"]
+        invalid_usernames = ["o'connell", 'Éric', 'jean marc', "أحمد", 'trailingnewline\n']
         v = validators.ASCIIUsernameValidator()
         for valid in valid_usernames:
             with self.subTest(valid=valid):
"""
)
EPISODES = {
    "static": (PROBLEM,),
    "matched": (
        PROBLEM + "\n\nFirst inspect the repository and identify the smallest relevant surface.",
        "No requirements have changed. Propose the smallest implementation and focused test plan.",
        "Implement the unchanged username-validator fix now and run the focused tests.",
    ),
    "evolved": (
        "Inspect the repository's authentication code. Identify the module and classes that own "
        "username character validation. Do not edit yet.",
        "Plan a minimal change that would make both ASCII and Unicode username validation reject "
        "a trailing newline without changing the allowed character set. Do not edit yet.",
        PROBLEM + "\n\nImplement the fix now and run the focused tests.",
    ),
}

env = Environment(name="parallax-swebench-django-11099", version="0.1.0")
env.workspace(WORKSPACE, network=False, track_files=True)


@dataclass
class DirectorState:
    turns: tuple[str, ...]
    index: int = 0


_director = FastMCP(name="parallax-swebench-turn-director")
_states: dict[str, DirectorState] = {}
_server_task: asyncio.Task[None] | None = None


@_director.tool
def advance(token: str) -> dict[str, object]:
    """Reveal exactly one subsequent turn."""
    state = _states[token]
    if state.index + 1 >= len(state.turns):
        return {"done": True, "index": state.index}
    state.index += 1
    return {"done": False, "index": state.index, "turn": state.turns[state.index]}


def _unused_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _run(
    argv: list[str],
    *,
    input_text: str | None = None,
    timeout: int = 300,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        cwd=WORKSPACE,
        input=input_text,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )


def _reset() -> None:
    reset = _run(["git", "reset", "--hard", BASE_COMMIT])
    clean = _run(["git", "clean", "-fdx"])
    if reset.returncode or clean.returncode:
        raise RuntimeError(f"failed to reset task workspace: {reset.stderr}{clean.stderr}")


def _grade() -> EvaluationResult:
    changed = _run(["git", "diff", "--name-only", BASE_COMMIT])
    if changed.returncode:
        return EvaluationResult(reward=0.0, content="invalid git state")
    changed_paths = tuple(sorted(filter(None, changed.stdout.splitlines())))
    violations = tuple(path for path in changed_paths if path not in ALLOWED_PATHS)
    if not changed_paths or violations:
        return EvaluationResult(
            reward=0.0,
            content="invalid submission scope",
            info={"changed_paths": changed_paths, "violations": violations},
        )

    test_file = "tests/auth_tests/test_validators.py"
    restore = _run(["git", "checkout", BASE_COMMIT, "--", test_file])
    applied = _run(["git", "apply", "-"], input_text=TEST_PATCH)
    if restore.returncode or applied.returncode:
        return EvaluationResult(reward=0.0, content="failed to prepare sealed tests")
    try:
        result = _run(
            [
                "/opt/miniconda3/bin/conda",
                "run",
                "-n",
                "testbed",
                "python",
                "tests/runtests.py",
                "--verbosity",
                "1",
                "--settings=test_sqlite",
                "--parallel",
                "1",
                "auth_tests.test_validators",
            ]
        )
    finally:
        _run(["git", "checkout", BASE_COMMIT, "--", test_file])

    passed = result.returncode == 0
    return EvaluationResult(
        reward=float(passed),
        content="official verifier passed" if passed else "official verifier failed",
        info={
            "arm_verifier": "swebench-lite-official-command",
            "changed_paths": changed_paths,
            "instance_id": INSTANCE_ID,
            "returncode": result.returncode,
        },
    )


@env.initialize
async def _start_director() -> None:
    global _server_task
    port = _unused_port()
    _server_task = asyncio.create_task(
        _director.run_http_async(
            show_banner=False,
            host="127.0.0.1",
            port=port,
            log_level="error",
        )
    )
    env.add_capability(
        Capability.mcp(name="director", url=f"http://127.0.0.1:{port}/mcp")
    )
    await asyncio.sleep(0.2)


@env.shutdown
async def _stop_director() -> None:
    if _server_task is not None:
        _server_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await _server_task


@env.template(id="episode")
async def episode(arm: str):
    if arm not in EPISODES:
        raise ValueError(f"unknown arm: {arm}")
    await asyncio.to_thread(_reset)
    turns = EPISODES[arm]
    token = secrets.token_urlsafe(24)
    _states[token] = DirectorState(turns=turns)
    _answer = yield json.dumps({"arm": arm, "token": token, "turn": turns[0]})
    final = _states.pop(token)
    grade = await asyncio.to_thread(_grade)
    info = {
        **(grade.info or {}),
        "arm": arm,
        "final_turn": final.index,
        "instance_id": INSTANCE_ID,
        "turns": len(turns),
    }
    completed = final.index == len(turns) - 1
    yield EvaluationResult(
        reward=grade.reward if completed else 0.0,
        content=grade.content if completed else "episode ended before final intent",
        info=info,
        subscores=grade.subscores,
    )
