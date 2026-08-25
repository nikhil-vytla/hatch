"""The pluggable sandbox boundary and the one execution service
(Stage 3C.2B, hardened in 3C.2B.1).

A `SandboxBackend` is a trusted, named, versioned execution boundary for
UNTRUSTED candidate code. Each backend declares — MECHANICALLY, not by
promise — which capabilities it enforces (filesystem confinement, network
denial, subprocess denial, environment scrubbing, per-execution resource
limits, cross-case non-persistence), reports per-execution provenance
pinning the exact runtime digests, and refuses to be silently downgraded.

Registration is an INJECTED, IMMUTABLE catalog (`BackendCatalog` of
`BackendDescriptor` factories) — not an import-time mutable global — so the
set of backends a run may use is explicit and testable. `CandidateExecutor`
is the single kernel-owned service every strategy-execution path goes
through: `run_strategy` is never called directly outside the
`process-fault-only@1` backend and its own tests.

Backends:

- `process-fault-only@1` — the `python -I` subprocess boundary
  (`strive.sandbox`): FAULT CONTAINMENT, not security (no filesystem
  confinement, no network denial). For author-written fixtures and trusted
  code ONLY; a `CandidateExecutor` refuses it for untrusted code.
- `deno-pyodide@1` — the shipping SECURE LOCAL backend (DSPy
  `PythonInterpreter`; Deno + Pyodide WASM). Default-deny filesystem /
  network / environment / subprocess, a fresh interpreter per case, a
  parent wall-clock hard-kill, and OS resource limits applied to the Deno
  process via `strive.sandbox_launcher`.
- `linux-landlock-seccomp@1` — a NOOA-derived spike that is ALWAYS
  UNAVAILABLE on this build (its full Landlock/seccomp ruleset is not
  implemented); it never reports available+secure with a stubbed `run`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Protocol, Sequence

from strive.codec import register
from strive.contracts import (
    FAILURE_CRASH,
    FAILURE_TIMEOUT,
    FAULT_INFRASTRUCTURE,
    CaseOutcome,
    ExecutionReport,
    FailureRecord,
    TaskCase,
)

FAULT_ONLY_BACKEND = "process-fault-only@1"

# -- capabilities --------------------------------------------------------------------------------

CAP_FILESYSTEM_CONFINED = "filesystem_confined"  # no host path is readable/writable
CAP_NETWORK_DENIED = "network_denied"  # no outbound sockets
CAP_SUBPROCESS_DENIED = "subprocess_denied"  # no fork/exec of children
CAP_ENV_SCRUBBED = "env_scrubbed"  # no host environment variables
CAP_RESOURCE_LIMITED = "resource_limited"  # cpu/mem/output/wall/files/procs bounded
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
# to have been mechanically enforced — the secure-execution floor. Resource
# limiting is part of "secure" (3C.2B.1): unbounded CPU/memory/output is an
# escape of its own.
SECURE_EXECUTION_CAPABILITIES = (
    CAP_FILESYSTEM_CONFINED,
    CAP_NETWORK_DENIED,
    CAP_SUBPROCESS_DENIED,
    CAP_ENV_SCRUBBED,
    CAP_RESOURCE_LIMITED,
    CAP_FRESH_PER_CASE,
)


class SandboxError(Exception):
    """A sandbox boundary failure (unavailable backend, refused downgrade,
    untrusted code on a fault-only boundary)."""


@register("sandbox-capabilities", 1)
@dataclass(frozen=True)
class SandboxCapabilities:
    """What a backend MECHANICALLY enforces on this host — a report, pinned
    into evidence. `enforced` lists the capabilities the backend guarantees;
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
    """Resource ceilings for one protected execution. `suite_deadline_s` is
    the ABSOLUTE wall budget for a whole protected suite (all cases); the
    others are per-case."""

    wall_time_s: float = 10.0
    suite_deadline_s: float = 120.0
    cpu_seconds: int = 11
    memory_bytes: int = 2 * 1024 * 1024 * 1024  # coarse absolute cap on the runtime
    output_bytes: int = 1_000_000
    open_files: int = 64
    max_processes: int = 0  # 0 = no children permitted


