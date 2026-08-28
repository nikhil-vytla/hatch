from __future__ import annotations

import json

import pytest
from conftest import CHECKPOINT_FIXTURE
from test_checkpoint_sandbox import LOCKDOWN_FLAGS, SimulatedDockerRunner

from parallax.checkpoint_agent import HAIKU_STAGE_PRICING
from parallax.checkpoint_evolution import BudgetMatchingError, StageVerification
from parallax.checkpoint_runner import (
    CeFamilyRecord,
    CeManifestRecord,
    CeRunRecord,
    CheckpointDelivery,
    read_ce_jsonl,
)
from parallax.checkpoint_screening import (
    CE_EXPECTED_RESPONSE_MODEL,
    CE_SCREENING_MODEL,
    _capped_factory,
    ce_cost_upper_usd,
    dry_run_transport,
    run_ce_screening,
)
from parallax.outcome import BudgetError, RunFailure
from parallax.provider import HudGatewayProvider
from parallax.screening import SpendApprovalRequired

SEEDS = (7, 8)


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
        trial_seeds=SEEDS,
    )
    assert len(runs) == 2 * len(SEEDS)
    records = read_ce_jsonl(output)
    manifest = records[0]
    assert isinstance(manifest, CeManifestRecord)
    assert isinstance(records[1], CeFamilyRecord)
    assert records[1].admission.decision == "admitted"
    run_records = [record for record in records if isinstance(record, CeRunRecord)]
    assert len(run_records) == 2 * len(SEEDS)
    for record in run_records:
        assert len(record.receipts) == 3
        assert record.censored == ()
        for receipt in record.receipts:
            assert isinstance(receipt.outcome, StageVerification)
            assert receipt.outcome.strict_pass
            assert receipt.usage is not None
            assert receipt.usage.prompt_tokens > 0
            assert receipt.usage.estimated_cost_usd == 0.0


def test_dry_run_needs_no_real_credential(seed_fixture, tmp_path, monkeypatch) -> None:
    monkeypatch.delenv("HUD_API_KEY", raising=False)
    runs = run_ce_screening(
        mode="dry-run",
        seed_path=CHECKPOINT_FIXTURE,
        output_path=tmp_path / "dry-run.jsonl",
        trial_seeds=(7,),
    )
    assert all(run.failure is None for run in runs)


def test_dry_run_can_route_verification_through_the_sandbox(
    seed_fixture, tmp_path
) -> None:
    runner = SimulatedDockerRunner()
    run_ce_screening(
        mode="dry-run",
        seed_path=CHECKPOINT_FIXTURE,
        output_path=tmp_path / "dry-run-sandbox.jsonl",
        trial_seeds=(7,),
        dry_run_execution="sandbox",
        sandbox_runner=runner,
    )
    assert runner.commands
    for command in runner.commands:
        for flag in LOCKDOWN_FLAGS:
            assert flag in command


def test_execution_identity_is_bound_into_the_manifest(seed_fixture, tmp_path) -> None:
    trusted = tmp_path / "trusted.jsonl"
    sandboxed = tmp_path / "sandboxed.jsonl"
    run_ce_screening(
        mode="dry-run",
        seed_path=CHECKPOINT_FIXTURE,
        output_path=trusted,
        trial_seeds=(7,),
    )
    run_ce_screening(
        mode="dry-run",
        seed_path=CHECKPOINT_FIXTURE,
        output_path=sandboxed,
        trial_seeds=(7,),
        dry_run_execution="sandbox",
        sandbox_runner=SimulatedDockerRunner(),
    )
    trusted_manifest = read_ce_jsonl(trusted)[0]
    sandboxed_manifest = read_ce_jsonl(sandboxed)[0]
    assert isinstance(trusted_manifest, CeManifestRecord)
    assert isinstance(sandboxed_manifest, CeManifestRecord)
    assert (
        trusted_manifest.model_config_digest != sandboxed_manifest.model_config_digest
    )


def test_live_screening_refuses_budget_confounded_designs(
    seed_fixture, tmp_path
) -> None:
    """The original flat-cap family is refused before approval or spend."""
    transport, calls = _live_transport(seed_fixture)
    with pytest.raises(BudgetMatchingError, match="not budget-matched"):
        run_ce_screening(
            mode="live",
            seed_path=CHECKPOINT_FIXTURE,
            output_path=tmp_path / "live.jsonl",
            trial_seeds=SEEDS,
            approve_spend=True,
            transport=transport,
            environment={"HUD_API_KEY": "offline-test-credential"},
            sandbox_runner=SimulatedDockerRunner(),
        )
    assert calls == []


def test_live_screening_requires_spend_approval_before_any_call(
    seed_fixture, tmp_path
) -> None:
    transport, calls = _live_transport(seed_fixture)
    with pytest.raises(SpendApprovalRequired, match="requires approval"):
        run_ce_screening(
            mode="live",
            seed_path=CHECKPOINT_FIXTURE,
            output_path=tmp_path / "live.jsonl",
            trial_seeds=SEEDS,
            min_budget_headroom=0.0,
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
            trial_seeds=SEEDS,
            approve_spend=True,
            spend_cap_usd=0.001,
            min_budget_headroom=0.0,
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
        trial_seeds=SEEDS,
        approve_spend=True,
        min_budget_headroom=0.0,
        transport=transport,
        environment={"HUD_API_KEY": "offline-test-credential"},
        sandbox_runner=runner,
    )
    assert len(runs) == 2 * len(SEEDS)
    stage_calls = 3 * 2 * len(SEEDS)
    assert len(calls) == stage_calls
    family = seed_fixture.family
    executed_cases = (
        sum(len(family.obligations(index)) for index in (1, 2, 3)) * 2 * len(SEEDS)
    )
    assert len(runner.commands) == executed_cases
    for command in runner.commands:
        for flag in LOCKDOWN_FLAGS:
            assert flag in command
    records = read_ce_jsonl(output)
    run_records = [record for record in records if isinstance(record, CeRunRecord)]
    for record in run_records:
        assert record.agent_model == CE_SCREENING_MODEL
        for receipt in record.receipts:
            assert isinstance(receipt.outcome, StageVerification)
            assert receipt.usage is not None
            assert receipt.usage.estimated_cost_usd > 0.0


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
        trial_seeds=(7,),
        approve_spend=True,
        min_budget_headroom=0.0,
        transport=drifted,
        environment={"HUD_API_KEY": "offline-test-credential"},
        sandbox_runner=SimulatedDockerRunner(),
    )
    for run in runs:
        outcome = run.receipts[0].outcome
        assert isinstance(outcome, RunFailure)
        assert outcome.failure_kind == "agent"
        assert "provider reported" in outcome.message


def test_cost_upper_bound_stays_under_the_default_cap(seed_fixture) -> None:
    upper = ce_cost_upper_usd(seed_fixture.family, trial_seeds=tuple(range(10)))
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
        pricing=HAIKU_STAGE_PRICING,
        spend_cap_usd=0.000001,
    )
    agent = factory(admitted.family.family_id, "evolved", 7)
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
