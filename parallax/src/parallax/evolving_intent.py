from __future__ import annotations

import json
import random
from collections.abc import Callable
from typing import (
    Annotated,
    Literal,
    Self,
    TypeAlias,
    TypeVar,
    assert_never,
)

from pydantic import Field, TypeAdapter, ValidationError, model_validator

from .gsm8k import Problem
from .types import ConstructionSeed, NonEmptyText, StrictModel

Arm: TypeAlias = Literal["static", "matched", "evolved"]
Role: TypeAlias = Literal["system", "user", "assistant"]
Stage: TypeAlias = Literal["extract-intent", "counterfactual", "predecessor"]
PositiveBudget = Annotated[int, Field(gt=0)]


class ConstructionError(ValueError):
    pass


class ScheduleError(ConstructionError):
    pass


class Message(StrictModel):
    role: Role
    content: str


Chat: TypeAlias = Callable[[tuple[Message, ...], int], str]


class Argument(StrictModel):
    identifier: NonEmptyText
    value: NonEmptyText


class Intent(StrictModel):
    function: NonEmptyText
    arguments: tuple[Argument, ...]
    revealed_identifiers: tuple[str, ...]

    @model_validator(mode="after")
    def valid_identifiers(self) -> Self:
        identifiers = tuple(argument.identifier for argument in self.arguments)
        if len(set(identifiers)) != len(identifiers):
            raise ValueError("intent argument identifiers must be unique")
        if len(set(self.revealed_identifiers)) != len(self.revealed_identifiers):
            raise ValueError("revealed identifiers must be unique")
        if not set(self.revealed_identifiers) <= set(identifiers):
            raise ValueError("revealed identifiers must name intent arguments")
        return self


class Reveal(StrictModel):
    kind: Literal["reveal"] = "reveal"
    identifier: str
    value: str


class Revise(StrictModel):
    kind: Literal["revise"] = "revise"
    identifier: str
    before: str
    after: str


class Switch(StrictModel):
    kind: Literal["switch"] = "switch"
    before: str
    after: str


Event: TypeAlias = Annotated[Reveal | Revise | Switch, Field(discriminator="kind")]


class Turn(StrictModel):
    text: str
    events: tuple[Event, ...]
    state_after: Intent


class Script(StrictModel):
    arm: Arm
    problem: Problem
    turns: tuple[Turn, ...]
    max_output_tokens: tuple[PositiveBudget, ...]

    @model_validator(mode="after")
    def aligned_turn_budgets(self) -> Self:
        if not self.turns or len(self.turns) != len(self.max_output_tokens):
            raise ValueError("script turns and budgets must be non-empty and aligned")
        return self


class GenerationAttempt(StrictModel):
    stage: Stage
    target: str
    model: str
    output: str
    accepted: bool
    reason: str


class ScriptFamily(StrictModel):
    source_intent: Intent
    static: Script
    matched: Script
    evolved: Script
    construction_seed: ConstructionSeed
    construction_model: str
    fallback_model: str | None
    attempts: tuple[GenerationAttempt, ...]

    @model_validator(mode="after")
    def controlled_arms(self) -> Self:
        scripts = self.scripts
        if tuple(script.arm for script in scripts) != (
            "static",
            "matched",
            "evolved",
        ):
            raise ValueError(
                "script family must contain static, matched, and evolved arms"
            )
        if any(script.problem != self.static.problem for script in scripts):
            raise ValueError("script family arms must share one problem")
        if (
            len(self.matched.turns) != len(self.evolved.turns)
            or self.matched.max_output_tokens != self.evolved.max_output_tokens
        ):
            raise ValueError("matched and evolved arms must share turn budgets")
        return self

    @property
    def scripts(self) -> tuple[Script, Script, Script]:
        return self.static, self.matched, self.evolved


class _ExtractIntent(StrictModel):
    function: NonEmptyText
    arguments: tuple[Argument, ...]

    @model_validator(mode="after")
    def unique_arguments(self) -> Self:
        identifiers = tuple(argument.identifier for argument in self.arguments)
        if len(set(identifiers)) != len(identifiers):
            raise ValueError("extract-intent: argument identifiers must be unique")
        return self


