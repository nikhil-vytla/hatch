"""Concrete sandbox backends (Stage 3C.2B, hardened in 3C.2B.1).

Exposed as an immutable `DESCRIPTORS` tuple (name + factory) that
`strive.sandboxes.default_catalog()` assembles — there is NO import-time
registration side effect.

- `process-fault-only@1` wraps `strive.sandbox.run_strategy` — the honest
  fault-containment boundary, for author-written fixtures and trusted code
  only. Its report names what it does NOT enforce.
- `deno-pyodide@1` is the shipping SECURE local backend (DSPy
  `PythonInterpreter`; Deno + Pyodide WASM). The candidate runs in a fresh
  interpreter, in a SEPARATE namespace that receives only `input_text`,
  cannot see the runner globals or the trusted serialization, and whose
  result is built OUTSIDE that namespace with primitives captured before
  the candidate ran. Deno launches through `strive.sandbox_launcher` so OS
  resource limits (CPU/memory/files/procs) are mechanically applied.
- `linux-landlock-seccomp@1` is a NOOA-derived spike that ALWAYS reports
  UNAVAILABLE on this build — its full Landlock/seccomp ruleset is not
  implemented, so it never claims available+secure with a stubbed `run`.
"""

from __future__ import annotations

import hashlib
import json
import sys
import threading
import time
from pathlib import Path

