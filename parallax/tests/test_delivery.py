from __future__ import annotations

import asyncio
from types import SimpleNamespace

import mcp.types as mcp_types
import pytest
from hud.agents.tool_agent import RunState
from hud.agents.types import AgentStep
from hud.types import Trace
from pydantic import ValidationError

from parallax.delivery import (
    INTENT_UPDATE_PREFIX,
    CompleteDeliveryReceiptV1,
    PhaseActivityV1,
    TurnDeliveryController,
)
from parallax.hud_screening import HarnessTurnAgent


class ScriptedPolicy:
    clients = ()

    def __init__(self, steps: list[AgentStep]) -> None:
        self.steps = steps
        self.config = SimpleNamespace(
            citations_enabled=False,
            model="scripted-model",
            system_prompt=None,
        )

    async def _initialize_state(self, *, prompt):
        return RunState(messages=[])

    async def _build_tools(self, connections):
        return {}, []

    async def get_response(self, state, *, system_prompt, citations_enabled):
        return self.steps.pop(0)

    def _stop_condition(self, step):
        return None

    def _format_user_text(self, text):
        return {"role": "user", "content": text}


class ScriptedRun:
    def __init__(self) -> None:
        self.client = SimpleNamespace(manifest=None)
        self.prompt_messages = [
            mcp_types.PromptMessage(
                role="user",
                content=mcp_types.TextContent(type="text", text="first"),
            )
        ]
        self.trace = Trace()

    def record(self, step) -> None:
        self.trace.record(step)


def test_early_submission_is_discarded_into_next_turn() -> None:
    controller = TurnDeliveryController(
        turns=("first", "second"),
        step_budgets=(3, 3),
    )

    follow_up = controller.observe_step(submitted=True)

    assert follow_up == f"{INTENT_UPDATE_PREFIX}second"
    assert not controller.complete
    with pytest.raises(RuntimeError, match="before every scripted turn"):
        controller.receipt()

    assert controller.observe_step(submitted=True) is None
    receipt = controller.receipt()
    assert tuple(phase.steps_consumed for phase in receipt.phases) == (1, 1)
    assert tuple(phase.advance_trigger for phase in receipt.phases) == (
        "submission",
        "terminal_submission",
    )


def test_phase_budget_exhaustion_delivers_next_turn() -> None:
    controller = TurnDeliveryController(
        turns=("first", "second"),
        step_budgets=(2, 2),
    )

    assert controller.observe_step(submitted=False) is None
    assert controller.observe_step(submitted=False) == f"{INTENT_UPDATE_PREFIX}second"
    assert controller.observe_step(submitted=False) is None
    assert controller.observe_step(submitted=False) is None

    receipt = controller.receipt()
    assert tuple(phase.steps_consumed for phase in receipt.phases) == (2, 2)
    assert tuple(phase.advance_trigger for phase in receipt.phases) == (
        "budget_exhaustion",
        "terminal_budget_exhaustion",
    )


def test_complete_receipt_cannot_skip_a_turn() -> None:
    with pytest.raises(ValidationError, match="does not cover every turn"):
        CompleteDeliveryReceiptV1(
            turn_count=2,
            total_step_budget=2,
            phases=(
                PhaseActivityV1(
                    turn_index=0,
                    step_budget=1,
                    steps_consumed=1,
                    advance_trigger="terminal_submission",
                ),
            ),
        )


def test_controller_cannot_be_drained_after_completion() -> None:
    controller = TurnDeliveryController(turns=("only",), step_budgets=(1,))
    controller.observe_step(submitted=True)

    with pytest.raises(RuntimeError, match="already complete"):
        controller.observe_step(submitted=True)


def test_harness_agent_intercepts_early_submission() -> None:
    policy = ScriptedPolicy(
        [
            AgentStep(content="first submission", done=True),
            AgentStep(content="final submission", done=True),
        ]
    )
    run = ScriptedRun()
    agent = HarnessTurnAgent(
        policy,
        turns=("first", "second"),
        step_budgets=(3, 3),
    )

    asyncio.run(agent(run))

    receipt = CompleteDeliveryReceiptV1.model_validate_json(run.trace.content)
    assert receipt.complete
    assert tuple(phase.advance_trigger for phase in receipt.phases) == (
        "submission",
        "terminal_submission",
    )
    injected = [
        step for step in run.trace.steps if step.source == "user" and step.messages
    ]
    assert len(injected) == 1
    assert INTENT_UPDATE_PREFIX in injected[0].messages[0].content.text
