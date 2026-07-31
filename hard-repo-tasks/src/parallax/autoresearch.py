from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any


class IntentCondition(StrEnum):
    STATIC = "static"
    REPEAT = "repeat"
    REVEAL = "reveal"
    REVISION = "revision"
    SWITCH = "switch"
    COMBINED = "combined"
    REPEAT_DEEP = "repeat-deep"
    COMBINED_DEEP = "combined-deep"


class RunStatus(StrEnum):
    SUCCESS = "success"
    MODEL_FAILURE = "model_failure"
    INVALID_RESPONSE = "invalid_response"
    PROVIDER_ERROR = "provider_error"
    HARNESS_ERROR = "harness_error"


@dataclass(frozen=True)
class ArithmeticTask:
    task_id: str
    teams: int
    units_per_team: int
    points_per_unit: int
    penalty: int
    generator_version: str = "intent-arithmetic-v1"

    @property
    def expected(self) -> int:
        return self.teams * self.units_per_team * self.points_per_unit - self.penalty

    def digest(self) -> str:
        return _digest(asdict(self))


@dataclass(frozen=True)
class ConversationVariant:
    task_id: str
    source_digest: str
    condition: str
    turns: tuple[str, ...]
    expected: int
    renderer_version: str = "evolving-intent-v1"
    parent_condition: str | None = None
    intervention: str | None = None

    def digest(self) -> str:
        return _digest(asdict(self))


@dataclass(frozen=True)
class CampaignManifest:
    campaign_id: str
    model: str
    repetitions: int
    tasks: tuple[ArithmeticTask, ...]
    conditions: tuple[IntentCondition, ...]
    max_calls_non_static: int = 4
    seed: int = 0
    protocol_version: str = "parallax-autoresearch-v1"

    def __post_init__(self) -> None:
        if self.repetitions < 1:
            raise ValueError("repetitions must be positive")
        if self.max_calls_non_static < 2:
            raise ValueError("multi-turn campaigns require at least two calls")
        if not self.tasks:
            raise ValueError("at least one task is required")

    def digest(self) -> str:
        return _digest(asdict(self))

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> CampaignManifest:
        return cls(
            campaign_id=value["campaign_id"],
            model=value["model"],
            repetitions=int(value["repetitions"]),
            tasks=tuple(ArithmeticTask(**task) for task in value["tasks"]),
            conditions=tuple(IntentCondition(item) for item in value["conditions"]),
            max_calls_non_static=int(value.get("max_calls_non_static", 4)),
            seed=int(value.get("seed", 0)),
            protocol_version=value.get("protocol_version", "parallax-autoresearch-v1"),
        )

    @classmethod
    def load(cls, path: Path) -> CampaignManifest:
        return cls.from_dict(json.loads(path.read_text()))


@dataclass(frozen=True)
class RunRecord:
    campaign_id: str
    campaign_digest: str
    task_id: str
    source_digest: str
    conversation_digest: str
    condition: str
    model: str
    repetition: int
    calls: int
    expected: int
    parsed_answer: int | None
    reward: float | None
    status: RunStatus
    final_response: str
    replies: tuple[str, ...]
    trace_ids: tuple[str, ...]
    started_at: str
    finished_at: str
    error: str | None = None
    parent_condition: str | None = None
    intervention: str | None = None

    @property
    def key(self) -> tuple[str, str, str, int]:
        return self.campaign_id, self.task_id, self.condition, self.repetition

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def default_tasks() -> tuple[ArithmeticTask, ...]:
    return (
        ArithmeticTask("workshop-alpha", teams=7, units_per_team=13, points_per_unit=8, penalty=37),
        ArithmeticTask("workshop-beta", teams=9, units_per_team=11, points_per_unit=6, penalty=29),
        ArithmeticTask("workshop-gamma", teams=8, units_per_team=14, points_per_unit=7, penalty=45),
    )


