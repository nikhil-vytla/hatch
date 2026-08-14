"""The genuine model-capability lane (Stage 3C.2B, repaired in 3C.2B.1).

Separate from the deterministic pipeline fixtures: this runs REPEATED,
SEEDED trials of a REAL model (through the existing OpenAI-compatible
adapter, including local vLLM/Ollama-compatible endpoints), proposing
candidates and evaluating their code inside the SECURE sandbox backend, and
reports honest AGGREGATE capability evidence against a PREREGISTERED
criterion — never a claim from a single run.

Trustworthiness fixes over 3C.2B:

- **Real seeds.** Each trial's seed is propagated into every `ModelRequest`
  (`LoopConfig.model_seed`), so seeded trials genuinely vary the seed. The
  provider's seed support is recorded honestly (`seed_support`); repeated
  seed-0 requests are never called "seeded."
- **A preregistered criterion.** `CapabilityCriterion` (min trials, minimum
  clean-acceptance rate) is fixed BEFORE the trials run; `supported`
  additionally requires the lower bound of a proportion interval to clear
  zero, so ONE success among many is never automatically "supported."
- **An immutable manifest.** One `manifest.json` per run pins, per trial,
  the request / prompt / completion / revision / evidence / sandbox / budget
  / outcome refs; it is written once and never rewritten.
- **Resume without duplicate spend.** A completed trial writes a
  `trial.json`; a resumed run reuses it and only executes missing trials.

A single trial or a fixture is NEVER capability evidence: the scripted
`FakeModelAdapter` control is labeled `fixture`/`inconclusive` unchanged.
Real trials execute model-generated code, so they REQUIRE a secure backend;
the lane refuses the fault-only boundary.
"""

from __future__ import annotations

import json
import math
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
class CapabilityCriterion:
    """The PREREGISTERED bar a real-model run must clear to be `supported`,
    fixed before the trials run. `supported` requires at least `min_trials`
    real trials, a clean-acceptance point estimate >= `min_clean_rate`, AND
    a proportion-interval lower bound above zero (so a lone fluke never
    reads as support)."""

    min_trials: int = MIN_CAPABILITY_TRIALS
    min_clean_rate: float = 0.5
    confidence_z: float = 1.96  # ~95% normal-approx interval


@dataclass(frozen=True)
class TrialResult:
    """One seeded trial's honest record."""

    trial: int
    seed: int
    source: str  # "real" | "fixture"
    model_id: str
    seed_support: str  # how the adapter treats the seed (honest)
    proposal_valid: bool
    accepted: bool
    regressions: int
    failure_kind: str | None
    model_calls: int
    tokens: int
    latency_ms: float | None
    sandbox_backend: str
    run_id: str
    revision_id: str | None = None
    prompt_refs: tuple[str, ...] = ()
    completion_refs: tuple[str, ...] = ()
    selection_ref: str | None = None
    sandbox_provenance_ref: str | None = None


@dataclass(frozen=True)
class CapabilityReport:
    """Aggregate capability evidence across repeated trials, judged against a
    preregistered criterion. `verdict` is `supported` only when real trials
    clear the criterion; `inconclusive` for fixtures / too few trials /
    interval touching zero; `negative` when real trials ran but none was a
    clean acceptance."""

    task_id: str
    source: str  # "real" | "fixture"
    model_id: str
    parameters: str
    sandbox_backend: str
    sandbox_secure: bool
    criterion: CapabilityCriterion
    trials: tuple[TrialResult, ...]
    acceptance_rate: float
    clean_acceptance_rate: float  # accepted AND zero regressions
    clean_rate_lower_bound: float
    total_failures: int
    verdict: str
    notes: str
    manifest_path: str = ""

    @property
    def n(self) -> int:
        return len(self.trials)


def _config(
    adapter: object, sandbox_backend: str, seed: int, *, unsafe: bool
) -> LoopConfig:
    from strive.contracts import BudgetSpec
    from strive.diagnose import EvidenceDiagnoser
    from strive.model_proposer import ModelProposer

    return LoopConfig(
        proposer=ModelProposer(),
        diagnoser=EvidenceDiagnoser(),
        model_adapter=adapter,  # type: ignore[arg-type]
        budget=BudgetSpec(model_calls=6, executions=24),
        model_max_tokens=2048,
        unsafe_model_code=unsafe,
        sandbox_backend=sandbox_backend,
        model_seed=seed,  # the REAL per-trial seed, into every ModelRequest
    )


