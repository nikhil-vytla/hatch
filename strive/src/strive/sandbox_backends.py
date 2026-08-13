"""Concrete sandbox backends (Stage 3C.2B), registered at import.

- `process-fault-only@1` wraps `strive.sandbox.run_strategy` — the honest
  fault-containment boundary, for author-written fixtures and trusted code
  only. Its capability report names what it does NOT enforce (filesystem,
  network).
- `deno-pyodide@1` is the shipping SECURE LOCAL backend (DSPy
  `PythonInterpreter`; Deno + Pyodide WASM). Default-deny: no host
  filesystem, network, environment, or subprocess. A fresh interpreter per
  execution means candidate state cannot persist.
- `linux-landlock-seccomp@1` is the NOOA-derived spike: available only on a
  probe-confirmed Linux kernel; otherwise UNAVAILABLE (never downgraded).
"""

from __future__ import annotations

import json
import threading
import time

from strive.codec import register  # noqa: F401 — records live in sandboxes
from strive.contracts import (
    FAILURE_CRASH,
    FAILURE_MALFORMED_OUTPUT,
    FAILURE_TIMEOUT,
    CaseOutcome,
    ExecutionReport,
    FailureRecord,
    TaskCase,
)
from strive.sandbox import run_strategy
from strive.sandbox_guards import check_enforceable
from strive.sandboxes import (
    CAP_ENV_SCRUBBED,
    CAP_FILESYSTEM_CONFINED,
    CAP_FRESH_PER_CASE,
    CAP_NETWORK_DENIED,
    CAP_RESOURCE_LIMITED,
    CAP_SUBPROCESS_DENIED,
    SandboxCapabilities,
    SandboxLimits,
    SandboxProvenance,
    SandboxRequest,
    SandboxResult,
    register_backend,
)

_RUNNER_PROTOCOL = 1


# -- process-fault-only@1 ------------------------------------------------------------------------


class ProcessFaultOnlyBackend:
    """The honest fault-containment boundary (today's `python -I` child).
    NOT a security sandbox: filesystem and network are not confined. For
    author-written fixtures and trusted code only."""

    backend = "process-fault-only@1"
    version = 1

    def available(self) -> tuple[bool, str]:
        return True, "subprocess boundary always available"

    def capabilities(self) -> SandboxCapabilities:
        return SandboxCapabilities(
            backend=self.backend,
            enforced=(CAP_ENV_SCRUBBED, CAP_RESOURCE_LIMITED, CAP_FRESH_PER_CASE),
            not_enforced=(
                CAP_FILESYSTEM_CONFINED,
                CAP_NETWORK_DENIED,
                CAP_SUBPROCESS_DENIED,
            ),
            detail=(
                "fault containment only: separate python -I process, scrubbed "
                "env, wall-clock kill, POSIX rlimits — but NO filesystem "
                "confinement and NO network denial. Trusted code only."
            ),
        )

    def provenance(self, limits: SandboxLimits) -> SandboxProvenance:
        import sys

        return SandboxProvenance(
            backend=self.backend,
            runtime_digest=f"cpython-{sys.version.split()[0]}-isolated",
            enforced_capabilities=self.capabilities().enforced,
            mount_policy="inherits controller UID's filesystem view (NOT confined)",
            network_policy="not denied (candidate may open sockets)",
            limits=limits,
        )

    def run(self, request: SandboxRequest) -> SandboxResult:
        report = run_strategy(
            request.strategy_source,
            request.cases,
            generation_id=request.generation_id,
            timeout_s=request.limits.wall_time_s,
            output_bytes_cap=request.limits.output_bytes,
        )
        return SandboxResult(report=report, provenance=self.provenance(request.limits))


# -- deno-pyodide@1 ------------------------------------------------------------------------------

