"""Stage-3A contract spike tests, final pre-merge form.

Covers the frozen core wire types (scopes, refs, binding transitions, scope
vs resolved manifests, revisions) and the provisional envelopes, including:
state/evidence separation with one revision evaluated under two manifests,
cross-scope lineage without collisions, binding-transition labels/inversion/
conflict checks, descriptor_ref pinning, non-uniform policy-params risk, and
canonical-ordering/self-reference rejections."""

from pathlib import Path

import pytest

from strive import codec
from strive.cas import ObjectStore
from strive.contracts import BudgetSpec, BudgetUsage
from strive.loop import run_cycle
from strive.stage3_contracts import (
    ABSENT,
    AlgorithmRun,
    AlgorithmStep,
    BindingState,
    ContractViolation,
    DatasetRevision,
    EvaluationManifest,
    GLOBAL_SCOPE,
    HarnessRevision,
    MASKED,
    ManifestBinding,
    ResolutionContext,
    ResolvedHarnessManifest,
    RevisionRef,
    ScopeContribution,
    ScopeManifest,
    ScopeRef,
    CURRENT_DESCRIPTOR,
    DESCRIPTOR_REGISTRY,
    JournalHeadRef,
    MigrationProvenance,
    RevisionActivation,
    SelectionDecision,
    SurfaceDelta,
    TaskSpecVersion,
    ValidationBundle,
    ValidatorResult,
    check_delta_applies,
    content_binding,
    delta_label,
    effective_risk,
    invert_delta,
    resolve_bindings,
    revision_activation_from_activation,
    revision_from_generation,
    validate_binding,
    validate_revision_activation,
    validate_resolved_manifest,
    validate_revision,
    validate_scope,
    validate_scope_manifest,
    validate_selection,
)
from strive.store import Store
from strive.tasks import SUM_INTEGERS_TASK

TASK_SCOPE = ScopeRef("task", "sum-integers")
PROJECT_SCOPE = ScopeRef("project", "integers")


# -- frozen core: binding transitions ------------------------------------------------


def test_binding_states_are_complete_and_validated() -> None:
    code = content_binding("strategy-code", "aa" * 32)
    assert code.descriptor_ref == "strategy-code@1"  # pinned from the registry
    validate_binding(code, "strategy-code")
    validate_binding(ABSENT, "prompt")
    validate_binding(MASKED, "prompt")
    with pytest.raises(ContractViolation, match="requires both content_ref"):
        validate_binding(BindingState("content", "aa" * 32, None), "prompt")
    with pytest.raises(ContractViolation, match="not in the trusted registry"):
        validate_binding(BindingState("content", "aa" * 32, "prompt@9"), "prompt")
    with pytest.raises(ContractViolation, match="does not describe"):
        validate_binding(
            BindingState("content", "aa" * 32, "strategy-code@1"), "prompt"
        )
    with pytest.raises(ContractViolation, match="must carry no content"):
        validate_binding(BindingState("absent", "aa" * 32, None), "prompt")
    with pytest.raises(ContractViolation, match="unknown binding state"):
        validate_binding(BindingState("pending"), "prompt")


def test_delta_labels_are_derived_from_transitions() -> None:
    old = content_binding("prompt", "aa" * 32)
    new = content_binding("prompt", "bb" * 32)
    assert delta_label(SurfaceDelta("prompt", "x", ABSENT, new)) == "create"
    assert delta_label(SurfaceDelta("prompt", "x", old, new)) == "update"
    assert delta_label(SurfaceDelta("prompt", "x", old, ABSENT)) == "delete"
    assert delta_label(SurfaceDelta("prompt", "x", old, MASKED)) == "mask"
    # unmasking is representable in both directions
    assert delta_label(SurfaceDelta("prompt", "x", MASKED, ABSENT)) == "unmask"
    assert delta_label(SurfaceDelta("prompt", "x", MASKED, new)) == "unmask"
    with pytest.raises(ContractViolation, match="no-op"):
        delta_label(SurfaceDelta("prompt", "x", old, old))


