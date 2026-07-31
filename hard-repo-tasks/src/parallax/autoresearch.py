from __future__ import annotations

import hashlib
import itertools
import json
import random
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
    REPEAT_BURIED = "repeat-buried"
    COMBINED_BURIED = "combined-buried"
    REPEAT_TABLELAST = "repeat-tablelast"
    COMBINED_TABLELAST = "combined-tablelast"


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
class LookupRecord:
    region: str
    tier: str
    channel: str
    code: str


@dataclass(frozen=True)
class LookupTask:
    task_id: str
    records: tuple[LookupRecord, ...]
    anchor_region: str
    anchor_tier: str
    anchor_channel: str
    generator_version: str = "intent-lookup-v1"

    @property
    def expected(self) -> str:
        matches = [
            record.code
            for record in self.records
            if (
                record.region == self.anchor_region
                and record.tier == self.anchor_tier
                and record.channel == self.anchor_channel
            )
        ]
        if len(matches) != 1:
            raise ValueError("lookup anchor must match exactly one record")
        return matches[0]

    def digest(self) -> str:
        return _digest(asdict(self))


SourceTask = ArithmeticTask | LookupTask


@dataclass(frozen=True)
class ConversationVariant:
    task_id: str
    source_digest: str
    condition: str
    turns: tuple[str, ...]
    expected: int | str
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
    tasks: tuple[SourceTask, ...]
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
        tasks: list[SourceTask] = []
        for raw_task in value["tasks"]:
            task = dict(raw_task)
            kind = task.pop("kind", "arithmetic")
            if kind == "arithmetic":
                tasks.append(ArithmeticTask(**task))
            elif kind == "lookup":
                task["records"] = tuple(LookupRecord(**row) for row in task["records"])
                tasks.append(LookupTask(**task))
            else:
                raise ValueError(f"unknown task kind: {kind!r}")
        return cls(
            campaign_id=value["campaign_id"],
            model=value["model"],
            repetitions=int(value["repetitions"]),
            tasks=tuple(tasks),
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
    expected: int | str
    parsed_answer: int | str | None
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


def generate_lookup_tasks(
    count: int,
    rows_per_task: int,
    seed: int,
) -> tuple[LookupTask, ...]:
    if count < 1:
        raise ValueError("count must be positive")
    regions = tuple(f"region-{index}" for index in range(8))
    tiers = ("standard", "priority", "critical")
    channels = ("email", "chat", "phone")
    combinations = list(itertools.product(regions, tiers, channels))
    if rows_per_task < 3 or rows_per_task > len(combinations):
        raise ValueError("rows_per_task must be between 3 and 72")

    rng = random.Random(seed)
    tasks: list[LookupTask] = []
    for task_index in range(count):
        selected = rng.sample(combinations, rows_per_task)
        records = tuple(
            LookupRecord(
                region=region,
                tier=tier,
                channel=channel,
                code=f"CODE{task_index:02d}{row_index:02d}",
            )
            for row_index, (region, tier, channel) in enumerate(selected)
        )
        anchor = records[-1]
        tasks.append(
            LookupTask(
                task_id=f"routing-grid-{task_index:02d}",
                records=records,
                anchor_region=anchor.region,
                anchor_tier=anchor.tier,
                anchor_channel=anchor.channel,
                generator_version=f"intent-lookup-grid-v1-seed-{seed}",
            )
        )
    return tuple(tasks)


def render_conversation(
    task: SourceTask,
    condition: IntentCondition,
    *,
    intent_ledger: bool = False,
) -> ConversationVariant:
    if isinstance(task, LookupTask):
        return _render_lookup_conversation(task, condition, intent_ledger=intent_ledger)

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


def validate_conversation(task: SourceTask, variant: ConversationVariant) -> None:
    if variant.source_digest != task.digest():
        raise ValueError("conversation source digest does not match task")
    if variant.expected != task.expected:
        raise ValueError("conversation verifier target does not match source task")
    base_condition = variant.parent_condition or variant.condition
    if base_condition == IntentCondition.STATIC:
        expected_calls = 1
    elif base_condition in {
        IntentCondition.REPEAT_DEEP,
        IntentCondition.COMBINED_DEEP,
    }:
        expected_calls = 7
    elif base_condition in {
        IntentCondition.REPEAT_BURIED,
        IntentCondition.COMBINED_BURIED,
        IntentCondition.REPEAT_TABLELAST,
        IntentCondition.COMBINED_TABLELAST,
    }:
        expected_calls = 12
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


def verify_response(
    response: str, expected: int | str
) -> tuple[int | str | None, float]:
    if isinstance(expected, int):
        parsed: int | str | None = extract_integer(response)
    else:
        labels = re.findall(r"\b[A-Z][A-Z0-9_-]{2,15}\b", response)
        parsed = labels[-1] if labels else response.strip().upper() or None
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
        if condition.endswith("-deep"):
            control = "repeat-deep"
        elif condition.endswith("-buried"):
            control = "repeat-buried"
        elif condition.endswith("-tablelast"):
            control = "repeat-tablelast"
        else:
            control = "repeat"
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


def _render_lookup_conversation(
    task: LookupTask,
    condition: IntentCondition,
    *,
    intent_ledger: bool,
) -> ConversationVariant:
    full = _lookup_full_prompt(task)
    if condition == IntentCondition.STATIC:
        turns = (full,)
    elif condition == IntentCondition.REPEAT_DEEP:
        turns = (
            full,
            "No routing fields have changed. Keep the original request active.",
            "There are still no updates. Do not substitute another table row.",
            "Confirm that region, tier, and channel all remain unchanged.",
            "Continue using only the routing table and the original active request.",
            "No value has been superseded. Prepare the final lookup.",
            "Give only the routing code for the unchanged request.",
        )
    elif condition == IntentCondition.COMBINED_DEEP:
        alternatives = [
            record
            for record in task.records
            if record.code != task.expected
        ]
        if len(alternatives) < 2:
            raise ValueError("deep lookup conversations require two alternative records")
        first, second = alternatives[:2]
        turns = (
            (
                f"{_lookup_table(task)}\n\nStart with this request: region={first.region}, "
                f"tier={task.anchor_tier}, channel={first.channel}. Find its routing code."
            ),
            (
                f"Switch requests: now use region={second.region}, tier={second.tier}, "
                f"channel={second.channel}. Do not finalize yet."
            ),
            (
                f"Correction: the active region is {task.anchor_region}, not "
                f"{second.region}. Keep the other current fields for now."
            ),
            (
                "Switch objectives briefly: state which three routing fields are active, "
                "but do not output a code."
            ),
            (
                f"Correction: the active tier is {task.anchor_tier}, not {second.tier}. "
                "Keep tracking the current request."
            ),
            (
                f"Final correction: the active channel is {task.anchor_channel}, not "
                f"{second.channel}. Return to the routing-code objective."
            ),
            "Using the latest region, tier, and channel, give only the routing code.",
        )
    elif condition in {
        IntentCondition.REPEAT_BURIED,
        IntentCondition.COMBINED_BURIED,
    }:
        turns = _buried_lookup_turns(task, condition)
    elif condition in {
        IntentCondition.REPEAT_TABLELAST,
        IntentCondition.COMBINED_TABLELAST,
    }:
        turns = _tablelast_lookup_turns(task, condition)
    else:
        raise ValueError(f"lookup tasks do not support condition {condition!r}")

    parent: str | None = None
    intervention: str | None = None
    name = str(condition)
    if intent_ledger:
        if condition == IntentCondition.STATIC:
            raise ValueError("the intent ledger is only defined for multi-turn conditions")
        ledger = (
            "Current intent ledger:\n"
            f"- Goal: return the routing code.\n"
            f"- Active region: {task.anchor_region}.\n"
            f"- Active tier: {task.anchor_tier}.\n"
            f"- Active channel: {task.anchor_channel}.\n"
            "- Ignore superseded requests and values."
        )
        turns = (*turns[:-1], f"{turns[-1]}\n\n{ledger}")
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


def _disjoint_records(task: LookupTask, need: int) -> list[LookupRecord]:
    """Return records sharing no field value with the anchor request."""
    disjoint = [
        record
        for record in task.records
        if record.code != task.expected
        and record.region != task.anchor_region
        and record.tier != task.anchor_tier
        and record.channel != task.anchor_channel
    ]
    if len(disjoint) < need:
        raise ValueError(
            f"this lookup conversation requires {need} records sharing no "
            "field with the anchor"
        )
    return disjoint


def _buried_lookup_turns(
    task: LookupTask, condition: IntentCondition
) -> tuple[str, ...]:
    """Render 12-turn conversations whose anchor intent is buried mid-history.

    Every record referenced after the burial point shares no field value with
    the anchor, so the final active intent cannot be recovered from recency
    alone: the last statement of each anchor field sits at least seven turns
    before the final question, behind side lookups that plant competing codes.
    """
    disjoint = _disjoint_records(task, 6)
    first, second = disjoint[0], disjoint[1]
    side = disjoint[2:6]

    def side_lookup(record: LookupRecord) -> str:
        return (
            "Side question that does not change the active request: what is the "
            f"routing code for region={record.region}, tier={record.tier}, "
            f"channel={record.channel}? Answer it, then keep the active request "
            "unchanged."
        )

    if condition == IntentCondition.REPEAT_BURIED:
        return (
            _lookup_full_prompt(task),
            "No routing fields have changed. Keep the original request active.",
            side_lookup(side[0]),
            "Still no changes to the active request. Do not substitute another "
            "table row.",
            side_lookup(side[1]),
            "Confirm that the active region, tier, and channel all remain "
            "unchanged, without naming their values.",
            side_lookup(side[2]),
            "For history only: no request has been superseded because none "
            "changed. Confirm the active request is still the original one, "
            "without giving a code.",
            side_lookup(side[3]),
            "No value has been superseded. Keep the active request in mind.",
            "Prepare the final lookup for the active request, but do not output "
            "the code yet.",
            "Give only the routing code for the active request.",
        )
    return (
        (
            f"{_lookup_table(task)}\n\nStart with this request: "
            f"region={first.region}, tier={first.tier}, "
            f"channel={first.channel}. Find its routing code but do not "
            "finalize."
        ),
        (
            f"Switch requests: now use region={second.region}, "
            f"tier={second.tier}, channel={second.channel}. Do not finalize "
            "yet."
        ),
        (
            f"Correction: the active region is {task.anchor_region}, not "
            f"{second.region}. Keep the other current fields for now."
        ),
        (
            f"Correction: the active tier is {task.anchor_tier}, not "
            f"{second.tier}. Keep tracking the current request."
        ),
        (
            f"Final correction: the active channel is {task.anchor_channel}, "
            f"not {second.channel}. The active request is now fixed. Do not "
            "output its code yet."
        ),
        side_lookup(side[0]),
        side_lookup(side[1]),
        (
            "For history only: earlier turns mentioned "
            f"region={first.region}, region={second.region}, "
            f"tier={second.tier}, and channel={second.channel}. All of those "
            "are superseded. Confirm the active request is unchanged, without "
            "naming its fields or giving a code."
        ),
        side_lookup(side[2]),
        (
            "Do not change anything. Keep the active request in mind while "
            "handling side questions."
        ),
        side_lookup(side[3]),
        "Return to the active request. Give only its routing code.",
    )


def _tablelast_lookup_turns(
    task: LookupTask, condition: IntentCondition
) -> tuple[str, ...]:
    """Render 12-turn conversations that withhold the table until the end.

    Because no reply can contain any routing code before the final turn, the
    model cannot resolve the answer early and copy it from its own replies.
    It must carry the active request itself across the interference window.
    """
    disjoint = _disjoint_records(task, 6)
    first, second = disjoint[0], disjoint[1]
    side = disjoint[2:6]

    def side_note(record: LookupRecord) -> str:
        return (
            "Side note that does not change the active request: a separate "
            f"ticket mentioned region={record.region}, tier={record.tier}, "
            f"channel={record.channel}. Acknowledge it but do not adopt it."
        )

    final = (
        f"{_lookup_table(task)}\n\nGive only the routing code for the active "
        "request."
    )
    if condition == IntentCondition.REPEAT_TABLELAST:
        return (
            (
                "You will receive the routing table only at the end of this "
                f"conversation. Current request: region={task.anchor_region}, "
                f"tier={task.anchor_tier}, channel={task.anchor_channel}. "
                "Remember it and do not answer until the table arrives."
            ),
            "No routing fields have changed. Keep the original request active.",
            side_note(side[0]),
            "Still no changes to the active request. Do not adopt any "
            "side-note request.",
            side_note(side[1]),
            "Confirm the active request is still the original one, without "
            "naming its fields.",
            side_note(side[2]),
            "For history only: no request has been superseded because none "
            "changed.",
            side_note(side[3]),
            "No value has been superseded. Keep the active request in mind.",
            "The routing table arrives next. Prepare to look up the active "
            "request.",
            final,
        )
    return (
        (
            "You will receive the routing table only at the end of this "
            f"conversation. Start with this request: region={first.region}, "
            f"tier={first.tier}, channel={first.channel}. Remember it and do "
            "not answer until the table arrives."
        ),
        (
            f"Switch requests: now use region={second.region}, "
            f"tier={second.tier}, channel={second.channel}. Do not answer yet."
        ),
        (
            f"Correction: the active region is {task.anchor_region}, not "
            f"{second.region}. Keep the other current fields for now."
        ),
        (
            f"Correction: the active tier is {task.anchor_tier}, not "
            f"{second.tier}. Keep tracking the current request."
        ),
        (
            f"Final correction: the active channel is {task.anchor_channel}, "
            f"not {second.channel}. The active request is now fixed. Continue "
            "to wait for the table."
        ),
        side_note(side[0]),
        side_note(side[1]),
        (
            "For history only: earlier turns mentioned "
            f"region={first.region}, region={second.region}, "
            f"tier={second.tier}, and channel={second.channel}. All of those "
            "are superseded. Confirm the active request is unchanged, without "
            "naming its fields."
        ),
        side_note(side[2]),
        "Do not change anything. Keep the active request in mind while "
        "handling side notes.",
        side_note(side[3]),
        final,
    )


def _lookup_table(task: LookupTask) -> str:
    rows = "\n".join(
        f"- region={row.region}, tier={row.tier}, channel={row.channel} -> {row.code}"
        for row in task.records
    )
    return f"Routing table:\n{rows}"


def _lookup_full_prompt(task: LookupTask) -> str:
    return (
        f"{_lookup_table(task)}\n\n"
        f"Current request: region={task.anchor_region}, tier={task.anchor_tier}, "
        f"channel={task.anchor_channel}. Give only the matching routing code."
    )


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
