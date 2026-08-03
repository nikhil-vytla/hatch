from __future__ import annotations

import json
import re
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any, TypeAlias

from parallax.gsm8k import SourceTask
from parallax.ids import digest_value

_SHA256 = re.compile(r"[0-9a-f]{64}")
_ANCHOR_GOAL = "answer_source_task"


@dataclass(frozen=True)
class TurnBudget:
    max_turns: int
    output_tokens_per_turn: int

    def __post_init__(self) -> None:
        if self.max_turns < 1 or self.output_tokens_per_turn < 1:
            raise ValueError("turn and output-token budgets must be positive")


@dataclass(frozen=True)
class Reveal:
    target: str
    after: str
    message: str
    kind: str = "reveal"


@dataclass(frozen=True)
class Revise:
    target: str
    before: str
    after: str
    message: str
    kind: str = "revise"


@dataclass(frozen=True)
class Switch:
    before: str
    after: str
    message: str
    kind: str = "switch"


IntentEvent: TypeAlias = Reveal | Revise | Switch


@dataclass(frozen=True)
class ProposalBundle:
    upstream_revision: str
    model: str
    prompt_digest: str
    raw_response_digest: str
    raw_sealed_evidence: str | None
    parameters: tuple[tuple[str, str | int | float | bool | None], ...]
    seed: int
    initial_goal: str
    initial_values: tuple[tuple[str, str], ...]
    opening_turn: str
    events: tuple[IntentEvent, ...]
    format: str = "parallax.frozen-proposal.v1"

    def __post_init__(self) -> None:
        if not all(
            value.strip()
            for value in (
                self.upstream_revision,
                self.model,
                self.prompt_digest,
                self.raw_response_digest,
                self.initial_goal,
                self.opening_turn,
            )
        ):
            raise ValueError("frozen proposal fields must be non-empty")
        if not _SHA256.fullmatch(self.prompt_digest):
            raise ValueError("prompt_digest must be a lowercase SHA-256 digest")
        if not _SHA256.fullmatch(self.raw_response_digest):
            raise ValueError("raw_response_digest must be a lowercase SHA-256 digest")
        if not self.events:
            raise ValueError("frozen proposal requires at least one typed event")
        if self.events[0].message != self.opening_turn:
            raise ValueError("opening_turn must be copied from the first typed event")
        if len(dict(self.initial_values)) != len(self.initial_values):
            raise ValueError("initial intent value keys must be unique")
        replay_events(self.initial_goal, self.initial_values, self.events)

    @property
    def digest(self) -> str:
        return digest_value(self.sealed_payload())

    def sealed_payload(self) -> dict[str, Any]:
        return {
            "events": [_event_dict(event) for event in self.events],
            "format": self.format,
            "initial_goal": self.initial_goal,
            "initial_values": dict(self.initial_values),
            "model": self.model,
            "opening_turn": self.opening_turn,
            "parameters": dict(self.parameters),
            "prompt_digest": self.prompt_digest,
            "raw_response_digest": self.raw_response_digest,
            "raw_sealed_evidence": self.raw_sealed_evidence,
            "seed": self.seed,
            "upstream_revision": self.upstream_revision,
        }

    @classmethod
    def load(cls, path: Path) -> ProposalBundle:
        value: Any = json.loads(path.read_text())
        if not isinstance(value, dict):
            raise ValueError("frozen proposal must be a JSON object")
        if value.get("format") != "parallax.frozen-proposal.v1":
            raise ValueError("unsupported frozen proposal format")
        evidence = value.get("raw_sealed_evidence")
        response_digest = value.get("raw_response_digest")
        if (evidence is None) == (response_digest is None):
            raise ValueError(
                "proposal requires exactly one of raw_response_digest or raw_sealed_evidence"
            )
        if evidence is not None:
            if not isinstance(evidence, str) or not evidence:
                raise ValueError("raw_sealed_evidence must be a non-empty string")
            response_digest = digest_value({"raw_sealed_evidence": evidence})
        parameters = value.get("parameters")
        if not isinstance(parameters, dict) or not all(
            isinstance(key, str) and _is_scalar(item) for key, item in parameters.items()
        ):
            raise ValueError("proposal parameters must be a scalar JSON object")
        initial_values = value.get("initial_values", {})
        if not isinstance(initial_values, dict) or not all(
            isinstance(key, str) and isinstance(item, str) for key, item in initial_values.items()
        ):
            raise ValueError("initial_values must map strings to strings")
        raw_events = value.get("events")
        if not isinstance(raw_events, list):
            raise ValueError("proposal events must be a list")
        return cls(
            upstream_revision=_text(value, "upstream_revision"),
            model=_text(value, "model"),
            prompt_digest=_text(value, "prompt_digest"),
            raw_response_digest=str(response_digest),
            raw_sealed_evidence=evidence,
            parameters=tuple(sorted(parameters.items())),
            seed=_integer(value, "seed"),
            initial_goal=_text(value, "initial_goal"),
            initial_values=tuple(sorted(initial_values.items())),
            opening_turn=_text(value, "opening_turn"),
            events=tuple(_parse_event(event) for event in raw_events),
        )


