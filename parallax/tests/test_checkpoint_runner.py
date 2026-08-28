from __future__ import annotations

import pytest
from conftest import broken_total_workspace
from pydantic import ValidationError

from parallax import checkpoint_runner
from parallax.canonical import canonical_digest
from parallax.checkpoint_evolution import (
    CONTRACT,
    EMPTY_WORKSPACE,
    ReferenceBuild,
    SeedFamilyFixture,
    StageVerification,
    VerifierError,
    Workspace,
    admit_family,
    build_checkpoint_variants,
    run_case_trusted,
    verify_stage,
)
from parallax.checkpoint_runner import (
    AdmittedFamily,
    CheckpointDelivery,
    FamilyRun,
    MeteredWorkspace,
    StageReceipt,
    StageUsage,
    run_checkpoint_family,
)
from parallax.outcome import BudgetError, RunFailure
from parallax.perturbation import Condition, Variant, VariantSet

EVOLVED = Condition("evolved")
CARRY = Condition("carry-reference")


def built(fixture: SeedFamilyFixture) -> VariantSet:
    return build_checkpoint_variants(fixture.family, fixture.references)


def evolved_variant(fixture: SeedFamilyFixture) -> Variant:
    return built(fixture).variant(EVOLVED)


def carry_variant(fixture: SeedFamilyFixture) -> Variant:
    return built(fixture).variant(CARRY)


class ReferenceAgent:
    def __init__(self, fixture: SeedFamilyFixture) -> None:
        # Keyed by checkpoint index rather than by delivered text: the delivery
        # is the perturbation's material plus the agent contract, so matching on
        # a bare spec string would silently stop matching.
        self.by_index = {
            checkpoint.index: fixture.references.stages[position]
            for position, checkpoint in enumerate(fixture.family.checkpoints)
        }
        self.deliveries: list[CheckpointDelivery] = []

    def __call__(self, delivery: CheckpointDelivery) -> Workspace:
        self.deliveries.append(delivery)
        return self.by_index[delivery.index]


class MyopicAgent(ReferenceAgent):
    def __init__(self, fixture: SeedFamilyFixture) -> None:
        super().__init__(fixture)
        for position, checkpoint in enumerate(fixture.family.checkpoints):
            if position >= 1:
                self.by_index[checkpoint.index] = broken_total_workspace(
                    fixture.references.stages[position]
                )


class FailingAgent(ReferenceAgent):
    def __init__(
        self,
        fixture: SeedFamilyFixture,
        failing_index: int,
        error: Exception,
    ) -> None:
        super().__init__(fixture)
        self.failing_index = failing_index
        self.error = error

    def __call__(self, delivery: CheckpointDelivery) -> Workspace:
        if delivery.index == self.failing_index:
            raise self.error
        return super().__call__(delivery)


def test_evolved_arm_completes_and_chains_the_agents_own_workspace(
    seed_fixture, admitted
) -> None:
    agent = ReferenceAgent(seed_fixture)
    run = run_checkpoint_family(
        admitted, agent, variants=built(seed_fixture), condition=EVOLVED
    )
    assert len(run.receipts) == 3
    assert run.censored == ()
    assert run.failure is None
    assert all(
        isinstance(receipt.outcome, StageVerification) and receipt.outcome.strict_pass
        for receipt in run.receipts
    )
    assert run.receipts[0].input_workspace_digest == EMPTY_WORKSPACE.digest
    for previous, current in zip(run.receipts, run.receipts[1:], strict=False):
        assert current.input_workspace_digest == previous.output_workspace_digest
    assert [delivery.index for delivery in agent.deliveries] == [1, 2, 3]
    assert [delivery.public_spec for delivery in agent.deliveries] == list(
        built(seed_fixture).prompts(EVOLVED)
    )
    assert all(
        checkpoint.public_spec in delivery.public_spec
        and CONTRACT.instructions in delivery.public_spec
        for checkpoint, delivery in zip(
            admitted.family.checkpoints, agent.deliveries, strict=True
        )
    )
    assert agent.deliveries[1].workspace == seed_fixture.references.stages[0]


def test_delivery_is_public_material_only() -> None:
    assert set(CheckpointDelivery.model_fields) == {
        "index",
        "public_spec",
        "workspace",
        "max_output_bytes",
    }


