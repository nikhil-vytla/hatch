from __future__ import annotations

import json
from pathlib import Path

import pytest
from test_swebench import INSTANCE_ID, row, runtime

from parallax.gsm8k import Verdict, Verification
from parallax.runner import RunFailure
from parallax.screening import (
    ScreeningCost,
    SpendApprovalRequired,
    build_screening_plan,
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
        return Verification(verdict=Verdict.PASS, reason="passed")

    with pytest.raises(SpendApprovalRequired, match=r"\$0.20-\$1.00"):
        run_screening(
            plan,
            executor,
            output_path=tmp_path / "runs.jsonl",
        )

    assert not called


def test_screening_hard_stops_above_twenty_dollars(tmp_path: Path) -> None:
    plan = build_screening_plan(
        (problem(),),
        model="boundary-model",
        trial_seeds=tuple(range(41)),
        cost=ScreeningCost(
            lower_per_episode_usd=0.10,
            upper_per_episode_usd=0.50,
        ),
    )

    with pytest.raises(SpendApprovalRequired, match="exceeds"):
        run_screening(
            plan,
            lambda unit: Verification(verdict=Verdict.PASS, reason="passed"),
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
        return Verification(verdict=verdict, reason="scripted")

    path = tmp_path / "screening.jsonl"
    runs = run_screening(
        plan,
        executor,
        output_path=path,
        approve_spend=True,
    )
    summary = summarize_screening(plan, runs)

    assert summary.action == "proceed"
    assert summary.boundary_sources == (problem().record_id,)
    assert summary.sources[0].pass_rate == 0.5
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
    assert summarize_screening(plan, runs).action == "change_model_or_instances"


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