def render_conversation(
    task: ArithmeticTask,
    condition: IntentCondition,
    *,
    intent_ledger: bool = False,
) -> ConversationVariant:
    full = _full_prompt(task)
    if condition == IntentCondition.STATIC:
        turns = (full,)
    elif condition == IntentCondition.REPEAT:
        turns = (
            full,
            "No facts or requirements have changed. Continue with the same task.",
            "There are still no changes. Keep the original values and objective.",
            "Give only the final integer answer for the unchanged task.",
        )
    elif condition == IntentCondition.REVEAL:
        turns = (
            f"A workshop has {task.teams} teams. I will provide the rest shortly.",
            f"Each team completes {task.units_per_team} units.",
            (
                f"Each unit earns {task.points_per_unit} points, and the workshop receives "
                f"a fixed penalty of {task.penalty} points."
            ),
            "What is the final score after the penalty? Give only the integer.",
        )
    elif condition == IntentCondition.REVISION:
        wrong_rate = task.points_per_unit + 3
        turns = (
            _full_prompt(task, points_per_unit=wrong_rate),
            "Work through that request, but do not finalize yet.",
            (
                f"Correction: each unit earns {task.points_per_unit} points, not "
                f"{wrong_rate}. Every other value and the objective stay unchanged."
            ),
            "Use the corrected value and give only the final integer answer.",
        )
    elif condition == IntentCondition.SWITCH:
        turns = (
            (
                f"A workshop has {task.teams} teams completing {task.units_per_team} units "
                f"each at {task.points_per_unit} points per unit. First calculate the gross "
                "score before any penalty."
            ),
            "Keep working on the gross-score request. Do not apply a penalty yet.",
            (
                f"Switch the objective: subtract a fixed penalty of {task.penalty} points "
                "and report the final score instead."
            ),
            "Give only the integer final score after the penalty.",
        )
    elif condition == IntentCondition.COMBINED:
        wrong_rate = task.points_per_unit + 3
        turns = (
            (
                f"A workshop has {task.teams} teams. Each team completes "
                f"{task.units_per_team} units at {wrong_rate} points per unit. Start by "
                "finding the gross score."
            ),
            (
                f"Switch focus briefly: report how many units all {task.teams} teams "
                "complete in total. Do not finalize the overall score."
            ),
            (
                f"Correction: the rate is {task.points_per_unit} points per unit, not "
                f"{wrong_rate}. Return to the score calculation and subtract a fixed "
                f"penalty of {task.penalty} points."
            ),
            "Give only the integer final score using the corrected rate and penalty.",
        )
    elif condition == IntentCondition.REPEAT_DEEP:
        turns = (
            full,
            "No facts or requirements have changed. Continue with the same task.",
            "There are still no changes. Keep the original values and objective.",
            "Confirm that the original team count remains active.",
            "Confirm that the original unit rate and penalty remain active.",
            "No values have been superseded. Prepare the final calculation.",
            "Give only the final integer answer for the unchanged task.",
        )
    elif condition == IntentCondition.COMBINED_DEEP:
        wrong_teams = task.teams + 2
        wrong_units = task.units_per_team - 3
        wrong_rate = task.points_per_unit + 4
        wrong_penalty = task.penalty + 18
        turns = (
            (
                f"A workshop has {wrong_teams} teams. Each team completes "
                f"{task.units_per_team} units at {wrong_rate} points per unit. Start by "
                "finding the gross score."
            ),
            (
                f"Switch objectives: use {wrong_units} units per team and report only the "
                "total number of units, not a score."
            ),
            (
                f"Correction: there are {task.teams} teams, not {wrong_teams}. Now return "
                f"to the score and subtract a penalty of {wrong_penalty} points."
            ),
            (
                "Switch again: explain which values are currently active, but do not "
                "finalize the score."
            ),
            (
                f"Corrections: each team completes {task.units_per_team} units, not "
                f"{wrong_units}, and each unit earns {task.points_per_unit} points, not "
                f"{wrong_rate}."
            ),
            (
                f"Final correction: the fixed penalty is {task.penalty}, not "
                f"{wrong_penalty}. Return to the original final-score objective."
            ),
            "Give only the integer final score using the latest corrected values.",
        )
    else:
        raise ValueError(f"unsupported condition: {condition}")

    parent: str | None = None
    intervention: str | None = None
    name = str(condition)
    if intent_ledger:
        if condition == IntentCondition.STATIC:
            raise ValueError("the intent ledger is only defined for multi-turn conditions")
        turns = (*turns[:-1], f"{turns[-1]}\n\n{_intent_ledger(task)}")
        parent = name
        name = f"{name}+intent-ledger"
        intervention = "canonical-active-intent-ledger-v1"

    variant = ConversationVariant(
        task_id=task.task_id,
        source_digest=task.digest(),
        condition=name,
        turns=turns,
        expected=task.expected,
        parent_condition=parent,
        intervention=intervention,
    )
    validate_conversation(task, variant)
    return variant


def validate_conversation(task: ArithmeticTask, variant: ConversationVariant) -> None:
    if variant.source_digest != task.digest():
        raise ValueError("conversation source digest does not match task")
    if variant.expected != task.expected:
        raise ValueError("conversation verifier target does not match source task")
    if variant.condition == IntentCondition.STATIC:
        expected_calls = 1
    elif variant.condition in {
        IntentCondition.REPEAT_DEEP,
        IntentCondition.COMBINED_DEEP,
    }:
        expected_calls = 7
    else:
        expected_calls = 4
    if len(variant.turns) != expected_calls:
        raise ValueError(
            f"condition {variant.condition!r} requires {expected_calls} calls, "
            f"found {len(variant.turns)}"
        )
    if any(not turn.strip() for turn in variant.turns):
        raise ValueError("conversation turns cannot be empty")


