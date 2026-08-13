"""The genuine model-capability lane (Stage 3C.2B).

Separate from the deterministic pipeline fixtures: this runs REPEATED,
SEEDED trials of a REAL model (through the existing OpenAI-compatible
adapter, including local vLLM/Ollama-compatible endpoints), proposing
candidates and evaluating their code inside the SECURE sandbox backend, and
reports honest AGGREGATE capability evidence — acceptance rate, regressions,
and failures across trials — never a claim from a single run.

Two honest boundaries this module enforces:

- **A single trial or a fixture is NOT capability evidence.** The scripted
  `FakeModelAdapter` remains the deterministic CI control and is labeled
  unchanged (`source="fixture"`); a genuine verdict requires `trials >= 2`
  real-model trials and is otherwise reported `inconclusive`.
- **Negative and inconclusive results are reported honestly** — a low
  acceptance rate is a real finding, not a failure to hide.

Every trial records the model id, parameters, seed, prompt/completion refs
(journaled by the adapter), the sandbox provenance, the budget, the
outcome, regressions, and any failure. Real trials execute model-generated
code, so they REQUIRE a secure backend (`deno-pyodide@1` by default); the
lane refuses to run untrusted code on the fault-only boundary.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from strive.loop import LoopConfig, run_cycle
from strive.store import Store
from strive.tasks import Task

VERDICT_SUPPORTED = "supported"
VERDICT_INCONCLUSIVE = "inconclusive"
VERDICT_NEGATIVE = "negative"

MIN_CAPABILITY_TRIALS = 2  # n=1 is never capability evidence


@dataclass(frozen=True)
class TrialResult:
    """One seeded trial's honest record."""

    trial: int
    seed: int
    source: str  # "real" | "fixture"
    model_id: str
    proposal_valid: bool
    accepted: bool
    regressions: int
    failure_kind: str | None
    model_calls: int
    tokens: int
    latency_ms: float | None
    sandbox_backend: str
    run_id: str


@dataclass(frozen=True)
class CapabilityReport:
    """Aggregate capability evidence across repeated trials. `verdict` is
    `supported` only with enough real trials and a positive acceptance rate;
    `inconclusive` for fixtures, single trials, or too few; `negative` when
    real trials ran but none produced an accepted, regression-free
    candidate."""

    task_id: str
    source: str  # "real" | "fixture"
    model_id: str
    parameters: str
    sandbox_backend: str
    sandbox_secure: bool
    trials: tuple[TrialResult, ...]
    acceptance_rate: float
    clean_acceptance_rate: float  # accepted AND zero regressions
    total_failures: int
    verdict: str
    notes: str

    @property
    def n(self) -> int:
        return len(self.trials)


def _config(
    adapter: object, sandbox_backend: str, seed: int, *, unsafe: bool
) -> LoopConfig:
    from strive.diagnose import EvidenceDiagnoser
    from strive.model_proposer import ModelProposer

    from strive.contracts import BudgetSpec

    return LoopConfig(
        proposer=ModelProposer(),
        diagnoser=EvidenceDiagnoser(),
        model_adapter=adapter,  # type: ignore[arg-type]
        budget=BudgetSpec(model_calls=6, executions=24),
        model_max_tokens=2048,
        unsafe_model_code=unsafe,
        sandbox_backend=sandbox_backend,
    )


