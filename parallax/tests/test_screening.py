from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from test_swebench import INSTANCE_ID, row, runtime

import parallax.screening as screening_module
from parallax.gsm8k import Verdict, Verification
from parallax.metering import MeteredUsage
from parallax.runner import RunFailure
from parallax.screening import (
    EvidenceLockedError,
    ScreeningCost,
    ScreeningExecution,
    ScreeningExecutionError,
    ScreeningUnit,
    SpendApprovalRequired,
    build_screening_plan,
    classify_operating_point,
    initialize_screening_manifest,
    read_screening_jsonl,
    run_screening,
    single_writer,
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
        usage=MeteredUsage(prompt_tokens=10, completion_tokens=5, cost_usd=0.01),
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

    assert summary.action == "underpowered"
    assert not summary.powered
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
    assert summarize_screening(plan, runs).action == "underpowered"


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
        usage=MeteredUsage(prompt_tokens=10, completion_tokens=5, cost_usd=0.01),
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
        usage=MeteredUsage(
            prompt_tokens=1_000,
            completion_tokens=1_000,
            cost_usd=5.01,
        ),
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


def test_a_second_writer_to_one_evidence_file_is_refused(tmp_path: Path) -> None:
    plan = build_screening_plan(
        (problem(),),
        model="boundary-model",
        trial_seeds=(11,),
    )
    path = tmp_path / "screening.jsonl"

    def racing(unit: ScreeningUnit) -> ScreeningExecution:
        with pytest.raises(EvidenceLockedError, match="already writing"):
            run_screening(
                plan,
                lambda other: execution(Verdict.PASS),
                output_path=path,
                approve_spend=True,
            )
        return execution(Verdict.PASS)

    runs = run_screening(
        plan,
        racing,
        output_path=path,
        approve_spend=True,
    )

    assert len(runs) == 1
    assert len(read_screening_jsonl(path)) == 2


def test_a_second_session_cannot_take_the_lock_this_session_holds(
    tmp_path: Path,
) -> None:
    """The incident this guards was two operating system processes, not two
    calls, so exclusion is checked across a real process boundary."""
    path = tmp_path / "screening.jsonl"
    probe = (
        "import sys;"
        "from pathlib import Path;"
        "from parallax.screening import EvidenceLockedError, single_writer;"
        "\ntry:\n"
        f"    ctx = single_writer(Path({str(path)!r}))\n"
        "    ctx.__enter__()\n"
        "except EvidenceLockedError:\n"
        "    sys.exit(17)\n"
        "sys.exit(0)\n"
    )

    with single_writer(path):
        blocked = subprocess.run(
            [sys.executable, "-c", probe],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    allowed = subprocess.run(
        [sys.executable, "-c", probe],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )

    assert blocked.returncode == 17, blocked.stderr
    assert allowed.returncode == 0, allowed.stderr


def test_the_evidence_lock_is_released_for_the_next_run(tmp_path: Path) -> None:
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

    with single_writer(path):
        pass


def test_operating_point_margins_leave_room_at_the_floor_and_ceiling() -> None:
    assert classify_operating_point(None) == "unknown"
    assert classify_operating_point(0.0) == "floor"
    assert classify_operating_point(0.1) == "floor"
    assert classify_operating_point(1 / 3) == "boundary"
    assert classify_operating_point(0.9) == "ceiling"
    assert classify_operating_point(1.0) == "ceiling"


def test_margin_rule_diverges_from_exact_equality_only_past_nine_trials() -> None:
    """Pins why a driver's `== 0`/`== 1` copy of this rule went unnoticed."""

    def exact_equality(rate: float) -> str:
        if rate == 0:
            return "floor"
        if rate == 1:
            return "ceiling"
        return "boundary"

    def agrees_at(trials: int) -> bool:
        return all(
            exact_equality(passes / trials) == classify_operating_point(passes / trials)
            for passes in range(trials + 1)
        )

    assert all(agrees_at(trials) for trials in range(1, 10))
    assert not agrees_at(10)