from strive.contracts import (
    FAILURE_CRASH,
    FAILURE_MALFORMED_OUTPUT,
    FAILURE_TIMEOUT,
    FAULT_INFRASTRUCTURE,
    FAULT_UNKNOWN,
    CaseOutcome,
    ExecutionReport,
    FailureRecord,
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
    BackendDescriptor,
    SandboxCapabilities,
    SandboxLimits,
    SandboxProvenance,
    SandboxRequest,
    SandboxResult,
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
            enforced=(CAP_ENV_SCRUBBED, CAP_FRESH_PER_CASE),
            not_enforced=(
                CAP_FILESYSTEM_CONFINED,
                CAP_NETWORK_DENIED,
                CAP_SUBPROCESS_DENIED,
                CAP_RESOURCE_LIMITED,
            ),
            detail=(
                "fault containment only: separate python -I process, scrubbed "
                "env, wall-clock kill, some POSIX rlimits — but NO filesystem "
                "confinement, NO network denial, and no full resource floor. "
                "Trusted code only; never secure for model-authored code."
            ),
        )

    def provenance(self, limits: SandboxLimits) -> SandboxProvenance:
        return SandboxProvenance(
            backend=self.backend,
            runtime_digest=f"cpython-{sys.version.split()[0]}-isolated",
            component_digests={"cpython": sys.version.split()[0]},
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

# The runner program. The candidate source runs in a SEPARATE namespace
# (`_ns`) that holds only builtins; it never sees `_inputs`, `_src`, or the
# captured trusted serialization (`_dumps`). The result envelope is built
# OUTSIDE the candidate namespace with primitives captured BEFORE any
# candidate code ran, so rebinding `json.dumps` inside the candidate cannot
# reach it. Only `input_text` strings enter the sandbox — case id, split,
# expected value, and the rest of the suite stay parent-side, so frame or
# global inspection yields nothing but the candidate's own input and source.
_RUNNER_TEMPLATE = '''
import json as _json, time as _time, builtins as _bi

_dumps = _json.dumps
_inputs = _json.loads(_STRIVE_INPUTS)
_src = _STRIVE_SRC
_code = compile(_src, "<candidate>", "exec")

_results = []
for _text in _inputs:
    _ns = {"__builtins__": _bi.__dict__}
    _t = _time.monotonic()
    _out = None
    _err = None
    try:
        exec(_code, _ns)
        _solve = _ns.get("solve")
        if not callable(_solve):
            _err = "no callable solve(input_text) is defined"
        else:
            _val = _solve(_text)
            if isinstance(_val, bool) or not isinstance(_val, int):
                _err = "non-integer output of type %s" % type(_val).__name__
            else:
                _out = _val
    except BaseException as _exc:
        _err = "%s: %s" % (type(_exc).__name__, _exc)
    _results.append({"output": _out, "error": _err,
                     "duration_ms": (_time.monotonic() - _t) * 1000.0})

_STRIVE_RESULT = _dumps({"protocol": 1, "results": _results})
'''


class DenoPyodideBackend:
    """The shipping SECURE local backend: DSPy's `PythonInterpreter`
    (Deno + Pyodide WASM). Default-deny filesystem/network/env/subprocess; a
    fresh interpreter per run; a parent wall-clock hard-kill; and OS resource
    limits applied to the Deno process via `strive.sandbox_launcher`."""

    backend = "deno-pyodide@1"
    version = 1

    def __init__(self) -> None:
        self._deno_version: str | None = None
        self._base_command: list[str] | None = None
        self._runner_digest: str | None = None
        self._pyodide_version: str | None = None
        self._dspy_version: str | None = None

    # -- availability + digests ----------------------------------------------

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
        self._collect_digests()
        return True, "deno + DSPy PythonInterpreter available"

    def _collect_digests(self) -> None:
        if self._runner_digest is not None:
            return
        try:
            import dspy

            self._dspy_version = getattr(dspy, "__version__", "unknown")
            from dspy.primitives import python_interpreter as _pi

            runner_path = Path(_pi.__file__).with_name("runner.js")
            runner_bytes = runner_path.read_bytes()
            self._runner_digest = hashlib.sha256(runner_bytes).hexdigest()
            text = runner_bytes.decode("utf-8", "replace")
            marker = "pyodide"
            self._pyodide_version = "bundled"
            for token in text.replace('"', " ").replace("'", " ").split():
                if "pyodide" in token and any(ch.isdigit() for ch in token):
                    self._pyodide_version = token
                    break
        except Exception:  # noqa: BLE001 — digests are best-effort, never block
            self._runner_digest = self._runner_digest or "unknown"
            self._pyodide_version = self._pyodide_version or "unknown"
            self._dspy_version = self._dspy_version or "unknown"

    def _launcher_command(self, base: list[str], limits: SandboxLimits) -> list[str]:
        """Prepend the rlimit launcher so the Deno process runs under OS
        resource limits (CPU/memory/files/procs, mechanically enforced)."""
        return [
            sys.executable,
            "-m",
            "strive.sandbox_launcher",
            str(limits.cpu_seconds),
            str(limits.memory_bytes),
            str(limits.open_files),
            str(limits.max_processes),
            str(limits.output_bytes),
            "--",
            *base,
        ]

    def _config_digest(self, command: list[str]) -> str:
        # digest the backend config (command shape) minus host-specific
        # absolute paths, so evidence pins the boundary configuration
        shape = [
            Path(part).name if "/" in part else part for part in command
        ]
        return hashlib.sha256(
            json.dumps(shape, sort_keys=True).encode("utf-8")
        ).hexdigest()[:16]

    # -- reports --------------------------------------------------------------

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
                "Deno+Pyodide WASM VFS: no host path is nameable, no outbound "
                "socket, no os.fork/subprocess, no host environment; fresh "
                "interpreter per execution; parent wall-clock hard-kill. OS "
                "resource limits (CPU seconds, open files, processes, single-"
                "file size) are applied to the Deno process via the rlimit "
                "launcher; the memory ceiling (RLIMIT_AS) is a COARSE absolute "
                "bound on the whole WASM runtime (not a tight per-candidate "
                "cap) and is unreliable on macOS."
            ),
        )

    def provenance(self, limits: SandboxLimits) -> SandboxProvenance:
        self._collect_digests()
        base = self._ensure_base_command()
        command = self._launcher_command(base, limits)
        return SandboxProvenance(
            backend=self.backend,
            runtime_digest=(self._deno_version or "deno") + "+pyodide",
            component_digests={
                "deno": self._deno_version or "unknown",
                "pyodide": self._pyodide_version or "unknown",
                "dspy": self._dspy_version or "unknown",
                "runner_sha256": (self._runner_digest or "unknown")[:16],
                "backend_config": self._config_digest(command),
            },
            enforced_capabilities=self.capabilities().enforced,
            mount_policy=(
                "WASM virtual filesystem; deno --allow-read limited to the "
                "runner + deno cache; no repo/CAS/ledger/home/socket reachable"
            ),
            network_policy="deno default-deny (no --allow-net)",
            limits=limits,
        )

    def _ensure_base_command(self) -> list[str]:
        if self._base_command is not None:
            return self._base_command
        from dspy.primitives.python_interpreter import PythonInterpreter

        probe = PythonInterpreter()
        try:
            self._base_command = list(probe.deno_command)
        finally:
            try:
                probe.shutdown()
            except Exception:  # noqa: BLE001
                pass
        return self._base_command

    # -- execution ------------------------------------------------------------

    def run(self, request: SandboxRequest) -> SandboxResult:
        from dspy.primitives.python_interpreter import (
            CodeExecutionError,
            PythonInterpreter,
        )

        started = time.monotonic()
        denials: list[str] = []
        inputs = [c.input_text for c in request.cases]  # ONLY input text
        program = (
            f"_STRIVE_INPUTS = {json.dumps(json.dumps(inputs))}\n"
            f"_STRIVE_SRC = {json.dumps(request.strategy_source)}\n"
            + _RUNNER_TEMPLATE
            + "\n_STRIVE_RESULT\n"
        )

        base = self._ensure_base_command()
        deno_command = self._launcher_command(base, request.limits)
        interp = PythonInterpreter(deno_command=deno_command)

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
            self._hard_kill(interp)
            worker.join(timeout=5.0)
            return self._fail(
                request, started, FAILURE_TIMEOUT,
                f"killed after {request.limits.wall_time_s}s", denials,
                # a wall timeout is not distinguishable (candidate hang vs deno
                # stall) — the cause is UNKNOWN
                fault_origin=FAULT_UNKNOWN,
            )
        try:
            if "exc" in exc_holder:
                raise exc_holder["exc"]
            raw = raw_holder.get("raw", "")
        except CodeExecutionError as exc:
            denials.append(f"pyodide denied/failed execution: {str(exc)[:200]}")
            # a GENERIC CodeExecutionError does not prove which side failed
            # (candidate exception vs a pyodide/runtime error) — UNKNOWN
            return self._fail(
                request, started, FAILURE_CRASH,
                f"pyodide execution error: {str(exc)[:200]}", denials,
                fault_origin=FAULT_UNKNOWN,
            )
        except Exception as exc:  # noqa: BLE001 — never crash the controller
            return self._fail(
                request, started, FAILURE_CRASH,
                f"backend error: {str(exc)[:200]}", denials,
                fault_origin=FAULT_INFRASTRUCTURE,  # PROVEN: the deno/pyodide BACKEND faulted
            )
        finally:
            self._shutdown(interp)

        report = self._parse(raw, request, started)
        return SandboxResult(
            report=report,
            provenance=self.provenance(request.limits),
            denials=tuple(denials),
        )

    def _fail(
        self,
        request: SandboxRequest,
        started: float,
        kind: str,
        detail: str,
        denials: list[str],
        *,
        fault_origin: str = FAULT_INFRASTRUCTURE,
    ) -> SandboxResult:
        return SandboxResult(
            report=ExecutionReport(
                ok=False,
                generation_id=request.generation_id,
                outcomes=(),
                failure=FailureRecord(kind=kind, detail=detail),
                wall_time_s=round(time.monotonic() - started, 6),
                stdout_bytes=0,
                fault_origin=fault_origin,
            ),
            provenance=self.provenance(request.limits),
            denials=tuple(denials),
        )

    @staticmethod
    def _hard_kill(interp: object) -> None:
        process = getattr(interp, "deno_process", None)
        if process is not None:
            try:
                process.kill()
            except Exception:  # noqa: BLE001
                pass

    @staticmethod
    def _shutdown(interp: object) -> None:
        done = threading.Event()

        def _close() -> None:
            try:
                interp.shutdown()  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001
                pass
            finally:
                done.set()

        closer = threading.Thread(target=_close, daemon=True)
        closer.start()
        if not done.wait(timeout=5.0):
            DenoPyodideBackend._hard_kill(interp)

    def _parse(
        self, raw: object, request: SandboxRequest, started: float
    ) -> ExecutionReport:
        """STRICT envelope validation. The parent assigns case ids by
        position (the sandbox never supplies an id, so ids cannot be forged);
        the result count must equal the input count; each result carries
        exactly {output, error, duration_ms} with output a non-bool int or
        null. Any deviation — protocol mutation, extra/missing/duplicate
        fields, a spoofed shape — is a malformed-output failure."""

        def fail(kind: str, detail: str) -> ExecutionReport:
            return ExecutionReport(
                ok=False,
                generation_id=request.generation_id,
                outcomes=(),
                failure=FailureRecord(kind=kind, detail=detail),
                wall_time_s=round(time.monotonic() - started, 6),
                stdout_bytes=len(str(raw)),
                fault_origin=FAULT_UNKNOWN,  # a runner-protocol break; cause not proven
            )

        try:
            parsed = json.loads(raw) if isinstance(raw, str) else raw
        except (json.JSONDecodeError, TypeError) as exc:
            return fail(FAILURE_MALFORMED_OUTPUT, f"runner output unparseable: {exc}")
        if not isinstance(parsed, dict) or set(parsed.keys()) != {"protocol", "results"}:
            return fail(FAILURE_MALFORMED_OUTPUT, "unexpected runner envelope keys")
        if parsed["protocol"] != _RUNNER_PROTOCOL:
            return fail(
                FAILURE_MALFORMED_OUTPUT,
                f"protocol mutated to {parsed['protocol']!r}",
            )
        results = parsed["results"]
        if not isinstance(results, list) or len(results) != len(request.cases):
            return fail(
                FAILURE_MALFORMED_OUTPUT,
                f"expected {len(request.cases)} result(s), got "
                f"{len(results) if isinstance(results, list) else 'non-list'}",
            )
        outcomes: list[CaseOutcome] = []
        for case, item in zip(request.cases, results):
            if not isinstance(item, dict) or set(item.keys()) != {
                "output", "error", "duration_ms"
            }:
                return fail(FAILURE_MALFORMED_OUTPUT, "result has unexpected fields")
            output = item["output"]
            if output is not None and (
                isinstance(output, bool) or not isinstance(output, int)
            ):
                return fail(
                    FAILURE_MALFORMED_OUTPUT,
                    f"result output is not a non-bool int: {output!r}",
                )
            error = item["error"]
            if error is not None and not isinstance(error, str):
                return fail(FAILURE_MALFORMED_OUTPUT, "result error is not a string")
            duration = item["duration_ms"]
            if isinstance(duration, bool) or not isinstance(duration, (int, float)):
                return fail(FAILURE_MALFORMED_OUTPUT, "result duration is not a number")
            outcomes.append(
                CaseOutcome(
                    case_id=case.case_id,  # PARENT assigns the id
                    output=output,
                    error=error,
                    duration_ms=float(duration),
                )
            )
        return ExecutionReport(
            ok=True,
            generation_id=request.generation_id,
            outcomes=tuple(outcomes),
            failure=None,
            wall_time_s=round(time.monotonic() - started, 6),
            stdout_bytes=len(str(raw)),
        )