def test_failing_verdicts_never_halt_the_family(seed_fixture, admitted) -> None:
    agent = MyopicAgent(seed_fixture)
    run = run_checkpoint_family(
        admitted, agent, variants=built(seed_fixture), condition=EVOLVED
    )
    assert len(run.receipts) == 3
    assert run.censored == ()
    outcomes = [receipt.outcome for receipt in run.receipts]
    assert isinstance(outcomes[0], StageVerification) and outcomes[0].strict_pass
    assert isinstance(outcomes[1], StageVerification)
    assert outcomes[1].isolated_pass and not outcomes[1].strict_pass
    assert (
        run.receipts[2].input_workspace_digest
        == run.receipts[1].output_workspace_digest
    )
    assert (
        run.receipts[1].output_workspace_digest
        == broken_total_workspace(seed_fixture.references.stages[1]).digest
    )


def test_carry_reference_arm_opens_every_stage_from_the_frozen_reference(
    seed_fixture, admitted
) -> None:
    agent = MyopicAgent(seed_fixture)
    run = run_checkpoint_family(
        admitted, agent, variants=built(seed_fixture), condition=CARRY
    )
    assert len(run.receipts) == 3
    assert run.receipts[0].input_workspace_digest == EMPTY_WORKSPACE.digest
    assert (
        run.receipts[1].input_workspace_digest
        == seed_fixture.references.stages[0].digest
    )
    assert (
        run.receipts[2].input_workspace_digest
        == seed_fixture.references.stages[1].digest
    )
    assert agent.deliveries[2].workspace == seed_fixture.references.stages[1]


def test_budget_fault_censors_evolved_but_not_carry_reference(
    seed_fixture, admitted
) -> None:
    limit = evolved_variant(seed_fixture).turns[1].output_limit
    oversized = Workspace.from_files({"tally.py": "#" * (limit + 1)})

    class OversizedAtTwo(ReferenceAgent):
        def __call__(self, delivery: CheckpointDelivery) -> Workspace:
            if delivery.index == 2:
                return oversized
            return super().__call__(delivery)

    evolved = run_checkpoint_family(
        admitted,
        OversizedAtTwo(seed_fixture),
        variants=built(seed_fixture),
        condition=EVOLVED,
    )
    assert len(evolved.receipts) == 2
    assert evolved.censored == (3,)
    fault = evolved.receipts[1].outcome
    assert isinstance(fault, RunFailure)
    assert fault.failure_kind == "budget"
    assert evolved.receipts[1].output_workspace_digest is None
    assert evolved.receipts[1].output_bytes == 0
    carried = run_checkpoint_family(
        admitted,
        OversizedAtTwo(seed_fixture),
        variants=built(seed_fixture),
        condition=CARRY,
    )
    assert len(carried.receipts) == 3
    assert isinstance(carried.receipts[1].outcome, RunFailure)
    assert isinstance(carried.receipts[2].outcome, StageVerification)


def test_agent_faults_are_run_failures_with_censoring(seed_fixture, admitted) -> None:
    crash = run_checkpoint_family(
        admitted,
        FailingAgent(seed_fixture, 2, RuntimeError("provider disconnected")),
        variants=built(seed_fixture),
        condition=EVOLVED,
    )
    assert crash.censored == (3,)
    fault = crash.receipts[1].outcome
    assert isinstance(fault, RunFailure) and fault.failure_kind == "agent"
    exhausted = run_checkpoint_family(
        admitted,
        FailingAgent(seed_fixture, 1, BudgetError("declared budget unusable")),
        variants=built(seed_fixture),
        condition=EVOLVED,
    )
    assert exhausted.censored == (2, 3)
    first = exhausted.receipts[0].outcome
    assert isinstance(first, RunFailure) and first.failure_kind == "budget"


def test_verifier_fault_is_infrastructure_and_family_continues(
    seed_fixture, admitted, monkeypatch
) -> None:
    def flaky(family, index, workspace, *, execute=run_case_trusted):
        if index == 2:
            raise VerifierError("interpreter spawn failed")
        return verify_stage(family, index, workspace, execute=execute)

    monkeypatch.setattr(checkpoint_runner, "verify_stage", flaky)
    run = run_checkpoint_family(
        admitted,
        ReferenceAgent(seed_fixture),
        variants=built(seed_fixture),
        condition=EVOLVED,
    )
    assert len(run.receipts) == 3
    assert run.censored == ()
    fault = run.receipts[1].outcome
    assert isinstance(fault, RunFailure) and fault.failure_kind == "verifier"
    assert run.receipts[1].output_workspace_digest is not None
    assert isinstance(run.receipts[2].outcome, StageVerification)


