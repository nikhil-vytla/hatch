from __future__ import annotations

import json
from pathlib import Path

import pytest
from test_swebench import INSTANCE_ID, row, runtime

import parallax.screening as screening_module
from parallax.gsm8k import Verdict, Verification
from parallax.runner import RunFailure
from parallax.screening import (
    ScreeningCost,
    ScreeningExecution,
    ScreeningExecutionError,
    SpendApprovalRequired,
    build_screening_plan,
    initialize_screening_manifest,
    read_screening_jsonl,
    run_screening,
    summarize_screening,
    write_screening_plan,
)
from parallax.swebench import load_swebench_rows


def problem():
    return load_swebench_rows(
        (row(),),
        (INSTANCE_ID,),
        runtimes={INSTANCE_ID: runtime()},
    )[0]


def execution(verdict: Verdict) -> ScreeningExecution:
    return ScreeningExecution(
        outcome=Verification(verdict=verdict, reason="scripted"),
        reported_model="boundary-model",
        prompt_tokens=10,
        completion_tokens=5,
        estimated_cost_usd=0.01,
    )


def test_screening_plan_preregisters_units_and_cost(tmp_path: Path) -> None:
    plan = build_screening_plan(
        (problem(),),
        model="boundary-model",
        trial_seeds=(11, 12),
    )
    path = tmp_path / "screening-plan.jsonl"
    write_screening_plan(plan, path)

    assert len(plan.units) == 2
    assert plan.estimated_cost_lower_usd == 0.2
    assert plan.estimated_cost_upper_usd == 1.0
    assert json.loads(path.read_text())["kind"] == "screening_manifest"
    assert read_screening_jsonl(path) == (plan,)


def test_screening_never_runs_without_spend_approval(tmp_path: Path) -> None:
    plan = build_screening_plan(
        (problem(),),
        model="boundary-model",
        trial_seeds=(11, 12),
    )
    called = False

    def executor(unit):
        nonlocal called
        called = True
        return execution(Verdict.PASS)

    with pytest.raises(SpendApprovalRequired, match=r"\$0.20-\$1.00"):
        run_screening(
            plan,
            executor,
            output_path=tmp_path / "runs.jsonl",
        )

    assert not called


def test_screening_hard_stops_above_five_dollars(tmp_path: Path) -> None:
    plan = build_screening_plan(
        (problem(),),
        model="boundary-model",
        trial_seeds=tuple(range(11)),
        cost=ScreeningCost(
            lower_per_episode_usd=0.10,
            upper_per_episode_usd=0.50,
        ),
    )

    with pytest.raises(SpendApprovalRequired, match="exceeds"):
        run_screening(
            plan,
            lambda unit: execution(Verdict.PASS),
            output_path=tmp_path / "runs.jsonl",
            approve_spend=True,
        )


def test_approved_scripted_screening_finds_boundary_instance(
    tmp_path: Path,
) -> None:
    plan = build_screening_plan(
        (problem(),),
        model="boundary-model",
        trial_seeds=(11, 12),
    )

    def executor(unit):
        verdict = Verdict.PASS if unit.trial_index == 0 else Verdict.WRONG
        return execution(verdict)

    path = tmp_path / "evidence" / "screening.jsonl"
    runs = run_screening(
        plan,
        executor,
        output_path=path,
        approve_spend=True,
    )
    summary = summarize_screening(plan, runs)

    assert summary.minimum_detectable_effect > 0.5
    assert summary.boundary_sources == (problem().record_id,)
    assert summary.sources[0].pass_rate == 0.5
    assert sum(run.prompt_tokens for run in runs) == 20
    assert sum(run.completion_tokens for run in runs) == 10
    assert sum(run.estimated_cost_usd for run in runs) == 0.02
    assert path.read_text().count('"kind":"screening_run"') == 2
    assert "test_patch" not in path.read_text()
    assert len(read_screening_jsonl(path)) == 3


def test_executor_exceptions_remain_run_failures(tmp_path: Path) -> None:
    plan = build_screening_plan(
        (problem(),),
        model="boundary-model",
        trial_seeds=(11,),
    )
    runs = run_screening(
        plan,
        lambda unit: (_ for _ in ()).throw(TimeoutError("provider timeout")),
        output_path=tmp_path / "screening.jsonl",
        approve_spend=True,
    )

    assert isinstance(runs[0].outcome, RunFailure)
    assert runs[0].outcome.failure_kind == "agent"
    summary = summarize_screening(plan, runs)
    assert summary.sources[0].run_failures == 1
    assert summary.sources[0].operating_point == "unknown"
    assert summary.boundary_sources == ()


def test_typed_verifier_exception_preserves_failure_taxonomy(
    tmp_path: Path,
) -> None:
    plan = build_screening_plan(
        (problem(),),
        model="boundary-model",
        trial_seeds=(11,),
    )

    def executor(unit):
        raise ScreeningExecutionError("verifier", "official harness timed out")

    runs = run_screening(
        plan,
        executor,
        output_path=tmp_path / "screening.jsonl",
        approve_spend=True,
    )

    assert isinstance(runs[0].outcome, RunFailure)
    assert runs[0].outcome.failure_kind == "verifier"


