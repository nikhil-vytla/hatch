from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Annotated, Self, TypeAlias, assert_never

from pydantic import Field, model_validator

from .checkpoint_evolution import (
    CARRY_REFERENCE,
    EMPTY_WORKSPACE,
    EVOLVED,
    AdmissionReceipt,
    CaseExecution,
    CheckpointFamily,
    PositiveInt,
    ReferenceBuild,
    StageVerification,
    VerifierError,
    Workspace,
    run_case_trusted,
    verify_stage,
)
from .experiment import Execution, Unit
from .outcome import (
    BudgetError,
    Outcome,
    RunFailure,
    Verdict,
    Verification,
)
from .perturbation import Condition, Variant, VariantSet
from .types import (
    DigestText,
    NonEmptyText,
    NonNegativeInt,
    SourceId,
    StrictModel,
    TrialIndex,
)

StageOutcome: TypeAlias = Annotated[
    StageVerification | RunFailure,
    Field(discriminator="kind"),
]


class CheckpointRunError(ValueError):
    pass


class AdmittedFamily(StrictModel):
    family: CheckpointFamily
    references: ReferenceBuild
    admission: AdmissionReceipt

    @model_validator(mode="after")
    def admitted_only(self) -> Self:
        if self.admission.decision != "admitted":
            raise CheckpointRunError(f"family {self.family.family_id} was not admitted")
        if (
            self.admission.family_digest != self.family.digest
            or self.admission.reference_digest != self.references.digest
            or self.references.family_digest != self.family.digest
        ):
            raise CheckpointRunError(
                "admission receipt is bound to different family or reference bytes"
            )
        return self


class CheckpointDelivery(StrictModel):
    index: PositiveInt
    public_spec: NonEmptyText
    workspace: Workspace
    max_output_bytes: PositiveInt


class StageUsage(StrictModel):
    prompt_tokens: NonNegativeInt
    completion_tokens: NonNegativeInt
    estimated_cost_usd: Annotated[float, Field(ge=0, allow_inf_nan=False)]


class MeteredWorkspace(StrictModel):
    workspace: Workspace
    usage: StageUsage


CheckpointAgent: TypeAlias = Callable[
    [CheckpointDelivery], Workspace | MeteredWorkspace
]
AgentFactory: TypeAlias = Callable[
    [SourceId, Condition, TrialIndex],
    CheckpointAgent,
]


class StageReceipt(StrictModel):
    index: PositiveInt
    spec_digest: DigestText
    input_workspace_digest: DigestText
    output_workspace_digest: DigestText | None
    max_output_bytes: PositiveInt
    output_bytes: NonNegativeInt
    usage: StageUsage | None = None
    outcome: StageOutcome

    @model_validator(mode="after")
    def graded_only_with_workspace(self) -> Self:
        if isinstance(self.outcome, StageVerification):
            if self.output_workspace_digest is None:
                raise CheckpointRunError(
                    f"stage {self.index} was graded without a produced workspace"
                )
            if self.outcome.index != self.index:
                raise CheckpointRunError(
                    f"stage {self.index} carries a verification for another stage"
                )
        elif isinstance(self.outcome, RunFailure):
            pass
        else:
            assert_never(self.outcome)
        if self.output_workspace_digest is None and self.output_bytes != 0:
            raise CheckpointRunError(
                f"stage {self.index} counted bytes for a missing workspace"
            )
        if (
            self.output_workspace_digest is not None
            and self.output_bytes > self.max_output_bytes
        ):
            raise CheckpointRunError(
                f"stage {self.index} retained a workspace over its declared budget"
            )
        return self