_RUNNER_TEMPLATE = '''
import json, sys, time

_payload = json.loads(_STRIVE_PAYLOAD)

{strategy_source}

_results = []
for _case in _payload["cases"]:
    _t = time.monotonic()
    try:
        _out = solve(_case["input_text"])
        _err = None
        if not isinstance(_out, int):
            _err = "solve did not return an int (got %s)" % type(_out).__name__
            _out = None
    except BaseException as _exc:
        _out, _err = None, "%s: %s" % (type(_exc).__name__, _exc)
    _results.append({{
        "case_id": _case["case_id"],
        "output": _out,
        "error": _err,
        "duration_ms": (time.monotonic() - _t) * 1000.0,
    }})

_STRIVE_RESULT = json.dumps({{"protocol": 1, "results": _results}})
'''


class DenoPyodideBackend:
    """The first secure LOCAL backend: DSPy's `PythonInterpreter` (Deno +
    Pyodide WASM). Default-deny — no host filesystem, network, environment,
    or subprocess permission is granted. Each `run` boots a FRESH
    interpreter, so candidate state never persists across executions."""

    backend = "deno-pyodide@1"
    version = 1

    def __init__(self) -> None:
        self._deno_version: str | None = None

    def available(self) -> tuple[bool, str]:
        import shutil
        import subprocess

        if shutil.which("deno") is None:
            return False, "the `deno` runtime is not on PATH"
        try:
            import dspy.primitives.python_interpreter  # noqa: F401
        except ImportError as exc:
            return False, f"DSPy PythonInterpreter unavailable: {exc}"
        try:
            out = subprocess.run(
                ["deno", "--version"], capture_output=True, text=True, timeout=10
            )
            self._deno_version = out.stdout.splitlines()[0].strip()
        except Exception as exc:  # noqa: BLE001
            return False, f"deno --version failed: {exc}"
        return True, "deno + DSPy PythonInterpreter available"

    def capabilities(self) -> SandboxCapabilities:
        return SandboxCapabilities(
            backend=self.backend,
            enforced=(
                CAP_FILESYSTEM_CONFINED,
                CAP_NETWORK_DENIED,
                CAP_SUBPROCESS_DENIED,
                CAP_ENV_SCRUBBED,
                CAP_FRESH_PER_CASE,
            ),
            not_enforced=(CAP_RESOURCE_LIMITED,),
            detail=(
                "Deno+Pyodide WASM VFS: no host path is nameable, no outbound "
                "socket, no os.fork/subprocess, no host environment. Fresh "
                "interpreter per execution. Wall-clock is parent-enforced; "
                "fine-grained cpu/memory caps are Pyodide-internal (reported "
                "as not mechanically enforced by strive)."
            ),
        )

    def provenance(self, limits: SandboxLimits) -> SandboxProvenance:
        return SandboxProvenance(
            backend=self.backend,
            runtime_digest=(self._deno_version or "deno") + "+pyodide",
            enforced_capabilities=self.capabilities().enforced,
            mount_policy=(
                "WASM virtual filesystem; deno --allow-read limited to the "
                "runner + deno cache; no repo/CAS/ledger/home/socket reachable"
            ),
            network_policy="deno default-deny (no --allow-net)",
            limits=limits,
        )

    def run(self, request: SandboxRequest) -> SandboxResult:
        from dspy.primitives.python_interpreter import (
            CodeExecutionError,
            PythonInterpreter,
        )

        started = time.monotonic()
        denials: list[str] = []
        payload = json.dumps(
            {
                "cases": [
                    {"case_id": c.case_id, "input_text": c.input_text}
                    for c in request.cases
                ]
            }
        )
        program = (
            f"_STRIVE_PAYLOAD = {json.dumps(payload)}\n"
            + _RUNNER_TEMPLATE.format(strategy_source=request.strategy_source)
            + "\n_STRIVE_RESULT\n"
        )
        # a FRESH interpreter — default-deny, no persisted state
        interp = PythonInterpreter()
        # wall-clock watchdog: pyodide has no internal wall kill, so the
        # parent runs execute() in a thread and SIGKILLs the deno process
        # (interp.shutdown) if it overruns — a candidate cannot hang us
        raw_holder: dict[str, object] = {}
        exc_holder: dict[str, BaseException] = {}

        def _execute() -> None:
            try:
                raw_holder["raw"] = interp.execute(program)
            except BaseException as exc:  # noqa: BLE001 — carried to the parent
                exc_holder["exc"] = exc

        worker = threading.Thread(target=_execute, daemon=True)
        worker.start()
        worker.join(timeout=request.limits.wall_time_s)
        if worker.is_alive():
            denials.append(
                f"execution exceeded {request.limits.wall_time_s}s wall time; "
                "deno process killed"
            )
            # a CPU-bound candidate never reads a graceful shutdown RPC (and
            # interp.shutdown() would then block on wait()), so the PARENT
            # SIGKILLs the deno OS process directly — NOOA's hard-kill pattern
            self._hard_kill(interp)
            worker.join(timeout=5.0)
            return SandboxResult(
                report=ExecutionReport(
                    ok=False,
                    generation_id=request.generation_id,
                    outcomes=(),
                    failure=FailureRecord(
                        kind=FAILURE_TIMEOUT,
                        detail=f"killed after {request.limits.wall_time_s}s",
                    ),
                    wall_time_s=round(time.monotonic() - started, 6),
                    stdout_bytes=0,
                ),
                provenance=self.provenance(request.limits),
                denials=tuple(denials),
            )
        try:
            if "exc" in exc_holder:
                raise exc_holder["exc"]
            raw = raw_holder.get("raw", "")
        except CodeExecutionError as exc:
            denials.append(f"pyodide denied/failed execution: {str(exc)[:200]}")
            return SandboxResult(
                report=ExecutionReport(
                    ok=False,
                    generation_id=request.generation_id,
                    outcomes=(),
                    failure=FailureRecord(
                        kind=FAILURE_CRASH,
                        detail=f"pyodide execution error: {str(exc)[:200]}",
                    ),
                    wall_time_s=round(time.monotonic() - started, 6),
                    stdout_bytes=0,
                ),
                provenance=self.provenance(request.limits),
                denials=tuple(denials),
            )
        except Exception as exc:  # noqa: BLE001 — never crash the controller
            return SandboxResult(
                report=ExecutionReport(
                    ok=False,
                    generation_id=request.generation_id,
                    outcomes=(),
                    failure=FailureRecord(
                        kind=FAILURE_CRASH, detail=f"backend error: {str(exc)[:200]}"
                    ),
                    wall_time_s=round(time.monotonic() - started, 6),
                    stdout_bytes=0,
                ),
                provenance=self.provenance(request.limits),
                denials=tuple(denials),
            )
        finally:
            self._shutdown(interp)

        report = self._parse(raw, request, started)
        return SandboxResult(
            report=report,
            provenance=self.provenance(request.limits),
            denials=tuple(denials),
        )

    @staticmethod
    def _hard_kill(interp: object) -> None:
        """SIGKILL the deno subprocess directly (bypassing DSPy's graceful
        shutdown, which blocks on wait() for a CPU-bound child that never
        reads the shutdown RPC)."""
        process = getattr(interp, "deno_process", None)
        if process is not None:
            try:
                process.kill()
            except Exception:  # noqa: BLE001
                pass

    @staticmethod
    def _shutdown(interp: object) -> None:
        """Graceful shutdown in a watchdog thread; hard-kill on overrun so a
        wedged child never blocks the controller on interpreter teardown."""
        import threading as _t

        done = _t.Event()

        def _close() -> None:
            try:
                interp.shutdown()  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001
                pass
            finally:
                done.set()

        closer = _t.Thread(target=_close, daemon=True)
        closer.start()
        if not done.wait(timeout=5.0):
            DenoPyodideBackend._hard_kill(interp)

    def _parse(
        self, raw: object, request: SandboxRequest, started: float
    ) -> ExecutionReport:
        def fail(kind: str, detail: str) -> ExecutionReport:
            return ExecutionReport(
                ok=False,
                generation_id=request.generation_id,
                outcomes=(),
                failure=FailureRecord(kind=kind, detail=detail),
                wall_time_s=round(time.monotonic() - started, 6),
                stdout_bytes=0,
            )

        try:
            parsed = json.loads(raw) if isinstance(raw, str) else raw
            if (
                not isinstance(parsed, dict)
                or parsed.get("protocol") != _RUNNER_PROTOCOL
                or not isinstance(parsed.get("results"), list)
            ):
                return fail(FAILURE_MALFORMED_OUTPUT, "unexpected runner envelope")
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
            return fail(FAILURE_MALFORMED_OUTPUT, f"runner output unparseable: {exc}")
        return ExecutionReport(
            ok=True,
            generation_id=request.generation_id,
            outcomes=outcomes,
            failure=None,
            wall_time_s=round(time.monotonic() - started, 6),
            stdout_bytes=len(str(raw)),
        )