def test_manifest_precedes_execution_and_completed_units_resume(
    tmp_path: Path,
) -> None:
    plan = build_screening_plan(
        (problem(),),
        model="boundary-model",
        trial_seeds=(11, 12),
    )
    path = tmp_path / "screening.jsonl"
    attempts = []

    def interrupted(unit):
        records = read_screening_jsonl(path.with_name(f"{path.name}.partial"))
        assert records[0] == plan
        attempts.append(unit.trial_index)
        if unit.trial_index == 1:
            raise KeyboardInterrupt
        return execution(Verdict.PASS)

    with pytest.raises(KeyboardInterrupt):
        run_screening(
            plan,
            interrupted,
            output_path=path,
            approve_spend=True,
        )
    partial = path.with_name(f"{path.name}.partial")
    assert not path.exists()
    assert len(read_screening_jsonl(partial)) == 2

    resumed = run_screening(
        plan,
        lambda unit: execution(Verdict.WRONG),
        output_path=path,
        approve_spend=True,
    )

    assert attempts == [0, 1]
    assert len(resumed) == 2
    assert resumed[0].outcome.verdict == Verdict.PASS
    assert resumed[1].outcome.verdict == Verdict.WRONG
    assert path.exists()
    assert not partial.exists()


def test_manifest_can_be_fsynced_before_paid_setup(tmp_path: Path) -> None:
    plan = build_screening_plan(
        (problem(),),
        model="boundary-model",
        expected_response_model="boundary-model",
        trial_seeds=(11,),
    )
    path = tmp_path / "preregistered" / "screening.jsonl"
    partial = path.with_name(f"{path.name}.partial")

    initialize_screening_manifest(plan, path)
    initialize_screening_manifest(plan, path)

    assert read_screening_jsonl(partial) == (plan,)


def test_completed_evidence_is_never_overwritten(tmp_path: Path) -> None:
    plan = build_screening_plan(
        (problem(),),
        model="boundary-model",
        trial_seeds=(11,),
    )
    path = tmp_path / "screening.jsonl"
    run_screening(
        plan,
        lambda unit: execution(Verdict.PASS),
        output_path=path,
        approve_spend=True,
    )

    with pytest.raises(FileExistsError, match="already exists"):
        run_screening(
            plan,
            lambda unit: pytest.fail("completed unit must not rerun"),
            output_path=path,
            approve_spend=True,
        )


def test_finalization_does_not_overwrite_concurrent_destination(
    tmp_path: Path,
) -> None:
    plan = build_screening_plan(
        (problem(),),
        model="boundary-model",
        trial_seeds=(11,),
    )
    path = tmp_path / "screening.jsonl"

    def executor(unit):
        path.write_text("concurrent evidence\n", encoding="utf-8")
        return execution(Verdict.PASS)

    with pytest.raises(FileExistsError):
        run_screening(
            plan,
            executor,
            output_path=path,
            approve_spend=True,
        )

    assert path.read_text() == "concurrent evidence\n"
    assert path.with_name(f"{path.name}.partial").exists()


def test_manifest_run_and_finalization_are_fsynced(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = []
    monkeypatch.setattr(screening_module.os, "fsync", calls.append)
    plan = build_screening_plan(
        (problem(),),
        model="boundary-model",
        trial_seeds=(11,),
    )

    run_screening(
        plan,
        lambda unit: execution(Verdict.PASS),
        output_path=tmp_path / "screening.jsonl",
        approve_spend=True,
    )

    assert len(calls) == 3


def test_provider_model_mismatch_is_retained_as_run_failure(
    tmp_path: Path,
) -> None:
    plan = build_screening_plan(
        (problem(),),
        model="boundary-model-alias",
        expected_response_model="boundary-model-2026-08-01",
        trial_seeds=(11,),
    )
    mismatched = ScreeningExecution(
        outcome=Verification(verdict=Verdict.PASS, reason="scripted"),
        reported_model="other-model",
        prompt_tokens=10,
        completion_tokens=5,
        estimated_cost_usd=0.01,
    )

    runs = run_screening(
        plan,
        lambda unit: mismatched,
        output_path=tmp_path / "screening.jsonl",
        approve_spend=True,
    )

    assert runs[0].reported_model == "other-model"
    assert isinstance(runs[0].outcome, RunFailure)
    assert runs[0].outcome.error_type == "ProviderModelMismatch"


def test_observed_cost_stops_and_preserves_partial_evidence(
    tmp_path: Path,
) -> None:
    plan = build_screening_plan(
        (problem(),),
        model="boundary-model",
        trial_seeds=(11,),
    )
    path = tmp_path / "screening.jsonl"
    expensive = ScreeningExecution(
        outcome=Verification(verdict=Verdict.PASS, reason="scripted"),
        reported_model="boundary-model",
        prompt_tokens=1_000,
        completion_tokens=1_000,
        estimated_cost_usd=5.01,
    )

    with pytest.raises(SpendApprovalRequired, match="observed cost"):
        run_screening(
            plan,
            lambda unit: expensive,
            output_path=path,
            approve_spend=True,
        )

    partial = path.with_name(f"{path.name}.partial")
    assert not path.exists()
    assert len(read_screening_jsonl(partial)) == 2


def test_screening_reader_rejects_unknown_fields(tmp_path: Path) -> None:
    plan = build_screening_plan(
        (problem(),),
        model="boundary-model",
        trial_seeds=(11,),
    )
    record = plan.model_dump(mode="json")
    record["unknown"] = True
    path = tmp_path / "invalid.jsonl"
    path.write_text(json.dumps(record) + "\n", encoding="utf-8")

    with pytest.raises(ValueError, match="Extra inputs"):
        read_screening_jsonl(path)


def test_screening_reader_rejects_design_digest_drift(tmp_path: Path) -> None:
    plan = build_screening_plan(
        (problem(),),
        model="boundary-model",
        trial_seeds=(11,),
    )
    record = plan.model_dump(mode="json")
    record["design_digest"] = "0" * 64
    path = tmp_path / "invalid.jsonl"
    path.write_text(json.dumps(record) + "\n", encoding="utf-8")

    with pytest.raises(ValueError, match="design digest mismatch"):
        read_screening_jsonl(path)