def test_delta_inversion_is_exact_and_conflicts_are_checkable() -> None:
    old = content_binding("prompt", "aa" * 32)
    new = content_binding("prompt", "bb" * 32)
    delta = SurfaceDelta("prompt", "x", old, new)
    inverse = invert_delta(delta)
    assert inverse.before == new and inverse.after == old
    assert invert_delta(inverse) == delta  # exact round trip
    assert delta_label(inverse) == "update"

    check_delta_applies(delta, old)  # applies to exactly the recorded state
    with pytest.raises(ContractViolation, match="expected binding"):
        check_delta_applies(delta, new)  # someone changed it underneath
    with pytest.raises(ContractViolation, match="expected binding"):
        check_delta_applies(delta, ABSENT)


# -- frozen core: descriptors and computed risk ---------------------------------------


def _delta(kind: str, name: str, before: BindingState, after: BindingState) -> SurfaceDelta:
    return SurfaceDelta(kind, name, before, after)


def test_risk_is_derived_from_the_delta_itself() -> None:
    """Callers cannot supply a transition label — risk evaluation reads the
    delta's own before/after states, so a proposal has nothing to spoof."""
    old = content_binding("prompt", "aa" * 32)
    new = content_binding("prompt", "bb" * 32)
    assert effective_risk(_delta("prompt", "tmpl", old, new), TASK_SCOPE) == "medium"
    assert effective_risk(_delta("prompt", "tmpl", old, new), GLOBAL_SCOPE) == "high"
    # a removal is floored at medium because the delta SAYS it is a removal —
    # there is no label argument through which to claim otherwise
    assert effective_risk(_delta("prompt", "tmpl", old, MASKED), TASK_SCOPE) == "medium"
    assert effective_risk(_delta("prompt", "tmpl", old, ABSENT), TASK_SCOPE) == "medium"
    code = _delta(
        "strategy-code", "solve",
        content_binding("strategy-code", "aa" * 32),
        content_binding("strategy-code", "bb" * 32),
    )
    assert effective_risk(code, TASK_SCOPE) == "high"
    with pytest.raises(ContractViolation, match="not in the trusted registry"):
        effective_risk(_delta("kernel-config", "x", ABSENT, MASKED), TASK_SCOPE)


def test_policy_params_fail_closed_and_bar_trusted_settings() -> None:
    """Unknown families are rejected (never defaulted low); trusted kernel
    settings are not representable as evolvable policy-params at all."""
    def params(name: str) -> SurfaceDelta:
        return _delta(
            "policy-params", name, ABSENT, content_binding("policy-params", "ee" * 32)
        )
    # reviewed agent-behavior families, tiered, inside trusted caps
    assert effective_risk(params("retry.max_attempts"), TASK_SCOPE) == "medium"
    assert effective_risk(params("search.beam_width"), TASK_SCOPE) == "medium"
    assert effective_risk(params("display.verbosity"), TASK_SCOPE) == "low"
    assert effective_risk(params("display.verbosity"), PROJECT_SCOPE) == "medium"
    # trusted settings: not evolvable at any risk level
    for forbidden in (
        "sandbox.timeout", "budget.model_calls", "evaluator.threshold",
        "acceptance.bar", "secrets.token", "ledger.path",
    ):
        with pytest.raises(ContractViolation, match="trusted kernel setting"):
            effective_risk(params(forbidden), TASK_SCOPE)
        with pytest.raises(ContractViolation, match="trusted kernel setting"):
            validate_delta_for_test(params(forbidden))
    # unknown families: fail closed, no low-risk default
    with pytest.raises(ContractViolation, match="fail-closed"):
        effective_risk(params("mystery.knob"), TASK_SCOPE)
    with pytest.raises(ContractViolation, match="fail-closed"):
        validate_delta_for_test(params("mystery.knob"))


def validate_delta_for_test(delta: SurfaceDelta) -> None:
    from strive.stage3_contracts import validate_delta

    validate_delta(delta, TASK_SCOPE)


def test_descriptor_registry_is_historical_with_a_current_pointer() -> None:
    for ref, descriptor in DESCRIPTOR_REGISTRY.items():
        assert ref == descriptor.descriptor_ref
        assert "@" in descriptor.validation_policy
        assert "@" in descriptor.risk_policy_ref
        assert "@" in descriptor.materializer
    for kind, current_ref in CURRENT_DESCRIPTOR.items():
        assert DESCRIPTOR_REGISTRY[current_ref].kind == kind


