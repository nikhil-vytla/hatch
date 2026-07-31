from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from enum import StrEnum
from typing import Any


class TaskComponent(StrEnum):
    INSTRUCTION = "instruction"
    INITIAL_STATE = "initial_state"
    GOAL = "goal"
    CONSTRAINTS = "constraints"
    VERIFIER = "verifier"
    BUDGET = "budget"
    METADATA = "metadata"


class IntentRelation(StrEnum):
    PRESERVE = "preserve"
    REFINE = "refine"
    GENERALIZE = "generalize"
    SHIFT = "shift"
    INVERT = "invert"
    CORRUPT = "corrupt"


class StateMode(StrEnum):
    READ_ONLY = "read_only"
    TRANSACTIONAL = "transactional"
    STAGED = "read_only_then_transactional"
    PERSISTENT = "persistent"


class VerifierPolicy(StrEnum):
    REUSE = "reuse"
    TRANSPORT = "transport"
    AUGMENT = "augment"
    COMPOSE = "compose"
    REPLACE = "replace"
    REJECT = "reject"


class IntentEventKind(StrEnum):
    REVEAL = "reveal"
    REVISE = "revise"
    SWITCH = "switch"
    REPEAT = "repeat"


class VariantFamily(StrEnum):
    PARAPHRASE = "instruction_paraphrase"
    DELAYED_REVEAL = "delayed_reveal"
    ARGUMENT_REVISION = "argument_revision"
    FUNCTION_SWITCH = "function_switch"
    COMBINED_EVOLUTION = "combined_evolution"
    BUDGET_SHIFT = "budget_shift"
    CONSTRAINT_REFINEMENT = "constraint_refinement"
    STATE_EQUIVALENCE = "state_equivalence"
    GOAL_EXTENSION = "goal_extension"
    PERSISTENT_EPISODE = "persistent_episode"


@dataclass(frozen=True)
class Budget:
    max_turns: int
    max_tool_calls: int | None = None
    timeout_seconds: int | None = None

    def __post_init__(self) -> None:
        if self.max_turns < 1:
            raise ValueError("max_turns must be positive")
        if self.max_tool_calls is not None and self.max_tool_calls < 1:
            raise ValueError("max_tool_calls must be positive")
        if self.timeout_seconds is not None and self.timeout_seconds < 1:
            raise ValueError("timeout_seconds must be positive")


