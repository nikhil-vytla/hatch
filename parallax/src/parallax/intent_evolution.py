"""Reference-based perturbation: reach one task through an evolving intent.

Every condition ends at the same task with the same total headroom, so the only
difference is the route:

- `base` states the fully revealed intent in one turn.
- `matched` reveals one true argument per turn, so it is spread over the same
  number of turns as `evolved` and information accumulates, but nothing is ever
  wrong and the goal never moves. This is the offered control.
- `evolved` starts from a plausible predecessor goal with counterfactual
  argument values, then reveals, revises, and finally switches goals until it
  has restored exactly the reference intent.

`matched` is what makes a result mean something. A live 1,296-episode GSM8K
round measured `evolved` at 0.109 below `base` with a 95% interval of
[-0.160, -0.060]; against `matched` that decomposes into -0.086 from multi-turn
presentation alone and -0.023 from intent evolution on top, the latter spanning
zero. A two-arm design would have credited the entire drop to the manipulation.
It is offered rather than required because at three sources the same control
buys nothing but cost.

This module knows nothing about which benchmark supplied the reference text.
It previously imported `gsm8k.Problem` and typed its scripts against it, which
is why "the generic strategy" only ever worked on one benchmark.
"""

from __future__ import annotations

import json
import random
from collections.abc import Callable
from typing import Annotated, Literal, Self, TypeAlias, TypeVar, assert_never

from pydantic import Field, TypeAdapter, ValidationError, model_validator

from .canonical import canonical_bytes
from .perturbation import (
    Condition,
    GenerationRecord,
    Turn,
    Variant,
    VariantSet,
)
from .provider import Chat, Message, json_schema_instructions, unfence
from .task import AgentContract
from .types import (
    ConstructionSeed,
    DigestText,
    NonEmptyText,
    SourceId,
    StrictModel,
)

ModelT = TypeVar("ModelT", bound=StrictModel)
ValueT = TypeVar("ValueT")

BASE = Condition("base")
MATCHED = Condition("matched")
EVOLVED = Condition("evolved")
Stage: TypeAlias = Literal["extract-intent", "counterfactual", "predecessor"]


class ConstructionError(ValueError):
    pass


class ScheduleError(ConstructionError):
    pass


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


_TEXT = TypeAdapter(str)


def _request(
    chat: Chat,
    stage: Stage,
    payload: dict[str, object],
    budget: int,
    reply: type[StrictModel],
) -> str:
    messages = (
        Message(
            role="system",
            content=(
                f"parallax-stage:{stage}\n"
                + json_schema_instructions(reply, f"You are the {stage} stage.")
            ),
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


def _parse_model(model: type[ModelT], output: str, stage: Stage) -> ModelT:
    try:
        return model.model_validate_json(unfence(output))
    except ValidationError as error:
        detail = error.errors(include_url=False)[0]["msg"]
        raise ConstructionError(f"{stage}: {detail}") from error


def _attempt(
    stage: Stage,
    target: str,
    payload: dict[str, object],
    providers: tuple[tuple[Chat, str, int], ...],
    accept: Callable[[str], tuple[ValueT, str]],
    budget: int,
    reply: type[StrictModel],
) -> tuple[ValueT, tuple[GenerationRecord, ...]]:
    evidence: list[GenerationRecord] = []
    last_error = ""
    for provider, model, count in providers:
        for _ in range(count):
            output = _request(provider, stage, payload, budget, reply)
            try:
                candidate, reason = accept(output)
            except (ConstructionError, ValueError) as error:
                last_error = str(error)
                evidence.append(
                    GenerationRecord(
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
                GenerationRecord(
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


def _texts(initial: Intent, events: tuple[Event, ...]) -> tuple[str, ...]:
    if not events:
        details = " ".join(
            f"Use {item.identifier.replace('_', ' ')}: {item.value}."
            for item in initial.arguments
        )
        return (f"I need help with {initial.function}. {details}",)
    state, texts = initial, []
    for index, event in enumerate(events):
        texts.append(_render_event(state, event, index == 0))
        state = _apply(state, event)
    return tuple(texts)


def _matched_texts(source: Intent, count: int) -> tuple[str, ...]:
    """Reveal one true argument per turn: same shape as evolved, no manipulation.

    This is the reference semantics for a presentation-matched control, and it is
    what the documented design always said. The SWE-bench adapter shipped its own
    `matched` that delivered the whole issue statement in every turn, so nothing
    accumulated and the arm measured nothing; the admission gate compared turn
    counts and per-turn budgets, so it could not tell the two apart. Two
    benchmarks diverged silently under one name — which is the argument for one
    perturbation module rather than one per benchmark.
    """

    state = Intent(
        function=source.function,
        arguments=source.arguments,
        revealed_identifiers=(),
    )
    texts: list[str] = []
    for index in range(count):
        if index < len(source.arguments):
            argument = source.arguments[index]
            event = Reveal(identifier=argument.identifier, value=argument.value)
            texts.append(_render_event(state, event, index == 0))
            state = _apply(state, event)
        else:
            texts.append("Keep the same goal and values from the conversation.")
    return tuple(texts)


def build_intent_variants(
    task_id: SourceId,
    reference_text: str,
    reference_digest: DigestText,
    primary: Chat,
    *,
    seed: int,
    construction_model: str,
    agent_contract: AgentContract,
    fallback: Chat | None = None,
    fallback_model: str | None = None,
    headroom_per_turn: int = 64,
) -> VariantSet:
    """Build `base`, `matched`, and `evolved` for one reference task.

    All three are constructed because constructing them is free; which of them
    an experiment pays to run is `ExperimentConfig.conditions`.
    """

    source, attempts = _attempt(
        "extract-intent",
        task_id,
        {"question": reference_text},
        ((primary, construction_model, 1),),
        _parse_intent,
        256,
        _ExtractIntent,
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
            _Counterfactual,
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
        _Predecessor,
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
    evolved_texts = _texts(
        Intent(
            function=predecessor,
            arguments=counterfactual_tuple,
            revealed_identifiers=(),
        ),
        events,
    )
    turn_count = len(evolved_texts)
    total_headroom = headroom_per_turn * turn_count

    def condition(name: Condition, texts: tuple[str, ...]) -> Variant:
        per_turn = total_headroom // len(texts)
        return Variant(
            condition=name,
            turns=tuple(
                Turn(
                    text=text,
                    headroom=(
                        per_turn
                        if index < len(texts) - 1
                        else total_headroom - per_turn * (len(texts) - 1)
                    ),
                )
                for index, text in enumerate(texts)
            ),
        )

    return VariantSet(
        task_id=task_id,
        provenance="reference_based",
        agent_contract=agent_contract,
        reference_digest=reference_digest,
        construction_seed=construction_seed,
        variants=(
            condition(BASE, _texts(_fully_revealed(source), ())),
            condition(MATCHED, _matched_texts(source, turn_count)),
            condition(EVOLVED, evolved_texts),
        ),
        control=MATCHED,
        evidence=(
            *evidence,
            GenerationRecord(
                stage="schedule",
                target=str(task_id),
                model=construction_model,
                output="",
                accepted=True,
                reason=f"{len(events)} scheduled events restored the source intent",
                payload=canonical_bytes(
                    {
                        "source_intent": source.model_dump(mode="json"),
                        "predecessor": predecessor,
                        "events": [event.model_dump(mode="json") for event in events],
                    }
                ).decode(),
            ),
        ),
    )