def test_historical_binding_stays_valid_after_new_descriptor_version() -> None:
    """prompt@2 is current, but a binding pinned to prompt@1 validates against
    its exact pinned descriptor — history does not rot on registry upgrades."""
    assert CURRENT_DESCRIPTOR["prompt"] == "prompt@2"
    historical = content_binding("prompt", "aa" * 32, descriptor_ref="prompt@1")
    assert historical.descriptor_ref == "prompt@1"
    validate_binding(historical, "prompt")  # resolves the pinned version
    fresh = content_binding("prompt", "bb" * 32)
    assert fresh.descriptor_ref == "prompt@2"  # default is the current pointer
    with pytest.raises(ContractViolation, match="not in the trusted registry"):
        content_binding("prompt", "cc" * 32, descriptor_ref="prompt@9")
    with pytest.raises(ContractViolation, match="does not describe kind"):
        content_binding("prompt", "cc" * 32, descriptor_ref="strategy-code@1")


# -- frozen core: scope manifests vs resolved manifests -------------------------------


def _scope_manifest(scope: ScopeRef, *bindings: ManifestBinding) -> ScopeManifest:
    manifest = ScopeManifest(scope=scope, bindings=tuple(bindings))
    validate_scope_manifest(manifest)
    return manifest


def test_scope_manifest_enforces_canonical_order_and_no_absent() -> None:
    prompt = ManifestBinding("prompt", "tmpl", content_binding("prompt", "aa" * 32))
    params = ManifestBinding("policy-params", "retry.max", content_binding("policy-params", "bb" * 32))
    _scope_manifest(TASK_SCOPE, params, prompt)  # canonical: policy-params < prompt
    with pytest.raises(ContractViolation, match="canonical"):
        validate_scope_manifest(ScopeManifest(TASK_SCOPE, (prompt, params)))
    with pytest.raises(ContractViolation, match="duplicate"):
        validate_scope_manifest(ScopeManifest(TASK_SCOPE, (prompt, prompt)))
    with pytest.raises(ContractViolation, match="absent bindings"):
        validate_scope_manifest(
            ScopeManifest(TASK_SCOPE, (ManifestBinding("prompt", "x", ABSENT),))
        )


def test_resolution_produces_a_run_resolved_manifest_distinct_from_scope_state() -> None:
    context = ResolutionContext.build(task="sum-integers", project="integers")
    project_manifest = _scope_manifest(
        PROJECT_SCOPE,
        ManifestBinding("policy-params", "retry.max", content_binding("policy-params", "cc" * 32)),
        ManifestBinding("prompt", "tmpl", content_binding("prompt", "aa" * 32)),
    )
    task_manifest = _scope_manifest(
        TASK_SCOPE,
        ManifestBinding("prompt", "tmpl", content_binding("prompt", "bb" * 32)),
        ManifestBinding("strategy-code", "solve", content_binding("strategy-code", "dd" * 32)),
    )

    effective = resolve_bindings([task_manifest, project_manifest], context)
    resolved = ResolvedHarnessManifest(
        resolution_chain=context.chain,
        contributions=(
            ScopeContribution(
                TASK_SCOPE, RevisionRef(TASK_SCOPE, "rev-0003"),
                JournalHeadRef("jsonl@1", "41"),
            ),
            ScopeContribution(
                PROJECT_SCOPE, RevisionRef(PROJECT_SCOPE, "rev-0001"),
                JournalHeadRef("jsonl@1", "7"),
            ),
        ),
        effective=effective,
    )
    validate_resolved_manifest(resolved)
    by_key = {(b.kind, b.name): b.binding.content_ref for b in resolved.effective}
    assert by_key[("prompt", "tmpl")] == "bb" * 32  # task shadows project
    assert by_key[("policy-params", "retry.max")] == "cc" * 32  # inherited
    assert by_key[("strategy-code", "solve")] == "dd" * 32
    assert codec.loads(codec.dumps(resolved)) == resolved


