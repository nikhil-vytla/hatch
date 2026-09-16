"""Reference-based perturbation: reach one issue through predecessor phases.

Three conditions, all ending at the same issue with the same total steps and
headroom:

- `base` delivers the issue and its extracted intent in one turn.
- `matched` spreads the same true intent over the same number of turns as
  `evolved`, revealing one argument per turn. The goal never moves and nothing
  is ever wrong, so it isolates the cost of multi-turn presentation.
- `evolved` works toward intermediate predecessor intents first, then receives
  the full issue.

The previous `matched` here delivered the whole issue statement in every turn,
so nothing accumulated and the arm measured nothing, while GSM8K's `matched`
did implement the documented progressive reveal. Two adapters diverged silently
under one name because admission compared turn counts and per-turn budgets
rather than what the turns said. GSM8K's semantics are the reference, and
`_reveal_texts` below is the same construction. The old `base` also carried no
rendered intent at all, so it did not share an extracted intent with the
multi-turn arms as documented; it does now.
"""

from __future__ import annotations

import json
from typing import Annotated, Literal, Self, TypeAlias

from pydantic import Field, ValidationError, field_validator, model_validator

from .canonical import canonical_bytes
from .perturbation import (
    Condition,
    GenerationRecord,
    Turn,
    Variant,
    VariantSet,
)
from .provider import Chat, Message, json_schema_instructions, unfence
from .swebench import SweBenchError, SweBenchTask, SweBenchVerifier
from .types import NonEmptyText, StrictModel

BASE = Condition("base")
MATCHED = Condition("matched")
EVOLVED = Condition("evolved")
ArgumentCategory: TypeAlias = Literal[
    "symptom",
    "context",
    "constraint",
    "implementation",
]


class PhaseArgument(StrictModel):
    identifier: NonEmptyText
    value: NonEmptyText
    category: ArgumentCategory

    @field_validator("value", mode="before")
    @classmethod
    def scalar_value_as_text(cls, value: object) -> object:
        if isinstance(value, bool | int | float):
            return json.dumps(value, allow_nan=False, separators=(",", ":"))
        return value


class PhaseIntent(StrictModel):
    function: NonEmptyText
    arguments: tuple[PhaseArgument, ...]

    @model_validator(mode="after")
    def unique_arguments(self) -> Self:
        identifiers = tuple(argument.identifier for argument in self.arguments)
        if len(set(identifiers)) != len(identifiers):
            raise ValueError("intent argument identifiers must be unique")
        return self


class PhaseConstruction(StrictModel):
    source: PhaseIntent
    predecessors: Annotated[tuple[PhaseIntent, ...], Field(min_length=1)]

    @model_validator(mode="after")
    def changing_functions(self) -> Self:
        functions = tuple(item.function for item in (*self.predecessors, self.source))
        if len(set(functions)) != len(functions):
            raise ValueError("predecessor functions must be distinct")
        return self

    @property
    def phases(self) -> tuple[PhaseIntent, ...]:
        return (*self.predecessors, self.source)


_CONSTRUCTION_INSTRUCTIONS = json_schema_instructions(
    PhaseConstruction,
    "Extract one source software intent and one immediate predecessor. "
    "Every argument value is a JSON string, including booleans and numbers.",
)


def construct_phases(
    task: SweBenchTask,
    chat: Chat,
    *,
    model: str,
    max_output_tokens: int = 1024,
) -> tuple[PhaseConstruction, GenerationRecord]:
    """Ask a construction model to decompose one public issue into phases.

    Only public material crosses into the prompt; the sealed verifier is not
    reachable from `task.problem_statement`, `task.repo`, or the instance id.
    """

    messages = (
        Message(role="system", content=_CONSTRUCTION_INSTRUCTIONS),
        Message(
            role="user",
            content=json.dumps(
                {
                    "instance_id": task.instance_id,
                    "problem_statement": task.problem_statement,
                    "repo": task.repo,
                },
                sort_keys=True,
                separators=(",", ":"),
            ),
        ),
    )
    output = chat(messages, max_output_tokens)
    try:
        construction = PhaseConstruction.model_validate_json(unfence(output))
    except ValidationError as error:
        detail = error.errors(include_url=False)[0]["msg"]
        raise SweBenchError(f"phase construction is invalid: {detail}") from error
    return construction, GenerationRecord(
        stage="construct-phases",
        target=str(task.instance_id),
        model=model,
        output=output,
        accepted=True,
        reason=f"{len(construction.predecessors)} predecessor phase(s) accepted",
        payload=canonical_bytes(construction).decode(),
    )