def extract_integer(response: str) -> int | None:
    boxed = re.findall(r"\\boxed\{(-?[\d,]+)\}", response)
    if boxed:
        return int(boxed[-1].replace(",", ""))
    numbers = re.findall(r"(?<!\w)-?\d[\d,]*(?!\w)", response)
    if not numbers:
        return None
    return int(numbers[-1].replace(",", ""))


def verify_response(response: str, expected: int) -> tuple[int | None, float]:
    parsed = extract_integer(response)
    return parsed, float(parsed == expected)


def append_record(path: Path, record: RunRecord) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as handle:
        handle.write(json.dumps(record.to_dict(), sort_keys=True) + "\n")


def load_records(path: Path) -> list[RunRecord]:
    if not path.exists():
        return []
    rows: list[RunRecord] = []
    for line in path.read_text().splitlines():
        if not line:
            continue
        value = json.loads(line)
        value["status"] = RunStatus(value["status"])
        value["replies"] = tuple(value["replies"])
        value["trace_ids"] = tuple(value["trace_ids"])
        rows.append(RunRecord(**value))
    return rows


def summarize_records(records: Iterable[RunRecord]) -> dict[str, Any]:
    rows = list(records)
    by_condition: dict[str, list[RunRecord]] = {}
    for row in rows:
        by_condition.setdefault(row.condition, []).append(row)

    conditions: dict[str, dict[str, Any]] = {}
    for condition, condition_rows in sorted(by_condition.items()):
        valid = [
            row
            for row in condition_rows
            if row.status
            in {
                RunStatus.SUCCESS,
                RunStatus.MODEL_FAILURE,
                RunStatus.INVALID_RESPONSE,
            }
        ]
        rewards = [row.reward for row in valid if row.reward is not None]
        conditions[condition] = {
            "runs": len(condition_rows),
            "valid_runs": len(valid),
            "successes": sum(row.status == RunStatus.SUCCESS for row in valid),
            "accuracy": sum(rewards) / len(rewards) if rewards else None,
            "provider_errors": sum(
                row.status == RunStatus.PROVIDER_ERROR for row in condition_rows
            ),
            "harness_errors": sum(
                row.status == RunStatus.HARNESS_ERROR for row in condition_rows
            ),
            "invalid_responses": sum(
                row.status == RunStatus.INVALID_RESPONSE for row in condition_rows
            ),
        }

    paired: dict[str, dict[str, Any]] = {}
    for condition, condition_rows in by_condition.items():
        if (
            condition == IntentCondition.STATIC
            or condition.startswith("repeat")
            or "+" in condition
        ):
            continue
        control = "repeat-deep" if condition.endswith("-deep") else "repeat"
        repeat = {
            (row.task_id, row.repetition): row
            for row in by_condition.get(control, [])
            if row.reward is not None
        }
        pairs = [
            (repeat[(row.task_id, row.repetition)], row)
            for row in condition_rows
            if (row.task_id, row.repetition) in repeat and row.reward is not None
        ]
        deltas = [candidate.reward - baseline.reward for baseline, candidate in pairs]
        paired[condition] = {
            "pairs": len(pairs),
            "mean_delta_vs_repeat": sum(deltas) / len(deltas) if deltas else None,
            "degraded_pairs": sum(delta < 0 for delta in deltas),
            "improved_pairs": sum(delta > 0 for delta in deltas),
        }

    return {
        "runs": len(rows),
        "conditions": conditions,
        "paired_against_repeat": paired,
    }


def _full_prompt(task: ArithmeticTask, *, points_per_unit: int | None = None) -> str:
    rate = points_per_unit if points_per_unit is not None else task.points_per_unit
    return (
        f"A workshop has {task.teams} teams. Each team completes "
        f"{task.units_per_team} units. Each unit earns {rate} points. The workshop "
        f"then receives a fixed penalty of {task.penalty} points. What is the final "
        "score after the penalty? Give only the integer."
    )


def _intent_ledger(task: ArithmeticTask) -> str:
    return (
        "Current intent ledger:\n"
        "- Goal: calculate the final workshop score after the penalty.\n"
        f"- Active teams: {task.teams}.\n"
        f"- Active units per team: {task.units_per_team}.\n"
        f"- Active points per unit: {task.points_per_unit}.\n"
        f"- Active fixed penalty: {task.penalty}.\n"
        "- Ignore superseded values and earlier objectives."
    )


def _digest(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode()).hexdigest()
