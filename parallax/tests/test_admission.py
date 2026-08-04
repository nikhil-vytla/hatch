from __future__ import annotations

from pathlib import Path

import pytest
from test_swebench import INSTANCE_ID, construction, row, runtime

from parallax.admission import (
    GATE_ORDER,
    IDENTITY_PATCH,
    AdmittedSweFamily,
    admit_swe_family,
    construction_rejection,
    read_admission_record,
    write_admission_record,
)
from parallax.canonical import canonical_digest
from parallax.outcome import RunFailure, Verdict, Verification
from parallax.screening import build_admitted_screening_plan
from parallax.swebench import build_swe_script_family, load_swebench_rows
from parallax.swebench_harness import HarnessEvaluation, OfficialHarnessError


def family():
    problem = load_swebench_rows(
        (row(),),
        (INSTANCE_ID,),
        runtimes={INSTANCE_ID: runtime()},
    )[0]
    return build_swe_script_family(
        problem,
        construction(),
        total_agent_steps=12,
        max_output_tokens=4096,
    )


def evaluation(
    verdict: Verdict,
    *,
    patch_applied: bool = True,
    fail_to_pass_success: tuple[str, ...] = (),
) -> HarnessEvaluation:
    return HarnessEvaluation(
        outcome=Verification(verdict=verdict, reason="scripted"),
        report_digest=canonical_digest({"verdict": verdict}),
        harness_revision="f7bbbb2ccdf479001d6467c9e34af59e44a840f9",
        image_digest="a" * 64,
        patch_successfully_applied=patch_applied,
        fail_to_pass_success=fail_to_pass_success,
        pass_to_pass_success=(),
    )


def test_admission_runs_all_gates_in_pipeline_order(tmp_path: Path) -> None:
    candidate = family()
    patches = []

    def harness(task, environment, patch, run_directory):
        patches.append(patch)
        if patch == IDENTITY_PATCH:
            return evaluation(Verdict.WRONG)
        assert patch == candidate.static.problem.verifier.gold_patch
        return evaluation(
            Verdict.PASS,
            fail_to_pass_success=candidate.static.problem.verifier.fail_to_pass,
        )

    record = admit_swe_family(
        candidate,
        work_directory=tmp_path,
        run_harness=harness,
    )

    assert record.decision == "admitted"
    assert tuple(gate.gate for gate in record.gates) == GATE_ORDER
    assert all(gate.passed for gate in record.gates)
    assert patches == [IDENTITY_PATCH, candidate.static.problem.verifier.gold_patch]
    assert "test_patch" not in record.model_dump_json()

    plan = build_admitted_screening_plan(
        (AdmittedSweFamily(family=candidate, admission=record),),
        model="boundary-model",
        trial_seeds=(1, 2),
        arms=("static", "evolved"),
    )
    assert tuple(unit.arm for unit in plan.units) == (
        "static",
        "evolved",
        "static",
        "evolved",
    )


def test_gold_retries_only_infrastructure_failures(tmp_path: Path) -> None:
    calls = 0

    def harness(task, environment, patch, run_directory):
        nonlocal calls
        if patch == IDENTITY_PATCH:
            return evaluation(Verdict.WRONG)
        calls += 1
        if calls == 1:
            raise OfficialHarnessError("temporary Docker fault")
        return evaluation(
            Verdict.PASS,
            fail_to_pass_success=task.sealed.fail_to_pass,
        )

    record = admit_swe_family(
        family(),
        work_directory=tmp_path,
        run_harness=harness,
    )

    assert record.decision == "admitted_flaky"
    assert calls == 2
    assert isinstance(record.gates[-1].attempts[0], RunFailure)


def test_gold_wrong_is_terminal(tmp_path: Path) -> None:
    gold_calls = 0

    def harness(task, environment, patch, run_directory):
        nonlocal gold_calls
        if patch == IDENTITY_PATCH:
            return evaluation(Verdict.WRONG)
        gold_calls += 1
        return evaluation(Verdict.WRONG)

    record = admit_swe_family(
        family(),
        work_directory=tmp_path,
        run_harness=harness,
    )

    assert record.decision == "rejected"
    assert gold_calls == 1
    assert not record.gates[-1].passed


def test_noop_requires_applied_patch_and_real_f2p_failure(tmp_path: Path) -> None:
    def harness(task, environment, patch, run_directory):
        if patch == IDENTITY_PATCH:
            return evaluation(Verdict.WRONG, patch_applied=False)
        return evaluation(
            Verdict.PASS,
            fail_to_pass_success=task.sealed.fail_to_pass,
        )

    record = admit_swe_family(
        family(),
        work_directory=tmp_path,
        run_harness=harness,
    )

    assert record.decision == "rejected"
    assert not record.gates[4].passed


def test_construction_failure_rejects_all_arms_uniformly() -> None:
    record = construction_rejection(
        family().static.problem.record_id,
        ValueError("construction failed"),
    )

    assert record.decision == "rejected"
    assert tuple(gate.gate for gate in record.gates) == GATE_ORDER
    assert not any(gate.passed for gate in record.gates)
    assert record.spec_digest is None


def test_admission_evidence_is_idempotent_and_refuses_drift(tmp_path: Path) -> None:
    record = construction_rejection(
        family().static.problem.record_id,
        ValueError("construction failed"),
    )
    path = tmp_path / "admission.json"

    write_admission_record(record, path)
    write_admission_record(record, path)

    assert read_admission_record(path) == record
    changed = construction_rejection(
        family().static.problem.record_id,
        ValueError("different failure"),
    )
    with pytest.raises(FileExistsError, match="differs"):
        write_admission_record(changed, path)