@register("sandbox-provenance", 2)
@dataclass(frozen=True)
class SandboxProvenance:
    """Pinned into `EvaluationManifest`: exactly which boundary executed the
    candidate and under which runtime, so evidence from different backends is
    distinct and replay can demand the recorded backend. `runtime_digest` is
    a stable summary; `component_digests` pins the exact Deno / Pyodide /
    DSPy / runner-code / backend-config versions the execution actually ran
    under (empty for the fault-only boundary, which pins the interpreter)."""

    backend: str  # name@version
    runtime_digest: str
    component_digests: dict[str, str]
    enforced_capabilities: tuple[str, ...]
    mount_policy: str  # human description of what was (not) mounted
    network_policy: str
    limits: SandboxLimits

    @property
    def secure(self) -> bool:
        return all(
            cap in self.enforced_capabilities for cap in SECURE_EXECUTION_CAPABILITIES
        )


@dataclass(frozen=True)
class SandboxRequest:
    """One protected execution request. The candidate receives ONLY each
    case's `input_text` (the runner sends nothing else into the candidate's
    namespace)."""

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
        its declared capabilities on this host reports False — the catalog
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


# -- the injected, immutable backend catalog -----------------------------------------------------


@dataclass(frozen=True)
class BackendDescriptor:
    """An immutable catalog entry: a backend name and a zero-arg factory that
    builds a FRESH backend instance. No import-time mutation of a global."""

    name: str
    factory: Callable[[], SandboxBackend]


class BackendCatalog:
    """An immutable set of backend descriptors, resolved by exact
    name@version. `resolve` fails closed: an unknown or (when
    `require_available`) unavailable backend raises, never a substitution."""

    def __init__(self, descriptors: Sequence[BackendDescriptor]) -> None:
        self._descriptors: dict[str, BackendDescriptor] = {}
        for descriptor in descriptors:
            if descriptor.name in self._descriptors:
                raise SandboxError(f"duplicate backend descriptor {descriptor.name!r}")
            self._descriptors[descriptor.name] = descriptor

    def names(self) -> tuple[str, ...]:
        return tuple(sorted(self._descriptors))

    def create(self, name: str) -> SandboxBackend:
        descriptor = self._descriptors.get(name)
        if descriptor is None:
            raise SandboxError(
                f"unknown sandbox backend {name!r}; known: {list(self.names())} "
                "— refusing to substitute a different backend"
            )
        return descriptor.factory()

    def resolve(self, name: str, *, require_available: bool = True) -> SandboxBackend:
        backend = self.create(name)
        if require_available:
            ok, reason = backend.available()
            if not ok:
                raise SandboxError(
                    f"sandbox backend {name!r} is unavailable on this host: "
                    f"{reason} — refusing to silently downgrade to a weaker "
                    "boundary; install the backend or choose it explicitly"
                )
        return backend


def default_catalog() -> BackendCatalog:
    """The build's default catalog, assembled from `strive.sandbox_backends`
    descriptors WITHOUT any import-time registration side effect."""
    from strive.sandbox_backends import DESCRIPTORS

    return BackendCatalog(DESCRIPTORS)


# -- the reusable conformance suite --------------------------------------------------------------


def conformance_violations(backend: SandboxBackend) -> list[str]:
    """Structural conformance checks every backend must satisfy (regardless
    of availability): versioned name, self-consistent capability report,
    provenance that names the backend and carries every enforced capability.
    Returns a list of violations (empty = conformant)."""
    problems: list[str] = []
    if "@" not in backend.backend:
        problems.append(f"backend {backend.backend!r} is not versioned (name@version)")
    caps = backend.capabilities()
    if caps.backend != backend.backend:
        problems.append("capabilities.backend disagrees with backend.backend")
    overlap = set(caps.enforced) & set(caps.not_enforced)
    if overlap:
        problems.append(f"capabilities both enforce and not-enforce {sorted(overlap)}")
    unknown = (set(caps.enforced) | set(caps.not_enforced)) - set(ALL_CAPABILITIES)
    if unknown:
        problems.append(f"capabilities name unknown capabilities {sorted(unknown)}")
    prov = backend.provenance(SandboxLimits())
    if prov.backend != backend.backend:
        problems.append("provenance.backend disagrees with backend.backend")
    if set(prov.enforced_capabilities) != set(caps.enforced):
        problems.append("provenance enforced_capabilities disagree with capabilities")
    if caps.secure != prov.secure:
        problems.append("capabilities.secure disagrees with provenance.secure")
    return problems


