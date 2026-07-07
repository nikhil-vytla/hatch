"""Dataset export: traces -> training data (the RL/SFT pillar's first slice).

Key design point: observations are NOT stored in traces — they are
*reconstructed* by replaying the world and re-rendering each actor's view.
Deterministic replay (ADR-0001) guarantees the reconstruction is exactly
what the actor saw, so the trace stays lean while export stays faithful.
Reward comes from the contract: objective scores aggregate to a scalar,
invariants gate safety — verifier-driven labeling instead of hand-scoring.

Each exported record is policy-agnostic: (observation, decision) plus run
provenance and reward. Chat-format SFT for model policies and token-level RL
fidelity are renderers/extensions over these records (see
docs/platform-pillars.md for the staged plan).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from windtunnel import engine
from windtunnel.content import flatten_text
from windtunnel.plugins import Registry
from windtunnel.spec import WorldSpec
from windtunnel.trace import Trace
from windtunnel.verify import Verdict


def reward_summary(spec: WorldSpec, verdicts: list[Verdict]) -> dict[str, Any]:
    """Contract -> reward: mean objective score, gated by invariant safety."""
    by_name = {v.name: v for v in verdicts}
    objective_scores = [
        by_name[item.name].score for item in spec.contract if item.kind == "objective"
    ]
    invariants_ok = all(
        by_name[item.name].passed for item in spec.contract if item.kind == "invariant"
    )
    objective_reward = sum(objective_scores) / len(objective_scores) if objective_scores else 0.0
    return {
        "objective_reward": objective_reward,
        "invariants_ok": invariants_ok,
        "reward": objective_reward if invariants_ok else 0.0,
    }


async def collect_records(
    spec: WorldSpec,
    trace: Trace,
    registry: Registry | None = None,
    actor_ids: set[str] | None = None,
) -> tuple[list[dict[str, Any]], engine.RunResult]:
    """Replay the trace, reconstructing each (observation, decision) pair.

    `actor_ids=None` defaults to actors with role `system_under_test`.
    """
    if actor_ids is None:
        actor_ids = {a.id for a in spec.actors if a.role == "system_under_test"}
    records: list[dict[str, Any]] = []

    def observer(actor_id: str, activation: int, observation: Any, decision: Any) -> None:
        if actor_id not in actor_ids:
            return
        records.append(
            {
                "actor_id": actor_id,
                "activation": activation,
                "time": observation.time,
                "observation": flatten_text(observation.parts),
                "decision": decision.model_dump(mode="json"),
            }
        )

    result = await engine.replay(spec, trace, registry=registry, observer=observer)
    return records, result


async def export_sft(
    spec: WorldSpec,
    trace: Trace,
    registry: Registry | None = None,
    actor_ids: set[str] | None = None,
    require_pass: bool = True,
) -> list[dict[str, Any]]:
    """Export one run as training records, labeled by its contract verdicts.

    With `require_pass`, runs that violate any invariant or miss any
    objective contribute nothing — contract-filtered imitation data.
    """
    records, result = await collect_records(spec, trace, registry, actor_ids)
    rewards = reward_summary(spec, result.verdicts)
    if require_pass and not result.passed:
        return []
    provenance = {
        "spec_name": trace.meta.spec_name,
        "spec_hash": trace.meta.spec_hash,
        "seed": trace.meta.seed,
        **rewards,
    }
    return [{**record, **provenance} for record in records]


def write_jsonl(rows: list[dict[str, Any]], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w") as fh:
        for row in rows:
            fh.write(json.dumps(row) + "\n")