@dataclass(frozen=True)
class TaskSpec:
    task_id: str
    instruction: str
    initial_state_id: str
    goals: tuple[str, ...]
    constraints: tuple[str, ...]
    verifier_id: str
    budget: Budget
    metadata: tuple[tuple[str, str], ...] = ()

    def __post_init__(self) -> None:
        if not self.task_id:
            raise ValueError("task_id is required")
        if not self.instruction:
            raise ValueError("instruction is required")
        if not self.initial_state_id:
            raise ValueError("initial_state_id is required")
        if not self.goals:
            raise ValueError("at least one goal is required")
        if not self.verifier_id:
            raise ValueError("verifier_id is required")
        if len(dict(self.metadata)) != len(self.metadata):
            raise ValueError("metadata keys must be unique")

    def digest(self) -> str:
        payload = json.dumps(asdict(self), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(payload.encode()).hexdigest()

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> TaskSpec:
        return cls(
            task_id=value["task_id"],
            instruction=value["instruction"],
            initial_state_id=value["initial_state_id"],
            goals=tuple(value["goals"]),
            constraints=tuple(value.get("constraints", [])),
            verifier_id=value["verifier_id"],
            budget=Budget(**value["budget"]),
            metadata=tuple(sorted(value.get("metadata", {}).items())),
        )

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["metadata"] = dict(self.metadata)
        return value


@dataclass(frozen=True)
class IntentSlot:
    id: str
    value: str


@dataclass(frozen=True)
class IntentAnchor:
    goal: str
    slots: tuple[IntentSlot, ...]

    def __post_init__(self) -> None:
        ids = [slot.id for slot in self.slots]
        if len(ids) != len(set(ids)):
            raise ValueError("intent slot IDs must be unique")

    def values(self) -> dict[str, str]:
        return {slot.id: slot.value for slot in self.slots}


@dataclass(frozen=True)
class IntentEvent:
    turn: int
    kind: IntentEventKind
    target: str
    before: str | None
    after: str | None
    message: str

    def __post_init__(self) -> None:
        if self.turn < 1:
            raise ValueError("event turn must be positive")
        if not self.message:
            raise ValueError("event message is required")


@dataclass(frozen=True)
class AnchorTrajectory:
    initial_goal: str
    initial_values: tuple[tuple[str, str], ...]
    initially_revealed: tuple[str, ...]
    events: tuple[IntentEvent, ...]


@dataclass(frozen=True)
class CompiledTrajectory:
    turns: tuple[tuple[str, ...], ...]
    final_goal: str
    final_values: tuple[tuple[str, str], ...]
    revealed: tuple[str, ...]


@dataclass(frozen=True)
class VariantBlueprint:
    family: VariantFamily
    components: tuple[TaskComponent, ...]
    relation: IntentRelation
    state_mode: StateMode
    verifier_policy: VerifierPolicy
    research_question: str
    independent_benchmark_task: bool = False


@dataclass(frozen=True)
class TaskVariant:
    source_task_id: str
    variant_id: str
    source_digest: str
    spec: TaskSpec
    declared_components: tuple[TaskComponent, ...]
    relation: IntentRelation
    state_mode: StateMode
    verifier_policy: VerifierPolicy
    generator_version: str
    trajectory: AnchorTrajectory | None = None
    provenance: tuple[tuple[str, str], ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class VariantAdmission:
    admitted: bool
    violations: tuple[str, ...]
    changed_components: tuple[TaskComponent, ...]
    clustered_with_source: bool


def compile_anchor_trajectory(
    anchor: IntentAnchor,
    trajectory: AnchorTrajectory,
) -> CompiledTrajectory:
    values = dict(trajectory.initial_values)
    if len(values) != len(trajectory.initial_values):
        raise ValueError("initial intent values must have unique slot IDs")
    unknown = set(values) - set(anchor.values())
    if unknown:
        raise ValueError(f"initial values contain unknown slots: {sorted(unknown)}")

    revealed = set(trajectory.initially_revealed)
    if not revealed <= values.keys():
        raise ValueError("initially revealed slots must have initial values")

    goal = trajectory.initial_goal
    by_turn: dict[int, list[str]] = {}
    previous_turn = 0
    for event in trajectory.events:
        if event.turn < previous_turn:
            raise ValueError("events must be ordered by turn")
        previous_turn = event.turn
        by_turn.setdefault(event.turn, []).append(event.message)

        if event.kind == IntentEventKind.REPEAT:
            if event.before is not None or event.after is not None:
                raise ValueError("repeat events cannot mutate intent")
            continue

        if event.kind == IntentEventKind.SWITCH:
            if event.target != "goal":
                raise ValueError("switch events must target goal")
            if event.before is not None and goal != event.before:
                raise ValueError("switch event does not match the active goal")
            if event.after is None:
                raise ValueError("switch events require a new goal")
            goal = event.after
            continue

        if event.target not in anchor.values():
            raise ValueError(f"event targets unknown slot {event.target!r}")
        if event.kind == IntentEventKind.REVEAL:
            if event.before is not None or event.after is None:
                raise ValueError("reveal requires after and forbids before")
            if event.target in revealed:
                raise ValueError(f"slot {event.target!r} was already revealed")
            values[event.target] = event.after
            revealed.add(event.target)
            continue

        if event.kind == IntentEventKind.REVISE:
            if event.target not in revealed:
                raise ValueError("a slot must be revealed before it can be revised")
            if event.before is None or event.after is None:
                raise ValueError("revision events require before and after")
            if values[event.target] != event.before:
                raise ValueError("revision does not match the active slot value")
            values[event.target] = event.after
            continue

        raise ValueError(f"unsupported intent event: {event.kind}")

    anchor_values = anchor.values()
    if goal != anchor.goal:
        raise ValueError("terminal goal does not return to the anchor")
    if values != anchor_values:
        raise ValueError("terminal slot values do not return to the anchor")
    if revealed != anchor_values.keys():
        raise ValueError("terminal intent does not reveal every anchor slot")

    turns = tuple(tuple(by_turn[turn]) for turn in sorted(by_turn))
    return CompiledTrajectory(
        turns=turns,
        final_goal=goal,
        final_values=tuple(sorted(values.items())),
        revealed=tuple(sorted(revealed)),
    )


def changed_components(source: TaskSpec, candidate: TaskSpec) -> tuple[TaskComponent, ...]:
    changed: list[TaskComponent] = []
    if source.instruction != candidate.instruction:
        changed.append(TaskComponent.INSTRUCTION)
    if source.initial_state_id != candidate.initial_state_id:
        changed.append(TaskComponent.INITIAL_STATE)
    if source.goals != candidate.goals:
        changed.append(TaskComponent.GOAL)
    if source.constraints != candidate.constraints:
        changed.append(TaskComponent.CONSTRAINTS)
    if source.verifier_id != candidate.verifier_id:
        changed.append(TaskComponent.VERIFIER)
    if source.budget != candidate.budget:
        changed.append(TaskComponent.BUDGET)
    if source.metadata != candidate.metadata:
        changed.append(TaskComponent.METADATA)
    return tuple(changed)


def admit_variant(source: TaskSpec, variant: TaskVariant) -> VariantAdmission:
    violations: list[str] = []
    actual = changed_components(source, variant.spec)
    if variant.source_task_id != source.task_id:
        violations.append("source task ID does not match")
    if variant.source_digest != source.digest():
        violations.append("source task digest does not match")
    if set(actual) != set(variant.declared_components):
        violations.append("declared components do not match the actual task delta")

    behavior_changes = {
        TaskComponent.INITIAL_STATE,
        TaskComponent.GOAL,
        TaskComponent.CONSTRAINTS,
        TaskComponent.VERIFIER,
    }
    if variant.verifier_policy == VerifierPolicy.REUSE and behavior_changes & set(actual):
        violations.append("the original verifier cannot be reused after a behavioral change")
    if variant.state_mode == StateMode.PERSISTENT and variant.verifier_policy == VerifierPolicy.REUSE:
        violations.append("persistent state requires an episode-aware verifier")
    if variant.relation == IntentRelation.PRESERVE and (
        source.goals != variant.spec.goals or source.constraints != variant.spec.constraints
    ):
        violations.append("intent-preserving variants cannot change goals or constraints")
    if variant.relation == IntentRelation.CORRUPT:
        violations.append("corrupt variants are negative controls and cannot be admitted")
    if variant.verifier_policy == VerifierPolicy.REJECT:
        violations.append("the selected verifier policy rejects this variant")
    if variant.trajectory is not None:
        try:
            compile_anchor_trajectory(
                IntentAnchor(
                    goal=source.goals[0],
                    slots=tuple(
                        IntentSlot(f"constraint:{index}", value)
                        for index, value in enumerate(source.constraints)
                    ),
                ),
                variant.trajectory,
            )
        except ValueError as error:
            violations.append(f"invalid anchor trajectory: {error}")

    clustered = not (
        TaskComponent.INITIAL_STATE in actual
        and TaskComponent.GOAL in actual
        and variant.verifier_policy in {VerifierPolicy.REPLACE, VerifierPolicy.TRANSPORT}
    )
    return VariantAdmission(
        admitted=not violations,
        violations=tuple(violations),
        changed_components=actual,
        clustered_with_source=clustered,
    )


def default_variant_blueprints() -> tuple[VariantBlueprint, ...]:
    rows: tuple[
        tuple[
            VariantFamily,
            tuple[TaskComponent, ...],
            IntentRelation,
            StateMode,
            VerifierPolicy,
            str,
        ],
        ...,
    ] = (
        (
            VariantFamily.PARAPHRASE,
            (TaskComponent.INSTRUCTION,),
            IntentRelation.PRESERVE,
            StateMode.TRANSACTIONAL,
            VerifierPolicy.REUSE,
            "Does wording change success while semantics and reward remain fixed?",
        ),
        (
            VariantFamily.DELAYED_REVEAL,
            (TaskComponent.INSTRUCTION, TaskComponent.BUDGET),
            IntentRelation.PRESERVE,
            StateMode.STAGED,
            VerifierPolicy.REUSE,
            "Can the agent accumulate an incompletely revealed intent?",
        ),
        (
            VariantFamily.ARGUMENT_REVISION,
            (TaskComponent.INSTRUCTION, TaskComponent.BUDGET),
            IntentRelation.PRESERVE,
            StateMode.STAGED,
            VerifierPolicy.REUSE,
            "Can the agent replace stale constraints with restored anchor values?",
        ),
        (
            VariantFamily.FUNCTION_SWITCH,
            (TaskComponent.INSTRUCTION, TaskComponent.BUDGET),
            IntentRelation.PRESERVE,
            StateMode.STAGED,
            VerifierPolicy.REUSE,
            "Can the agent pivot from an adjacent request back to the anchor?",
        ),
        (
            VariantFamily.COMBINED_EVOLUTION,
            (TaskComponent.INSTRUCTION, TaskComponent.BUDGET),
            IntentRelation.PRESERVE,
            StateMode.STAGED,
            VerifierPolicy.REUSE,
            "Which compositions of reveal, revision, and switch are adversarial?",
        ),
        (
            VariantFamily.BUDGET_SHIFT,
            (TaskComponent.BUDGET,),
            IntentRelation.PRESERVE,
            StateMode.TRANSACTIONAL,
            VerifierPolicy.REUSE,
            "How does resource pressure change strategy on the same task?",
        ),
        (
            VariantFamily.CONSTRAINT_REFINEMENT,
            (TaskComponent.INSTRUCTION, TaskComponent.CONSTRAINTS),
            IntentRelation.REFINE,
            StateMode.TRANSACTIONAL,
            VerifierPolicy.AUGMENT,
            "Which added constraints expose brittle but behaviorally correct patches?",
        ),
        (
            VariantFamily.STATE_EQUIVALENCE,
            (TaskComponent.INITIAL_STATE,),
            IntentRelation.PRESERVE,
            StateMode.TRANSACTIONAL,
            VerifierPolicy.TRANSPORT,
            "Does the policy survive a semantics-preserving state representation change?",
        ),
        (
            VariantFamily.GOAL_EXTENSION,
            (TaskComponent.INSTRUCTION, TaskComponent.GOAL),
            IntentRelation.REFINE,
            StateMode.TRANSACTIONAL,
            VerifierPolicy.COMPOSE,
            "Can the agent preserve the anchor behavior while adding a related outcome?",
        ),
        (
            VariantFamily.PERSISTENT_EPISODE,
            (
                TaskComponent.INSTRUCTION,
                TaskComponent.INITIAL_STATE,
                TaskComponent.METADATA,
            ),
            IntentRelation.SHIFT,
            StateMode.PERSISTENT,
            VerifierPolicy.REPLACE,
            "Which prior side effects make later intent changes adversarial?",
        ),
    )
    return tuple(
        VariantBlueprint(
            family=family,
            components=components,
            relation=relation,
            state_mode=state_mode,
            verifier_policy=policy,
            research_question=question,
        )
        for family, components, relation, state_mode, policy, question in rows
    )


def blueprints_as_dicts() -> list[dict[str, Any]]:
    return [asdict(blueprint) for blueprint in default_variant_blueprints()]