class _Counterfactual(StrictModel):
    identifier: NonEmptyText
    value: NonEmptyText
    rationale: str


class _Predecessor(StrictModel):
    function: NonEmptyText
    rationale: str


T = TypeVar("T")
M = TypeVar("M", bound=StrictModel)
_TEXT = TypeAdapter(str)


def _request(chat: Chat, stage: Stage, payload: dict[str, object], budget: int) -> str:
    messages = (
        Message(
            role="system",
            content=f"parallax-stage:{stage}\nReturn one strict JSON object.",
        ),
        Message(
            role="user",
            content=json.dumps(payload, sort_keys=True, separators=(",", ":")),
        ),
    )
    try:
        return _TEXT.validate_python(chat(messages, budget), strict=True)
    except ValidationError as error:
        raise ConstructionError(
            f"{stage}: provider returned non-text output"
        ) from error


def _parse_model(model: type[M], output: str, stage: Stage) -> M:
    try:
        return model.model_validate_json(output)
    except ValidationError as error:
        detail = error.errors(include_url=False)[0]["msg"]
        raise ConstructionError(f"{stage}: {detail}") from error


def _attempt(
    stage: Stage,
    target: str,
    payload: dict[str, object],
    providers: tuple[tuple[Chat, str, int], ...],
    accept: Callable[[str], tuple[T, str]],
    budget: int,
) -> tuple[T, tuple[GenerationAttempt, ...]]:
    evidence: list[GenerationAttempt] = []
    last_error = ""
    for provider, model, count in providers:
        for _ in range(count):
            output = _request(provider, stage, payload, budget)
            try:
                candidate, reason = accept(output)
            except (ConstructionError, ValueError) as error:
                last_error = str(error)
                evidence.append(
                    GenerationAttempt(
                        stage=stage,
                        target=target,
                        model=model,
                        output=output,
                        accepted=False,
                        reason=str(error),
                    )
                )
                continue
            evidence.append(
                GenerationAttempt(
                    stage=stage,
                    target=target,
                    model=model,
                    output=output,
                    accepted=True,
                    reason=reason,
                )
            )
            return candidate, tuple(evidence)
    raise ConstructionError(
        f"{stage}: attempts exhausted for {target}; last rejection: {last_error}"
    )


def _parse_intent(output: str) -> tuple[Intent, str]:
    value = _parse_model(_ExtractIntent, output, "extract-intent")
    return (
        Intent(
            function=value.function,
            arguments=value.arguments,
            revealed_identifiers=(),
        ),
        "schema accepted",
    )


def _counterfactual_parser(
    identifier: str, source_value: str
) -> Callable[[str], tuple[Argument, str]]:
    def parse(output: str) -> tuple[Argument, str]:
        value = _parse_model(_Counterfactual, output, "counterfactual")
        if value.identifier != identifier:
            raise ConstructionError("counterfactual: identifier is invalid")
        if value.value == source_value:
            raise ConstructionError("counterfactual: value did not change")
        return (
            Argument(identifier=value.identifier, value=value.value),
            f"changed value: {value.rationale}",
        )

    return parse


def _predecessor_parser(source: Intent) -> Callable[[str], tuple[str, str]]:
    def parse(output: str) -> tuple[str, str]:
        value = _parse_model(_Predecessor, output, "predecessor")
        if value.function == source.function:
            raise ConstructionError("predecessor: function did not change")
        return value.function, f"immediate successor is coherent: {value.rationale}"

    return parse


def _fully_revealed(source: Intent) -> Intent:
    return Intent(
        function=source.function,
        arguments=source.arguments,
        revealed_identifiers=tuple(
            argument.identifier for argument in source.arguments
        ),
    )


