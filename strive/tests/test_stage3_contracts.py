"""Stage-3A contract spike tests (revised pass).

These prove the ADR wire shapes serialize, enforce their structural rules,
and represent the required scenarios — including the revision-pass fixes:
state/evidence separation, globally unambiguous revision refs, typed scopes
with mask-vs-delete semantics, computed risk, environment-generic task specs,
policy-neutral dispositions, and resumable algorithm state."""

from pathlib import Path

import pytest

from strive import codec
from strive.cas import ObjectStore
from strive.contracts import BudgetSpec, BudgetUsage
from strive.loop import run_cycle
from strive.stage3_contracts import (
    AlgorithmRun,
    AlgorithmStep,
    ContractViolation,
    DatasetRevision,
    EvaluationManifest,
    GLOBAL_SCOPE,
    HarnessManifest,
    HarnessRevision,
    ManifestEntry,
    ResolutionContext,
    RevisionRef,
    ScopeRef,
    SelectionDecision,
    SurfaceArtifact,
    SurfaceDelta,
    SURFACE_REGISTRY,
    TaskSpecVersion,
    ValidationBundle,
    ValidatorResult,
    effective_risk,
    resolve_artifact,
    revision_from_generation,
    validate_manifest,
    validate_revision,
    validate_scope,
    validate_selection,
)
from strive.store import Store
from strive.tasks import SUM_INTEGERS_TASK

TASK_SCOPE = ScopeRef("task", "sum-integers")
PROJECT_SCOPE = ScopeRef("project", "integers")


def _manifest_ref(objects: ObjectStore, entries: tuple[ManifestEntry, ...]) -> str:
    manifest = HarnessManifest(entries=entries)
    validate_manifest(manifest)
    return objects.put_text(codec.dumps(manifest))


# -- scenario 1: today's single strategy-code generation as a revision -----------