class PlanArm(StrEnum):
    STATIC = "static"
    MATCHED = "matched"
    EVOLVED = "evolved"


@dataclass(frozen=True)
class StaticPlan:
    turns: tuple[str, ...]
    budget: TurnBudget
    anchor_digest: str
    arm: PlanArm = PlanArm.STATIC


@dataclass(frozen=True)
class IntentPlan:
    arm: PlanArm
    turns: tuple[str, ...]
    budget: TurnBudget
    anchor_digest: str
    initial_goal: str
    initial_values: tuple[tuple[str, str], ...]
    events: tuple[IntentEvent, ...]

    def __post_init__(self) -> None:
        if self.arm not in {PlanArm.MATCHED, PlanArm.EVOLVED}:
            raise ValueError("IntentPlan arm must be matched or evolved")


@dataclass(frozen=True)
class CheckpointPlan:
    checkpoint_ids: tuple[str, ...]
    arm: str = "checkpoint"


SynthesisPlan: TypeAlias = StaticPlan | IntentPlan | CheckpointPlan


@dataclass(frozen=True)
class EvolvingIntent:
    proposal: ProposalBundle
    max_turns: int | None = None
    output_tokens_per_turn: int = 256

    @classmethod
    def frozen(
        cls,
        path: Path,
        *,
        max_turns: int | None = None,
        output_tokens_per_turn: int = 256,
    ) -> EvolvingIntent:
        return cls(ProposalBundle.load(path), max_turns, output_tokens_per_turn)


def compile_plans(source: SourceTask, strategy: EvolvingIntent) -> tuple[SynthesisPlan, ...]:
    proposal = strategy.proposal
    evolved_turns = (*tuple(event.message for event in proposal.events), source.question)
    if strategy.max_turns is not None and strategy.max_turns != len(evolved_turns):
        raise ValueError(
            f"configured max_turns is {strategy.max_turns}, proposal requires {len(evolved_turns)}"
        )
    anchor_digest = digest_value({"terminal_anchor": source.question})
    evolved_budget = TurnBudget(len(evolved_turns), strategy.output_tokens_per_turn)
    plans: tuple[SynthesisPlan, ...] = (
        StaticPlan(
            turns=(source.question,),
            budget=TurnBudget(1, strategy.output_tokens_per_turn),
            anchor_digest=anchor_digest,
        ),
        IntentPlan(
            arm=PlanArm.MATCHED,
            turns=_matched_turns(source.question, len(evolved_turns)),
            budget=evolved_budget,
            anchor_digest=anchor_digest,
            initial_goal=_ANCHOR_GOAL,
            initial_values=(),
            events=(),
        ),
        IntentPlan(
            arm=PlanArm.EVOLVED,
            turns=evolved_turns,
            budget=evolved_budget,
            anchor_digest=anchor_digest,
            initial_goal=proposal.initial_goal,
            initial_values=proposal.initial_values,
            events=proposal.events,
        ),
    )
    for plan in plans:
        replay_plan(source, plan)
    return plans


