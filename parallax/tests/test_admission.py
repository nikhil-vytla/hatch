from __future__ import annotations

from pathlib import Path

import pytest
from test_swebench import INSTANCE_ID, construction, row, runtime

from parallax.admission import (
    GATE_ORDER,
    IDENTITY_PATCH,
    AdmissionError,
    admit_swe_task,
    check_admission,
    construction_rejection,
    read_admission_record,
    write_admission_record,
)
from parallax.canonical import canonical_digest
from parallax.intent_phases import build_phase_variants
from parallax.outcome import RunFailure, Verdict, Verification
from parallax.swebench import load_swebench_rows
from parallax.swebench_harness import HarnessEvaluation, OfficialHarnessError
from parallax.swebench_specs import freeze_swe_task


def task():
    return load_swebench_rows(
        (row(),),
        (INSTANCE_ID,),
        runtimes={INSTANCE_ID: runtime()},
    )[0]


def family():
    return build_phase_variants(
        task(),
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
    candidate = task()
    patches = []

    def harness(task, environment, patch, run_directory):
        patches.append(patch)
        if patch == IDENTITY_PATCH:
            return evaluation(Verdict.WRONG)
        assert patch == candidate.verifier.gold_patch
        return evaluation(
            Verdict.PASS,
            fail_to_pass_success=candidate.verifier.fail_to_pass,
        )

    record, spec, environment = admit_swe_task(
        candidate,
        work_directory=tmp_path,
        run_harness=harness,
    )

    assert record.decision == "admitted"
    assert tuple(gate.gate for gate in record.gates) == GATE_ORDER
    assert all(gate.passed for gate in record.gates)
    assert patches == [IDENTITY_PATCH, candidate.verifier.gold_patch]
    assert "test_patch" not in record.model_dump_json()

    check_admission(spec, environment, record)


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

    record, _, _ = admit_swe_task(
        task(),
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

    record, _, _ = admit_swe_task(
        task(),
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

    record, _, _ = admit_swe_task(
        task(),
        work_directory=tmp_path,
        run_harness=harness,
    )

    assert record.decision == "rejected"
    assert not record.gates[0].passed


def test_construction_failure_rejects_every_gate_uniformly() -> None:
    record = construction_rejection(
        task().record_id,
        ValueError("construction failed"),
    )

    assert record.decision == "rejected"
    assert tuple(gate.gate for gate in record.gates) == GATE_ORDER
    assert not any(gate.passed for gate in record.gates)
    assert record.spec_digest is None


def test_admission_evidence_is_idempotent_and_refuses_drift(tmp_path: Path) -> None:
    record = construction_rejection(
        task().record_id,
        ValueError("construction failed"),
    )
    path = tmp_path / "admission.json"

    write_admission_record(record, path)
    write_admission_record(record, path)

    assert read_admission_record(path) == record
    changed = construction_rejection(
        task().record_id,
        ValueError("different failure"),
    )
    with pytest.raises(FileExistsError, match="differs"):
        write_admission_record(changed, path)


def test_admission_survives_an_edit_to_an_unrelated_condition(tmp_path: Path) -> None:
    """A retired or edited condition must not invalidate a committed admission.

    Under the previous model the task spec hashed every arm's turn text, so
    retiring the matched arm changed the identity of tasks whose own material
    was untouched and orphaned their admission records.
    """

    def harness(patch_target, environment, patch, run_directory):
        if patch == IDENTITY_PATCH:
            return evaluation(Verdict.WRONG)
        return evaluation(
            Verdict.PASS,
            fail_to_pass_success=patch_target.sealed.fail_to_pass,
        )

    record, spec, _ = admit_swe_task(
        task(),
        work_directory=tmp_path,
        run_harness=harness,
    )
    narrower = build_phase_variants(
        task(),
        construction(),
        total_agent_steps=6,
        max_output_tokens=1024,
    )

    assert narrower.variants != family().variants
    later_spec, later_environment = freeze_swe_task(task())
    check_admission(later_spec, later_environment, record)
    assert later_spec.spec_digest == spec.spec_digest


def test_admission_still_refuses_a_task_whose_own_material_changed(
    tmp_path: Path,
) -> None:
    def harness(patch_target, environment, patch, run_directory):
        if patch == IDENTITY_PATCH:
            return evaluation(Verdict.WRONG)
        return evaluation(
            Verdict.PASS,
            fail_to_pass_success=patch_target.sealed.fail_to_pass,
        )

    record, _, environment = admit_swe_task(
        task(),
        work_directory=tmp_path,
        run_harness=harness,
    )
    edited = task().model_copy(update={"problem_statement": "a different issue"})
    edited_spec, edited_environment = freeze_swe_task(edited)

    with pytest.raises(AdmissionError, match="spec digest"):
        check_admission(edited_spec, edited_environment, record)
    assert environment.digest == edited_environment.digest
