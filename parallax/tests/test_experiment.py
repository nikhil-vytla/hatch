from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from parallax.experiment import (
    CostRange,
    DesignError,
    Execution,
    ExecutionError,
    ExperimentConfig,
    Plan,
    SpendApprovalRequired,
    Unit,
    execute,
    journal_contents,
    plan_experiment,
    total_spend_usd,
)
from parallax.gsm8k import Gsm8kTask, verify
from parallax.outcome import RunFailure, Verdict, Verification
from parallax.perturbation import Condition, Turn, Variant, VariantSet
from parallax.types import SourceAnswer, SourceId

BASE = Condition("base")
PERTURBED = Condition("perturbed")
MODEL = "offline-model"


def task(record_id: str = "t-1", answer: str = "42") -> Gsm8kTask:
    return Gsm8kTask(
        record_id=SourceId(record_id),
        question=f"what is the answer for {record_id}?",
        answer=SourceAnswer(answer),
    )


def variants(problem: Gsm8kTask, *, headroom: tuple[int, int] = (64, 64)) -> VariantSet:
    return VariantSet(
        task_id=problem.task_id,
        provenance="reference_based",
        agent_contract=problem.agent_contract,
        reference_digest=problem.public_digest,
        variants=(
            Variant(
                condition=BASE,
                turns=(Turn(text="stated plainly", headroom=headroom[0]),),
            ),
            Variant(
                condition=PERTURBED,
                turns=(Turn(text="stated obliquely", headroom=headroom[1]),),
            ),
        ),
    )


def config(**overrides: object) -> ExperimentConfig:
    fields: dict[str, object] = {
        "model": MODEL,
        "conditions": (BASE, PERTURBED),
        "trials": 2,
        "cost": CostRange(lower_per_episode_usd=0.0, upper_per_episode_usd=0.01),
    }
    fields.update(overrides)
    return ExperimentConfig(**fields)


def answering(answers: dict[Condition, str]):
    def run(unit: Unit) -> Execution:
        return Execution(
            outcome=verify(task(str(unit.task_id)), answers[unit.condition]),
            reported_model=MODEL,
            prompt_tokens=10,
            completion_tokens=5,
            estimated_cost_usd=0.001,
        )

    return run


def test_plan_is_digest_bound_to_its_own_body() -> None:
    problem = task()
    plan = plan_experiment(((problem, variants(problem)),), config())

    assert len(plan.units) == 4
    assert plan.headroom_matched
    assert plan.tasks[0].public_digest == problem.public_digest
    tampered = plan.model_dump(mode="json") | {"model": "another-model"}
    with pytest.raises(ValueError, match="design digest mismatch"):
        Plan.model_validate_json(json.dumps(tampered))


def test_an_unmatched_contrast_is_refused_before_any_spend() -> None:
    problem = task()
    unmatched = variants(problem, headroom=(64, 8))

    with pytest.raises(DesignError, match="measure the allowance"):
        plan_experiment(((problem, unmatched),), config())
    permitted = plan_experiment(
        ((problem, unmatched),),
        config(require_matched_headroom=False),
    )

    assert not permitted.headroom_matched
    assert dict(permitted.headroom) == {BASE: 64, PERTURBED: 8}


def test_scheduling_a_condition_nobody_built_is_refused() -> None:
    problem = task()

    with pytest.raises(DesignError, match="not constructed for conditions"):
        plan_experiment(
            ((problem, variants(problem)),),
            config(conditions=(BASE, Condition("never-built"))),
        )


def test_execution_requires_explicit_spend_approval(tmp_path: Path) -> None:
    problem = task()
    plan = plan_experiment(((problem, variants(problem)),), config())
    executor = answering({BASE: "FINAL_ANSWER: 42", PERTURBED: "FINAL_ANSWER: 42"})

    with pytest.raises(SpendApprovalRequired, match="requires approval"):
        execute(plan, executor, journal_path=tmp_path / "run.jsonl")
    with pytest.raises(SpendApprovalRequired, match="exceeds"):
        execute(
            plan,
            executor,
            journal_path=tmp_path / "run.jsonl",
            approve_spend=True,
            spend_cap_usd=0.001,
        )
    assert not (tmp_path / "run.jsonl").exists()


def test_a_completed_journal_replays_without_spending(tmp_path: Path) -> None:
    problem = task()
    plan = plan_experiment(((problem, variants(problem)),), config())
    journal = tmp_path / "run.jsonl"
    calls = 0

    def counting(unit: Unit) -> Execution:
        nonlocal calls
        calls += 1
        return answering({BASE: "FINAL_ANSWER: 42", PERTURBED: "FINAL_ANSWER: 1"})(unit)

    first = execute(
        plan,
        counting,
        journal_path=journal,
        approve_spend=True,
        progress=lambda _: None,
    )
    second = execute(
        plan,
        counting,
        journal_path=journal,
        approve_spend=True,
        progress=lambda _: None,
    )

    assert calls == 4
    assert first == second
    stored_plan, observations = journal_contents(journal)
    assert stored_plan == plan
    assert len(observations) == 4