def sealed_text_fragments(verifier: SweBenchVerifier, public: str) -> tuple[str, ...]:
    """Sealed strings that must never appear in a turn the agent reads.

    Test identifiers already named by the public issue are excluded: the issue
    is public by construction, and treating its own words as a leak would make
    every instance that cites a failing test unusable.
    """

    derived = (
        value
        for value in (*verifier.fail_to_pass, *verifier.pass_to_pass)
        if value and value not in public
    )
    return (verifier.test_patch, *derived)


def _ordered(intent: PhaseIntent) -> tuple[PhaseArgument, ...]:
    symptoms = tuple(
        argument for argument in intent.arguments if argument.category == "symptom"
    )
    scheduled = tuple(
        argument for argument in intent.arguments if argument.category != "symptom"
    )
    return (*symptoms, *scheduled)


def _render_arguments(intent: PhaseIntent) -> str:
    return " ".join(
        f"{argument.identifier.replace('_', ' ')}: {argument.value}."
        for argument in _ordered(intent)
    )


def _allocate_steps(total: int, turns: int) -> tuple[int, ...]:
    if total < turns:
        raise SweBenchError("total agent steps must cover every turn")
    base, remainder = divmod(total, turns)
    return tuple(base + int(index < remainder) for index in range(turns))


def _final_text(task: SweBenchTask, intent: PhaseIntent, closing: str) -> str:
    return (
        f"{task.problem_statement}\n\n"
        f"The final intent is {intent.function}. "
        f"{_render_arguments(intent)} {closing}"
    )


def _reveal_texts(
    task: SweBenchTask,
    source: PhaseIntent,
    count: int,
) -> tuple[str, ...]:
    """One true argument per turn: GSM8K's `matched` semantics, on an issue.

    The goal is stated up front and never moves; only the constraints accumulate.
    The last turn hands over the full issue statement, so this condition and
    `base` agree on the material the agent finally has.
    """

    arguments = _ordered(source)
    texts: list[str] = []
    for index in range(count - 1):
        if index < len(arguments):
            argument = arguments[index]
            identifier = argument.identifier.replace("_", " ")
            texts.append(
                f"The goal is {source.function}. So far you know one constraint: "
                f"{identifier}: {argument.value}. "
                "Do not implement the final issue yet."
            )
        else:
            texts.append(
                f"The goal is still {source.function} under the constraints "
                "already given. Do not implement the final issue yet."
            )
    texts.append(_final_text(task, source, "Implement it now and run focused tests."))
    return tuple(texts)


def build_phase_variants(
    task: SweBenchTask,
    construction: PhaseConstruction,
    *,
    total_agent_steps: int,
    max_output_tokens: int,
) -> VariantSet:
    phases = construction.phases
    evolved_texts = tuple(
        (
            f"Work toward this intermediate intent: {intent.function}. "
            f"{_render_arguments(intent)} Do not implement the final issue yet."
            if index < len(phases) - 1
            else _final_text(task, intent, "Implement it now and run focused tests.")
        )
        for index, intent in enumerate(phases)
    )
    base_texts = (
        _final_text(
            task,
            construction.source,
            "Implement it now and run focused tests.",
        ),
    )
    matched_texts = _reveal_texts(task, construction.source, len(evolved_texts))
    sealed = sealed_text_fragments(task.verifier, task.problem_statement)
    for text in (*base_texts, *matched_texts, *evolved_texts):
        leaked = next((value for value in sealed if value and value in text), None)
        if leaked is not None:
            raise SweBenchError("a scheduled turn contains sealed verifier material")

    def condition(name: Condition, texts: tuple[str, ...]) -> Variant:
        allocation = _allocate_steps(total_agent_steps, len(texts))
        return Variant(
            condition=name,
            turns=tuple(
                Turn(text=text, steps=steps, headroom=steps * max_output_tokens)
                for text, steps in zip(texts, allocation, strict=True)
            ),
        )

    return VariantSet(
        task_id=task.record_id,
        provenance="reference_based",
        agent_contract=task.agent_contract,
        reference_digest=task.public_digest,
        variants=(
            condition(BASE, base_texts),
            condition(MATCHED, matched_texts),
            condition(EVOLVED, evolved_texts),
        ),
        control=MATCHED,
        evidence=(
            GenerationRecord(
                stage="schedule-phases",
                target=str(task.instance_id),
                model="parallax-phase-overlay",
                output="",
                accepted=True,
                reason=(f"{len(phases)} phases; symptoms first within each intent"),
                payload=canonical_bytes(
                    {
                        "injected_argument_order": [
                            [
                                intent.function,
                                [item.identifier for item in _ordered(intent)],
                            ]
                            for intent in phases
                        ],
                    }
                ).decode(),
            ),
        ),
    )