def run_capability_trials(
    root: Path,
    task: Task,
    *,
    trials: int,
    sandbox_backend: str = "deno-pyodide@1",
    seeds: tuple[int, ...] | None = None,
    use_fixture: bool = False,
) -> CapabilityReport:
    """Run repeated seeded trials and aggregate honest capability evidence.

    With ``use_fixture=True`` the deterministic scripted adapter is used and
    the report is labeled `fixture`/`inconclusive` no matter the outcome —
    a control, never capability evidence. Otherwise a real adapter is built
    from the environment; real model-generated code REQUIRES a secure
    backend, so the lane refuses an insecure one."""
    import strive.sandbox_backends  # noqa: F401 — register backends
    from strive.loop import _backend_is_secure
    from strive.model import adapter_from_env
    from strive.sandboxes import SandboxError, get_backend

    if root.exists() and any(root.iterdir()):
        raise RuntimeError(
            f"capability directory {root} already contains a run; use a fresh "
            "directory (reuse is refused for reproducibility)"
        )
    seed_tuple = seeds or tuple(range(trials))
    if len(seed_tuple) != trials:
        raise ValueError("seeds must have exactly `trials` entries")

    secure = _backend_is_secure(sandbox_backend)
    if use_fixture:
        from strive.fakemodel import prompt_sensitive_adapter

        adapter: object = prompt_sensitive_adapter()
        source, model_id = "fixture", "scripted-fixture"
    else:
        adapter = adapter_from_env()
        if adapter is None:
            raise RuntimeError(
                "no real model configured; set STRIVE_MODEL_PROVIDER etc. "
                "(see strive.model.adapter_from_env), or pass use_fixture=True "
                "for the deterministic control"
            )
        if not secure:
            # never run untrusted model code on the fault-only boundary
            try:
                available, reason = get_backend(
                    sandbox_backend, require_available=False
                ).available()
            except SandboxError as exc:
                reason = str(exc)
                available = False
            raise RuntimeError(
                f"real capability trials require a SECURE sandbox backend; "
                f"{sandbox_backend!r} is not secure/available "
                f"({'available' if available else reason}) — refusing to run "
                "untrusted model code on an insecure boundary"
            )
        source = "real"
        model_id = str(getattr(adapter, "model_id", "unknown"))

    results: list[TrialResult] = []
    for index, seed in enumerate(seed_tuple):
        store = Store(root / f"trial-{index}", task.task_id)
        config = _config(
            adapter, sandbox_backend, seed, unsafe=not use_fixture
        )
        report = run_cycle(store, task, config)
        calls, tokens, latency = _trial_metrics(store, report.run_id)
        decision = report.decision
        regressions = (
            len(decision.regressed_case_ids) if decision is not None else 0
        )
        results.append(
            TrialResult(
                trial=index,
                seed=seed,
                source=source,
                model_id=model_id,
                proposal_valid=report.proposal is not None,
                accepted=bool(decision.accepted) if decision is not None else False,
                regressions=regressions,
                failure_kind=(
                    report.proposal_failure.kind
                    if report.proposal_failure is not None
                    else None
                ),
                model_calls=calls,
                tokens=tokens,
                latency_ms=latency,
                sandbox_backend=sandbox_backend,
                run_id=report.run_id,
            )
        )

    return _aggregate(
        task, source, model_id, sandbox_backend, secure, tuple(results)
    )


def _aggregate(
    task: Task,
    source: str,
    model_id: str,
    sandbox_backend: str,
    secure: bool,
    results: tuple[TrialResult, ...],
) -> CapabilityReport:
    n = len(results)
    accepted = sum(1 for r in results if r.accepted)
    clean = sum(1 for r in results if r.accepted and r.regressions == 0)
    failures = sum(1 for r in results if r.failure_kind is not None)
    acceptance_rate = accepted / n if n else 0.0
    clean_rate = clean / n if n else 0.0

    if source == "fixture":
        verdict = VERDICT_INCONCLUSIVE
        notes = (
            "FIXTURE control (deterministic scripted adapter): NOT capability "
            "evidence, whatever the outcome. Labeled inconclusive by design."
        )
    elif n < MIN_CAPABILITY_TRIALS:
        verdict = VERDICT_INCONCLUSIVE
        notes = (
            f"only {n} real trial(s); a single trial is not capability "
            f"evidence (need >= {MIN_CAPABILITY_TRIALS})."
        )
    elif clean > 0:
        verdict = VERDICT_SUPPORTED
        notes = (
            f"{clean}/{n} trials produced an accepted, regression-free "
            f"candidate under a mechanically-secure backend ({sandbox_backend})."
        )
    else:
        verdict = VERDICT_NEGATIVE
        notes = (
            f"{n} real trials, none produced an accepted regression-free "
            "candidate — an honest negative result, not a hidden failure."
        )
    return CapabilityReport(
        task_id=task.task_id,
        source=source,
        model_id=model_id,
        parameters="max_tokens=2048 budget_model_calls=6",
        sandbox_backend=sandbox_backend,
        sandbox_secure=secure,
        trials=results,
        acceptance_rate=acceptance_rate,
        clean_acceptance_rate=clean_rate,
        total_failures=failures,
        verdict=verdict,
        notes=notes,
    )


def _trial_metrics(store: Store, run_id: str) -> tuple[int, int, float | None]:
    from strive.events import EventLog

    events = EventLog(store.runs_dir / run_id / "events.jsonl", run_id).read_all()
    calls = [e for e in events if e.type == "model_call"]
    tokens = 0
    latency: float | None = None
    for event in calls:
        payload = event.payload
        raw_tokens = payload.get("tokens", 0)
        if isinstance(raw_tokens, (int, float)):
            tokens += int(raw_tokens)
        latency_val = payload.get("latency_ms")
        if isinstance(latency_val, (int, float)):
            latency = (latency or 0.0) + float(latency_val)
    return len(calls), tokens, latency


__all__ = [
    "CapabilityReport",
    "MIN_CAPABILITY_TRIALS",
    "TrialResult",
    "VERDICT_INCONCLUSIVE",
    "VERDICT_NEGATIVE",
    "VERDICT_SUPPORTED",
    "run_capability_trials",
]