def test_a_crash_resumes_from_the_partial_journal_without_double_paying(
    tmp_path: Path,
) -> None:
    problem = task()
    plan = plan_experiment(((problem, variants(problem)),), config())
    journal = tmp_path / "run.jsonl"
    calls: list[Unit] = []

    def flaky(unit: Unit) -> Execution:
        calls.append(unit)
        if len(calls) == 3:
            raise KeyboardInterrupt("simulated crash")
        return answering({BASE: "FINAL_ANSWER: 42", PERTURBED: "FINAL_ANSWER: 42"})(
            unit
        )

    with pytest.raises(KeyboardInterrupt):
        execute(
            plan,
            flaky,
            journal_path=journal,
            approve_spend=True,
            progress=lambda _: None,
        )
    assert not journal.exists()
    assert journal.with_name("run.jsonl.partial").exists()

    observations = execute(
        plan,
        answering({BASE: "FINAL_ANSWER: 42", PERTURBED: "FINAL_ANSWER: 42"}),
        journal_path=journal,
        approve_spend=True,
        progress=lambda _: None,
    )

    assert len(observations) == 4
    assert len({item.key for item in observations}) == 4
    # the two units completed before the crash were not re-run
    assert len(calls) == 3


def test_replayed_units_are_not_counted_as_new_spend(tmp_path: Path) -> None:
    problem = task()
    plan = plan_experiment(((problem, variants(problem)),), config())

    def cached(unit: Unit) -> Execution:
        return Execution(
            outcome=Verification(verdict=Verdict.PASS, reason="cached"),
            reported_model=MODEL,
            prompt_tokens=10,
            completion_tokens=5,
            estimated_cost_usd=0.002,
            fresh=unit.condition == BASE,
        )

    observations = execute(
        plan,
        cached,
        journal_path=tmp_path / "run.jsonl",
        approve_spend=True,
        progress=lambda _: None,
    )

    assert total_spend_usd(observations) == pytest.approx(0.004)
    assert sum(item.estimated_cost_usd for item in observations) == pytest.approx(0.008)


def test_a_paid_failure_keeps_its_usage_in_the_journal(tmp_path: Path) -> None:
    problem = task()
    plan = plan_experiment(((problem, variants(problem)),), config())

    def failing(unit: Unit) -> Execution:
        raise ExecutionError(
            "verifier",
            "container died after the model answered",
            reported_model=MODEL,
            prompt_tokens=90,
            completion_tokens=40,
            estimated_cost_usd=0.003,
        )

    observations = execute(
        plan,
        failing,
        journal_path=tmp_path / "run.jsonl",
        approve_spend=True,
        progress=lambda _: None,
    )

    assert all(isinstance(item.outcome, RunFailure) for item in observations)
    assert total_spend_usd(observations) == pytest.approx(0.012)
    assert all(item.prompt_tokens == 90 for item in observations)


def test_a_different_model_than_preregistered_is_a_run_failure(tmp_path: Path) -> None:
    problem = task()
    plan = plan_experiment(
        ((problem, variants(problem)),),
        config(expected_response_model="offline-model-20260101"),
    )

    def drifted(unit: Unit) -> Execution:
        return Execution(
            outcome=Verification(verdict=Verdict.PASS, reason="scripted"),
            reported_model="some-other-model",
            prompt_tokens=10,
            completion_tokens=5,
            estimated_cost_usd=0.001,
        )

    observations = execute(
        plan,
        drifted,
        journal_path=tmp_path / "run.jsonl",
        approve_spend=True,
        progress=lambda _: None,
    )

    for observation in observations:
        assert isinstance(observation.outcome, RunFailure)
        assert "provider reported" in observation.outcome.message


def test_a_journal_written_for_another_design_is_refused(tmp_path: Path) -> None:
    problem = task()
    journal = tmp_path / "run.jsonl"
    plan = plan_experiment(((problem, variants(problem)),), config())
    execute(
        plan,
        answering({BASE: "FINAL_ANSWER: 42", PERTURBED: "FINAL_ANSWER: 42"}),
        journal_path=journal,
        approve_spend=True,
        progress=lambda _: None,
    )
    other = plan_experiment(((problem, variants(problem)),), config(trials=9))

    with pytest.raises(ValueError, match="different plan"):
        execute(other, answering({}), journal_path=journal, approve_spend=True)


def test_journal_rows_are_fsynced_before_the_next_unit_starts(
    tmp_path: Path, monkeypatch
) -> None:
    """The property that survived a disk-full crash and three relaunches."""

    problem = task()
    plan = plan_experiment(((problem, variants(problem)),), config())
    syncs: list[int] = []
    real_fsync = os.fsync
    monkeypatch.setattr(os, "fsync", lambda fd: (syncs.append(fd), real_fsync(fd))[1])

    execute(
        plan,
        answering({BASE: "FINAL_ANSWER: 42", PERTURBED: "FINAL_ANSWER: 42"}),
        journal_path=tmp_path / "run.jsonl",
        approve_spend=True,
        progress=lambda _: None,
    )

    # one for the plan line, one per unit, one for the directory on finalize
    assert len(syncs) == 6


def test_trials_are_samples_and_no_seed_pretends_otherwise() -> None:
    """The gateway accepts `seed` and ignores it, verified empirically.

    The retired plan preregistered a `trial_seed` per unit and bound it into the
    design digest, which read as a promise that a trial could be reproduced. It
    could not. A trial is a sample index, and temperature — which is causally
    real — is what the design pins.
    """

    problem = task()
    plan = plan_experiment(((problem, variants(problem)),), config(trials=3))

    assert "seed" not in plan.model_dump_json()
    assert set(Unit.model_fields) == {
        "task_id",
        "public_digest",
        "verifier_digest",
        "condition",
        "trial_index",
    }
    indexes = [unit.trial_index for unit in plan.units if unit.condition == BASE]
    assert indexes == [0, 1, 2]
    assert plan.temperature == 1.0


def test_temperature_is_part_of_the_preregistered_design() -> None:
    problem = task()
    hot = plan_experiment(((problem, variants(problem)),), config(temperature=0.0))
    cold = plan_experiment(((problem, variants(problem)),), config(temperature=1.0))

    assert hot.design_digest != cold.design_digest