def test_mask_stops_fall_through_in_resolution() -> None:
    context = ResolutionContext.build(task="sum-integers", project="integers")
    project_manifest = _scope_manifest(
        PROJECT_SCOPE,
        ManifestBinding("prompt", "tmpl", content_binding("prompt", "aa" * 32)),
    )
    masking_task_manifest = _scope_manifest(
        TASK_SCOPE, ManifestBinding("prompt", "tmpl", MASKED)
    )
    assert resolve_bindings([masking_task_manifest, project_manifest], context) == ()
    # delete = no binding at task scope at all: inheritance resumes
    assert resolve_bindings([project_manifest], context)[0].binding.content_ref == "aa" * 32
    # resolved manifests refuse non-content effective bindings
    with pytest.raises(ContractViolation, match="content bindings only"):
        validate_resolved_manifest(
            ResolvedHarnessManifest(
                resolution_chain=context.chain,
                contributions=(),
                effective=(ManifestBinding("prompt", "tmpl", MASKED),),
            )
        )
    # duplicate manifests for one scope are rejected during resolution
    with pytest.raises(ContractViolation, match="duplicate scope manifest"):
        resolve_bindings([project_manifest, project_manifest], context)


def test_resolved_manifest_contribution_invariants() -> None:
    context = ResolutionContext.build(task="sum-integers", project="integers")
    head = JournalHeadRef("jsonl@1", "1")
    ok = ScopeContribution(TASK_SCOPE, RevisionRef(TASK_SCOPE, "rev-1"), head)
    project = ScopeContribution(PROJECT_SCOPE, RevisionRef(PROJECT_SCOPE, "rev-1"), head)

    def resolved(
        *contributions: ScopeContribution,
        chain: tuple[ScopeRef, ...] = context.chain,
    ) -> ResolvedHarnessManifest:
        return ResolvedHarnessManifest(
            resolution_chain=chain, contributions=contributions, effective=()
        )

    validate_resolved_manifest(resolved(ok, project))  # chain order: task, project
    with pytest.raises(ContractViolation, match="must record its resolution chain"):
        validate_resolved_manifest(resolved(chain=()))
    with pytest.raises(ContractViolation, match="chain-order|chain order"):
        validate_resolved_manifest(resolved(project, ok))
    with pytest.raises(ContractViolation, match="duplicate contribution"):
        validate_resolved_manifest(resolved(ok, ok))
    with pytest.raises(ContractViolation, match="is not in the"):
        validate_resolved_manifest(
            resolved(ScopeContribution(ScopeRef("task", "other"),
                                       RevisionRef(ScopeRef("task", "other"), "r"), head))
        )
    with pytest.raises(ContractViolation, match="belong to the contributing scope"):
        validate_resolved_manifest(
            resolved(ScopeContribution(TASK_SCOPE, RevisionRef(PROJECT_SCOPE, "r"), head))
        )
    with pytest.raises(ContractViolation, match="must not repeat scopes"):
        validate_resolved_manifest(
            ResolvedHarnessManifest(
                resolution_chain=(TASK_SCOPE, TASK_SCOPE),
                contributions=(), effective=(),
            )
        )


def test_scope_manifest_rejects_disallowed_kinds_for_content_and_masks() -> None:
    # strategy-code is task-only: content AND masks are rejected at project scope
    with pytest.raises(ContractViolation, match="not allowed at scope level"):
        validate_scope_manifest(
            ScopeManifest(
                PROJECT_SCOPE,
                (ManifestBinding(
                    "strategy-code", "solve",
                    content_binding("strategy-code", "aa" * 32),
                ),),
            )
        )
    with pytest.raises(ContractViolation, match="not allowed at scope level"):
        validate_scope_manifest(
            ScopeManifest(
                PROJECT_SCOPE, (ManifestBinding("strategy-code", "solve", MASKED),)
            )
        )
    with pytest.raises(ContractViolation, match="not in the trusted registry"):
        validate_scope_manifest(
            ScopeManifest(TASK_SCOPE, (ManifestBinding("kernel-config", "x", MASKED),))
        )


# -- frozen core: revisions -----------------------------------------------------------