class FamilyRun(StrictModel):
    admitted: AdmittedFamily
    variant: Variant
    receipts: tuple[StageReceipt, ...]
    censored: tuple[PositiveInt, ...]
    failure: RunFailure | None

    @model_validator(mode="after")
    def full_delivery_or_censored(self) -> Self:
        family = self.admitted.family
        total = len(family.checkpoints)
        delivered = len(self.receipts)
        if tuple(receipt.index for receipt in self.receipts) != tuple(
            range(1, delivered + 1)
        ):
            raise CheckpointRunError(
                "checkpoint delivery must be contiguous from stage 1"
            )
        if self.censored != tuple(range(delivered + 1, total + 1)):
            raise CheckpointRunError(
                "censored stages must be exactly the undelivered suffix"
            )
        if (self.failure is not None) != (delivered == 0):
            raise CheckpointRunError(
                "a run must hold receipts or exactly one pre-episode failure"
            )
        turns = self.variant.turns
        if len(turns) != total:
            raise CheckpointRunError(
                "the condition's turn count differs from the family's checkpoints"
            )
        for receipt, turn in zip(self.receipts, turns, strict=False):
            if receipt.max_output_bytes != turn.output_limit:
                raise CheckpointRunError(
                    f"stage {receipt.index} ran under an undeclared budget"
                )
        for receipt, checkpoint in zip(self.receipts, family.checkpoints, strict=False):
            if receipt.spec_digest != checkpoint.spec_digest:
                raise CheckpointRunError(
                    f"stage {receipt.index} delivered a drifted specification"
                )
            if isinstance(receipt.outcome, StageVerification):
                scheduled = {
                    (
                        origin,
                        case.case_id,
                        "new" if origin == receipt.index else "regression",
                        case.category,
                    )
                    for origin, case in family.obligations(receipt.index)
                }
                graded = {
                    (
                        result.origin_index,
                        result.case_id,
                        result.role,
                        result.category,
                    )
                    for result in receipt.outcome.case_results
                }
                if scheduled != graded:
                    raise CheckpointRunError(
                        f"stage {receipt.index} was graded against a different "
                        "obligation set than the accumulated sealed suite"
                    )
        self._validate_workspace_chain()
        return self

    def _validate_workspace_chain(self) -> None:
        total = len(self.admitted.family.checkpoints)
        delivered = len(self.receipts)
        if self.variant.condition == EVOLVED:
            previous = EMPTY_WORKSPACE.digest
            for receipt in self.receipts:
                if previous is None or receipt.input_workspace_digest != previous:
                    raise CheckpointRunError(
                        f"stage {receipt.index} did not start from the agent's "
                        "own terminal workspace"
                    )
                previous = receipt.output_workspace_digest
            if delivered not in (0, total):
                last = self.receipts[-1]
                if last.output_workspace_digest is not None or not isinstance(
                    last.outcome, RunFailure
                ):
                    raise CheckpointRunError(
                        "evolved censoring requires a missing workspace after "
                        "a run failure"
                    )
        elif self.variant.condition == CARRY_REFERENCE:
            if delivered not in (0, total):
                raise CheckpointRunError(
                    "carry-reference must deliver every checkpoint"
                )
            stages = self.admitted.references.stages
            for receipt in self.receipts:
                expected = (
                    EMPTY_WORKSPACE.digest
                    if receipt.index == 1
                    else stages[receipt.index - 2].digest
                )
                if receipt.input_workspace_digest != expected:
                    raise CheckpointRunError(
                        f"stage {receipt.index} did not start from the frozen "
                        "reference workspace"
                    )
        else:
            raise CheckpointRunError(f"unknown condition: {self.variant.condition}")


def _failure_usage(error: Exception) -> StageUsage | None:
    usage = getattr(error, "stage_usage", None)
    return usage if isinstance(usage, StageUsage) else None


def _stage_attempt(
    agent: CheckpointAgent,
    delivery: CheckpointDelivery,
) -> tuple[Workspace | RunFailure, StageUsage | None]:
    try:
        produced = agent(delivery)
        if isinstance(produced, MeteredWorkspace):
            workspace, usage = produced.workspace, produced.usage
        elif isinstance(produced, Workspace):
            workspace, usage = produced, None
        else:
            raise TypeError("agent returned a non-workspace artifact")
    except BudgetError as error:
        return RunFailure(
            failure_kind="budget",
            error_type=type(error).__name__,
            message=str(error),
        ), _failure_usage(error)
    except Exception as error:
        return RunFailure(
            failure_kind="agent",
            error_type=type(error).__name__,
            message=str(error),
        ), _failure_usage(error)
    if workspace.content_bytes > delivery.max_output_bytes:
        return RunFailure(
            failure_kind="budget",
            error_type="WorkspaceBudgetExceeded",
            message=(
                f"stage {delivery.index} returned {workspace.content_bytes} bytes "
                f"over the declared {delivery.max_output_bytes}-byte budget"
            ),
        ), usage
    return workspace, usage


