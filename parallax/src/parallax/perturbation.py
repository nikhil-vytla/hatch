"""The one perturbation model.

A perturbation takes a task and produces the conditions to compare it under.
The distinction the research cares about is where the material comes from:

- `reference_based`: every condition is derived from an existing benchmark
  task, so the reference task's own difficulty is the anchor. Intent evolution
  is this: the same GSM8K or SWE-bench problem, reached by different
  conversational routes.
- `reference_free`: the family is synthesized rather than derived, so there is
  no reference difficulty to anchor against and the obligations have to carry
  their own authority. Checkpoint evolution is this: a hand-authored or
  generated family whose requirements accumulate.

That distinction is a field, not a folder, because it changes what a result
means: a reference-based contrast can be read against the reference task's
known pass rate, and a reference-free one cannot.
"""

from __future__ import annotations

from typing import Literal, NewType, Self, TypeAlias

from pydantic import Field, model_validator

from .canonical import canonical_digest
from .task import AgentContract
from .types import (
    ConditionDigest,
    ConstructionSeed,
    DigestText,
    NonEmptyText,
    NonNegativeInt,
    PositiveInt,
    SourceId,
    StrictModel,
)

Condition = NewType("Condition", NonEmptyText)
Provenance: TypeAlias = Literal["reference_based", "reference_free"]


class Turn(StrictModel):
    """One scheduled turn of material, with the allowance it runs under.

    The allowance is split rather than flat, and that split is the point.
    `required_output` is what this condition's own construction forces the
    agent to emit before it can do any task work; `headroom` is what is left
    over for the task itself. Two conditions are budget-matched when their
    headroom matches, not when their limits match.

    That is not a hypothetical. Checkpoint-evolution screening gave both arms
    the same flat `max_output_bytes`, but the evolved arm had to re-serialize
    its own accumulated workspace to answer at all, so an equal limit handed it
    strictly less room to work in. It failed 10/10 on the cap rather than on
    the task, and the arms were "matched" the whole time. A flat cap cannot
    express the difference; this shape cannot hide it.

    Units are whatever the benchmark meters (output tokens, workspace bytes),
    and both fields are totals *for this turn*. `steps` is how many agent
    actions the harness allows before it delivers the next turn, so a harness
    that caps each step individually divides rather than being told twice.
    """

    text: NonEmptyText
    steps: PositiveInt = 1
    required_output: NonNegativeInt = 0
    headroom: PositiveInt

    @property
    def output_limit(self) -> int:
        return self.required_output + self.headroom

    @property
    def per_step_output(self) -> int:
        return self.output_limit // self.steps


class GenerationRecord(StrictModel):
    """One accepted or rejected generation attempt, kept for audit.

    `payload` is the method's own structured evidence, canonicalized to text so
    that this module needs no opinion about what a method records.
    """

    stage: NonEmptyText
    target: NonEmptyText
    model: NonEmptyText
    output: str
    accepted: bool
    reason: str
    payload: str = ""


class Variant(StrictModel):
    """One condition's material for one task.

    Identity is scoped here rather than to the enclosing set: `digest` covers
    this condition's turns and allowances and nothing else. Editing or removing
    a sibling condition therefore leaves this one's identity untouched, which
    is what lets an admission record outlive a change to the experimental
    design. The previous model hashed every arm's bytes into one task spec, so
    retiring an arm nobody ran silently invalidated the admission records of
    tasks whose own material had not changed.
    """

    condition: Condition
    turns: tuple[Turn, ...] = Field(min_length=1)

    @property
    def digest(self) -> ConditionDigest:
        return ConditionDigest(canonical_digest(self))

    @property
    def total_steps(self) -> int:
        return sum(turn.steps for turn in self.turns)

    @property
    def total_headroom(self) -> int:
        return sum(turn.headroom for turn in self.turns)


class VariantSet(StrictModel):
    """Every condition one perturbation produced for one task.

    A perturbation declares what it produces; an experiment declares which of
    those it runs. Neither the count nor the names live in a type here, because
    the useful invariant is not "there are three arms" but "the conditions
    being compared are matched in effect", and that is a property of a
    comparison rather than of a family.

    `control` is how a perturbation offers an intermediate condition without
    forcing anyone to pay for it. A live GSM8K round showed why it is worth
    offering: the evolved condition scored 0.109 below base, and only the
    presence of a presentation-matched control split that into -0.086 from
    multi-turn presentation and -0.023 from intent evolution on top. Without
    it the whole drop would have been attributed to the manipulation. The same
    control is worthless at three sources, so the experiment opts in when its
    sample can support the attribution.
    """

    task_id: SourceId
    provenance: Provenance
    agent_contract: AgentContract
    reference_digest: DigestText | None = None
    construction_seed: ConstructionSeed | None = None
    variants: tuple[Variant, ...] = Field(min_length=1)
    control: Condition | None = None
    evidence: tuple[GenerationRecord, ...] = ()

    @model_validator(mode="after")
    def coherent_set(self) -> Self:
        conditions = tuple(variant.condition for variant in self.variants)
        if len(set(conditions)) != len(conditions):
            raise ValueError("condition names must be unique within a variant set")
        based = self.provenance == "reference_based"
        if based and self.reference_digest is None:
            raise ValueError("a reference-based variant set must name its reference")
        if not based and self.reference_digest is not None:
            raise ValueError("a reference-free variant set has no reference to name")
        if self.control is not None and self.control not in conditions:
            raise ValueError(f"declared control {self.control!r} was not constructed")
        return self

    def prompts(self, condition: Condition) -> tuple[str, ...]:
        """Agent-facing text for one condition: material plus the contract.

        This is the only way to get text that is meant to reach a model, and it
        cannot be called without a contract, because the contract is a required
        field of the set that owns the material. `Turn.text` is the perturbation's
        material and is what the digest covers; a runner that renders `Turn.text`
        directly is skipping the contract, which is a visible mistake at the call
        site rather than an invisible one in a prompt.

        The contract goes on every turn because several runners call the provider
        once per turn with no conversation state, so a contract stated only in
        turn one would never reach turn two. Restating it costs input tokens and
        no headroom; not stating it cost a full GSM8K round its validity.
        """

        return tuple(
            f"{turn.text}\n\n{self.agent_contract.instructions}"
            for turn in self.variant(condition).turns
        )

    def variant(self, condition: Condition) -> Variant:
        for candidate in self.variants:
            if candidate.condition == condition:
                return candidate
        raise KeyError(f"{self.task_id} has no condition {condition!r}")

    @property
    def conditions(self) -> tuple[Condition, ...]:
        return tuple(variant.condition for variant in self.variants)


def headroom_mismatch(
    variants: tuple[Variant, ...],
) -> dict[Condition, int] | None:
    """Report per-condition headroom when the conditions are not matched.

    This is a reported finding rather than a raised error. Whether an unmatched
    comparison is a bug or the point is a question about the experiment, so the
    experiment config decides what to do about it; the plan records the answer
    either way so a reader can see it without rerunning anything.
    """

    headroom = {variant.condition: variant.total_headroom for variant in variants}
    return None if len(set(headroom.values())) <= 1 else headroom