def test_unadmitted_families_are_unrepresentable(seed_fixture) -> None:
    family = seed_fixture.family
    receipt = admit_family(family, seed_fixture.references)
    broken_references = ReferenceBuild(
        family_digest=family.digest,
        stages=(
            seed_fixture.references.stages[0],
            broken_total_workspace(seed_fixture.references.stages[1]),
            seed_fixture.references.stages[2],
        ),
    )
    rejected = admit_family(family, broken_references)
    assert rejected.decision == "rejected"
    with pytest.raises(ValidationError, match="not admitted"):
        AdmittedFamily(
            family=family,
            references=broken_references,
            admission=rejected,
        )
    with pytest.raises(ValidationError, match="different family or reference"):
        AdmittedFamily(
            family=family,
            references=broken_references,
            admission=receipt,
        )


def test_grading_without_full_delivery_is_unrepresentable(
    seed_fixture, admitted
) -> None:
    run = run_checkpoint_family(
        admitted,
        ReferenceAgent(seed_fixture),
        variants=built(seed_fixture),
        condition=EVOLVED,
    )
    with pytest.raises(ValidationError, match="contiguous from stage 1"):
        FamilyRun(
            admitted=admitted,
            variant=evolved_variant(seed_fixture),
            receipts=run.receipts[1:],
            censored=(),
            failure=None,
        )
    with pytest.raises(ValidationError, match="undelivered suffix"):
        FamilyRun(
            admitted=admitted,
            variant=evolved_variant(seed_fixture),
            receipts=run.receipts[:2],
            censored=(),
            failure=None,
        )
    drifted = run.receipts[1].model_copy(
        update={"spec_digest": canonical_digest("another specification")}
    )
    with pytest.raises(ValidationError, match="drifted specification"):
        FamilyRun(
            admitted=admitted,
            variant=evolved_variant(seed_fixture),
            receipts=(run.receipts[0], drifted, run.receipts[2]),
            censored=(),
            failure=None,
        )
    broken_chain = run.receipts[1].model_copy(
        update={"input_workspace_digest": EMPTY_WORKSPACE.digest}
    )
    with pytest.raises(ValidationError, match="own terminal workspace"):
        FamilyRun(
            admitted=admitted,
            variant=evolved_variant(seed_fixture),
            receipts=(run.receipts[0], broken_chain, run.receipts[2]),
            censored=(),
            failure=None,
        )
    foreign_case = (
        run.receipts[0]
        .outcome.case_results[0]
        .model_copy(update={"case_id": "t9-unscheduled"})
    )
    tampered_verification = run.receipts[0].outcome.model_copy(
        update={
            "case_results": (
                foreign_case,
                *run.receipts[0].outcome.case_results[1:],
            )
        }
    )
    with pytest.raises(ValidationError, match="obligation set"):
        FamilyRun(
            admitted=admitted,
            variant=evolved_variant(seed_fixture),
            receipts=(
                run.receipts[0].model_copy(update={"outcome": tampered_verification}),
                *run.receipts[1:],
            ),
            censored=(),
            failure=None,
        )
    with pytest.raises(ValidationError, match="pre-episode failure"):
        FamilyRun(
            admitted=admitted,
            variant=evolved_variant(seed_fixture),
            receipts=(),
            censored=(1, 2, 3),
            failure=None,
        )


def test_carry_reference_runs_must_cover_every_stage(seed_fixture, admitted) -> None:
    run = run_checkpoint_family(
        admitted,
        MyopicAgent(seed_fixture),
        variants=built(seed_fixture),
        condition=CARRY,
    )
    with pytest.raises(ValidationError, match="every checkpoint"):
        FamilyRun(
            admitted=admitted,
            variant=carry_variant(seed_fixture),
            receipts=run.receipts[:2],
            censored=(3,),
            failure=None,
        )
    swapped = run.receipts[2].model_copy(
        update={"input_workspace_digest": run.receipts[1].output_workspace_digest}
    )
    with pytest.raises(ValidationError, match="frozen"):
        FamilyRun(
            admitted=admitted,
            variant=carry_variant(seed_fixture),
            receipts=(*run.receipts[:2], swapped),
            censored=(),
            failure=None,
        )


