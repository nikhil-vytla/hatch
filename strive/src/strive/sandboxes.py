"""The pluggable sandbox boundary (Stage 3C.2B).

A `SandboxBackend` is a trusted, named, versioned execution boundary for
UNTRUSTED candidate code. Each backend declares — mechanically, not by
promise — which capabilities it enforces (filesystem confinement, network
denial, subprocess denial, environment scrubbing, per-execution resource
limits, cross-case non-persistence). The registry resolves a backend by
name; a REQUESTED backend that is unavailable on this host FAILS CLOSED and
is NEVER silently downgraded to a weaker one.

Three backends:

- `process-fault-only@1` — today's `python -I` subprocess boundary
  (`strive.sandbox`), renamed honestly: FAULT CONTAINMENT, not security.
  It enforces process isolation, a wall-clock kill, environment scrubbing,
  and POSIX rlimits, but NOT filesystem confinement or network denial. It
  is retained only for author-written fixtures and trusted code, and its
  capability report says so.
- `deno-pyodide@1` — the first SECURE LOCAL backend, via DSPy's
  `PythonInterpreter` (Deno + Pyodide WASM). Default-deny: no host
  filesystem, no network, no environment, no subprocess/`os.fork`. The
  candidate runs in a WASM VFS that cannot name a host path; each protected
  case gets a FRESH interpreter, so candidate state cannot persist.
- `linux-landlock-seccomp@1` — a spike adapting NOOA's Apache-2.0
  `guards.py` (unprivileged Landlock path-beneath + seccomp-BPF socket
  denial + rlimits, self-installed post-fork, fail-closed capability
  probing). Available only on Linux with a probe-confirmed kernel; on this
  build it reports UNAVAILABLE rather than pretending.

Every backend's capability report and per-execution provenance feed the
evidence manifests (`strive.evidence`), so activation authority can require
that every capability a promotion depends on was MECHANICALLY ENFORCED —
and so evidence produced under one backend is never confused with another's.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, Sequence

from strive.codec import register
from strive.contracts import (
    FAILURE_CRASH,
    CaseOutcome,
    ExecutionReport,
    FailureRecord,
    TaskCase,
)

# -- capabilities --------------------------------------------------------------------------------

CAP_FILESYSTEM_CONFINED = "filesystem_confined"  # no host path is readable/writable
CAP_NETWORK_DENIED = "network_denied"  # no outbound sockets
CAP_SUBPROCESS_DENIED = "subprocess_denied"  # no fork/exec of children
CAP_ENV_SCRUBBED = "env_scrubbed"  # no host environment variables
CAP_RESOURCE_LIMITED = "resource_limited"  # cpu/mem/output/wall caps enforced
CAP_FRESH_PER_CASE = "fresh_per_case"  # candidate state never persists across cases

ALL_CAPABILITIES = (
    CAP_FILESYSTEM_CONFINED,
    CAP_NETWORK_DENIED,
    CAP_SUBPROCESS_DENIED,
    CAP_ENV_SCRUBBED,
    CAP_RESOURCE_LIMITED,
    CAP_FRESH_PER_CASE,
)

# the capabilities a promotion of MODEL-GENERATED (untrusted) code requires
# to have been mechanically enforced — the secure-execution floor
SECURE_EXECUTION_CAPABILITIES = (
    CAP_FILESYSTEM_CONFINED,
    CAP_NETWORK_DENIED,
    CAP_SUBPROCESS_DENIED,
    CAP_ENV_SCRUBBED,
    CAP_FRESH_PER_CASE,
)


class SandboxError(Exception):
    """A sandbox boundary failure (unavailable backend, refused downgrade)."""


@register("sandbox-capabilities", 1)
@dataclass(frozen=True)
class SandboxCapabilities:
    """What a backend MECHANICALLY enforces on this host — a report, pinned
    into evidence. `enforced` lists capabilities the backend guarantees;
    `not_enforced` names the rest explicitly (honest disclosure, never a
    silent gap). `secure` is True iff every secure-execution capability is
    enforced — the floor for untrusted model-code authority."""

    backend: str  # name@version
    enforced: tuple[str, ...]
    not_enforced: tuple[str, ...]
    detail: str

    @property
    def secure(self) -> bool:
        return all(cap in self.enforced for cap in SECURE_EXECUTION_CAPABILITIES)


@register("sandbox-limits", 1)
@dataclass(frozen=True)
class SandboxLimits:
    """Resource ceilings for one protected execution."""

    wall_time_s: float = 10.0
    cpu_seconds: int = 11
    memory_bytes: int = 256 * 1024 * 1024
    output_bytes: int = 1_000_000
    open_files: int = 64
    max_processes: int = 0  # 0 = no children permitted


@register("sandbox-provenance", 1)
@dataclass(frozen=True)
class SandboxProvenance:
    """Pinned into `EvaluationManifest`: exactly which boundary executed the
    candidate, so evidence from different backends is distinct and replay can
    demand the recorded backend. `runtime_digest` identifies the concrete
    runtime (interpreter/image/tool versions) the execution ran under."""

    backend: str  # name@version
    runtime_digest: str
    enforced_capabilities: tuple[str, ...]
    mount_policy: str  # human description of what was (not) mounted
    network_policy: str
    limits: SandboxLimits


@dataclass(frozen=True)
class SandboxRequest:
    """One protected execution request: the candidate source and the cases
    to run it over. The candidate receives ONLY each case's `input_text`."""

    strategy_source: str
    cases: tuple[TaskCase, ...]
    generation_id: str
    limits: SandboxLimits = field(default_factory=SandboxLimits)


