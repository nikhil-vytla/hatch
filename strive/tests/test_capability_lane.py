"""Stage 3C.2B: the model-capability lane and secure-backend lifecycle
authority. Deno-gated (skip, never silently pass, without deno)."""

from __future__ import annotations

from pathlib import Path

import pytest

from strive.capability import (
    MIN_CAPABILITY_TRIALS,
    VERDICT_INCONCLUSIVE,
    run_capability_trials,
)
from strive.sandboxes import default_catalog
from strive.tasks import SUM_INTEGERS_TASK

_available, _reason = default_catalog().create("deno-pyodide@1").available()
requires_deno = pytest.mark.skipif(
    not _available, reason=f"deno-pyodide unavailable: {_reason}"
)


@requires_deno
def test_fixture_lane_runs_in_secure_backend_but_is_never_capability_evidence(
    tmp_path: Path,
) -> None:
    report = run_capability_trials(
        tmp_path / "cap", SUM_INTEGERS_TASK, trials=2, use_fixture=True
    )
    assert report.source == "fixture"
    assert report.sandbox_backend == "deno-pyodide@1"
    assert report.sandbox_secure is True
    assert report.n == 2
    # a fixture is a control, labeled inconclusive whatever the outcome
    assert report.verdict == VERDICT_INCONCLUSIVE
    assert "NOT capability evidence" in report.notes
    # every trial executed inside the secure backend
    assert all(t.sandbox_backend == "deno-pyodide@1" for t in report.trials)


@requires_deno
def test_single_trial_is_not_capability_evidence(tmp_path: Path) -> None:
    assert MIN_CAPABILITY_TRIALS >= 2
    report = run_capability_trials(
        tmp_path / "cap", SUM_INTEGERS_TASK, trials=1, use_fixture=True
    )
    assert report.n == 1 and report.verdict == VERDICT_INCONCLUSIVE


def test_reused_directory_is_refused(tmp_path: Path) -> None:
    root = tmp_path / "cap"
    root.mkdir()
    (root / "marker").write_text("x")
    with pytest.raises(RuntimeError, match="already contains a run"):
        run_capability_trials(root, SUM_INTEGERS_TASK, trials=2, use_fixture=True)


@requires_deno
def test_secure_backend_cycle_pins_sandbox_provenance_and_grants_authority(
    tmp_path: Path,
) -> None:
    """A run_cycle under a secure backend with model-generated code grants
    lifecycle authority (not generation-native only) and pins the sandbox
    provenance into the evidence manifest."""
    from strive import codec, lifecycle
    from strive.contracts import BudgetSpec
    from strive.diagnose import EvidenceDiagnoser
    from strive.evidence import EvaluationManifest, SelectionDecision, ValidationBundle
    from strive.fakemodel import prompt_sensitive_adapter
    from strive.loop import LoopConfig, run_cycle
    from strive.model_proposer import ModelProposer
    from strive.sandboxes import SandboxProvenance
    from strive.store import Store

    store = Store(tmp_path / "artifacts", SUM_INTEGERS_TASK.task_id)
    config = LoopConfig(
        proposer=ModelProposer(),
        diagnoser=EvidenceDiagnoser(),
        model_adapter=prompt_sensitive_adapter(),
        budget=BudgetSpec(model_calls=6, executions=24),
        unsafe_model_code=True,  # model-generated code...
        sandbox_backend="deno-pyodide@1",  # ...contained by a secure backend
    )
    report = run_cycle(store, SUM_INTEGERS_TASK, config)
    assert report.decision is not None and report.decision.accepted

    # lifecycle authority was GRANTED (not generation-native only): the
    # accepted candidate is the active revision
    active = lifecycle.active_revision_id(store)
    assert active is not None and active.startswith("rev-")

    # the promoting selection's task bundle pins a decodable SandboxProvenance
    # naming the secure backend
    st = lifecycle.state(store)
    link = next(
        l for l in reversed(st.evidence_links[active]) if l.kind == "selection"
    )
    envelope: SelectionDecision = codec.loads(
        store.objects.get_text(link.envelope_ref), SelectionDecision
    )
    saw_provenance = False
    for item in envelope.evidence:
        bundle: ValidationBundle = codec.loads(
            store.objects.get_text(item.bundle_ref), ValidationBundle
        )
        manifest: EvaluationManifest = codec.loads(
            store.objects.get_text(bundle.evaluation_manifest_ref), EvaluationManifest
        )
        if manifest.sandbox_provenance_ref:
            prov: SandboxProvenance = codec.loads(
                store.objects.get_text(manifest.sandbox_provenance_ref),
                SandboxProvenance,
            )
            assert prov.backend == "deno-pyodide@1"
            assert "network_denied" in prov.enforced_capabilities
            saw_provenance = True
    assert saw_provenance, "no bundle pinned the sandbox provenance"