# -- linux-landlock-seccomp@1 (spike; always unavailable) ----------------------------------------


class LinuxLandlockSeccompBackend:
    """A NOOA-derived spike. Its full Landlock/seccomp ruleset is NOT
    implemented in this build, so it ALWAYS reports unavailable — it never
    claims available+secure while `run` would raise. `deno-pyodide@1` is the
    shipping secure backend."""

    backend = "linux-landlock-seccomp@1"
    version = 1

    def available(self) -> tuple[bool, str]:
        probe = check_enforceable()
        return False, (
            "linux-landlock-seccomp@1 is a spike: the full Landlock/seccomp "
            "ruleset and its leak-vs-closed tests are not implemented in this "
            f"build, so it is never runnable here (kernel probe: {probe.detail}). "
            "Use deno-pyodide@1, the shipping secure backend."
        )

    def capabilities(self) -> SandboxCapabilities:
        return SandboxCapabilities(
            backend=self.backend,
            enforced=(),
            not_enforced=(
                CAP_FILESYSTEM_CONFINED,
                CAP_NETWORK_DENIED,
                CAP_SUBPROCESS_DENIED,
                CAP_ENV_SCRUBBED,
                CAP_RESOURCE_LIMITED,
                CAP_FRESH_PER_CASE,
            ),
            detail=(
                "unimplemented spike (Landlock path-beneath + seccomp-BPF + "
                "rlimits, self-installed post-fork, NOOA-derived): reports no "
                "enforced capabilities and is always unavailable until the "
                "ruleset and leak-vs-closed tests land."
            ),
        )

    def provenance(self, limits: SandboxLimits) -> SandboxProvenance:
        return SandboxProvenance(
            backend=self.backend,
            runtime_digest="linux-landlock-seccomp-spike-unimplemented",
            component_digests={},
            enforced_capabilities=(),
            mount_policy="(unimplemented)",
            network_policy="(unimplemented)",
            limits=limits,
        )

    def run(self, request: SandboxRequest) -> SandboxResult:
        from strive.sandboxes import SandboxError

        raise SandboxError(
            "linux-landlock-seccomp@1 is unimplemented and always unavailable; "
            "deno-pyodide@1 is the shipping secure backend"
        )


DESCRIPTORS = (
    BackendDescriptor("process-fault-only@1", ProcessFaultOnlyBackend),
    BackendDescriptor("deno-pyodide@1", DenoPyodideBackend),
    BackendDescriptor("linux-landlock-seccomp@1", LinuxLandlockSeccompBackend),
)


__all__ = [
    "DESCRIPTORS",
    "DenoPyodideBackend",
    "LinuxLandlockSeccompBackend",
    "ProcessFaultOnlyBackend",
]