@dataclass(frozen=True)
class SandboxResult:
    """The execution report plus the provenance of the boundary that produced
    it and any mechanically-denied-and-journaled attack observations."""

    report: ExecutionReport
    provenance: SandboxProvenance
    denials: tuple[str, ...] = ()  # human notes on denied operations, journaled


class SandboxBackend(Protocol):
    """A trusted, named, versioned execution boundary for untrusted code."""

    backend: str  # name@version
    version: int

    def available(self) -> tuple[bool, str]:
        """(available, reason). A backend that cannot mechanically enforce
        its declared capabilities on this host reports False — the registry
        then FAILS CLOSED rather than downgrading."""
        ...

    def capabilities(self) -> SandboxCapabilities:
        """What this backend mechanically enforces on this host."""
        ...

    def provenance(self, limits: SandboxLimits) -> SandboxProvenance:
        """The provenance this backend stamps on executions under `limits`."""
        ...

    def run(self, request: SandboxRequest) -> SandboxResult:
        """Execute the candidate over the cases, returning a report + the
        boundary's provenance."""
        ...


# -- registry (fail-closed; never silently downgrades) -------------------------------------------

_BACKENDS: dict[str, "SandboxBackend"] = {}


def register_backend(backend: "SandboxBackend") -> "SandboxBackend":
    _BACKENDS[backend.backend] = backend
    return backend


def known_backends() -> tuple[str, ...]:
    return tuple(sorted(_BACKENDS))


def get_backend(name: str, *, require_available: bool = True) -> "SandboxBackend":
    """Resolve a backend by name@version EXACTLY. A requested backend that is
    unknown or unavailable raises `SandboxError` — the caller never receives
    a different (weaker) backend than it asked for."""
    backend = _BACKENDS.get(name)
    if backend is None:
        raise SandboxError(
            f"unknown sandbox backend {name!r}; known: {list(known_backends())} "
            "— refusing to substitute a different backend"
        )
    if require_available:
        ok, reason = backend.available()
        if not ok:
            raise SandboxError(
                f"sandbox backend {name!r} is unavailable on this host: {reason} "
                "— refusing to silently downgrade to a weaker boundary; install "
                "the backend or choose it explicitly"
            )
    return backend


# -- protected-suite execution -------------------------------------------------------------------


def run_protected_suite(
    backend: "SandboxBackend",
    strategy_source: str,
    cases: Sequence[TaskCase],
    *,
    generation_id: str,
    limits: SandboxLimits | None = None,
) -> tuple[dict[str, CaseOutcome], SandboxProvenance, tuple[str, ...]]:
    """Execute EACH protected case in a FRESH sandbox, in isolation: the
    candidate sees only that case's `input_text`, and no candidate state
    survives between cases (the backend's `fresh_per_case` capability). The
    parent retains case id, split, expected output, and the rest of the
    suite. Returns (outcomes by case id, provenance, denial notes).

    A backend that is `fresh_per_case` (deno-pyodide, process-fault-only)
    naturally isolates cases because each `run` call is a fresh boundary; we
    call it once per case so cross-case leakage is structurally impossible
    even for a stateful backend."""
    outcomes: dict[str, CaseOutcome] = {}
    denials: list[str] = []
    provenance: SandboxProvenance | None = None
    effective_limits = limits or SandboxLimits()
    for case in cases:
        result = backend.run(
            SandboxRequest(
                strategy_source=strategy_source,
                cases=(case,),
                generation_id=f"{generation_id}:{case.case_id}",
                limits=effective_limits,
            )
        )
        provenance = result.provenance
        denials.extend(result.denials)
        if result.report.ok:
            for outcome in result.report.outcomes:
                outcomes[outcome.case_id] = outcome
        else:
            failure = result.report.failure or FailureRecord(
                kind=FAILURE_CRASH, detail="protected execution failed"
            )
            outcomes[case.case_id] = CaseOutcome(
                case_id=case.case_id,
                output=None,
                error=f"{failure.kind}: {failure.detail}",
                duration_ms=0.0,
            )
    if provenance is None:  # empty suite: report the backend's own provenance
        provenance = backend.provenance(effective_limits)
    return outcomes, provenance, tuple(denials)


__all__ = [
    "ALL_CAPABILITIES",
    "CAP_ENV_SCRUBBED",
    "CAP_FILESYSTEM_CONFINED",
    "CAP_FRESH_PER_CASE",
    "CAP_NETWORK_DENIED",
    "CAP_RESOURCE_LIMITED",
    "CAP_SUBPROCESS_DENIED",
    "SECURE_EXECUTION_CAPABILITIES",
    "SandboxBackend",
    "SandboxCapabilities",
    "SandboxError",
    "SandboxLimits",
    "SandboxProvenance",
    "SandboxRequest",
    "SandboxResult",
    "get_backend",
    "known_backends",
    "register_backend",
    "run_protected_suite",
]