def test_existing_generation_maps_to_one_surface_revision(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts", SUM_INTEGERS_TASK.task_id)
    report = run_cycle(store, SUM_INTEGERS_TASK)
    assert report.decision is not None and report.decision.accepted

    active = store.active_generation()
    assert active is not None
    assert active.parent_id is not None
    parent = store.generation(active.parent_id)
    state_ref = _manifest_ref(
        store.objects,
        (ManifestEntry("strategy-code", "solve", active.source_ref),),
    )
    revision = revision_from_generation(active, parent, TASK_SCOPE, state_ref)
    validate_revision(revision)

    # before_ref is the parent's CONTENT ref, not a synthetic id string
    delta = revision.deltas[0]
    assert delta.before_ref == parent.source_ref
    assert delta.after_ref == active.source_ref
    assert delta.op == "update"
    # migration provenance is versioned like any proposer
    assert revision.proposer == "ledger-migration@1"
    # the revision owns state, not evaluation conditions
    assert revision.state_manifest_ref == state_ref
    decoded: HarnessRevision = codec.loads(codec.dumps(revision), HarnessRevision)
    assert decoded == revision


def test_generation_mapping_requires_consistent_parent(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts", SUM_INTEGERS_TASK.task_id)
    run_cycle(store, SUM_INTEGERS_TASK)
    seed = store.generation("gen-0000")
    evolved = store.generation("gen-0001")

    seed_rev = revision_from_generation(seed, None, TASK_SCOPE, "aa" * 32)
    assert seed_rev.base_parent is None and seed_rev.deltas[0].op == "create"

    with pytest.raises(ContractViolation, match="parent generation must be supplied"):
        revision_from_generation(evolved, None, TASK_SCOPE, "aa" * 32)
    with pytest.raises(ContractViolation, match="parent mismatch"):
        revision_from_generation(evolved, evolved, TASK_SCOPE, "aa" * 32)


# -- scenario 2: composite revision; computed (never trusted) risk -----------------


def _composite_revision(state_ref: str = "77" * 32) -> HarnessRevision:
    return HarnessRevision(
        ref=RevisionRef(TASK_SCOPE, "rev-0042"),
        base_parent=RevisionRef(TASK_SCOPE, "rev-0041"),
        provenance_parents=(RevisionRef(PROJECT_SCOPE, "rev-0007"),),
        deltas=(
            SurfaceDelta("update", "strategy-code", "solve", "aa" * 32, "bb" * 32),
            SurfaceDelta("update", "prompt", "proposal-template", "cc" * 32, "dd" * 32),
            SurfaceDelta("create", "policy-params", "retry-budget", None, "ee" * 32),
        ),
        state_manifest_ref=state_ref,
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


def test_risk_is_computed_from_descriptor_scope_and_op() -> None:
    # base risks at task scope
    assert effective_risk("strategy-code", TASK_SCOPE, "update") == "high"
    assert effective_risk("prompt", TASK_SCOPE, "update") == "medium"
    assert effective_risk("policy-params", TASK_SCOPE, "update") == "low"
    # broader scopes raise the stakes
    assert effective_risk("prompt", GLOBAL_SCOPE, "update") == "high"
    assert effective_risk("policy-params", PROJECT_SCOPE, "update") == "medium"
    # removals floor at medium
    assert effective_risk("policy-params", TASK_SCOPE, "delete") == "medium"
    assert effective_risk("policy-params", TASK_SCOPE, "mask") == "medium"
    with pytest.raises(ContractViolation, match="not in the trusted registry"):
        effective_risk("kernel-config", TASK_SCOPE, "update")
    # SurfaceDelta carries no risk field to trust
    assert not hasattr(
        SurfaceDelta("create", "prompt", "x", None, "aa" * 32), "risk_tier"
    )


def test_revision_structural_rules_are_enforced() -> None:
    base = _composite_revision()
    with pytest.raises(ContractViolation, match="not allowed at scope level"):
        validate_revision(  # strategy-code is task-scoped only
            HarnessRevision(
                RevisionRef(GLOBAL_SCOPE, "rev-1"), None, (),
                (SurfaceDelta("create", "strategy-code", "solve", None, "aa" * 32),),
                "ff" * 32, "p@1", "s", "t",
            )
        )
    with pytest.raises(ContractViolation, match="must have only after_ref"):
        validate_revision(
            HarnessRevision(
                RevisionRef(TASK_SCOPE, "rev-1"), None, (),
                (SurfaceDelta("create", "prompt", "x", "aa" * 32, "bb" * 32),),
                "ff" * 32, "p@1", "s", "t",
            )
        )
    with pytest.raises(ContractViolation, match="mask delta .* no content refs"):
        validate_revision(
            HarnessRevision(
                RevisionRef(TASK_SCOPE, "rev-1"), None, (),
                (SurfaceDelta("mask", "prompt", "x", "aa" * 32, None),),
                "ff" * 32, "p@1", "s", "t",
            )
        )
    with pytest.raises(ContractViolation, match="duplicate delta"):
        validate_revision(
            HarnessRevision(
                base.ref, base.base_parent, (),
                (base.deltas[1], base.deltas[1]),
                base.state_manifest_ref, "p@1", "s", "t",
            )
        )
    with pytest.raises(ContractViolation, match="must be versioned"):
        validate_revision(
            HarnessRevision(
                base.ref, base.base_parent, (), base.deltas,
                base.state_manifest_ref, "migrated", "s", "t",
            )
        )
    with pytest.raises(ContractViolation, match="state manifest"):
        validate_revision(
            HarnessRevision(
                base.ref, base.base_parent, (), base.deltas, "", "p@1", "s", "t"
            )
        )
    assert base.base_parent is not None
    with pytest.raises(ContractViolation, match="must not repeat"):
        validate_revision(
            HarnessRevision(
                base.ref, base.base_parent,
                (base.base_parent, *base.provenance_parents), base.deltas,
                base.state_manifest_ref, "p@1", "s", "t",
            )
        )
    with pytest.raises(ContractViolation, match="requires a name"):
        validate_revision(
            HarnessRevision(
                RevisionRef(ScopeRef("task", ""), "rev-1"), None, (), base.deltas,
                base.state_manifest_ref, "p@1", "s", "t",
            )
        )


def test_manifest_rejects_duplicate_artifact_keys() -> None:
    with pytest.raises(ContractViolation, match="duplicate .* artifact key"):
        validate_manifest(
            HarnessManifest(
                entries=(
                    ManifestEntry("prompt", "x", "aa" * 32),
                    ManifestEntry("prompt", "x", "bb" * 32),
                )
            )
        )


# -- scenario 2b: cross-scope lineage without collisions ---------------------------


def test_cross_scope_lineage_is_globally_unambiguous() -> None:
    """The same per-scope id can exist at two scopes; RevisionRef keeps
    lineage unambiguous, and base vs provenance parents are distinct."""
    task_rev = RevisionRef(TASK_SCOPE, "rev-0001")
    project_rev = RevisionRef(PROJECT_SCOPE, "rev-0001")  # same id, no collision
    assert task_rev != project_rev

    promotion = HarnessRevision(
        ref=RevisionRef(PROJECT_SCOPE, "rev-0002"),
        base_parent=project_rev,  # deltas apply to the project incumbent
        provenance_parents=(task_rev,),  # content originated in the task scope
        deltas=(
            SurfaceDelta("update", "prompt", "proposal-template", "aa" * 32, "bb" * 32),
        ),
        state_manifest_ref="cc" * 32,
        proposer="promotion@1",
        summary="task-proven prompt promoted to project scope",
        created_at="t",
    )
    validate_revision(promotion)
    decoded: HarnessRevision = codec.loads(codec.dumps(promotion), HarnessRevision)
    assert decoded.base_parent == project_rev
    assert decoded.provenance_parents == (task_rev,)


# -- scenario 3: typed scopes, shadowing, mask vs delete ----------------------------


def test_scope_refs_are_validated_and_context_is_explicit() -> None:
    validate_scope(GLOBAL_SCOPE)
    with pytest.raises(ContractViolation, match="requires a name"):
        validate_scope(ScopeRef("project", ""))
    with pytest.raises(ContractViolation, match="empty name"):
        validate_scope(ScopeRef("global", "oops"))
    with pytest.raises(ContractViolation, match="unknown scope level"):
        validate_scope(ScopeRef("tenant", "x"))

    # no implicit default project: a projectless task resolves task -> global
    assert ResolutionContext.build(task="sum-integers").chain == (
        TASK_SCOPE,
        GLOBAL_SCOPE,
    )
    with_project = ResolutionContext.build(task="sum-integers", project="integers")
    assert with_project.chain == (TASK_SCOPE, PROJECT_SCOPE, GLOBAL_SCOPE)
    with pytest.raises(ContractViolation, match="requires its task"):
        ResolutionContext.build(run="run-1")


def test_shadowing_with_mask_versus_delete_semantics() -> None:
    context = ResolutionContext.build(task="sum-integers", project="integers")
    project_prompt = SurfaceArtifact(
        "prompt", "proposal-template", PROJECT_SCOPE, "aa" * 32, "t1"
    )
    task_prompt = SurfaceArtifact(
        "prompt", "proposal-template", TASK_SCOPE, "bb" * 32, "t2"
    )

    # nearest-scope shadowing
    assert (
        resolve_artifact([project_prompt, task_prompt], "prompt", "proposal-template", context)
        is task_prompt
    )
    # delete = the task override is simply gone; inheritance resumes
    assert (
        resolve_artifact([project_prompt], "prompt", "proposal-template", context)
        is project_prompt
    )
    # mask = a present tombstone that stops fall-through: absent on purpose
    task_mask = SurfaceArtifact(
        "prompt", "proposal-template", TASK_SCOPE, "", "t3", masked=True
    )
    assert (
        resolve_artifact([project_prompt, task_mask], "prompt", "proposal-template", context)
        is None
    )
    # a different task is unaffected by the mask
    other = ResolutionContext.build(task="max-integers", project="integers")
    assert (
        resolve_artifact([project_prompt, task_mask], "prompt", "proposal-template", other)
        is project_prompt
    )


# -- scenario 4: state/evidence separation ------------------------------------------


def _evaluation_manifest(dataset_fingerprint: str, seeds: tuple[int, ...]) -> EvaluationManifest:
    return EvaluationManifest(
        harness_state_ref="77" * 32,
        objective_spec_ref="88" * 32,
        task_fingerprint="11" * 32,
        dataset_fingerprint=dataset_fingerprint,
        environment="function-task@1",
        scorer="exact-int-match@1",
        tool_versions={},
        runtime="cpython-3.12.10",
        seeds=seeds,
        validators=("selection-suite@1", "held-out@1"),
        budget=BudgetSpec(executions=8),
    )


def test_one_revision_evaluated_under_two_manifests(tmp_path: Path) -> None:
    """State/evidence separation: the revision owns its state manifest; each
    ValidationBundle pins its own evaluation manifest. Re-evaluating under a
    grown dataset (or more seeds) touches no revision field."""
    objects = ObjectStore(tmp_path / "objects")
    revision = _composite_revision()
    validate_revision(revision)

    manifest_v1 = _evaluation_manifest("22" * 32, seeds=(0,))
    manifest_v2 = _evaluation_manifest("33" * 32, seeds=(0, 1, 2))  # grown dataset
    ref_v1 = objects.put_text(codec.dumps(manifest_v1))
    ref_v2 = objects.put_text(codec.dumps(manifest_v2))
    assert ref_v1 != ref_v2

    bundles = [
        ValidationBundle(
            evaluation_manifest_ref=ref,
            subject=revision.ref,
            results=(
                ValidatorResult("selection-suite@1", "passed", {"overall": 1.0}, "ok"),
            ),
            feedback="all selection cases passed",
        )
        for ref in (ref_v1, ref_v2)
    ]
    assert bundles[0].subject == bundles[1].subject == revision.ref
    assert bundles[0].evaluation_manifest_ref != bundles[1].evaluation_manifest_ref
    for bundle in bundles:
        assert codec.loads(codec.dumps(bundle)) == bundle
    # and the recorded manifests reconstruct fully from CAS
    recovered: EvaluationManifest = codec.loads(objects.get_text(ref_v2), EvaluationManifest)
    assert recovered == manifest_v2


# -- ADR-0003: generic task specs and reconstructable datasets ----------------------


def test_task_spec_is_environment_generic_with_function_task_config(
    tmp_path: Path,
) -> None:
    objects = ObjectStore(tmp_path / "objects")
    # solve(str)->int details live in the FunctionTask config blob, not the spec
    config_ref = objects.put_text(
        '{"signature": "solve(input_text: str) -> int", "primitive_catalog": ["re"]}'
    )
    spec = TaskSpecVersion(
        task_id="sum-integers",
        version=3,
        description="sum signed integers",
        environment="function-task@1",
        action_schema="int@1",
        observation_schema="text@1",
        scorer="exact-int-match@1",
        config_ref=config_ref,
        fingerprint="11" * 32,
    )
    assert not hasattr(spec, "signature")
    assert codec.loads(codec.dumps(spec)) == spec


def test_dataset_revision_is_reconstructable_not_just_counted() -> None:
    dataset = DatasetRevision(
        dataset_id="sum-integers",
        revision=4,
        parent_revision=3,
        reason="regression: captured failing input from run-x",
        split_manifest_refs={
            "visible": "aa" * 32,
            "held_out": "bb" * 32,
            "regression": "cc" * 32,
            "audit": "dd" * 32,
        },
        split_counts={"visible": 6, "held_out": 3, "regression": 1, "audit": 2},
        fingerprint="22" * 32,
    )
    decoded: DatasetRevision = codec.loads(codec.dumps(dataset), DatasetRevision)
    assert decoded == dataset
    assert set(decoded.split_manifest_refs) == set(decoded.split_counts)


# -- ADR-0004: policy-neutral selection dispositions --------------------------------


def _decision(disposition: str, evidence: tuple[str, ...]) -> SelectionDecision:
    return SelectionDecision(
        policy_ref="paired-deterministic@1",
        objective_spec_ref="88" * 32,
        disposition=disposition,
        subject=RevisionRef(TASK_SCOPE, "rev-0042"),
        incumbent=RevisionRef(TASK_SCOPE, "rev-0041"),
        evidence_refs=evidence,
        rationale="r",
        at="t",
    )


def test_deterministic_and_frontier_dispositions_round_trip() -> None:
    promote = _decision("promote", ("44" * 32,))
    frontier = SelectionDecision(
        policy_ref="pareto-frontier@1",
        objective_spec_ref="88" * 32,
        disposition="frontier_add",  # joins the population without dethroning
        subject=RevisionRef(TASK_SCOPE, "rev-0043"),
        incumbent=None,
        evidence_refs=("55" * 32,),
        rationale="non-dominated on (visible, cost)",
        at="t",
    )
    for decision in (promote, frontier):
        validate_selection(decision)
        assert codec.loads(codec.dumps(decision)) == decision


def test_every_disposition_requires_evidence() -> None:
    for disposition in ("promote", "reject", "frontier_add", "provisional_activate"):
        validate_selection(_decision(disposition, ("aa" * 32,)))
        with pytest.raises(ContractViolation, match="requires evidence"):
            validate_selection(_decision(disposition, ()))


def test_selection_vocabulary_and_refs_are_enforced() -> None:
    with pytest.raises(ContractViolation, match="unknown disposition"):
        validate_selection(_decision("retain", ("aa" * 32,)))  # renamed away
    with pytest.raises(ContractViolation, match="must be versioned"):
        bad = SelectionDecision(
            "vibes", "88" * 32, "promote",
            RevisionRef(TASK_SCOPE, "r"), None, ("aa" * 32,), "r", "t",
        )
        validate_selection(bad)
    with pytest.raises(ContractViolation, match="objective spec"):
        bad = SelectionDecision(
            "p@1", "", "promote",
            RevisionRef(TASK_SCOPE, "r"), None, ("aa" * 32,), "r", "t",
        )
        validate_selection(bad)


# -- ADR-0005: resumable algorithm state ---------------------------------------------


def test_algorithm_run_and_steps_round_trip_for_resumability() -> None:
    run = AlgorithmRun(
        algorithm="pareto-population@1",
        run_id="alg-20260808-x",
        scope=TASK_SCOPE,
        budget=BudgetSpec(executions=64, model_calls=16),
        status="running",
        steps_completed=2,
    )
    steps = [
        AlgorithmStep(run.run_id, 0, "propose", "rev-0042", "mutated frontier parent",
                      BudgetUsage(model_calls=1, tokens=900)),
        AlgorithmStep(run.run_id, 1, "validate", "bundle:44" + "4" * 60, "selection suite",
                      BudgetUsage(executions=1)),
    ]
    assert codec.loads(codec.dumps(run)) == run
    for step in steps:
        assert codec.loads(codec.dumps(step)) == step
    # resumption cursor: the journaled step count, not in-memory state
    assert run.steps_completed == len(steps)