def test_stage_receipt_guards_grading_and_budget_accounting(
    seed_fixture, admitted
) -> None:
    run = run_checkpoint_family(
        admitted,
        ReferenceAgent(seed_fixture),
        variants=built(seed_fixture),
        condition=EVOLVED,
    )
    graded = run.receipts[0]
    with pytest.raises(ValidationError, match="without a produced workspace"):
        StageReceipt(
            index=graded.index,
            spec_digest=graded.spec_digest,
            input_workspace_digest=graded.input_workspace_digest,
            output_workspace_digest=None,
            max_output_bytes=graded.max_output_bytes,
            output_bytes=0,
            outcome=graded.outcome,
        )
    with pytest.raises(ValidationError, match="another stage"):
        StageReceipt(
            index=2,
            spec_digest=graded.spec_digest,
            input_workspace_digest=graded.input_workspace_digest,
            output_workspace_digest=graded.output_workspace_digest,
            max_output_bytes=graded.max_output_bytes,
            output_bytes=graded.output_bytes,
            outcome=graded.outcome,
        )
    with pytest.raises(ValidationError, match="over its declared budget"):
        StageReceipt(
            index=graded.index,
            spec_digest=graded.spec_digest,
            input_workspace_digest=graded.input_workspace_digest,
            output_workspace_digest=graded.output_workspace_digest,
            max_output_bytes=graded.max_output_bytes,
            output_bytes=graded.max_output_bytes + 1,
            outcome=graded.outcome,
        )
    assert all(
        receipt.output_bytes <= receipt.max_output_bytes for receipt in run.receipts
    )


STAGE_USAGE = StageUsage(
    prompt_tokens=1200,
    completion_tokens=400,
    estimated_cost_usd=0.0032,
)


class MeteredReferenceAgent(ReferenceAgent):
    def __call__(self, delivery: CheckpointDelivery) -> MeteredWorkspace:
        return MeteredWorkspace(
            workspace=super().__call__(delivery),
            usage=STAGE_USAGE,
        )


def test_metered_agents_land_usage_in_every_stage_receipt(
    seed_fixture, admitted
) -> None:
    run = run_checkpoint_family(
        admitted,
        MeteredReferenceAgent(seed_fixture),
        variants=built(seed_fixture),
        condition=EVOLVED,
    )
    assert len(run.receipts) == 3
    for receipt in run.receipts:
        assert receipt.usage == STAGE_USAGE
        assert isinstance(receipt.outcome, StageVerification)


def test_unmetered_agents_leave_usage_absent(seed_fixture, admitted) -> None:
    run = run_checkpoint_family(
        admitted,
        ReferenceAgent(seed_fixture),
        variants=built(seed_fixture),
        condition=EVOLVED,
    )
    assert all(receipt.usage is None for receipt in run.receipts)


def test_failed_stages_retain_usage_spent_before_the_fault(
    seed_fixture, admitted
) -> None:
    error = BudgetError("stage reply reached its output-token limit")
    error.stage_usage = STAGE_USAGE
    run = run_checkpoint_family(
        admitted,
        FailingAgent(seed_fixture, 2, error),
        variants=built(seed_fixture),
        condition=EVOLVED,
    )
    fault = run.receipts[1]
    assert isinstance(fault.outcome, RunFailure)
    assert fault.outcome.failure_kind == "budget"
    assert fault.output_workspace_digest is None
    assert fault.usage == STAGE_USAGE
    assert run.censored == (3,)


def test_oversized_metered_workspaces_keep_their_usage(seed_fixture, admitted) -> None:
    limit = evolved_variant(seed_fixture).turns[1].output_limit
    oversized = Workspace.from_files({"tally.py": "#" * (limit + 1)})

    class OversizedMetered(ReferenceAgent):
        def __call__(self, delivery: CheckpointDelivery) -> MeteredWorkspace:
            produced = oversized if delivery.index == 2 else super().__call__(delivery)
            return MeteredWorkspace(workspace=produced, usage=STAGE_USAGE)

    run = run_checkpoint_family(
        admitted,
        OversizedMetered(seed_fixture),
        variants=built(seed_fixture),
        condition=EVOLVED,
    )
    fault = run.receipts[1]
    assert isinstance(fault.outcome, RunFailure)
    assert fault.outcome.error_type == "WorkspaceBudgetExceeded"
    assert fault.usage == STAGE_USAGE


def test_evolved_gets_its_carrying_cost_back_as_extra_limit(seed_fixture) -> None:
    """The manipulation must not eat the allowance it is measured under.

    Both conditions get the same headroom, and the evolved condition's limit is
    larger by exactly the workspace it has to re-serialize. Screening handed
    both a flat cap, so the evolved arm paid for its own manipulation and failed
    10/10 on bytes instead of on the task.
    """

    variants = build_checkpoint_variants(seed_fixture.family, seed_fixture.references)
    evolved = variants.variant(Condition("evolved"))
    carry = variants.variant(Condition("carry-reference"))
    assert evolved.total_headroom == carry.total_headroom
    assert evolved.turns[0].output_limit == carry.turns[0].output_limit
    for index, stage in enumerate(seed_fixture.references.stages[:-1], start=1):
        assert (
            evolved.turns[index].output_limit - carry.turns[index].output_limit
            == stage.content_bytes
        )