def run_checkpoint_family(
    admitted: AdmittedFamily,
    agent: CheckpointAgent,
    *,
    variants: VariantSet,
    condition: Condition,
    execute: CaseExecution = run_case_trusted,
) -> FamilyRun:
    """Walk one condition through every checkpoint, grading as it goes.

    Each stage's byte allowance comes from the condition's own turn, which is
    `required_output + headroom`. The evolved condition therefore gets a larger
    limit than carry-reference by exactly the size of the workspace it has to
    carry forward, leaving both with the same room for new work.
    """

    family = admitted.family
    variant = variants.variant(condition)
    prompts = variants.prompts(condition)
    receipts: list[StageReceipt] = []
    carried = EMPTY_WORKSPACE
    for checkpoint in family.checkpoints:
        if condition == EVOLVED:
            opening = carried
        elif condition == CARRY_REFERENCE:
            opening = (
                EMPTY_WORKSPACE
                if checkpoint.index == 1
                else admitted.references.stages[checkpoint.index - 2]
            )
        else:
            raise CheckpointRunError(f"unknown condition: {condition}")
        delivery = CheckpointDelivery(
            index=checkpoint.index,
            public_spec=prompts[checkpoint.index - 1],
            workspace=opening,
            max_output_bytes=variant.turns[checkpoint.index - 1].output_limit,
        )
        attempt, usage = _stage_attempt(agent, delivery)
        produced: Workspace | None
        outcome: StageVerification | RunFailure
        if isinstance(attempt, RunFailure):
            produced = None
            outcome = attempt
        else:
            produced = attempt
            try:
                outcome = verify_stage(
                    family, checkpoint.index, produced, execute=execute
                )
            except VerifierError as error:
                outcome = RunFailure(
                    failure_kind="verifier",
                    error_type=type(error).__name__,
                    message=str(error),
                )
        receipts.append(
            StageReceipt(
                index=checkpoint.index,
                spec_digest=checkpoint.spec_digest,
                input_workspace_digest=opening.digest,
                output_workspace_digest=None if produced is None else produced.digest,
                max_output_bytes=variant.turns[checkpoint.index - 1].output_limit,
                output_bytes=0 if produced is None else produced.content_bytes,
                usage=usage,
                outcome=outcome,
            )
        )
        if condition == EVOLVED:
            if produced is None:
                break
            carried = produced
    return FamilyRun(
        admitted=admitted,
        variant=variant,
        receipts=tuple(receipts),
        censored=tuple(range(len(receipts) + 1, len(family.checkpoints) + 1)),
        failure=None,
    )


def checkpoint_executor(
    families: Mapping[SourceId, AdmittedFamily],
    variants: Mapping[SourceId, VariantSet],
    build_agent: AgentFactory,
    *,
    model: str,
    execute_case: CaseExecution = run_case_trusted,
) -> Callable[[Unit], Execution]:
    """Adapt checkpoint families to the one experiment loop.

    A unit's outcome is the terminal stage's verification, so a family that
    censored early reports the run failure that stopped it rather than a
    fabricated verdict. This replaced a 260-line second journal format with its
    own manifest, resume logic, and cost accounting.
    """

    def run(unit: Unit) -> Execution:
        admitted = families[unit.task_id]
        agent = build_agent(unit.task_id, unit.condition, unit.trial_index)
        family_run = run_checkpoint_family(
            admitted,
            agent,
            variants=variants[unit.task_id],
            condition=unit.condition,
            execute=execute_case,
        )
        usages = [
            receipt.usage
            for receipt in family_run.receipts
            if receipt.usage is not None
        ]
        terminal = family_run.receipts[-1] if family_run.receipts else None
        outcome: Outcome
        if terminal is None:
            outcome = family_run.failure or RunFailure(
                failure_kind="agent",
                error_type="NoStageDelivered",
                message="the family produced no stage receipts",
            )
        elif isinstance(terminal.outcome, RunFailure):
            outcome = terminal.outcome
        else:
            passed = terminal.outcome.strict_pass and not family_run.censored
            outcome = Verification(
                verdict=Verdict.PASS if passed else Verdict.WRONG,
                reason=(
                    f"stage {terminal.index} of {len(admitted.family.checkpoints)} "
                    f"{'satisfied' if passed else 'did not satisfy'} every "
                    "accumulated obligation"
                ),
            )
        return Execution(
            outcome=outcome,
            reported_model=model,
            prompt_tokens=sum(usage.prompt_tokens for usage in usages),
            completion_tokens=sum(usage.completion_tokens for usage in usages),
            estimated_cost_usd=sum(usage.estimated_cost_usd for usage in usages),
        )

    return run
