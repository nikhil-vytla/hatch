"""Dataset export: replay-reconstructed observations, contract-labeled rewards."""

from orrery import engine, export
from orrery.plugins import build_registry
from orrery.spec import WorldSpec


def support_spec(seed: int, **brief) -> WorldSpec:
    registry = build_registry(uses=["orrery.domains.support"])
    return registry.generators["support_desk"](brief, seed)


async def test_export_reconstructs_agent_observations() -> None:
    spec = support_spec(3, chaos=False)
    result = await engine.run(spec, seed=3)
    rows = await export.export_sft(spec, result.trace)

    assert rows, "passing run must yield records"
    assert all(row["actor_id"] == "agent-1" for row in rows)  # SUT only, by default
    # The reconstructed first observation contains the customer's complaint.
    assert "account-1001" in rows[0]["observation"]
    # Decisions in the export are exactly the recorded ones.
    recorded = [
        d.decision.model_dump(mode="json")
        for d in result.trace.decisions
        if d.actor_id == "agent-1"
    ]
    assert [row["decision"] for row in rows] == recorded
    # Contract-derived labels are attached.
    assert rows[0]["reward"] == 1.0
    assert rows[0]["invariants_ok"] is True
    assert rows[0]["spec_hash"] == spec.spec_hash()


async def test_export_is_deterministic() -> None:
    spec = support_spec(1)
    result = await engine.run(spec, seed=1)
    first = await export.export_sft(spec, result.trace)
    second = await export.export_sft(spec, result.trace)
    assert first == second


async def test_failing_run_is_filtered_unless_requested() -> None:
    spec = support_spec(2, leak_secret=True)
    result = await engine.run(spec, seed=2)
    assert not result.passed

    assert await export.export_sft(spec, result.trace) == []

    kept = await export.export_sft(spec, result.trace, require_pass=False)
    assert kept
    # The leak zeroes the reward via the invariant gate, even though
    # objectives were met — unsafe success is not training signal.
    assert kept[0]["objective_reward"] == 1.0
    assert kept[0]["invariants_ok"] is False
    assert kept[0]["reward"] == 0.0
