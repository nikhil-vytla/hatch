"""Stage-3A contract spike: round-trip and structural-rule tests for the ADR
designs. These contracts are experimental — unused by the live loop — and
these tests exist to prove the shapes serialize, validate, and represent the
four required scenarios before Stage 3B implements them for real."""

from pathlib import Path

import pytest

from strive import codec
from strive.contracts import BudgetSpec
from strive.loop import run_cycle
from strive.stage3_contracts import (
    ContractViolation,
    DatasetRevision,
    EvaluationManifest,
    HarnessRevision,
    SelectionDecision,
    SurfaceArtifact,
    SurfaceDelta,
    SURFACE_REGISTRY,
    TaskSpecVersion,
    ValidationBundle,
    ValidatorResult,
    resolve_artifact,
    revision_from_generation,
    scope_chain,
    validate_revision,
    validate_selection,
)
from strive.store import Store
from strive.tasks import SUM_INTEGERS_TASK


# -- scenario 1: today's single strategy-code generation as a revision -----------


def test_existing_generation_maps_to_one_surface_revision(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts", SUM_INTEGERS_TASK.task_id)
    report = run_cycle(store, SUM_INTEGERS_TASK)
    assert report.decision is not None and report.decision.accepted

    active = store.active_generation()
    assert active is not None
    revision = revision_from_generation(active, scope="task:sum-integers")
    validate_revision(revision)

    assert revision.parent_ids == ("rev-0000",)
    assert len(revision.deltas) == 1
    delta = revision.deltas[0]
    assert delta.kind == "strategy-code" and delta.op == "update"
    assert delta.after_ref == active.source_ref
    assert delta.risk_tier == "high"

    decoded: HarnessRevision = codec.loads(codec.dumps(revision), HarnessRevision)
    assert decoded == revision


def test_seed_generation_maps_to_create_delta(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts", SUM_INTEGERS_TASK.task_id)
    run_cycle(store, SUM_INTEGERS_TASK)
    seed = store.generation("gen-0000")
    revision = revision_from_generation(seed, scope="task:sum-integers")
    validate_revision(revision)
    assert revision.parent_ids == ()
    assert revision.deltas[0].op == "create"
    assert revision.deltas[0].before_ref is None


# -- scenario 2: hypothetical composite code + prompt + policy revision -----------


def _composite_revision() -> HarnessRevision:
    return HarnessRevision(
        revision_id="rev-0042",
        scope="task:sum-integers",
        parent_ids=("rev-0041",),
        deltas=(
            SurfaceDelta("update", "strategy-code", "solve", "aa" * 32, "bb" * 32, "high"),
            SurfaceDelta("update", "prompt", "proposal-template", "cc" * 32, "dd" * 32, "medium"),
            SurfaceDelta("create", "policy-params", "retry-budget", None, "ee" * 32, "low"),
        ),
        manifest_ref="ff" * 32,
        proposer="model@1",
        summary="joint code+prompt+policy candidate",
        created_at="2026-08-08T00:00:00+00:00",
    )


def test_composite_revision_validates_and_round_trips() -> None:
    revision = _composite_revision()
    validate_revision(revision)
    assert {d.kind for d in revision.deltas} == set(SURFACE_REGISTRY)
    decoded: HarnessRevision = codec.loads(codec.dumps(revision), HarnessRevision)
    assert decoded == revision


def test_revision_structural_rules_are_enforced() -> None:
    base = _composite_revision()
    with pytest.raises(ContractViolation, match="not in the trusted registry"):
        validate_revision(
            HarnessRevision(
                "rev-x", "global", (),
                (SurfaceDelta("create", "kernel-config", "x", None, "aa" * 32, "high"),),
                None, "p", "s", "t",
            )
        )
    with pytest.raises(ContractViolation, match="must have only after_ref"):
        validate_revision(
            HarnessRevision(
                "rev-x", "global", (),
                (SurfaceDelta("create", "prompt", "x", "aa" * 32, "bb" * 32, "medium"),),
                None, "p", "s", "t",
            )
        )
    with pytest.raises(ContractViolation, match="duplicate delta"):
        validate_revision(
            HarnessRevision(
                "rev-x", base.scope, base.parent_ids,
                (base.deltas[0], base.deltas[0]),
                None, "p", "s", "t",
            )
        )
    with pytest.raises(ContractViolation, match="at least one delta"):
        validate_revision(
            HarnessRevision("rev-x", "global", (), (), None, "p", "s", "t")
        )


# -- scenario 3: task-local vs project-scoped artifacts with shadowing -------------


def test_scope_chain_and_nearest_scope_shadowing() -> None:
    assert scope_chain("task:sum-integers") == (
        "task:sum-integers",
        "project:default",
        "global",
    )
    assert scope_chain("project:default") == ("project:default", "global")
    assert scope_chain("global") == ("global",)

    project_prompt = SurfaceArtifact(
        "prompt", "proposal-template", "project:default", "aa" * 32, "t1"
    )
    task_prompt = SurfaceArtifact(
        "prompt", "proposal-template", "task:sum-integers", "bb" * 32, "t2"
    )
    global_policy = SurfaceArtifact(
        "policy-params", "retry-budget", "global", "cc" * 32, "t0"
    )
    artifacts = [project_prompt, task_prompt, global_policy]
    chain = scope_chain("task:sum-integers")

    # the task-local prompt shadows the project one
    hit = resolve_artifact(artifacts, "prompt", "proposal-template", chain)
    assert hit is task_prompt
    # with no narrow shadow, resolution falls through to broader scopes
    assert resolve_artifact(artifacts, "policy-params", "retry-budget", chain) is global_policy
    # another task inherits the project prompt, not the sum-integers shadow
    other_chain = scope_chain("task:max-integers")
    assert resolve_artifact(artifacts, "prompt", "proposal-template", other_chain) is project_prompt
    assert resolve_artifact(artifacts, "prompt", "missing", chain) is None


def test_run_scope_requires_explicit_task_chain() -> None:
    with pytest.raises(ContractViolation, match="run scopes resolve"):
        scope_chain("run:run-20260808-abc")


# -- scenario 4: deterministic and Pareto-style selection outcomes -----------------


def _manifest() -> EvaluationManifest:
    return EvaluationManifest(
        task_fingerprint="11" * 32,
        dataset_fingerprint="22" * 32,
        seeds=(0, 1, 2),
        environment="function-task@1",
        validators=("selection-suite@1", "held-out@1"),
        budget=BudgetSpec(executions=8),
    )


def test_task_spec_dataset_and_manifest_round_trip() -> None:
    spec = TaskSpecVersion(
        task_id="sum-integers",
        version=3,
        description="sum signed integers",
        signature="solve(input_text: str) -> int",
        primitive_catalog=("re",),
        fingerprint="11" * 32,
    )
    dataset = DatasetRevision(
        dataset_id="sum-integers",
        revision=4,
        split_counts={"visible": 6, "held_out": 3, "regression": 1, "audit": 2},
        fingerprint="22" * 32,
        parent_revision=3,
        reason="regression: captured failing input from run-x",
    )
    for obj in (spec, dataset, _manifest()):
        assert codec.loads(codec.dumps(obj)) == obj


def test_deterministic_selection_decision_round_trips() -> None:
    bundle = ValidationBundle(
        manifest_ref="33" * 32,
        subject_revision_id="rev-0042",
        results=(
            ValidatorResult(
                validator="selection-suite@1",
                status="passed",
                metrics={"visible": 1.0, "held_out": 1.0, "overall": 1.0},
                detail="all selection cases passed",
            ),
        ),
        feedback="strict improvement, zero regressions",
    )
    decision = SelectionDecision(
        policy="paired-deterministic",
        policy_version=1,
        kind="paired-deterministic",
        verdict="promote",
        subject_revision_id="rev-0042",
        incumbent_revision_id="rev-0041",
        evidence_refs=("44" * 32,),
        rationale="candidate strictly improves with zero regressions",
        at="2026-08-08T00:00:00+00:00",
    )
    validate_selection(decision)
    assert codec.loads(codec.dumps(bundle)) == bundle
    assert codec.loads(codec.dumps(decision)) == decision


def test_pareto_retention_decision_round_trips() -> None:
    decision = SelectionDecision(
        policy="pareto-frontier",
        policy_version=1,
        kind="pareto-retention",
        verdict="retain",  # joins the frontier without dethroning the incumbent
        subject_revision_id="rev-0043",
        incumbent_revision_id=None,
        evidence_refs=("55" * 32,),
        rationale="non-dominated on (visible, cost); retained in population",
        at="2026-08-08T00:00:00+00:00",
    )
    validate_selection(decision)
    decoded: SelectionDecision = codec.loads(codec.dumps(decision), SelectionDecision)
    assert decoded == decision


def test_selection_vocabularies_are_closed_and_promote_needs_evidence() -> None:
    good = SelectionDecision(
        "p", 1, "stochastic", "reject", "rev-1", "rev-0", (), "worse on trials", "t"
    )
    validate_selection(good)  # reject without evidence refs is representable
    with pytest.raises(ContractViolation, match="unknown decision kind"):
        validate_selection(
            SelectionDecision("p", 1, "vibes", "promote", "r", None, ("x",), "r", "t")
        )
    with pytest.raises(ContractViolation, match="unknown verdict"):
        validate_selection(
            SelectionDecision("p", 1, "stochastic", "ship-it", "r", None, ("x",), "r", "t")
        )
    with pytest.raises(ContractViolation, match="requires evidence"):
        validate_selection(
            SelectionDecision("p", 1, "stochastic", "promote", "r", None, (), "r", "t")
        )