def _wilson_lower_bound(successes: int, n: int, z: float) -> float:
    """Normal-approximation (Wilson) lower bound on a proportion — a lone
    success in many trials yields a lower bound near zero, so it cannot pass
    the `> 0` gate on its own."""
    if n == 0:
        return 0.0
    phat = successes / n
    denom = 1.0 + z * z / n
    centre = phat + z * z / (2 * n)
    margin = z * math.sqrt((phat * (1 - phat) + z * z / (4 * n)) / n)
    return max(0.0, (centre - margin) / denom)


def run_capability_trials(
    root: Path,
    task: Task,
    *,
    trials: int,
    sandbox_backend: str = "deno-pyodide@1",
    seeds: tuple[int, ...] | None = None,
    use_fixture: bool = False,
    criterion: CapabilityCriterion | None = None,
    resume: bool = False,
) -> CapabilityReport:
    """Run repeated seeded trials and aggregate honest capability evidence
    against a preregistered criterion. With ``use_fixture=True`` the
    deterministic scripted adapter is used and the report is labeled
    `fixture`/`inconclusive` no matter the outcome. Otherwise a real adapter
    is built from the environment; real model-generated code REQUIRES a
    secure backend. ``resume=True`` reuses any already-completed trials in
    ``root`` (no duplicate model spend)."""
    from strive.loop import _backend_is_secure
    from strive.model import adapter_from_env
    from strive.sandboxes import SandboxError, default_catalog

    criterion = criterion or CapabilityCriterion()
    root.mkdir(parents=True, exist_ok=True)
    if not resume and any(p for p in root.iterdir() if p.name != "manifest.json"):
        raise RuntimeError(
            f"capability directory {root} already contains a run; use a fresh "
            "directory or pass resume=True (reuse is refused for reproducibility)"
        )
    seed_tuple = seeds or tuple(range(trials))
    if len(seed_tuple) != trials:
        raise ValueError("seeds must have exactly `trials` entries")

    secure = _backend_is_secure(sandbox_backend)
    catalog = default_catalog()
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
            try:
                available, reason = catalog.resolve(
                    sandbox_backend, require_available=False
                ).available()
            except SandboxError as exc:
                reason, available = str(exc), False
            raise RuntimeError(
                f"real capability trials require a SECURE sandbox backend; "
                f"{sandbox_backend!r} is not secure/available "
                f"({'available' if available else reason}) — refusing to run "
                "untrusted model code on an insecure boundary"
            )
        source = "real"
        model_id = str(getattr(adapter, "model_id", "unknown"))
    seed_support = str(getattr(adapter, "seed_support", "unverified"))

    results: list[TrialResult] = []
    for index, seed in enumerate(seed_tuple):
        trial_dir = root / f"trial-{index}"
        marker = trial_dir / "trial.json"
        if resume and marker.exists():
            results.append(_load_trial(marker))
            continue
        store = Store(trial_dir, task.task_id)
        config = _config(adapter, sandbox_backend, seed, unsafe=not use_fixture)
        report = run_cycle(store, task, config)
        result = _collect_trial(
            store, report, index=index, seed=seed, source=source,
            model_id=model_id, seed_support=seed_support,
            sandbox_backend=sandbox_backend,
        )
        marker.write_text(json.dumps(_trial_dict(result), indent=2, sort_keys=True))
        results.append(result)

    aggregate = _aggregate(
        task, source, model_id, sandbox_backend, secure, criterion,
        tuple(results),
    )
    manifest_path = root / "manifest.json"
    manifest_path.write_text(
        json.dumps(_manifest(aggregate), indent=2, sort_keys=True)
    )
    return _with_manifest_path(aggregate, str(manifest_path))