# -- the one execution service -------------------------------------------------------------------


@dataclass(frozen=True)
class ExecutionOutcome:
    """The result of a `CandidateExecutor` suite run: a case-ordered report,
    the boundary provenance, and journaled denial notes."""

    report: ExecutionReport
    provenance: SandboxProvenance
    denials: tuple[str, ...]


class CandidateExecutor:
    """The single kernel-owned strategy-execution service. Every run,
    promptgate, visible-context, experiment, compare, replay, audit,
    promotion, and capability path executes candidate code through here — so
    there is exactly one mechanically-bounded boundary per run, and
    `run_strategy` is never called directly elsewhere.

    A `process-fault-only@1` executor REQUIRES `trusted=True`: untrusted
    (model-authored) code is refused on the fault-only boundary and must
    name a secure backend."""

    def __init__(self, backend: SandboxBackend, *, trusted: bool) -> None:
        if backend.backend == FAULT_ONLY_BACKEND and not trusted:
            raise SandboxError(
                "process-fault-only@1 is fault containment, not security; it "
                "is for explicitly trusted fixtures/code only. Model-authored "
                "code requires a secure backend (e.g. deno-pyodide@1)."
            )
        self._backend = backend
        self._trusted = trusted

    @classmethod
    def from_catalog(
        cls,
        catalog: BackendCatalog,
        backend_name: str,
        *,
        trusted: bool,
        require_available: bool = True,
    ) -> "CandidateExecutor":
        backend = catalog.resolve(backend_name, require_available=require_available)
        return cls(backend, trusted=trusted)

    @property
    def backend_name(self) -> str:
        return self._backend.backend

    @property
    def trusted(self) -> bool:
        return self._trusted

    def capabilities(self) -> SandboxCapabilities:
        return self._backend.capabilities()

    def provenance(self, limits: SandboxLimits | None = None) -> SandboxProvenance:
        return self._backend.provenance(limits or SandboxLimits())

    def execute_suite(
        self,
        strategy_source: str,
        cases: Sequence[TaskCase],
        *,
        generation_id: str,
        limits: SandboxLimits | None = None,
    ) -> ExecutionOutcome:
        """Execute the candidate over `cases` (each in a fresh sandbox) and
        return a case-ordered `ExecutionReport` plus the boundary provenance.
        Failure-as-data: a case the boundary refused or crashed on carries
        its error at the floor, never raising into the controller."""
        outcomes, provenance, denials, wall_time_s, stdout_bytes, failure, fault_origin = (
            run_protected_suite(
                self._backend,
                strategy_source,
                cases,
                generation_id=generation_id,
                limits=limits,
            )
        )
        ordered = tuple(
            outcomes[case.case_id]
            for case in cases
            if case.case_id in outcomes
        )
        # A boundary/infrastructure fault (timeout, crash, refusal, malformed
        # runner output) surfaces as an aggregate `ok=False` report carrying the
        # `failure` — NOT as an ordinary per-case error. A candidate exception or
        # a wrong answer is caught inside the runner (`ok=True`, per-case `error`)
        # and stays a completed per-case evaluation.
        report = ExecutionReport(
            ok=failure is None,
            generation_id=generation_id,
            outcomes=ordered,
            failure=failure,
            wall_time_s=wall_time_s,      # ACTUAL aggregated backend wall time
            stdout_bytes=stdout_bytes,    # ACTUAL captured output bytes
            fault_origin=fault_origin,    # TRUSTED origin the boundary stamped
        )
        return ExecutionOutcome(report=report, provenance=provenance, denials=denials)


# -- protected-suite execution primitive ---------------------------------------------------------


