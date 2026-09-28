from __future__ import annotations

import pytest
from conftest import (
    FIXTURE,
    SOURCE_ARGUMENTS,
    SOURCE_FUNCTION,
    Constructor,
    Fallback,
    make_variants,
)

from parallax.gsm8k import CONTRACT, SUBMISSION_MARKER, load_gsm8k
from parallax.intent_evolution import BASE, EVOLVED, MATCHED, build_intent_variants


def test_every_condition_ends_at_the_same_task_with_the_same_headroom() -> None:
    variants, _ = make_variants()

    assert variants.provenance == "reference_based"
    assert set(variants.conditions) == {BASE, MATCHED, EVOLVED}
    headroom = {
        condition: variants.variant(condition).total_headroom
        for condition in variants.conditions
    }
    assert len(set(headroom.values())) == 1


def test_the_control_reveals_one_true_argument_per_turn() -> None:
    """GSM8K's `matched` semantics, which are the reference for every adapter.

    Information accumulates and the goal never moves, so the condition isolates
    the cost of multi-turn presentation from the cost of the manipulation. A
    1,296-episode run needed exactly this split: 0.109 total, of which 0.086 was
    presentation alone.
    """

    variants, _ = make_variants()
    matched = variants.variant(MATCHED)
    evolved = variants.variant(EVOLVED)

    assert variants.control == MATCHED
    assert len(matched.turns) == len(evolved.turns)
    assert SOURCE_FUNCTION in matched.turns[0].text
    revealed = [
        [
            identifier
            for identifier, _ in SOURCE_ARGUMENTS
            if f"Use {identifier.replace('_', ' ')}:" in turn.text
        ]
        for turn in matched.turns
    ]
    assert all(len(names) <= 1 for names in revealed)
    assert [name for names in revealed for name in names] == [
        identifier for identifier, _ in SOURCE_ARGUMENTS
    ]
    assert all("Correction: change" not in turn.text for turn in matched.turns)


def test_the_control_states_the_true_values_the_manipulation_contradicts() -> None:
    variants, _ = make_variants()
    matched_text = " ".join(turn.text for turn in variants.variant(MATCHED).turns)
    evolved_text = " ".join(turn.text for turn in variants.variant(EVOLVED).turns)

    for _, value in SOURCE_ARGUMENTS:
        assert value in matched_text
    assert "Correction: change" in evolved_text


def test_a_control_is_offered_and_an_experiment_need_not_run_it() -> None:
    """No type says three, and no validator demands three.

    The retired model pinned `Literal["static", "matched", "evolved"]` and made
    every family carry all three at equal budget, so a two-condition experiment
    still paid to construct an arm nobody ran. Construction is free; running is
    not, so the choice belongs to the experiment.
    """

    variants, _ = make_variants()

    assert variants.control is not None
    assert variants.variant(variants.control).condition == MATCHED
    two = tuple(c for c in variants.conditions if c != MATCHED)
    assert set(two) == {BASE, EVOLVED}


def test_agent_facing_text_carries_the_answer_contract_on_every_turn() -> None:
    variants, _ = make_variants()

    for condition in variants.conditions:
        prompts = variants.prompts(condition)
        assert all(SUBMISSION_MARKER in prompt for prompt in prompts)
        assert all(CONTRACT.instructions in prompt for prompt in prompts)


def test_construction_prompts_state_the_schema_of_the_reply_they_parse() -> None:
    _, constructor = make_variants()

    assert constructor.calls
    for messages, _ in constructor.calls:
        system = messages[0].content
        assert "JSON Schema:" in system
        assert "No Markdown fences" in system


def test_a_fenced_construction_reply_is_still_accepted() -> None:
    """`swebench.py` tolerated fences and the GSM8K path did not.

    One helper now, so a model's habit of fencing structured output cannot break
    one benchmark's construction while sparing another's.
    """

    class Fenced(Constructor):
        def __call__(self, messages, budget: int) -> str:
            return f"```json\n{super().__call__(messages, budget)}\n```"

    task = load_gsm8k(FIXTURE)[0]
    built = build_intent_variants(
        task.task_id,
        task.question,
        task.public_digest,
        Fenced(),
        fallback=Fallback(),
        seed=41,
        construction_model="offline-constructor",
        fallback_model="offline-fallback",
        agent_contract=task.agent_contract,
    )

    assert set(built.conditions) == {BASE, MATCHED, EVOLVED}


def test_asking_for_a_condition_nobody_built_is_an_error() -> None:
    variants, _ = make_variants()

    with pytest.raises(KeyError, match="static"):
        variants.variant("static")  # type: ignore[arg-type]
