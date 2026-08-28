from __future__ import annotations

import json

import pytest
from conftest import CHECKPOINT_FIXTURE
from test_checkpoint_sandbox import LOCKDOWN_FLAGS, SimulatedDockerRunner

from parallax.checkpoint_runner import CheckpointDelivery
from parallax.checkpoint_screening import (
    CE_EXPECTED_RESPONSE_MODEL,
    CE_SCREENING_MODEL,
    _capped_factory,
    dry_run_transport,
    family_cost_upper_usd,
    run_ce_screening,
)
from parallax.experiment import SpendApprovalRequired, journal_contents
from parallax.outcome import BudgetError, RunFailure, Verdict, Verification
from parallax.perturbation import Condition
from parallax.provider import HudGatewayProvider, pricing_for

TRIALS = 2


def _live_transport(seed_fixture):
    """Scripted HUD gateway impersonating the live screening wire shape."""
    base = dry_run_transport(seed_fixture)
    calls: list[bytes] = []

    def transport(endpoint, body, headers, timeout_seconds) -> bytes:
        calls.append(body)
        reply = json.loads(base(endpoint, body, headers, timeout_seconds))
        reply["model"] = CE_EXPECTED_RESPONSE_MODEL
        return json.dumps(reply).encode()

    return transport, calls


def test_dry_run_exercises_the_full_screening_path(seed_fixture, tmp_path) -> None:
    output = tmp_path / "dry-run.jsonl"
    runs = run_ce_screening(
        mode="dry-run",
        seed_path=CHECKPOINT_FIXTURE,
        output_path=output,
        trials=TRIALS,
    )
    assert len(runs) == 2 * TRIALS
    plan, observations = journal_contents(output)
    assert plan.headroom_matched
    assert set(plan.headroom) == {("carry-reference", 12288), ("evolved", 12288)}
    assert len(observations) == 2 * TRIALS
    for observation in observations:
        assert isinstance(observation.outcome, Verification)
        assert observation.outcome.verdict is Verdict.PASS
        assert observation.prompt_tokens > 0
        assert observation.estimated_cost_usd == 0.0


def test_dry_run_needs_no_real_credential(seed_fixture, tmp_path, monkeypatch) -> None:
    monkeypatch.delenv("HUD_API_KEY", raising=False)
    runs = run_ce_screening(
        mode="dry-run",
        seed_path=CHECKPOINT_FIXTURE,
        output_path=tmp_path / "dry-run.jsonl",
        trials=1,
    )
    assert all(isinstance(run.outcome, Verification) for run in runs)


def test_dry_run_can_route_verification_through_the_sandbox(
    seed_fixture, tmp_path
) -> None:
    runner = SimulatedDockerRunner()
    run_ce_screening(
        mode="dry-run",
        seed_path=CHECKPOINT_FIXTURE,
        output_path=tmp_path / "dry-run-sandbox.jsonl",
        trials=1,
        dry_run_execution="sandbox",
        sandbox_runner=runner,
    )
    assert runner.commands
    for command in runner.commands:
        for flag in LOCKDOWN_FLAGS:
            assert flag in command


def test_live_screening_requires_spend_approval_before_any_call(
    seed_fixture, tmp_path
) -> None:
    transport, calls = _live_transport(seed_fixture)
    with pytest.raises(SpendApprovalRequired, match="requires approval"):
        run_ce_screening(
            mode="live",
            seed_path=CHECKPOINT_FIXTURE,
            output_path=tmp_path / "live.jsonl",
            trials=TRIALS,
            transport=transport,
            environment={"HUD_API_KEY": "offline-test-credential"},
            sandbox_runner=SimulatedDockerRunner(),
        )
    assert calls == []


def test_live_screening_rejects_designs_over_the_cap(seed_fixture, tmp_path) -> None:
    transport, calls = _live_transport(seed_fixture)
    with pytest.raises(SpendApprovalRequired, match="exceeds"):
        run_ce_screening(
            mode="live",
            seed_path=CHECKPOINT_FIXTURE,
            output_path=tmp_path / "live.jsonl",
            trials=TRIALS,
            approve_spend=True,
            spend_cap_usd=0.001,
            transport=transport,
            environment={"HUD_API_KEY": "offline-test-credential"},
            sandbox_runner=SimulatedDockerRunner(),
        )
    assert calls == []


def test_live_screening_sandboxes_every_model_written_case(
    seed_fixture, tmp_path
) -> None:
    transport, calls = _live_transport(seed_fixture)
    runner = SimulatedDockerRunner()
    output = tmp_path / "live.jsonl"
    runs = run_ce_screening(
        mode="live",
        seed_path=CHECKPOINT_FIXTURE,
        output_path=output,
        trials=TRIALS,
        approve_spend=True,
        transport=transport,
        environment={"HUD_API_KEY": "offline-test-credential"},
        sandbox_runner=runner,
    )
    assert len(runs) == 2 * TRIALS
    stage_calls = 3 * 2 * TRIALS
    assert len(calls) == stage_calls
    family = seed_fixture.family
    executed_cases = (
        sum(len(family.obligations(index)) for index in (1, 2, 3)) * 2 * TRIALS
    )
    assert len(runner.commands) == executed_cases
    for command in runner.commands:
        for flag in LOCKDOWN_FLAGS:
            assert flag in command
    _, observations = journal_contents(output)
    for observation in observations:
        assert observation.reported_model == CE_EXPECTED_RESPONSE_MODEL
        assert isinstance(observation.outcome, Verification)
        assert observation.estimated_cost_usd > 0.0


def test_live_reported_model_drift_is_an_agent_fault(seed_fixture, tmp_path) -> None:
    base = dry_run_transport(seed_fixture)

    def drifted(endpoint, body, headers, timeout_seconds) -> bytes:
        reply = json.loads(base(endpoint, body, headers, timeout_seconds))
        reply["model"] = "some-other-model"
        return json.dumps(reply).encode()

    runs = run_ce_screening(
        mode="live",
        seed_path=CHECKPOINT_FIXTURE,
        output_path=tmp_path / "live.jsonl",
        trials=1,
        approve_spend=True,
        transport=drifted,
        environment={"HUD_API_KEY": "offline-test-credential"},
        sandbox_runner=SimulatedDockerRunner(),
    )
    for run in runs:
        assert isinstance(run.outcome, RunFailure)
        assert run.outcome.failure_kind == "agent"


def test_cost_upper_bound_stays_under_the_default_cap(seed_fixture) -> None:
    upper = family_cost_upper_usd(seed_fixture.family, trials=10)
    assert 0 < upper < 5.0


def test_capped_factory_refuses_to_start_an_unaffordable_stage(
    seed_fixture, admitted
) -> None:
    transport, calls = _live_transport(seed_fixture)
    provider = HudGatewayProvider(
        CE_SCREENING_MODEL,
        transport=transport,
        environment={"HUD_API_KEY": "offline-test-credential"},
    )
    factory = _capped_factory(
        admitted,
        provider,
        expected_response_model=CE_EXPECTED_RESPONSE_MODEL,
        max_output_tokens=2048,
        pricing=pricing_for("claude-haiku-4-5"),
        spend_cap_usd=0.000001,
    )
    agent = factory(admitted.family.family_id, Condition("evolved"), 7)
    checkpoint = admitted.family.checkpoints[0]
    delivery = CheckpointDelivery(
        index=1,
        public_spec=checkpoint.public_spec,
        workspace=seed_fixture.references.stages[0].model_copy(),
        max_output_bytes=checkpoint.max_output_bytes,
    )
    with pytest.raises(BudgetError, match="cap"):
        agent(delivery)
    assert calls == []