def _schedule_events(
    source: Intent,
    predecessor: str,
    counterfactuals: tuple[Argument, ...],
    seed: ConstructionSeed,
) -> tuple[Event, ...]:
    if tuple(item.identifier for item in counterfactuals) != tuple(
        item.identifier for item in source.arguments
    ):
        raise ScheduleError("counterfactual identifiers must match source order")
    source_values = {item.identifier: item.value for item in source.arguments}
    reveals = {
        f"r:{item.identifier}": Reveal(
            identifier=item.identifier,
            value=item.value,
        )
        for item in counterfactuals
    }
    revisions = {
        f"c:{item.identifier}": Revise(
            identifier=item.identifier,
            before=item.value,
            after=source_values[item.identifier],
        )
        for item in counterfactuals
        if item.value != source_values[item.identifier]
    }
    events: dict[str, Event] = {
        **reveals,
        **revisions,
        "s": Switch(before=predecessor, after=source.function),
    }
    dependencies = {key: set() for key in reveals}
    dependencies.update(
        {key: {f"r:{event.identifier}"} for key, event in revisions.items()}
    )
    dependencies["s"] = set(reveals)
    pending, done, ordered = set(events), set(), []
    rng = random.Random(seed)
    while pending:
        ready = sorted(key for key in pending if dependencies[key] <= done)
        if not ready:
            raise ScheduleError("event dependencies contain a cycle")
        key = ready[rng.randrange(len(ready))]
        ordered.append(events[key])
        pending.remove(key)
        done.add(key)
    return tuple(ordered)


def _apply(state: Intent, event: Event) -> Intent:
    arguments = {item.identifier: item.value for item in state.arguments}
    revealed = set(state.revealed_identifiers)
    function = state.function
    if isinstance(event, Reveal):
        if event.identifier not in arguments:
            raise ScheduleError(f"reveal names unknown argument {event.identifier}")
        if event.identifier in revealed or arguments[event.identifier] != event.value:
            raise ScheduleError("reveal does not match current state")
        revealed.add(event.identifier)
    elif isinstance(event, Revise):
        if event.identifier not in arguments:
            raise ScheduleError(f"revision names unknown argument {event.identifier}")
        wrong_value = arguments[event.identifier] != event.before
        if event.identifier not in revealed or wrong_value:
            raise ScheduleError("revision does not match current state")
        arguments[event.identifier] = event.after
    elif isinstance(event, Switch):
        if function != event.before:
            raise ScheduleError("switch does not match current function")
        function = event.after
    else:
        assert_never(event)
    ordered = tuple(
        Argument(identifier=item.identifier, value=arguments[item.identifier])
        for item in state.arguments
    )
    revealed_order = tuple(
        item.identifier for item in state.arguments if item.identifier in revealed
    )
    return Intent(
        function=function,
        arguments=ordered,
        revealed_identifiers=revealed_order,
    )


def _validate_schedule(
    source: Intent,
    predecessor: str,
    counterfactuals: tuple[Argument, ...],
    events: tuple[Event, ...],
) -> None:
    switches = [event for event in events if isinstance(event, Switch)]
    if len(switches) != 1:
        raise ScheduleError("schedule must contain exactly one switch")
    state = Intent(
        function=predecessor,
        arguments=counterfactuals,
        revealed_identifiers=(),
    )
    identifiers = {item.identifier for item in source.arguments}
    for event in events:
        if isinstance(event, Switch) and set(state.revealed_identifiers) != identifiers:
            raise ScheduleError("switch occurred before all arguments were revealed")
        state = _apply(state, event)
    if state != _fully_revealed(source):
        raise ScheduleError("schedule did not restore the fully revealed source intent")


def _render_event(before: Intent, event: Event, first: bool) -> str:
    if isinstance(event, Reveal):
        name = event.identifier.replace("_", " ")
        prefix = f"I need help with {before.function}. " if first else ""
        return f"{prefix}Use {name}: {event.value}."
    if isinstance(event, Revise):
        name = event.identifier.replace("_", " ")
        return f"Correction: change {name} from {event.before} to {event.after}."
    if isinstance(event, Switch):
        return (
            f"My goal has changed from {event.before} to {event.after}. "
            "Use the values from the conversation."
        )
    assert_never(event)


