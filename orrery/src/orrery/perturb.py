"""Chaos as actors + mechanics (ADR-0002; chaos-engineering lineage).

A perturbation is a scheduled, seeded, trace-attributed experiment — not
ambient noise. The built-in chaos daemon draws an outage window from its own
RNG stream at its first activation and commits to it via scheduled intents,
so replay reproduces the exact same fault schedule.

Perturbation events are `visibility="direct"`: the agent-under-test cannot
see *that* chaos happened, only its effects (failing tools) — while
omniscient verifiers see the cause and can check the steady-state hypothesis.
"""

from __future__ import annotations

from typing import Any

from orrery.actors import Decision, DecisionContext, ScheduledIntentDraft
from orrery.events import Event, Intent
from orrery.surfaces import Observation
from orrery.world import World


def mech_set_tool_status(world: World, actor_id: str, intent: Intent) -> list[Event]:
    tool = intent.payload["tool"]
    status = intent.payload["status"]
    if world.store.maybe(f"tool:{tool}") is None:
        return [
            world.new_event(
                "intent.rejected",
                actor_id,
                {"intent": "chaos.set_tool_status", "reason": f"no such tool {tool}"},
                visibility="direct",
            )
        ]
    return [
        world.new_event(
            "chaos.tool_status",
            actor_id,
            {"tool": tool, "status": status},
            visibility="direct",
        )
    ]


def reduce_tool_status(store: Any, event: Event) -> None:
    store.get(f"tool:{event.payload['tool']}").attrs["status"] = event.payload["status"]


class ToolOutagePolicy:
    """Chaos daemon: one seeded outage window for one tool.

    Params: tool, start_range=(lo, hi), duration_range=(lo, hi).
    """

    def __init__(
        self,
        tool: str,
        start_range: tuple[float, float] = (0.0, 1.0),
        duration_range: tuple[float, float] = (1.0, 2.0),
    ) -> None:
        self._tool = tool
        self._start = start_range
        self._duration = duration_range

    async def decide(self, obs: Observation, ctx: DecisionContext) -> Decision:
        if ctx.memory.get("committed"):
            return Decision()
        ctx.memory["committed"] = True
        start = obs.time + ctx.rng.uniform(*self._start)
        end = start + ctx.rng.uniform(*self._duration)
        down = Intent(kind="chaos.set_tool_status", payload={"tool": self._tool, "status": "down"})
        up = Intent(kind="chaos.set_tool_status", payload={"tool": self._tool, "status": "up"})
        return Decision(
            scheduled=[
                ScheduledIntentDraft(at_time=start, intent=down),
                ScheduledIntentDraft(at_time=end, intent=up),
            ]
        )


def register(registry: Any) -> None:
    registry.mechanics["chaos.set_tool_status"] = mech_set_tool_status
    registry.reducers["chaos.tool_status"] = reduce_tool_status
    registry.policies["chaos.tool_outage"] = lambda params: ToolOutagePolicy(
        tool=params["tool"],
        start_range=tuple(params.get("start_range", (0.0, 1.0))),
        duration_range=tuple(params.get("duration_range", (1.0, 2.0))),
    )
