"""Stage 3C.2B: the model-capability lane and secure-backend lifecycle
authority. Deno-gated (skip, never silently pass, without deno)."""

from __future__ import annotations

from pathlib import Path

import pytest

import strive.sandbox_backends  # noqa: F401 — registers backends
from strive.capability import (
    MIN_CAPABILITY_TRIALS,
    VERDICT_INCONCLUSIVE,
    run_capability_trials,
)
from strive.sandboxes import get_backend
from strive.tasks import SUM_INTEGERS_TASK

_available, _reason = get_backend("deno-pyodide@1", require_available=False).available()
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