def _turns(initial: Intent, events: tuple[Event, ...]) -> tuple[Turn, ...]:
    if not events:
        details = " ".join(
            f"Use {item.identifier.replace('_', ' ')}: {item.value}."
            for item in initial.arguments
        )
        return (
            Turn(
                text=f"I need help with {initial.function}. {details}",
                events=(),
                state_after=initial,
            ),
        )
    state, turns = initial, []
    for index, event in enumerate(events):
        text = _render_event(state, event, index == 0)
        state = _apply(state, event)
        turns.append(Turn(text=text, events=(event,), state_after=state))
    return tuple(turns)


def _matched_turns(source: Intent, count: int) -> tuple[Turn, ...]:
    state = Intent(
        function=source.function,
        arguments=source.arguments,
        revealed_identifiers=(),
    )
    turns: list[Turn] = []
    for index in range(count):
        if index < len(source.arguments):
            argument = source.arguments[index]
            event = Reveal(identifier=argument.identifier, value=argument.value)
            text = _render_event(state, event, index == 0)
            state = _apply(state, event)
            turns.append(Turn(text=text, events=(event,), state_after=state))
        else:
            turns.append(
                Turn(
                    text="Keep the same goal and values from the conversation.",
                    events=(),
                    state_after=state,
                )
            )
    return tuple(turns)


def build_script_family(
    problem: Problem,
    primary: Chat,
    *,
    seed: int,
    construction_model: str,
    fallback: Chat | None = None,
    fallback_model: str | None = None,
    max_output_tokens: int = 64,
) -> ScriptFamily:
    source, attempts = _attempt(
        "extract-intent",
        problem.record_id,
        {"question": problem.question},
        ((primary, construction_model, 1),),
        _parse_intent,
        256,
    )
    counterfactuals: list[Argument] = []
    evidence = list(attempts)
    for argument in source.arguments:
        candidate, attempts = _attempt(
            "counterfactual",
            argument.identifier,
            {
                "function": source.function,
                "identifier": argument.identifier,
                "source_value": argument.value,
            },
            ((primary, construction_model, 2),),
            _counterfactual_parser(argument.identifier, argument.value),
            128,
        )
        counterfactuals.append(candidate)
        evidence.extend(attempts)
    providers = [(primary, construction_model, 2)]
    if fallback is not None:
        providers.append((fallback, fallback_model or "fallback", 1))
    predecessor, attempts = _attempt(
        "predecessor",
        source.function,
        {
            "successor_function": source.function,
            "arguments": [item.model_dump(mode="json") for item in counterfactuals],
        },
        tuple(providers),
        _predecessor_parser(source),
        128,
    )
    evidence.extend(attempts)
    counterfactual_tuple = tuple(counterfactuals)
    construction_seed = ConstructionSeed(seed)
    events = _schedule_events(
        source,
        predecessor,
        counterfactual_tuple,
        construction_seed,
    )
    _validate_schedule(source, predecessor, counterfactual_tuple, events)
    evolved_turns = _turns(
        Intent(
            function=predecessor,
            arguments=counterfactual_tuple,
            revealed_identifiers=(),
        ),
        events,
    )
    restored = _fully_revealed(source)
    matched_turns = _matched_turns(source, len(evolved_turns))
    budget = tuple(max_output_tokens for _ in evolved_turns)
    static = Script(
        arm="static",
        problem=problem,
        turns=_turns(restored, ()),
        max_output_tokens=(sum(budget),),
    )
    matched = Script(
        arm="matched",
        problem=problem,
        turns=matched_turns,
        max_output_tokens=budget,
    )
    evolved = Script(
        arm="evolved",
        problem=problem,
        turns=evolved_turns,
        max_output_tokens=budget,
    )
    if matched.turns[-1].state_after != restored:
        raise ConstructionError("matched trajectory did not reveal the source intent")
    return ScriptFamily(
        source_intent=source,
        static=static,
        matched=matched,
        evolved=evolved,
        construction_seed=construction_seed,
        construction_model=construction_model,
        fallback_model=fallback_model,
        attempts=tuple(evidence),
    )
