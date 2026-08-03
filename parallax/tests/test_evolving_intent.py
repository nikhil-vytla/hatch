from __future__ import annotations

import json
import re

import pytest
from conftest import (
    COUNTERFACTUALS,
    PREDECESSOR,
    SOURCE_ARGUMENTS,
    SOURCE_FUNCTION,
    Constructor,
    Fallback,
    make_family,
    unsafe_problem,
)
from pydantic import TypeAdapter, ValidationError

from parallax.evolving_intent import (
    Argument,
    ConstructionError,
    Event,
    Intent,
    Message,
    Reveal,
    Revise,
    ScheduleError,
    ScriptFamily,
    Switch,
    _apply,
    _fully_revealed,
    _schedule_events,
    _validate_schedule,
    build_script_family,
)
from parallax.gsm8k import Problem
from parallax.types import SourceAnswer, SourceId


def test_three_arms_share_extraction_and_never_render_source_question(
    family: ScriptFamily,
) -> None:
    restored = _fully_revealed(family.source_intent)

    assert family.static.turns[-1].state_after == restored
    assert family.matched.turns[-1].state_after == restored
    assert family.evolved.turns[-1].state_after == restored
    assert SOURCE_FUNCTION in family.static.turns[0].text
    assert all(value in family.static.turns[0].text for _, value in SOURCE_ARGUMENTS)
    assert all(
        len(
            set(re.findall(r"[a-z0-9]+", turn.text.lower()))
            & set(re.findall(r"[a-z0-9]+", family.static.problem.question.lower()))
        )
        / len(set(re.findall(r"[a-z0-9]+", family.static.problem.question.lower())))
        < 0.6
        for script in family.scripts
        for turn in script.turns
    )
    assert all(
        family.static.problem.answer not in turn.text
        for script in family.scripts
        for turn in script.turns
    )
    assert len(family.matched.turns) == len(family.evolved.turns)
    assert sum(family.static.max_output_tokens) == sum(family.evolved.max_output_tokens)
    assert sum(family.matched.max_output_tokens) == sum(
        family.evolved.max_output_tokens
    )
    assert all(
        not isinstance(event, (Revise, Switch))
        for turn in family.matched.turns
        for event in turn.events
    )
    assert all(
        not turn.text.startswith("Correction:")
        and "goal has changed" not in turn.text.lower()
        for turn in family.matched.turns
    )


def test_event_union_has_an_explicit_discriminator() -> None:
    schema = TypeAdapter(Event).json_schema()

    assert schema["discriminator"]["propertyName"] == "kind"


@pytest.mark.parametrize(
    ("arguments", "revealed"),
    [
        (
            (
                Argument(identifier="x", value="1"),
                Argument(identifier="x", value="2"),
            ),
            (),
        ),
        ((Argument(identifier="x", value="1"),), ("unknown",)),
    ],
)
def test_intent_rejects_invalid_identifier_states(
    arguments: tuple[Argument, ...],
    revealed: tuple[str, ...],
) -> None:
    with pytest.raises(ValidationError):
        Intent(
            function="function",
            arguments=arguments,
            revealed_identifiers=revealed,
        )


def test_terminal_restoration_is_final_state_not_switch_position() -> None:
    source = Intent(
        function=SOURCE_FUNCTION,
        arguments=tuple(
            Argument(identifier=key, value=value) for key, value in SOURCE_ARGUMENTS
        ),
        revealed_identifiers=(),
    )
    counterfactuals = tuple(COUNTERFACTUALS.items())
    arguments = tuple(
        Argument(identifier=key, value=value) for key, value in counterfactuals
    )
    events = _schedule_events(source, PREDECESSOR, arguments, 41)
    state = Intent(
        function=PREDECESSOR,
        arguments=arguments,
        revealed_identifiers=(),
    )
    states = []
    for event in events:
        state = _apply(state, event)
        states.append(state)

    assert states[-1] == _fully_revealed(source)
    assert states[-2] != _fully_revealed(source)
    switch_index = next(
        index for index, event in enumerate(events) if isinstance(event, Switch)
    )
    assert any(isinstance(event, Revise) for event in events[switch_index + 1 :])


SOURCE = Intent(
    function=SOURCE_FUNCTION,
    arguments=tuple(
        Argument(identifier=key, value=value) for key, value in SOURCE_ARGUMENTS
    ),
    revealed_identifiers=(),
)
COUNTERFACTUAL_ARGUMENTS = tuple(
    Argument(identifier=key, value=value) for key, value in COUNTERFACTUALS.items()
)
REVEALS = tuple(
    Reveal(identifier=item.identifier, value=item.value)
    for item in COUNTERFACTUAL_ARGUMENTS
)
REVISIONS = tuple(
    Revise(identifier=key, before=COUNTERFACTUALS[key], after=value)
    for key, value in SOURCE_ARGUMENTS
)
SOURCE_SWITCH = Switch(before=PREDECESSOR, after=SOURCE_FUNCTION)


