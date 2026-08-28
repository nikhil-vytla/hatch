"""Canonical token pricing and spend arithmetic.

Every dollar figure in Parallax is produced here. Rates are keyed by the exact
model identifier sent to the provider, so a run cannot be metered at one
model's rates while another model does the work, and an unlisted model raises
instead of being silently priced at zero.

`PRICING_AS_OF` is enforced by `tests/test_metering.py`, which fails once the
table is older than `PRICING_REVIEW_DAYS`. Refresh the rates from
`PRICING_SOURCE`, then move the date.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Iterable

from pydantic import Field

from .types import NonNegativeInt, StrictModel, Usd

PRICING_SOURCE = "https://docs.claude.com/en/docs/about-claude/pricing"
PRICING_AS_OF = dt.date(2026, 8, 3)
PRICING_REVIEW_DAYS = 90


class UnknownModelPricingError(LookupError):
    pass


class TokenPricing(StrictModel):
    input_usd_per_million: float = Field(gt=0)
    output_usd_per_million: float = Field(gt=0)


MODEL_PRICING: dict[str, TokenPricing] = {
    "claude-haiku-4-5": TokenPricing(
        input_usd_per_million=1.0,
        output_usd_per_million=5.0,
    ),
    "claude-sonnet-4-6": TokenPricing(
        input_usd_per_million=2.0,
        output_usd_per_million=10.0,
    ),
    "claude-opus-4-8": TokenPricing(
        input_usd_per_million=5.0,
        output_usd_per_million=25.0,
    ),
}


def pricing_for(model: str) -> TokenPricing:
    try:
        return MODEL_PRICING[model]
    except KeyError:
        known = ", ".join(sorted(MODEL_PRICING))
        raise UnknownModelPricingError(
            f"no token pricing for {model!r} as of {PRICING_AS_OF.isoformat()}; "
            f"priced models are {known}. Add it from {PRICING_SOURCE} rather "
            "than guessing a rate."
        ) from None


class MeteredUsage(StrictModel):
    prompt_tokens: NonNegativeInt = 0
    completion_tokens: NonNegativeInt = 0
    cost_usd: Usd = 0.0

    def __add__(self, other: MeteredUsage) -> MeteredUsage:
        return MeteredUsage(
            prompt_tokens=self.prompt_tokens + other.prompt_tokens,
            completion_tokens=self.completion_tokens + other.completion_tokens,
            cost_usd=self.cost_usd + other.cost_usd,
        )


def meter(
    model: str,
    *,
    prompt_tokens: int,
    completion_tokens: int,
) -> MeteredUsage:
    pricing = pricing_for(model)
    return MeteredUsage(
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        cost_usd=(
            prompt_tokens * pricing.input_usd_per_million
            + completion_tokens * pricing.output_usd_per_million
        )
        / 1_000_000,
    )


def total(usages: Iterable[MeteredUsage]) -> MeteredUsage:
    return sum(usages, MeteredUsage())
