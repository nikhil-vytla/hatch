"""Benchmark adapters (ADR-0008): external task formats → WorldSpecs.

An adapter is `(rows, brief) -> list[WorldSpec]`. The emitted specs are
ordinary Orrery worlds: fully declarative (simulated tools ride along as
entity data — no Python required), executable against ANY agent (the
system-under-test policy is a parameter, not part of the task), and
self-validating (the default agent is an *oracle* that performs the task's
expected actions, so `adapt` can prove a converted world is solvable before
you point a real model at it).

Shipped adapter: `bfcl_style`, for function-calling rows shaped like the
Berkeley Function-Calling Leaderboard's simple/executable categories:

    {"id": "...", "question": "...",
     "function": [{"name", "description", "parameters"}, ...],
     "expected": [{"name": "...", "args": {...}}, ...],
     "responses": {"tool_name": <canned result>, ...}}   # optional

Mapping: question → NPC user message; each declared function → a `tool`
entity with a canned response; each expected call → an `eventually
tool.called` contract item (exact-args match — a simplification of BFCL's
answer ranges, noted in ADR-0008).
"""

from __future__ import annotations

from typing import Any

from orrery.entities import Entity
from orrery.spec import (
    ActorSpec,
    ContractItem,
    PolicySpec,
    ReactionRule,
    WorldSpec,
)

USER_ID = "user-1"
AGENT_ID = "agent-1"


def _oracle_policy(row: dict[str, Any]) -> PolicySpec:
    """A scripted agent that performs exactly the expected calls, then replies.

    Running the oracle against the adapted world checks that the conversion
    is faithful: if the oracle can't pass the contract, the world is wrong,
    not the agent.
    """
    steps: list[list[dict[str, Any]]] = [
        [{"kind": "call_tool", "payload": {"tool": call["name"], "args": call.get("args", {})}}]
        for call in row.get("expected", [])
    ]
    steps.append(
        [
            {
                "kind": "send_message",
                "payload": {
                    "to": USER_ID,
                    "content": [{"kind": "text", "text": "Done — task completed."}],
                },
            }
        ]
    )
    return PolicySpec(type="scripted", params={"steps": steps})


def adapt_bfcl_style(rows: list[dict[str, Any]], brief: dict[str, Any]) -> list[WorldSpec]:
    specs: list[WorldSpec] = []
    for row in rows:
        responses = row.get("responses", {})
        entities = [
            Entity(
                id=f"tool:{fn['name']}",
                kind="tool",
                attrs={
                    "status": "up",
                    "description": fn.get("description", ""),
                    "parameters": fn.get("parameters", {}),
                    "response": responses.get(fn["name"], {"ok": True}),
                },
            )
            for fn in row["function"]
        ]
        agent_policy = (
            PolicySpec.model_validate(brief["policy"]) if "policy" in brief else _oracle_policy(row)
        )
        actors = [
            ActorSpec(
                id=USER_ID,
                role="population",
                policy=PolicySpec(
                    type="scripted",
                    params={
                        "steps": [
                            [
                                {
                                    "kind": "send_message",
                                    "payload": {
                                        "to": AGENT_ID,
                                        "content": [{"kind": "text", "text": row["question"]}],
                                    },
                                }
                            ]
                        ]
                    },
                ),
                activate_at=[0.0],
            ),
            ActorSpec(id=AGENT_ID, role="system_under_test", policy=agent_policy),
        ]
        contract = [
            ContractItem(
                name=f"calls_{call['name']}_{index}",
                kind="objective",
                verifier="eventually_event",
                params={
                    "kind": "tool.called",
                    "actor_id": AGENT_ID,
                    "payload_contains": {"tool": call["name"], "args": call.get("args", {})},
                },
            )
            for index, call in enumerate(row.get("expected", []))
        ]
        contract += [
            ContractItem(
                name="responded_to_user",
                kind="objective",
                verifier="eventually_event",
                params={
                    "kind": "message.sent",
                    "payload_contains": {"from": AGENT_ID, "to": USER_ID},
                },
            ),
            ContractItem(
                name="call_budget",
                kind="invariant",
                verifier="budget_max",
                params={"kind": "tool.called", "limit": len(row.get("expected", [])) + 3},
            ),
        ]
        specs.append(
            WorldSpec(
                name=f"bfcl-{row['id']}",
                description=f"Adapted function-calling task: {row['question'][:80]}",
                horizon=float(brief.get("horizon", 10.0)),
                entities=entities,
                actors=actors,
                reactions=[
                    ReactionRule(on_kind="message.sent", activate=AGENT_ID, delay=0.1),
                    ReactionRule(on_kind="message.sent", activate=USER_ID, delay=0.1),
                    ReactionRule(on_kind="tool.result", activate=AGENT_ID, delay=0.05),
                    ReactionRule(on_kind="tool.failed", activate=AGENT_ID, delay=0.05),
                ],
                contract=contract,
            )
        )
    return specs


def register(registry: Any) -> None:
    registry.adapters["bfcl_style"] = adapt_bfcl_style