def _collect_trial(
    store: Store,
    report: object,
    *,
    index: int,
    seed: int,
    source: str,
    model_id: str,
    seed_support: str,
    sandbox_backend: str,
) -> TrialResult:
    from strive import lifecycle
    from strive.events import EventLog

    run_id = getattr(report, "run_id")
    decision = getattr(report, "decision", None)
    proposal = getattr(report, "proposal", None)
    proposal_failure = getattr(report, "proposal_failure", None)
    regressions = len(decision.regressed_case_ids) if decision is not None else 0

    events = EventLog(store.runs_dir / run_id / "events.jsonl", run_id).read_all()
    calls = [e for e in events if e.type == "model_call"]
    tokens = 0
    latency: float | None = None
    prompt_refs: list[str] = []
    completion_refs: list[str] = []
    observed_seeds: set[int] = set()
    for event in calls:
        payload = event.payload
        for key, acc in (("input_tokens", 0), ("output_tokens", 0)):
            raw = payload.get(key, 0)
            if isinstance(raw, (int, float)):
                tokens += int(raw)
        lat = payload.get("latency_ms")
        if isinstance(lat, (int, float)):
            latency = (latency or 0.0) + float(lat)
        if isinstance(payload.get("prompt_ref"), str):
            prompt_refs.append(str(payload["prompt_ref"]))
        if isinstance(payload.get("completion_ref"), str):
            completion_refs.append(str(payload["completion_ref"]))
        seed_val = payload.get("seed")
        if isinstance(seed_val, int) and not isinstance(seed_val, bool):
            observed_seeds.add(seed_val)

    # the seed actually reached the model iff the journaled call carries it
    effective_seed_support = seed_support
    if calls and observed_seeds and observed_seeds != {seed}:
        effective_seed_support = f"MISMATCH(sent {sorted(observed_seeds)}, want {seed})"

    revision_id: str | None = None
    selection_ref: str | None = None
    sandbox_provenance_ref: str | None = None
    try:
        st = lifecycle.state(store)
        revision_id = st.active_revision_id
        if revision_id is not None:
            links = st.evidence_links.get(revision_id, ())
            for link in reversed(links):
                if link.kind == "selection":
                    selection_ref = link.envelope_ref
                    break
            sandbox_provenance_ref = _sandbox_ref_for(store, revision_id, selection_ref)
    except Exception:  # noqa: BLE001 — manifest collection never breaks a trial
        pass

    return TrialResult(
        trial=index,
        seed=seed,
        source=source,
        model_id=model_id,
        seed_support=effective_seed_support,
        proposal_valid=proposal is not None,
        accepted=bool(decision.accepted) if decision is not None else False,
        regressions=regressions,
        failure_kind=proposal_failure.kind if proposal_failure is not None else None,
        model_calls=len(calls),
        tokens=tokens,
        latency_ms=latency,
        sandbox_backend=sandbox_backend,
        run_id=run_id,
        revision_id=revision_id,
        prompt_refs=tuple(prompt_refs),
        completion_refs=tuple(completion_refs),
        selection_ref=selection_ref,
        sandbox_provenance_ref=sandbox_provenance_ref,
    )


def _sandbox_ref_for(
    store: Store, revision_id: str, selection_ref: str | None
) -> str | None:
    from strive import codec
    from strive.evidence import EvaluationManifest, SelectionDecision, ValidationBundle

    if selection_ref is None:
        return None
    try:
        decision: SelectionDecision = codec.loads(
            store.objects.get_text(selection_ref), SelectionDecision
        )
        for item in decision.evidence:
            bundle: ValidationBundle = codec.loads(
                store.objects.get_text(item.bundle_ref), ValidationBundle
            )
            manifest: EvaluationManifest = codec.loads(
                store.objects.get_text(bundle.evaluation_manifest_ref),
                EvaluationManifest,
            )
            if manifest.sandbox_provenance_ref:
                return manifest.sandbox_provenance_ref
    except Exception:  # noqa: BLE001
        return None
    return None


def _aggregate(
    task: Task,
    source: str,
    model_id: str,
    sandbox_backend: str,
    secure: bool,
    criterion: CapabilityCriterion,
    results: tuple[TrialResult, ...],
) -> CapabilityReport:
    n = len(results)
    accepted = sum(1 for r in results if r.accepted)
    clean = sum(1 for r in results if r.accepted and r.regressions == 0)
    failures = sum(1 for r in results if r.failure_kind is not None)
    acceptance_rate = accepted / n if n else 0.0
    clean_rate = clean / n if n else 0.0
    lower = _wilson_lower_bound(clean, n, criterion.confidence_z)

    if source == "fixture":
        verdict = VERDICT_INCONCLUSIVE
        notes = (
            "FIXTURE control (deterministic scripted adapter): NOT capability "
            "evidence, whatever the outcome. Labeled inconclusive by design."
        )
    elif n < criterion.min_trials:
        verdict = VERDICT_INCONCLUSIVE
        notes = (
            f"only {n} real trial(s); the preregistered criterion needs "
            f">= {criterion.min_trials}."
        )
    elif clean == 0:
        verdict = VERDICT_NEGATIVE
        notes = (
            f"{n} real trials, none an accepted regression-free candidate — "
            "an honest negative result, not a hidden failure."
        )
    elif clean_rate >= criterion.min_clean_rate and lower > 0.0:
        verdict = VERDICT_SUPPORTED
        notes = (
            f"{clean}/{n} clean acceptances (rate {clean_rate:.2f}, "
            f"lower bound {lower:.2f} > 0) clears the preregistered criterion "
            f"(>= {criterion.min_clean_rate:.2f}) under a mechanically-secure "
            f"backend ({sandbox_backend})."
        )
    else:
        verdict = VERDICT_INCONCLUSIVE
        notes = (
            f"{clean}/{n} clean acceptances (rate {clean_rate:.2f}, lower "
            f"bound {lower:.2f}); below the preregistered criterion "
            f"(>= {criterion.min_clean_rate:.2f} with lower bound > 0) — one "
            "success among many is not automatically support."
        )
    return CapabilityReport(
        task_id=task.task_id,
        source=source,
        model_id=model_id,
        parameters="max_tokens=2048 budget_model_calls=6",
        sandbox_backend=sandbox_backend,
        sandbox_secure=secure,
        criterion=criterion,
        trials=results,
        acceptance_rate=acceptance_rate,
        clean_acceptance_rate=clean_rate,
        clean_rate_lower_bound=lower,
        total_failures=failures,
        verdict=verdict,
        notes=notes,
    )


