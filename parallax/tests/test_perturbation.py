from __future__ import annotations

import pytest
from pydantic import ValidationError

from parallax.perturbation import (
    Condition,
    Turn,
    Variant,
    VariantSet,
    headroom_mismatch,
)
from parallax.task import AgentContract

BASE = Condition("base")
PERTURBED = Condition("perturbed")
CONTRACT = AgentContract(instructions="Answer with FINAL_ANSWER: <integer>.")


def variant(condition: Condition, *turns: Turn) -> Variant:
    return Variant(condition=condition, turns=turns)


def test_a_turns_limit_is_its_carrying_cost_plus_its_headroom() -> None:
    turn = Turn(text="do the thing", required_output=400, headroom=1000)

    assert turn.output_limit == 1400
    assert turn.headroom == 1000


def test_equal_limits_with_unequal_carrying_costs_are_not_matched() -> None:
    """The checkpoint screening trap, stated as a test.

    Two conditions given the same flat limit are not matched when one of them
    has to spend part of that limit reproducing material the other is handed.
    """

    burdened = variant(
        PERTURBED, Turn(text="carry it", required_output=900, headroom=100)
    )
    free = variant(BASE, Turn(text="here it is", headroom=1000))

    assert burdened.turns[0].output_limit == free.turns[0].output_limit
    assert headroom_mismatch((burdened, free)) == {PERTURBED: 100, BASE: 1000}


def test_matching_headroom_survives_an_unequal_carrying_cost() -> None:
    burdened = variant(
        PERTURBED, Turn(text="carry it", required_output=900, headroom=1000)
    )
    free = variant(BASE, Turn(text="here it is", headroom=1000))

    assert burdened.turns[0].output_limit > free.turns[0].output_limit
    assert headroom_mismatch((burdened, free)) is None


def test_per_step_output_divides_a_turns_allowance() -> None:
    turn = Turn(text="work", steps=4, headroom=4000)

    assert turn.per_step_output == 1000


def test_identity_is_scoped_to_the_condition_not_the_set() -> None:
    """Editing one condition must not move another condition's digest.

    The retired model hashed every arm's turn text into one task spec, so
    deleting an unused arm changed the identity of tasks whose own material was
    untouched and orphaned their admission records.
    """

    control = variant(BASE, Turn(text="stated plainly", headroom=64))
    treatment = variant(PERTURBED, Turn(text="stated obliquely", headroom=64))
    pair = VariantSet(
        task_id="t-1",
        agent_contract=CONTRACT,
        provenance="reference_based",
        reference_digest="a" * 64,
        variants=(control, treatment),
    )
    trimmed = VariantSet(
        task_id="t-1",
        agent_contract=CONTRACT,
        provenance="reference_based",
        reference_digest="a" * 64,
        variants=(control,),
    )

    assert pair.variant(BASE).digest == trimmed.variant(BASE).digest
    assert control.digest != treatment.digest


def test_reference_based_and_reference_free_sets_cannot_be_confused() -> None:
    turns = (Turn(text="a task", headroom=64),)
    with pytest.raises(ValidationError, match="must name its reference"):
        VariantSet(
            task_id="t-1",
            agent_contract=CONTRACT,
            provenance="reference_based",
            variants=(variant(BASE, *turns),),
        )
    with pytest.raises(ValidationError, match="no reference to name"):
        VariantSet(
            task_id="t-1",
            agent_contract=CONTRACT,
            provenance="reference_free",
            reference_digest="a" * 64,
            variants=(variant(BASE, *turns),),
        )


def test_a_condition_cannot_appear_twice_in_one_set() -> None:
    turns = (Turn(text="a task", headroom=64),)
    with pytest.raises(ValidationError, match="must be unique"):
        VariantSet(
            task_id="t-1",
            agent_contract=CONTRACT,
            provenance="reference_free",
            variants=(variant(BASE, *turns), variant(BASE, *turns)),
        )


def test_asking_for_a_condition_that_was_never_built_is_an_error() -> None:
    built = VariantSet(
        task_id="t-1",
        agent_contract=CONTRACT,
        provenance="reference_free",
        variants=(variant(BASE, Turn(text="a task", headroom=64)),),
    )

    assert built.conditions == (BASE,)
    with pytest.raises(KeyError, match="perturbed"):
        built.variant(PERTURBED)


def test_agent_facing_text_always_carries_the_contract() -> None:
    """The one place a contract is stated, so it cannot go unstated.

    A live GSM8K round graded every episode on a `FINAL_ANSWER:` line the agent
    was never asked for. `prompts` is the only accessor that produces text meant
    for a model, and it cannot be reached without the contract the set carries.
    """

    built = VariantSet(
        task_id="t-1",
        agent_contract=CONTRACT,
        provenance="reference_free",
        variants=(
            variant(
                PERTURBED,
                Turn(text="first", headroom=64),
                Turn(text="then finish", headroom=64),
            ),
        ),
    )

    prompts = built.prompts(PERTURBED)

    assert all(CONTRACT.instructions in prompt for prompt in prompts)
    assert prompts[0].startswith("first")
    assert not any(
        CONTRACT.instructions in turn.text for turn in built.variant(PERTURBED).turns
    )


def test_a_declared_control_must_have_been_constructed() -> None:
    turns = (Turn(text="a task", headroom=64),)
    with pytest.raises(ValidationError, match="was not constructed"):
        VariantSet(
            task_id="t-1",
            agent_contract=CONTRACT,
            provenance="reference_free",
            variants=(variant(BASE, *turns),),
            control=PERTURBED,
        )


def test_a_set_may_offer_a_control_without_any_experiment_running_it() -> None:
    turns = (Turn(text="a task", headroom=64),)
    offered = VariantSet(
        task_id="t-1",
        agent_contract=CONTRACT,
        provenance="reference_free",
        variants=(variant(BASE, *turns), variant(PERTURBED, *turns)),
        control=PERTURBED,
    )

    assert offered.control == PERTURBED
    assert set(offered.conditions) == {BASE, PERTURBED}
