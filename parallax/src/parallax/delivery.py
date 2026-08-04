from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

NonEmptyText = Annotated[str, StringConstraints(min_length=1)]
PositiveInt = Annotated[int, Field(gt=0)]
AdvanceTrigger = Literal[
    "submission",
    "budget_exhaustion",
    "terminal_submission",
    "terminal_budget_exhaustion",
]

INTENT_UPDATE_PREFIX = (
    "Hold on — before you finalize, the user has new information. "
    "Do not submit yet unless this update has been fully incorporated.\n\n"
)


class StrictModel(BaseModel):
    model_config = ConfigDict(strict=True, frozen=True, extra="forbid")


class PhaseActivityV1(StrictModel):
    turn_index: Annotated[int, Field(ge=0)]
    step_budget: PositiveInt
    steps_consumed: PositiveInt
    advance_trigger: AdvanceTrigger

    @model_validator(mode="after")
    def within_budget(self) -> Self:
        if self.steps_consumed > self.step_budget:
            raise ValueError("phase activity exceeds its step budget")
        return self


class CompleteDeliveryReceiptV1(StrictModel):
    schema_version: Literal[1] = 1
    complete: Literal[True] = True
    turn_count: PositiveInt
    total_step_budget: PositiveInt
    phases: Annotated[tuple[PhaseActivityV1, ...], Field(min_length=1)]

    @model_validator(mode="after")
    def complete_contiguous_schedule(self) -> Self:
        if len(self.phases) != self.turn_count:
            raise ValueError("delivery receipt does not cover every turn")
        if tuple(phase.turn_index for phase in self.phases) != tuple(
            range(self.turn_count)
        ):
            raise ValueError("delivery receipt turn indexes are not contiguous")
        if sum(phase.step_budget for phase in self.phases) != self.total_step_budget:
            raise ValueError("delivery receipt budget total drift")
        if any(
            phase.advance_trigger not in {"submission", "budget_exhaustion"}
            for phase in self.phases[:-1]
        ):
            raise ValueError("non-terminal phase has a terminal trigger")
        if self.phases[-1].advance_trigger not in {
            "terminal_submission",
            "terminal_budget_exhaustion",
        }:
            raise ValueError("final phase lacks a terminal trigger")
        return self

    def as_answer(self) -> str:
        return json.dumps(
            self.model_dump(mode="json"),
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )


@dataclass
class TurnDeliveryController:
    turns: tuple[NonEmptyText, ...]
    step_budgets: tuple[PositiveInt, ...]
    _turn_index: int = 0
    _steps_consumed: int = 0
    _phases: list[PhaseActivityV1] = field(default_factory=list)
    _receipt: CompleteDeliveryReceiptV1 | None = None

    def __post_init__(self) -> None:
        if not self.turns or len(self.turns) != len(self.step_budgets):
            raise ValueError("delivery turns and budgets must be non-empty and aligned")

    @property
    def complete(self) -> bool:
        return self._receipt is not None

    @property
    def current_turn(self) -> int:
        return self._turn_index

    def observe_step(self, *, submitted: bool) -> str | None:
        if self._receipt is not None:
            raise RuntimeError("delivery is already complete")
        self._steps_consumed += 1
        budget_exhausted = self._steps_consumed == self.step_budgets[self._turn_index]
        final_turn = self._turn_index == len(self.turns) - 1
        if not submitted and not budget_exhausted:
            return None
        if final_turn:
            trigger: AdvanceTrigger = (
                "terminal_submission" if submitted else "terminal_budget_exhaustion"
            )
            self._record_phase(trigger)
            self._receipt = CompleteDeliveryReceiptV1(
                turn_count=len(self.turns),
                total_step_budget=sum(self.step_budgets),
                phases=tuple(self._phases),
            )
            return None
        trigger = "submission" if submitted else "budget_exhaustion"
        self._record_phase(trigger)
        self._turn_index += 1
        self._steps_consumed = 0
        return f"{INTENT_UPDATE_PREFIX}{self.turns[self._turn_index]}"

    def receipt(self) -> CompleteDeliveryReceiptV1:
        if self._receipt is None:
            raise RuntimeError("cannot grade before every scripted turn is delivered")
        return self._receipt

    def _record_phase(self, trigger: AdvanceTrigger) -> None:
        self._phases.append(
            PhaseActivityV1(
                turn_index=self._turn_index,
                step_budget=self.step_budgets[self._turn_index],
                steps_consumed=self._steps_consumed,
                advance_trigger=trigger,
            )
        )
