"""Process-isolated execution of strategy code with a hard timeout.

This is fault isolation, not a security boundary (see the project charter's
non-goals): a hanging or crashing strategy cannot take down the controller,
but a malicious one is out of scope for this milestone. The interface is the
seam where a real sandbox (container, seccomp, microVM) plugs in later.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Sequence

from strive.types import CaseResult, SandboxResult, TaskCase

_RUNNER_PATH = Path(__file__).with_name("strategy_runner.py")


def run_strategy(
    strategy_path: Path,
    cases: Sequence[TaskCase],
    timeout_s: float = 10.0,
) -> SandboxResult:
    """Run ``solve`` from ``strategy_path`` over ``cases`` in a child process."""
    payload = json.dumps(
        {"cases": [{"case_id": c.case_id, "input_text": c.input_text} for c in cases]}
    )
    try:
        proc = subprocess.run(
            [sys.executable, "-I", str(_RUNNER_PATH), str(strategy_path)],
            input=payload,
            capture_output=True,
            text=True,
            timeout=timeout_s,
        )
    except subprocess.TimeoutExpired:
        return SandboxResult(ok=False, failure=f"timeout after {timeout_s}s")

    if proc.returncode != 0:
        stderr_tail = proc.stderr.strip().splitlines()[-5:]
        return SandboxResult(
            ok=False,
            failure=f"child exited {proc.returncode}: " + " | ".join(stderr_tail),
        )

    try:
        parsed = json.loads(proc.stdout)
        case_results = tuple(
            CaseResult(
                case_id=str(item["case_id"]),
                output=item["output"],
                error=item["error"],
                duration_ms=float(item["duration_ms"]),
            )
            for item in parsed["results"]
        )
    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
        return SandboxResult(ok=False, failure=f"malformed runner output: {exc}")

    return SandboxResult(ok=True, case_results=case_results)
