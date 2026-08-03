from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from parallax.evolving_intent import Message, ScriptFamily, build_script_family
from parallax.gsm8k import Problem, load_gsm8k
from parallax.types import SourceId

FIXTURE = Path(__file__).parent / "fixtures" / "gsm8k.jsonl"
SOURCE_FUNCTION = "calculate daily egg-sale revenue"
PREDECESSOR = "calculate eggs available to sell"
SOURCE_ARGUMENTS = (
    ("eggs_per_day", "16"),
    ("eggs_eaten", "3"),
    ("eggs_baked", "4"),
    ("price_per_egg", "2 dollars"),
)
COUNTERFACTUALS = {
    "eggs_per_day": "12",
    "eggs_eaten": "2",
    "eggs_baked": "5",
    "price_per_egg": "3 dollars",
}


class Constructor:
    def __init__(self) -> None:
        self.calls: list[tuple[tuple[Message, ...], int]] = []

    def __call__(self, messages: tuple[Message, ...], budget: int) -> str:
        self.calls.append((messages, budget))
        stage = messages[0].content.splitlines()[0]
        payload = json.loads(messages[1].content)
        if stage == "parallax-stage:extract-intent":
            return json.dumps(
                {
                    "function": SOURCE_FUNCTION,
                    "arguments": [
                        {"identifier": key, "value": value}
                        for key, value in SOURCE_ARGUMENTS
                    ],
                }
            )
        if stage == "parallax-stage:counterfactual":
            identifier = payload["identifier"]
            return json.dumps(
                {
                    "identifier": identifier,
                    "value": COUNTERFACTUALS[identifier],
                    "rationale": "offline deterministic candidate",
                }
            )
        if stage == "parallax-stage:predecessor":
            return json.dumps(
                {
                    "function": SOURCE_FUNCTION,
                    "rationale": "deliberate rejected same-function candidate",
                }
            )
        raise AssertionError(stage)


class Fallback:
    def __call__(self, messages: tuple[Message, ...], budget: int) -> str:
        assert messages[0].content.startswith("parallax-stage:predecessor")
        return json.dumps(
            {
                "function": PREDECESSOR,
                "rationale": "available eggs precede sale revenue",
            }
        )


def _answer_from(messages: tuple[Message, ...]) -> str:
    values: dict[str, int] = {}
    goal = False
    for message in messages:
        if message.role != "user":
            continue
        goal = goal or SOURCE_FUNCTION in message.content
        for identifier, _ in SOURCE_ARGUMENTS:
            name = identifier.replace("_", " ")
            patterns = (
                rf"Use {re.escape(name)}: (-?[0-9]+)",
                rf"Correction: change {re.escape(name)} from .* to (-?[0-9]+)",
            )
            for pattern in patterns:
                if match := re.search(pattern, message.content):
                    values[identifier] = int(match.group(1))
    if not goal or set(values) != {key for key, _ in SOURCE_ARGUMENTS}:
        return "0"
    answer = (
        values["eggs_per_day"] - values["eggs_eaten"] - values["eggs_baked"]
    ) * values["price_per_egg"]
    return str(answer)


class HistoryAgent:
    def __call__(self, messages: tuple[Message, ...], budget: int) -> str:
        return f"FINAL_ANSWER: {_answer_from(messages)}"


class LastMessageAgent:
    def __call__(self, messages: tuple[Message, ...], budget: int) -> str:
        return f"FINAL_ANSWER: {_answer_from((messages[-1],))}"


def unsafe_problem(
    record_id: str,
    question: str,
    answer: object,
) -> Problem:
    return Problem.model_construct(
        record_id=SourceId(record_id),
        question=question,
        answer=answer,
    )


def make_family(
    *,
    seed: int = 41,
    source_id: str = "gsm8k-1",
    problem: Problem | None = None,
) -> tuple[ScriptFamily, Constructor]:
    selected = problem or load_gsm8k(FIXTURE)[0]
    if selected.record_id != source_id:
        selected = Problem(
            record_id=SourceId(source_id),
            question=selected.question,
            answer=selected.answer,
        )
    constructor = Constructor()
    family = build_script_family(
        selected,
        constructor,
        fallback=Fallback(),
        seed=seed,
        construction_model="offline-constructor",
        fallback_model="offline-fallback",
    )
    return family, constructor


@pytest.fixture
def family() -> ScriptFamily:
    return make_family()[0]