# -- linux-landlock-seccomp@1 (spike) ------------------------------------------------------------


class LinuxLandlockSeccompBackend:
    """A NOOA-derived spike: unprivileged Landlock + seccomp + rlimits,
    self-installed post-fork. Available ONLY on a probe-confirmed Linux
    kernel; otherwise UNAVAILABLE — never downgraded."""

    backend = "linux-landlock-seccomp@1"
    version = 1

    def available(self) -> tuple[bool, str]:
        probe = check_enforceable()
        if probe.all_enforceable:
            return True, probe.detail
        return False, (
            f"kernel confinement not fully enforceable ({probe.detail}); "
            "refusing to run untrusted code under a partial boundary"
        )

    def capabilities(self) -> SandboxCapabilities:
        return SandboxCapabilities(
            backend=self.backend,
            enforced=(
                CAP_FILESYSTEM_CONFINED,
                CAP_NETWORK_DENIED,
                CAP_SUBPROCESS_DENIED,
                CAP_ENV_SCRUBBED,
                CAP_RESOURCE_LIMITED,
                CAP_FRESH_PER_CASE,
            ),
            not_enforced=(),
            detail=(
                "unprivileged Landlock (default-deny fs) + seccomp (no inet "
                "socket) + rlimits (soft==hard), self-installed post-fork; "
                "fail-closed capability probe (NOOA-derived spike)"
            ),
        )

    def provenance(self, limits: SandboxLimits) -> SandboxProvenance:
        return SandboxProvenance(
            backend=self.backend,
            runtime_digest="linux-landlock-seccomp-spike",
            enforced_capabilities=self.capabilities().enforced,
            mount_policy="Landlock path-beneath allow-list (default deny)",
            network_policy="seccomp-BPF deny socket(AF_INET/AF_INET6)",
            limits=limits,
        )

    def run(self, request: SandboxRequest) -> SandboxResult:
        from strive.sandboxes import SandboxError

        raise SandboxError(
            "linux-landlock-seccomp@1 is a spike and is not runnable on this "
            "host; deno-pyodide@1 is the shipping secure backend"
        )


PROCESS_FAULT_ONLY = register_backend(ProcessFaultOnlyBackend())
DENO_PYODIDE = register_backend(DenoPyodideBackend())
LINUX_LANDLOCK_SECCOMP = register_backend(LinuxLandlockSeccompBackend())


__all__ = [
    "DENO_PYODIDE",
    "LINUX_LANDLOCK_SECCOMP",
    "PROCESS_FAULT_ONLY",
    "DenoPyodideBackend",
    "LinuxLandlockSeccompBackend",
    "ProcessFaultOnlyBackend",
]