def _composite_revision() -> HarnessRevision:
    return HarnessRevision(
        ref=RevisionRef(TASK_SCOPE, "rev-0042"),
        base_parent=RevisionRef(TASK_SCOPE, "rev-0041"),
        provenance_parents=(RevisionRef(PROJECT_SCOPE, "rev-0007"),),
        deltas=(  # canonical (kind, name) order
            SurfaceDelta(
                "policy-params", "retry.max",
                ABSENT, content_binding("policy-params", "ee" * 32),
            ),
            SurfaceDelta(
                "prompt", "proposal-template",
                content_binding("prompt", "cc" * 32), content_binding("prompt", "dd" * 32),
            ),
            SurfaceDelta(
                "strategy-code", "solve",
                content_binding("strategy-code", "aa" * 32),
                content_binding("strategy-code", "bb" * 32),
            ),
        ),
        scope_manifest_ref="77" * 32,
        proposer="model@1",
        summary="joint code+prompt+policy candidate",
        created_at="2026-08-08T00:00:00+00:00",
        proposal_ref="99" * 32,
        provenance_ref=None,
    )


def test_composite_revision_validates_and_round_trips() -> None:
    revision = _composite_revision()
    validate_revision(revision)
    assert {d.kind for d in revision.deltas} == set(CURRENT_DESCRIPTOR)
    assert revision.proposal_ref is not None  # optional provenance pointers exist
    decoded: HarnessRevision = codec.loads(codec.dumps(revision), HarnessRevision)
    assert decoded == revision


def test_revision_structural_rules_are_enforced() -> None:
    base = _composite_revision()

    def rebuild(**overrides: object) -> HarnessRevision:
        import dataclasses

        return dataclasses.replace(base, **overrides)  # type: ignore[arg-type]

    with pytest.raises(ContractViolation, match="not allowed at scope level"):
        validate_revision(
            rebuild(
                ref=RevisionRef(GLOBAL_SCOPE, "rev-1"), base_parent=None,
                provenance_parents=(),
                deltas=(SurfaceDelta(
                    "strategy-code", "solve", ABSENT,
                    content_binding("strategy-code", "aa" * 32),
                ),),
            )
        )
    with pytest.raises(ContractViolation, match="canonical"):
        validate_revision(rebuild(deltas=tuple(reversed(base.deltas))))
    with pytest.raises(ContractViolation, match="duplicate delta"):
        validate_revision(rebuild(deltas=(base.deltas[0], base.deltas[0])))
    with pytest.raises(ContractViolation, match="own base parent"):
        validate_revision(rebuild(base_parent=base.ref))
    with pytest.raises(ContractViolation, match="own provenance parent"):
        validate_revision(rebuild(provenance_parents=(base.ref,)))
    with pytest.raises(ContractViolation, match="belong in provenance_parents"):
        validate_revision(  # cross-scope base parent is not lineage, it's origin
            rebuild(base_parent=RevisionRef(PROJECT_SCOPE, "rev-0007"),
                    provenance_parents=())
        )
    assert base.base_parent is not None
    with pytest.raises(ContractViolation, match="must not repeat"):
        validate_revision(rebuild(provenance_parents=(base.base_parent,)))
    with pytest.raises(ContractViolation, match="duplicate provenance"):
        validate_revision(
            rebuild(provenance_parents=base.provenance_parents * 2)
        )
    with pytest.raises(ContractViolation, match="must be versioned"):
        validate_revision(rebuild(proposer="migrated"))
    with pytest.raises(ContractViolation, match="scope manifest"):
        validate_revision(rebuild(scope_manifest_ref=""))
    with pytest.raises(ContractViolation, match="at least one delta"):
        validate_revision(rebuild(deltas=()))


