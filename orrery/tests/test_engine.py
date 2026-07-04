"""End-to-end determinism, replay, chaos robustness, and safety detection."""

from pathlib import Path

import pytest

from orrery import engine
from orrery.plugins import build_registry
from orrery.spec import TimelineEntry, WorldSpec
from orrery.trace import Trace


def support_spec(seed: int, **brief) -> WorldSpec:
    registry = build_registry(uses=["orrery.domains.support"])
    return registry.generators["support_desk"](brief, seed)


async def test_same_seed_bit_identical() -> None:
    spec = support_spec(3)
    first = await engine.run(spec, seed=3)
    second = await engine.run(spec, seed=3)
    assert first.trace.event_fingerprint == second.trace.event_fingerprint
    assert first.trace.final_state == second.trace.final_state


async def test_different_seeds_diverge() -> None:
    fingerprints = set()
    for seed in range(6):
        spec = support_spec(seed)
        result = await engine.run(spec, seed=seed)
        fingerprints.add(result.trace.event_fingerprint)
    assert len(fingerprints) > 1


async def test_replay_reproduces_and_detects_tampering(tmp_path: Path) -> None:
    spec = support_spec(1)
    result = await engine.run(spec, seed=1)

    trace_path = tmp_path / "trace.jsonl"
    result.trace.write(trace_path)
    loaded = Trace.read(trace_path)
    assert loaded.event_fingerprint == result.trace.event_fingerprint

    replayed = await engine.replay(spec, loaded)
    assert replayed.trace.event_fingerprint == result.trace.event_fingerprint

    # Tamper with a recorded decision -> the world diverges -> replay must fail.
    tampered = loaded.model_copy(deep=True)
    victim = next(d for d in tampered.decisions if d.decision.intents)
    victim.decision.intents.clear()
    with pytest.raises(engine.ReplayDivergence):
        await engine.replay(spec, tampered)


async def test_contract_passes_across_population() -> None:
    for seed in range(8):
        spec = support_spec(seed)
        result = await engine.run(spec, seed=seed)
        assert result.passed, (seed, [(v.name, v.status, v.details) for v in result.verdicts])


async def test_chaos_outage_forces_retries_some_seed() -> None:
    """At least one seed in the population must actually hit the outage window."""
    saw_failure_then_recovery = False
    for seed in range(10):
        spec = support_spec(seed)
        result = await engine.run(spec, seed=seed)
        kinds = [e.kind for e in result.trace.events]
        if "tool.failed" in kinds:
            assert result.verdict("ticket_resolved").passed  # robustness: recovered
            saw_failure_then_recovery = True
    assert saw_failure_then_recovery


async def test_leaky_agent_fails_safety_invariant_with_evidence() -> None:
    spec = support_spec(2, leak_secret=True)
    result = await engine.run(spec, seed=2)
    verdict = result.verdict("no_fraud_leak")
    assert verdict.status == "fail"
    assert verdict.evidence  # cites the leaking message event
    leaked = {e.id for e in result.trace.events if e.kind == "message.sent"}
    assert set(verdict.evidence) <= leaked
    # Everything else still passes: failure is attributed, not global.
    assert result.verdict("ticket_resolved").passed


async def test_toml_world_runs() -> None:
    spec_path = Path(__file__).parent.parent / "worlds" / "support_desk.toml"
    spec = WorldSpec.from_toml(spec_path)
    result = await engine.run(spec, seed=7)
    assert result.passed


async def test_timeline_can_spawn_entities_mid_run() -> None:
    """Dynamic worlds: the timeline injects a new entity while the run is live."""
    spec = support_spec(0, chaos=False)
    spec.timeline.append(
        TimelineEntry(
            at=1.0,
            intent="spawn_entity",
            payload={"entity": {"id": "ticket-2", "kind": "ticket", "attrs": {"status": "open"}}},
        )
    )
    result = await engine.run(spec, seed=0)
    assert result.store.maybe("ticket-2") is not None
    assert any(e.kind == "entity.spawned" for e in result.trace.events)
    # And the growth replays like any other change.
    replayed = await engine.replay(spec, result.trace)
    assert replayed.store.maybe("ticket-2") is not None


async def test_chaos_events_hidden_from_agent_but_in_trace() -> None:
    """Perturbations are invisible to actors (direct visibility) yet fully
    attributed in the trace for omniscient verifiers."""
    for seed in range(10):
        spec = support_spec(seed)
        result = await engine.run(spec, seed=seed)
        chaos_events = [e for e in result.trace.events if e.kind == "chaos.tool_status"]
        if chaos_events:
            assert all(e.actor_id == "chaos-1" for e in chaos_events)
            assert all(e.visibility == "direct" for e in chaos_events)
            return
    raise AssertionError("no seed produced chaos events")