@pytest.mark.parametrize(
    ("events", "message"),
    [
        (
            (REVISIONS[0], *REVEALS, *REVISIONS[1:], SOURCE_SWITCH),
            "revision does not match current state",
        ),
        (
            (
                Reveal(
                    identifier=SOURCE_ARGUMENTS[0][0],
                    value=SOURCE_ARGUMENTS[0][1],
                ),
                *REVEALS[1:],
                SOURCE_SWITCH,
                *REVISIONS,
            ),
            "reveal does not match current state",
        ),
        (
            (SOURCE_SWITCH, *REVEALS, *REVISIONS),
            "before all arguments were revealed",
        ),
        ((*REVEALS, *REVISIONS), "exactly one switch"),
        (
            (*REVEALS, SOURCE_SWITCH, *REVISIONS[:-1]),
            "did not restore",
        ),
        (
            (*REVEALS, SOURCE_SWITCH, *REVISIONS, SOURCE_SWITCH),
            "exactly one switch",
        ),
    ],
)
def test_invalid_schedules_are_domain_errors(
    events: tuple[Reveal | Revise | Switch, ...],
    message: str,
) -> None:
    with pytest.raises(ScheduleError, match=message):
        _validate_schedule(
            SOURCE,
            PREDECESSOR,
            COUNTERFACTUAL_ARGUMENTS,
            events,
        )


def test_switch_before_corrections_is_legal_when_final_state_restores() -> None:
    events = (*REVEALS, SOURCE_SWITCH, *REVISIONS)

    _validate_schedule(SOURCE, PREDECESSOR, COUNTERFACTUAL_ARGUMENTS, events)
    state = Intent(
        function=PREDECESSOR,
        arguments=COUNTERFACTUAL_ARGUMENTS,
        revealed_identifiers=(),
    )
    for event in events:
        state = _apply(state, event)
    assert state == _fully_revealed(SOURCE)


def test_rejected_attempts_and_fallback_are_retained() -> None:
    family, _ = make_family()

    rejected = [attempt for attempt in family.attempts if not attempt.accepted]
    assert len(rejected) == 2
    assert all(attempt.stage == "predecessor" for attempt in rejected)
    assert family.attempts[-1].accepted
    assert family.attempts[-1].model == "offline-fallback"


def test_accepted_primary_predecessor_does_not_call_fallback() -> None:
    class Primary(Constructor):
        def __call__(self, messages: tuple[Message, ...], budget: int) -> str:
            if messages[0].content.startswith("parallax-stage:predecessor"):
                return json.dumps(
                    {"function": PREDECESSOR, "rationale": "accepted primary"}
                )
            return super().__call__(messages, budget)

    def forbidden_fallback(messages: tuple[Message, ...], budget: int) -> str:
        raise AssertionError("fallback called after accepted primary")

    build_script_family(
        Problem(
            record_id=SourceId("primary"),
            question="Question?",
            answer=SourceAnswer("1"),
        ),
        Primary(),
        fallback=forbidden_fallback,
        seed=3,
        construction_model="primary",
        fallback_model="forbidden",
    )


def test_unchanged_counterfactuals_exhaust_bounded_attempts() -> None:
    class Unchanged(Constructor):
        def __call__(self, messages: tuple[Message, ...], budget: int) -> str:
            if messages[0].content.startswith("parallax-stage:counterfactual"):
                payload = json.loads(messages[1].content)
                return json.dumps(
                    {
                        "identifier": payload["identifier"],
                        "value": payload["source_value"],
                        "rationale": "unchanged",
                    }
                )
            return super().__call__(messages, budget)

    with pytest.raises(ConstructionError, match="counterfactual: attempts exhausted"):
        build_script_family(
            Problem(
                record_id=SourceId("unchanged"),
                question="Question?",
                answer=SourceAnswer("1"),
            ),
            Unchanged(),
            seed=3,
            construction_model="unchanged",
        )


def test_same_seed_produces_equal_scripts() -> None:
    first, _ = make_family(seed=9)
    second, _ = make_family(seed=9)

    assert first == second


def test_construction_does_not_read_sealed_answer() -> None:
    class AnswerTrap:
        def __str__(self) -> str:
            raise AssertionError("construction read the answer")

        def __eq__(self, other: object) -> bool:
            raise AssertionError("construction compared the answer")

    problem = unsafe_problem("trap", "A standalone source question.", AnswerTrap())
    family = build_script_family(
        problem,
        Constructor(),
        fallback=Fallback(),
        seed=3,
        construction_model="offline-constructor",
        fallback_model="offline-fallback",
    )

    assert family.static.problem is problem


def test_strict_stage_json_fails_with_stage_name() -> None:
    def malformed(messages: tuple[Message, ...], budget: int) -> str:
        return "not-json"

    with pytest.raises(ConstructionError, match="extract-intent: Invalid JSON"):
        build_script_family(
            Problem(
                record_id=SourceId("bad"),
                question="Question without the answer.",
                answer=SourceAnswer("1"),
            ),
            malformed,
            seed=0,
            construction_model="malformed",
        )


@pytest.mark.parametrize(
    "payload",
    [
        {"function": SOURCE_FUNCTION, "arguments": [], "extra": True},
        {"function": 1, "arguments": []},
    ],
)
def test_construction_boundary_is_strict_and_forbids_extras(
    payload: dict[str, object],
) -> None:
    def invalid(messages: tuple[Message, ...], budget: int) -> str:
        return json.dumps(payload)

    with pytest.raises(ConstructionError, match="extract-intent"):
        build_script_family(
            Problem(
                record_id=SourceId("strict"),
                question="Question?",
                answer=SourceAnswer("1"),
            ),
            invalid,
            seed=0,
            construction_model="strict",
        )
