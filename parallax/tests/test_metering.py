from __future__ import annotations

import datetime as dt

import pytest

from parallax.metering import (
    MODEL_PRICING,
    PRICING_AS_OF,
    PRICING_REVIEW_DAYS,
    PRICING_SOURCE,
    MeteredUsage,
    UnknownModelPricingError,
    meter,
    pricing_for,
    total,
)


def test_pricing_an_unlisted_model_raises_instead_of_guessing() -> None:
    with pytest.raises(UnknownModelPricingError, match="no token pricing"):
        pricing_for("claude-opus-4-7")

    with pytest.raises(UnknownModelPricingError):
        meter("gpt-nonexistent", prompt_tokens=1000, completion_tokens=10)


def test_unknown_model_error_names_the_priced_models_and_the_source() -> None:
    with pytest.raises(UnknownModelPricingError) as caught:
        pricing_for("retired-model")

    message = str(caught.value)
    assert PRICING_SOURCE in message
    for model in MODEL_PRICING:
        assert model in message


def test_pricing_table_is_not_stale() -> None:
    """A screening round was once priced at retired-model rates.

    This fails on a schedule instead of silently pricing at old rates: refresh
    the table from PRICING_SOURCE, then move PRICING_AS_OF.
    """
    age = (dt.date.today() - PRICING_AS_OF).days

    assert age >= 0, "PRICING_AS_OF is in the future"
    assert age <= PRICING_REVIEW_DAYS, (
        f"token pricing was last confirmed {age} days ago; re-check "
        f"{PRICING_SOURCE} and update PRICING_AS_OF"
    )


def test_cost_is_metered_per_million_tokens_at_the_model_rate() -> None:
    usage = meter(
        "claude-opus-4-8",
        prompt_tokens=1_000_000,
        completion_tokens=100_000,
    )

    assert usage.cost_usd == pytest.approx(5.0 + 2.5)
    assert usage.prompt_tokens == 1_000_000


def test_arms_priced_at_their_own_model_rate_not_a_shared_default() -> None:
    haiku = meter("claude-haiku-4-5", prompt_tokens=1_000_000, completion_tokens=0)
    opus = meter("claude-opus-4-8", prompt_tokens=1_000_000, completion_tokens=0)

    assert haiku.cost_usd < opus.cost_usd


def test_usage_aggregates_into_one_ledger_total() -> None:
    first = meter("claude-opus-4-8", prompt_tokens=1000, completion_tokens=100)
    second = meter("claude-haiku-4-5", prompt_tokens=2000, completion_tokens=200)

    combined = total((first, second))

    assert combined.prompt_tokens == 3000
    assert combined.completion_tokens == 300
    assert combined.cost_usd == pytest.approx(first.cost_usd + second.cost_usd)
    assert total(()) == MeteredUsage()