def replay_plan(source: SourceTask, plan: SynthesisPlan) -> tuple[str, ...]:
    if isinstance(plan, CheckpointPlan):
        raise NotImplementedError("CheckpointPlan execution is not implemented")
    expected_anchor = digest_value({"terminal_anchor": source.question})
    if plan.anchor_digest != expected_anchor:
        raise ValueError("plan terminal anchor digest does not match source")
    if len(plan.turns) != plan.budget.max_turns:
        raise ValueError("plan turn count does not match its budget")
    if not plan.turns or plan.turns[-1] != source.question:
        raise ValueError("plan must terminate at the source-copied anchor")
    if isinstance(plan, StaticPlan):
        if plan.turns != (source.question,) or plan.budget.max_turns != 1:
            raise ValueError("static plan must be one fully specified source turn")
        return plan.turns
    if plan.arm is PlanArm.MATCHED:
        if plan.events or plan.initial_goal != _ANCHOR_GOAL or plan.initial_values:
            raise ValueError("matched plan cannot mutate semantic intent")
        if plan.turns != _matched_turns(source.question, plan.budget.max_turns):
            raise ValueError("matched plan contains a semantic change")
        return plan.turns
    if tuple(event.message for event in plan.events) != plan.turns[:-1]:
        raise ValueError("intent events do not replay to the rendered precursor turns")
    goal, _ = replay_events(plan.initial_goal, plan.initial_values, plan.events)
    if goal != _ANCHOR_GOAL:
        raise ValueError("evolved plan does not return to the source-task goal")
    return plan.turns


def replay_events(
    initial_goal: str,
    initial_values: tuple[tuple[str, str], ...],
    events: tuple[IntentEvent, ...],
) -> tuple[str, tuple[tuple[str, str], ...]]:
    goal = initial_goal
    values = dict(initial_values)
    for event in events:
        if not event.message.strip():
            raise ValueError("intent event messages must be non-empty")
        if isinstance(event, Reveal):
            if event.target in values:
                raise ValueError(f"cannot reveal existing intent slot {event.target!r}")
            values[event.target] = event.after
        elif isinstance(event, Revise):
            if values.get(event.target) != event.before:
                raise ValueError(f"revision does not match intent slot {event.target!r}")
            values[event.target] = event.after
        elif isinstance(event, Switch):
            if goal != event.before:
                raise ValueError("switch does not match the active goal")
            goal = event.after
    return goal, tuple(sorted(values.items()))


def _matched_turns(anchor: str, count: int) -> tuple[str, ...]:
    if count == 1:
        return (anchor,)
    unchanged = (
        "No requirements have changed. Keep working on the same problem and preserve "
        "the original answer target."
    )
    return (anchor, *((unchanged,) * (count - 2)), anchor)


def _parse_event(value: Any) -> IntentEvent:
    if not isinstance(value, dict):
        raise ValueError("proposal event must be a JSON object")
    kind = value.get("kind")
    if kind == "reveal":
        _exact_keys(value, {"kind", "target", "after", "message"})
        return Reveal(_text(value, "target"), _text(value, "after"), _text(value, "message"))
    if kind == "revise":
        _exact_keys(value, {"kind", "target", "before", "after", "message"})
        return Revise(
            _text(value, "target"),
            _text(value, "before"),
            _text(value, "after"),
            _text(value, "message"),
        )
    if kind == "switch":
        _exact_keys(value, {"kind", "before", "after", "message"})
        return Switch(_text(value, "before"), _text(value, "after"), _text(value, "message"))
    raise ValueError(f"unsupported proposal event kind: {kind!r}")


def _event_dict(event: IntentEvent) -> dict[str, str]:
    if isinstance(event, Reveal):
        return {
            "after": event.after,
            "kind": event.kind,
            "message": event.message,
            "target": event.target,
        }
    if isinstance(event, Revise):
        return {
            "after": event.after,
            "before": event.before,
            "kind": event.kind,
            "message": event.message,
            "target": event.target,
        }
    return {
        "after": event.after,
        "before": event.before,
        "kind": event.kind,
        "message": event.message,
    }


def _exact_keys(value: dict[str, Any], keys: set[str]) -> None:
    if set(value) != keys:
        raise ValueError(f"proposal event keys must be exactly {sorted(keys)}")


def _text(value: dict[str, Any], key: str) -> str:
    item = value.get(key)
    if not isinstance(item, str) or not item.strip():
        raise ValueError(f"proposal {key!r} must be a non-empty string")
    return item


def _integer(value: dict[str, Any], key: str) -> int:
    item = value.get(key)
    if isinstance(item, bool) or not isinstance(item, int):
        raise ValueError(f"proposal {key!r} must be an integer")
    return item


def _is_scalar(value: object) -> bool:
    return value is None or isinstance(value, (str, int, float, bool))
