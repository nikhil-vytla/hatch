"""Process-isolated execution of strategy code.

Isolation boundary, stated honestly (see ARCHITECTURE "Sandbox boundary" and
README): this is FAULT CONTAINMENT, not a production-grade security sandbox.
What is mechanically enforced here:

- the child is a separate process (`python -I`: isolated mode, no user site,
  no inherited PYTHONPATH) — evolvable code never enters the kernel process;
- a hard wall-clock timeout (kill on expiry);
- a scrubbed environment: the child inherits no environment variables from
  the controller (no secrets), only a minimal PATH/HOME pointing into the
  private workspace;
- a private working directory (fresh temp workspace per execution);
- bounded stdout/stderr (the parent stops reading and kills at the cap);
- POSIX resource limits where available: CPU seconds, file size, open files.

What is NOT enforced and must not be relied upon: network denial (no reliable
unprivileged cross-platform mechanism; candidates could open sockets), address
-space limits on macOS (RLIMIT_AS is unreliable there), and filesystem
confinement (a candidate that guesses an absolute path outside the workspace
can read/write wherever the controller's UID can). Real containment
(Landlock/seccomp on Linux, containers) is roadmap stage 3/6.
"""

from __future__ import annotations

import json
import resource
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import IO, Sequence

from strive.contracts import (
    FAILURE_CRASH,
    FAILURE_MALFORMED_OUTPUT,
    FAILURE_OUTPUT_LIMIT,
    FAILURE_SCHEMA_MISMATCH,
    FAILURE_TIMEOUT,
    FAULT_CANDIDATE,
    FAULT_UNKNOWN,
    CaseOutcome,
    ExecutionReport,
    FailureRecord,
    TaskCase,
)

_RUNNER_PATH = Path(__file__).with_name("strategy_runner.py")
_PROTOCOL = 1
_EXIT_SCHEMA_MISMATCH = 3


def _apply_rlimits(cpu_seconds: int, output_bytes: int) -> None:
    # Runs in the child between fork and exec. CPU cap backs up the wall-clock
    # timer; FSIZE bounds file writes; NOFILE bounds descriptor use.
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 1))
    resource.setrlimit(resource.RLIMIT_FSIZE, (output_bytes, output_bytes))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))


def _read_bounded(stream: IO[bytes], cap: int) -> bytes:
    chunks: list[bytes] = []
    remaining = cap + 1
    while remaining > 0:
        chunk = stream.read(min(65536, remaining))
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def run_strategy(
    strategy_source: str,
    cases: Sequence[TaskCase],
    *,
    generation_id: str,
    timeout_s: float = 10.0,
    output_bytes_cap: int = 1_000_000,
) -> ExecutionReport:
    """Run ``solve`` from the given source over ``cases`` in a contained child."""
    started = time.monotonic()

    def report(
        *,
        ok: bool,
        outcomes: tuple[CaseOutcome, ...] = (),
        failure: FailureRecord | None = None,
        stdout_bytes: int = 0,
        fault_origin: str | None = None,
    ) -> ExecutionReport:
        return ExecutionReport(
            ok=ok,
            generation_id=generation_id,
            outcomes=outcomes,
            failure=failure,
            wall_time_s=round(time.monotonic() - started, 6),
            stdout_bytes=stdout_bytes,
            fault_origin=fault_origin,
        )

    payload = json.dumps(
        {
            "protocol": _PROTOCOL,
            "cases": [
                {"case_id": c.case_id, "input_text": c.input_text} for c in cases
            ],
        }
    ).encode("utf-8")

    with tempfile.TemporaryDirectory(prefix="strive-sandbox-") as workspace:
        strategy_path = Path(workspace) / "strategy.py"
        strategy_path.write_text(strategy_source, encoding="utf-8")
        cpu_seconds = max(1, int(timeout_s) + 1)
        proc = subprocess.Popen(
            [sys.executable, "-I", str(_RUNNER_PATH), str(strategy_path)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=workspace,
            env={"HOME": workspace, "PATH": "/usr/bin:/bin"},  # no inherited secrets
            preexec_fn=lambda: _apply_rlimits(cpu_seconds, output_bytes_cap),
        )
        timed_out = threading.Event()

        def _kill() -> None:
            timed_out.set()
            proc.kill()

        timer = threading.Timer(timeout_s, _kill)
        timer.start()
        try:
            assert proc.stdin is not None and proc.stdout is not None
            assert proc.stderr is not None
            try:
                proc.stdin.write(payload)
                proc.stdin.close()
            except BrokenPipeError:
                pass  # child died early; fall through to exit-code handling
            stdout = _read_bounded(proc.stdout, output_bytes_cap)
            if len(stdout) > output_bytes_cap and not timed_out.is_set():
                proc.kill()
                proc.wait()
                return report(
                    ok=False,
                    failure=FailureRecord(
                        kind=FAILURE_OUTPUT_LIMIT,
                        detail=f"stdout exceeded {output_bytes_cap} bytes",
                    ),
                    stdout_bytes=len(stdout),
                    fault_origin=FAULT_CANDIDATE,  # the candidate flooded stdout
                )
            proc.wait()
            stderr = _read_bounded(proc.stderr, 65536)
        finally:
            timer.cancel()
            if proc.poll() is None:
                proc.kill()
                proc.wait()

    if timed_out.is_set():
        return report(
            ok=False,
            failure=FailureRecord(
                kind=FAILURE_TIMEOUT, detail=f"killed after {timeout_s}s"
            ),
            stdout_bytes=len(stdout),
            # a wall timeout is NOT proven candidate (a hung child looks the same
            # as a slow launcher) — the cause is UNKNOWN
            fault_origin=FAULT_UNKNOWN,
        )
    if proc.returncode == _EXIT_SCHEMA_MISMATCH:
        return report(
            ok=False,
            failure=FailureRecord(
                kind=FAILURE_SCHEMA_MISMATCH,
                detail=stderr.decode("utf-8", "replace").strip() or "runner rejected payload",
            ),
            stdout_bytes=len(stdout),
            fault_origin=FAULT_UNKNOWN,  # a runner-protocol break; cause not proven
        )
    if proc.returncode != 0:
        tail = stderr.decode("utf-8", "replace").strip().splitlines()[-5:]
        return report(
            ok=False,
            failure=FailureRecord(
                kind=FAILURE_CRASH,
                detail=f"child exited {proc.returncode}: " + " | ".join(tail),
            ),
            stdout_bytes=len(stdout),
            # a nonzero exit could be the candidate crashing OR the launcher/
            # runner failing to start — NOT distinguishable here, so UNKNOWN
            fault_origin=FAULT_UNKNOWN,
        )

    try:
        parsed = json.loads(stdout)
        if (
            not isinstance(parsed, dict)
            or parsed.get("protocol") != _PROTOCOL
            or not isinstance(parsed.get("results"), list)
        ):
            raise ValueError("unexpected envelope")
        outcomes = tuple(
            CaseOutcome(
                case_id=str(item["case_id"]),
                output=item["output"],
                error=item["error"],
                duration_ms=float(item["duration_ms"]),
            )
            for item in parsed["results"]
        )
    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
        return report(
            ok=False,
            failure=FailureRecord(
                kind=FAILURE_MALFORMED_OUTPUT, detail=f"runner output unparseable: {exc}"
            ),
            stdout_bytes=len(stdout),
            fault_origin=FAULT_UNKNOWN,  # protocol break; candidate-flood vs runner-bug unproven
        )

    return report(ok=True, outcomes=outcomes, stdout_bytes=len(stdout))