def run_protected_suite(
    backend: "SandboxBackend",
    strategy_source: str,
    cases: Sequence[TaskCase],
    *,
    generation_id: str,
    limits: SandboxLimits | None = None,
) -> tuple[
    dict[str, CaseOutcome], SandboxProvenance, tuple[str, ...], float, int,
    FailureRecord | None, str | None,
]:
    """Execute EACH protected case in a FRESH sandbox, in isolation: the
    candidate sees only that case's `input_text`, and no candidate state
    survives between cases. The parent retains case id, split, expected
    output, and the rest of the suite. Enforces the ABSOLUTE suite deadline
    across cases. Returns (outcomes by case id, provenance, denial notes, the
    ACTUAL aggregated backend wall time, the ACTUAL captured output bytes, and
    the first BOUNDARY failure — a timeout/crash/refusal/malformed-runner fault
    the backend reported as `ok=False`, distinct from a candidate exception the
    runner caught and returned as an `ok=True` per-case error).

    Kept as the per-case primitive `CandidateExecutor.execute_suite` builds
    on; callers outside the executor and backend tests should not use it."""
    import time

    outcomes: dict[str, CaseOutcome] = {}
    denials: list[str] = []
    provenance: SandboxProvenance | None = None
    boundary_failure: FailureRecord | None = None
    boundary_fault_origin: str | None = None
    effective_limits = limits or SandboxLimits()
    total_wall_s = 0.0
    total_stdout_bytes = 0
    suite_started = time.monotonic()
    for case in cases:
        remaining = effective_limits.suite_deadline_s - (
            time.monotonic() - suite_started
        )
        if remaining <= 0:
            denials.append(
                f"suite deadline {effective_limits.suite_deadline_s}s exhausted "
                f"before case {case.case_id}"
            )
            # an exhausted suite deadline is a BOUNDARY timeout, not a candidate
            # error — surface it as the aggregate failure.
            if boundary_failure is None:
                boundary_failure = FailureRecord(
                    kind=FAILURE_TIMEOUT,
                    detail=f"suite deadline {effective_limits.suite_deadline_s}s exhausted",
                )
                # a RUN-BUDGET shortfall enforced by the parent, not the candidate
                boundary_fault_origin = FAULT_INFRASTRUCTURE
            outcomes[case.case_id] = CaseOutcome(
                case_id=case.case_id,
                output=None,
                error="timeout: suite deadline exhausted",
                duration_ms=0.0,
            )
            continue
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
        # preserve the ACTUAL backend wall + captured output, never discard them
        total_wall_s += result.report.wall_time_s
        total_stdout_bytes += result.report.stdout_bytes
        if result.report.ok:
            for outcome in result.report.outcomes:
                outcomes[outcome.case_id] = outcome
        else:
            # a boundary/infrastructure fault: record a per-case error AND raise
            # it to the aggregate so the attempt is classified as ok=False.
            failure = result.report.failure or FailureRecord(
                kind=FAILURE_CRASH, detail="protected execution failed"
            )
            if boundary_failure is None:
                boundary_failure = failure
                # carry the backend's TRUSTED origin stamp (candidate vs backend)
                boundary_fault_origin = result.report.fault_origin
            outcomes[case.case_id] = CaseOutcome(
                case_id=case.case_id,
                output=None,
                error=f"{failure.kind}: {failure.detail}",
                duration_ms=0.0,
            )
    if provenance is None:  # empty suite (or all deadline-skipped)
        provenance = backend.provenance(effective_limits)
    return (
        outcomes, provenance, tuple(denials), round(total_wall_s, 6),
        total_stdout_bytes, boundary_failure, boundary_fault_origin,
    )


__all__ = [
    "ALL_CAPABILITIES",
    "CAP_ENV_SCRUBBED",
    "CAP_FILESYSTEM_CONFINED",
    "CAP_FRESH_PER_CASE",
    "CAP_NETWORK_DENIED",
    "CAP_RESOURCE_LIMITED",
    "CAP_SUBPROCESS_DENIED",
    "FAULT_ONLY_BACKEND",
    "SECURE_EXECUTION_CAPABILITIES",
    "BackendCatalog",
    "BackendDescriptor",
    "CandidateExecutor",
    "ExecutionOutcome",
    "SandboxBackend",
    "SandboxCapabilities",
    "SandboxError",
    "SandboxLimits",
    "SandboxProvenance",
    "SandboxRequest",
    "SandboxResult",
    "conformance_violations",
    "default_catalog",
    "run_protected_suite",
]