@requires_deno
def test_trials_use_distinct_real_seeds_and_write_immutable_manifest(
    tmp_path: Path,
) -> None:
    import json

    root = tmp_path / "cap"
    report = run_capability_trials(
        root, SUM_INTEGERS_TASK, trials=3, seeds=(11, 22, 33), use_fixture=True
    )
    # the DISTINCT seeds were propagated (not a repeated seed-0)
    assert [t.seed for t in report.trials] == [11, 22, 33]
    assert all(t.seed_support == "deterministic-by-seed" for t in report.trials)
    # one immutable manifest pins the per-trial refs
    manifest_path = root / "manifest.json"
    assert manifest_path.exists() and report.manifest_path == str(manifest_path)
    data = json.loads(manifest_path.read_text())
    assert data["schema"] == "capability-report@1"
    assert len(data["trials"]) == 3
    for trial in data["trials"]:
        assert trial["prompt_refs"] and trial["completion_refs"]
    # the fixture control is inconclusive regardless of outcome
    assert report.verdict == VERDICT_INCONCLUSIVE


@requires_deno
def test_resume_reuses_completed_trials_without_duplicate_spend(
    tmp_path: Path,
) -> None:
    root = tmp_path / "cap"
    first = run_capability_trials(
        root, SUM_INTEGERS_TASK, trials=2, seeds=(1, 2), use_fixture=True
    )
    markers = sorted(root.glob("trial-*/trial.json"))
    assert len(markers) == 2
    stamps = {m: m.read_text() for m in markers}

    # resume with MORE trials: the first two are reused byte-for-byte (no
    # re-run / duplicate spend), only the third executes
    resumed = run_capability_trials(
        root, SUM_INTEGERS_TASK, trials=3, seeds=(1, 2, 3),
        use_fixture=True, resume=True,
    )
    assert resumed.n == 3
    assert [t.seed for t in resumed.trials] == [1, 2, 3]
    for marker, text in stamps.items():
        assert marker.read_text() == text  # untouched — reused, not re-run


def test_criterion_requires_more_than_one_success() -> None:
    """A lone clean acceptance among many trials never reads as `supported`:
    the interval lower bound stays at zero."""
    from strive.capability import (
        CapabilityCriterion,
        TrialResult,
        VERDICT_INCONCLUSIVE,
        VERDICT_SUPPORTED,
        _aggregate,
    )

    def trial(i: int, accepted: bool) -> TrialResult:
        return TrialResult(
            trial=i, seed=i, source="real", model_id="m",
            seed_support="sent-honored-unverified", proposal_valid=True,
            accepted=accepted, regressions=0, failure_kind=None, model_calls=1,
            tokens=0, latency_ms=None, sandbox_backend="deno-pyodide@1",
            run_id=f"r{i}",
        )

    crit = CapabilityCriterion(min_trials=2, min_clean_rate=0.5)
    one_of_eight = _aggregate(
        SUM_INTEGERS_TASK, "real", "m", "deno-pyodide@1", True, crit,
        tuple([trial(0, True)] + [trial(i, False) for i in range(1, 8)]),
    )
    assert one_of_eight.verdict == VERDICT_INCONCLUSIVE
    all_clean = _aggregate(
        SUM_INTEGERS_TASK, "real", "m", "deno-pyodide@1", True, crit,
        tuple(trial(i, True) for i in range(6)),
    )
    assert all_clean.verdict == VERDICT_SUPPORTED