# -- trial + manifest (de)serialization ----------------------------------------------------------


def _trial_dict(result: TrialResult) -> dict[str, object]:
    return {
        "trial": result.trial,
        "seed": result.seed,
        "source": result.source,
        "model_id": result.model_id,
        "seed_support": result.seed_support,
        "proposal_valid": result.proposal_valid,
        "accepted": result.accepted,
        "regressions": result.regressions,
        "failure_kind": result.failure_kind,
        "model_calls": result.model_calls,
        "tokens": result.tokens,
        "latency_ms": result.latency_ms,
        "sandbox_backend": result.sandbox_backend,
        "run_id": result.run_id,
        "revision_id": result.revision_id,
        "prompt_refs": list(result.prompt_refs),
        "completion_refs": list(result.completion_refs),
        "selection_ref": result.selection_ref,
        "sandbox_provenance_ref": result.sandbox_provenance_ref,
    }


def _load_trial(marker: Path) -> TrialResult:
    data = json.loads(marker.read_text())
    return TrialResult(
        trial=int(data["trial"]),
        seed=int(data["seed"]),
        source=str(data["source"]),
        model_id=str(data["model_id"]),
        seed_support=str(data["seed_support"]),
        proposal_valid=bool(data["proposal_valid"]),
        accepted=bool(data["accepted"]),
        regressions=int(data["regressions"]),
        failure_kind=data["failure_kind"],
        model_calls=int(data["model_calls"]),
        tokens=int(data["tokens"]),
        latency_ms=data["latency_ms"],
        sandbox_backend=str(data["sandbox_backend"]),
        run_id=str(data["run_id"]),
        revision_id=data["revision_id"],
        prompt_refs=tuple(data.get("prompt_refs", [])),
        completion_refs=tuple(data.get("completion_refs", [])),
        selection_ref=data.get("selection_ref"),
        sandbox_provenance_ref=data.get("sandbox_provenance_ref"),
    )


def _manifest(report: CapabilityReport) -> dict[str, object]:
    return {
        "schema": "capability-report@1",
        "task_id": report.task_id,
        "source": report.source,
        "model_id": report.model_id,
        "parameters": report.parameters,
        "sandbox_backend": report.sandbox_backend,
        "sandbox_secure": report.sandbox_secure,
        "criterion": {
            "min_trials": report.criterion.min_trials,
            "min_clean_rate": report.criterion.min_clean_rate,
            "confidence_z": report.criterion.confidence_z,
        },
        "acceptance_rate": report.acceptance_rate,
        "clean_acceptance_rate": report.clean_acceptance_rate,
        "clean_rate_lower_bound": report.clean_rate_lower_bound,
        "total_failures": report.total_failures,
        "verdict": report.verdict,
        "notes": report.notes,
        "trials": [_trial_dict(t) for t in report.trials],
    }


def _with_manifest_path(report: CapabilityReport, path: str) -> CapabilityReport:
    return CapabilityReport(
        task_id=report.task_id,
        source=report.source,
        model_id=report.model_id,
        parameters=report.parameters,
        sandbox_backend=report.sandbox_backend,
        sandbox_secure=report.sandbox_secure,
        criterion=report.criterion,
        trials=report.trials,
        acceptance_rate=report.acceptance_rate,
        clean_acceptance_rate=report.clean_acceptance_rate,
        clean_rate_lower_bound=report.clean_rate_lower_bound,
        total_failures=report.total_failures,
        verdict=report.verdict,
        notes=report.notes,
        manifest_path=path,
    )


__all__ = [
    "CapabilityCriterion",
    "CapabilityReport",
    "MIN_CAPABILITY_TRIALS",
    "TrialResult",
    "VERDICT_INCONCLUSIVE",
    "VERDICT_NEGATIVE",
    "VERDICT_SUPPORTED",
    "run_capability_trials",
]