def test_cross_scope_lineage_is_globally_unambiguous() -> None:
    task_rev = RevisionRef(TASK_SCOPE, "rev-0001")
    project_rev = RevisionRef(PROJECT_SCOPE, "rev-0001")  # same id, no collision
    assert task_rev != project_rev
    promotion = HarnessRevision(
        ref=RevisionRef(PROJECT_SCOPE, "rev-0002"),
        base_parent=project_rev,
        provenance_parents=(task_rev,),
        deltas=(
            SurfaceDelta(
                "prompt", "proposal-template",
                content_binding("prompt", "aa" * 32), content_binding("prompt", "bb" * 32),
            ),
        ),
        scope_manifest_ref="cc" * 32,
        proposer="promotion@1",
        summary="task-proven prompt promoted to project scope",
        created_at="t",
    )
    validate_revision(promotion)
    decoded: HarnessRevision = codec.loads(codec.dumps(promotion), HarnessRevision)
    assert decoded.base_parent == project_rev
    assert decoded.provenance_parents == (task_rev,)


def test_existing_generation_maps_to_one_surface_revision(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts", SUM_INTEGERS_TASK.task_id)
    report = run_cycle(store, SUM_INTEGERS_TASK)
    assert report.decision is not None and report.decision.accepted

    active = store.active_generation()
    assert active is not None and active.parent_id is not None
    parent = store.generation(active.parent_id)
    scope_manifest = ScopeManifest(
        scope=TASK_SCOPE,
        bindings=(
            ManifestBinding(
                "strategy-code", "solve", content_binding("strategy-code", active.source_ref)
            ),
        ),
    )
    validate_scope_manifest(scope_manifest)
    manifest_ref = store.objects.put_text(codec.dumps(scope_manifest))

    revision = revision_from_generation(active, parent, TASK_SCOPE, manifest_ref)
    validate_revision(revision)
    delta = revision.deltas[0]
    assert delta.before.content_ref == parent.source_ref  # parent CONTENT ref
    assert delta.before.descriptor_ref == "strategy-code@1"  # pinned
    assert delta.after.content_ref == active.source_ref
    assert delta_label(delta) == "update"
    assert revision.proposer == "ledger-migration@1"
    # exact inversion of the migration delta is the rollback delta
    rollback = invert_delta(delta)
    assert rollback.after.content_ref == parent.source_ref


def test_generation_mapping_requires_consistent_parent(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts", SUM_INTEGERS_TASK.task_id)
    run_cycle(store, SUM_INTEGERS_TASK)
    seed = store.generation("gen-0000")
    evolved = store.generation("gen-0001")
    seed_rev = revision_from_generation(seed, None, TASK_SCOPE, "aa" * 32)
    assert seed_rev.base_parent is None
    assert delta_label(seed_rev.deltas[0]) == "create"
    with pytest.raises(ContractViolation, match="parent generation must be supplied"):
        revision_from_generation(evolved, None, TASK_SCOPE, "aa" * 32)
    with pytest.raises(ContractViolation, match="parent mismatch"):
        revision_from_generation(evolved, evolved, TASK_SCOPE, "aa" * 32)


# -- frozen core: scopes ---------------------------------------------------------------


def test_scope_refs_are_validated_and_context_is_explicit() -> None:
    validate_scope(GLOBAL_SCOPE)
    with pytest.raises(ContractViolation, match="requires a name"):
        validate_scope(ScopeRef("project", ""))
    with pytest.raises(ContractViolation, match="empty name"):
        validate_scope(ScopeRef("global", "oops"))
    with pytest.raises(ContractViolation, match="unknown scope level"):
        validate_scope(ScopeRef("tenant", "x"))
    assert ResolutionContext.build(task="sum-integers").chain == (
        TASK_SCOPE, GLOBAL_SCOPE,
    )
    with pytest.raises(ContractViolation, match="requires its task"):
        ResolutionContext.build(run="run-1")


# -- provisional: state/evidence separation -------------------------------------------


def _evaluation_manifest(dataset_fingerprint: str, seeds: tuple[int, ...]) -> EvaluationManifest:
    return EvaluationManifest(
        resolved_manifest_ref="77" * 32,
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
    """The revision owns only its scope manifest; each ValidationBundle pins
    its own evaluation manifest (which references *resolved* state)."""
    objects = ObjectStore(tmp_path / "objects")
    revision = _composite_revision()
    validate_revision(revision)

    ref_v1 = objects.put_text(codec.dumps(_evaluation_manifest("22" * 32, seeds=(0,))))
    ref_v2 = objects.put_text(codec.dumps(_evaluation_manifest("33" * 32, seeds=(0, 1, 2))))
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
    recovered: EvaluationManifest = codec.loads(objects.get_text(ref_v2), EvaluationManifest)
    assert recovered.seeds == (0, 1, 2)


# -- provisional: tasks/datasets, selection, algorithm state -------------------------


def test_task_spec_and_dataset_revision_round_trip(tmp_path: Path) -> None:
    objects = ObjectStore(tmp_path / "objects")
    config_ref = objects.put_text(
        '{"signature": "solve(input_text: str) -> int", "primitive_catalog": ["re"]}'
    )
    spec = TaskSpecVersion(
        task_id="sum-integers", version=3, description="sum signed integers",
        environment="function-task@1", action_schema="int@1",
        observation_schema="text@1", scorer="exact-int-match@1",
        config_ref=config_ref, fingerprint="11" * 32,
    )
    assert not hasattr(spec, "signature")
    dataset = DatasetRevision(
        dataset_id="sum-integers", revision=4, parent_revision=3,
        reason="regression: captured failing input from run-x",
        split_manifest_refs={"visible": "aa" * 32, "audit": "dd" * 32},
        split_counts={"visible": 6, "audit": 2},
        fingerprint="22" * 32,
    )
    for obj in (spec, dataset):
        assert codec.loads(codec.dumps(obj)) == obj


def test_selection_dispositions_are_policy_neutral_and_evidence_backed() -> None:
    def decision(disposition: str, evidence: tuple[str, ...]) -> SelectionDecision:
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

    for disposition in ("promote", "reject", "frontier_add", "provisional_activate"):
        validated = decision(disposition, ("aa" * 32,))
        validate_selection(validated)
        assert codec.loads(codec.dumps(validated)) == validated
        with pytest.raises(ContractViolation, match="requires evidence"):
            validate_selection(decision(disposition, ()))
    with pytest.raises(ContractViolation, match="unknown disposition"):
        validate_selection(decision("retain", ("aa" * 32,)))
    with pytest.raises(ContractViolation, match="must be versioned"):
        validate_selection(
            SelectionDecision(
                "vibes", "88" * 32, "promote",
                RevisionRef(TASK_SCOPE, "r"), None, ("aa" * 32,), "r", "t",
            )
        )


def test_algorithm_run_and_steps_round_trip_for_resumability() -> None:
    run = AlgorithmRun(
        algorithm="pareto-population@1", run_id="alg-20260808-x", scope=TASK_SCOPE,
        budget=BudgetSpec(executions=64, model_calls=16),
        status="running", steps_completed=1,
    )
    step = AlgorithmStep(
        run.run_id, 0, "propose", "rev-0042", "mutated frontier parent",
        BudgetUsage(model_calls=1, tokens=900),
    )
    assert codec.loads(codec.dumps(run)) == run
    assert codec.loads(codec.dumps(step)) == step


# -- frozen core: revision lifecycle seam ---------------------------------------------


def test_revision_activation_maps_real_history_and_preserves_derivation(
    tmp_path: Path,
) -> None:
    """Map a real activation@2 journal (seed → evolved → rollback → promote)
    activation-by-activation; the append-only 'last activation wins'
    derivation then reproduces the same active id at every prefix."""
    from strive.contracts import Activation as LiveActivation
    from strive.loop import promote_generation, run_cycle as _run

    store = Store(tmp_path / "artifacts", SUM_INTEGERS_TASK.task_id)
    _run(store, SUM_INTEGERS_TASK)  # seed + evolved activations
    store.rollback()  # rollback activation
    promote_generation(store, SUM_INTEGERS_TASK, "gen-0001")  # promote activation

    live = [e for e in store.entries() if isinstance(e, LiveActivation)]
    assert [a.reason for a in live] == ["seed", "evolved", "rollback", "promote"]

    # evidence is operation-specific: legacy activation@2 maps to
    # decision_ref=None across the board (the generation's original decision
    # lives only in MigrationProvenance)
    mapped = [revision_activation_from_activation(a) for a in live]
    for activation in mapped:
        validate_revision_activation(activation)
        assert codec.loads(codec.dumps(activation)) == activation

    # field-exact preservation
    for original, migrated in zip(live, mapped):
        assert migrated.revision.revision_id == original.generation_id.replace("gen-", "rev-")
        assert migrated.revision.scope == ScopeRef("task", original.task_id)
        assert migrated.mode == original.mode
        assert migrated.reason == original.reason
        assert migrated.at == original.at
        assert migrated.expires_after_cycles == original.expires_after_cycles
        assert migrated.baseline_score == original.baseline_score
        assert "@" in migrated.policy_ref  # legacy markers get the @0 era
    assert mapped[0].policy_ref == "seed@0"
    assert mapped[1].policy_ref == "paired-deterministic@1"  # already versioned

    # derivation parity: last-activation-wins yields the same active sequence
    for i in range(1, len(live) + 1):
        live_active = live[:i][-1].generation_id.replace("gen-", "rev-")
        assert mapped[:i][-1].revision.revision_id == live_active

    # no inferred evidence anywhere in the legacy mapping
    assert all(m.decision_ref is None for m in mapped)


def test_provisional_activation_mapping_requires_expiry() -> None:
    activation = RevisionActivation(
        revision=RevisionRef(TASK_SCOPE, "rev-0002"),
        mode="provisional",
        reason="promote",
        at="t",
        policy_ref="provisional@1",
        expires_after_cycles=2,
        baseline_score=1.0,
    )
    validate_revision_activation(activation)
    with pytest.raises(ContractViolation, match="must carry its expiry"):
        validate_revision_activation(
            RevisionActivation(
                revision=RevisionRef(TASK_SCOPE, "rev-0002"),
                mode="provisional", reason="promote", at="t",
                policy_ref="provisional@1",
            )
        )
    with pytest.raises(ContractViolation, match="unknown activation reason"):
        validate_revision_activation(
            RevisionActivation(
                revision=RevisionRef(TASK_SCOPE, "rev-0002"),
                mode="durable", reason="vibes", at="t", policy_ref="p@1",
            )
        )


def test_migration_provenance_preserves_every_generation_field(tmp_path: Path) -> None:
    """task_fingerprint, origin, weakness, and the embedded decision evidence
    all survive migration losslessly via the provenance record; cycle@1
    records are untouched (Stage 3B is dual-write) and stay replayable."""
    from strive.loop import replay_run, run_cycle as _run

    store = Store(tmp_path / "artifacts", SUM_INTEGERS_TASK.task_id)
    report = _run(store, SUM_INTEGERS_TASK)
    generation = store.generation("gen-0001")
    assert generation.decision is not None

    decision_ref = store.objects.put_text(codec.dumps(generation.decision))
    provenance = MigrationProvenance(
        source="generation@2",
        generation_id=generation.generation_id,
        task_id=generation.task_id,
        task_fingerprint=generation.task_fingerprint,
        origin=generation.origin,
        surface=generation.surface,
        weakness_id=generation.weakness_id,
        decision_ref=decision_ref,
    )
    provenance_ref = store.objects.put_text(codec.dumps(provenance))
    assert codec.loads(store.objects.get_text(provenance_ref)) == provenance

    recovered_decision: object = codec.loads(store.objects.get_text(decision_ref))
    assert recovered_decision == generation.decision  # acceptance evidence intact
    assert provenance.task_fingerprint == SUM_INTEGERS_TASK.fingerprint()

    # the revision points at its provenance; nothing is lost in the mapping
    parent = store.generation("gen-0000")
    revision = revision_from_generation(generation, parent, TASK_SCOPE, "aa" * 32)
    enriched = HarnessRevision(
        ref=revision.ref, base_parent=revision.base_parent,
        provenance_parents=revision.provenance_parents, deltas=revision.deltas,
        scope_manifest_ref=revision.scope_manifest_ref, proposer=revision.proposer,
        summary=revision.summary, created_at=revision.created_at,
        provenance_ref=provenance_ref,
    )
    validate_revision(enriched)

    # dual-write means the live cycle record still replays as-is
    replay = replay_run(store, SUM_INTEGERS_TASK, report.run_id)
    assert replay.matches and replay.decision_matches is True
