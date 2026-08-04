from __future__ import annotations

import pytest
from conftest import CHECKPOINT_FIXTURE, broken_total_workspace
from pydantic import ValidationError

from parallax.canonical import canonical_bytes, canonical_digest
from parallax.checkpoint_evolution import (
    EMPTY_WORKSPACE,
    GATES,
    AdmissionReceipt,
    CheckpointFamily,
    CheckpointSpec,
    EntrypointContract,
    GateResult,
    ReferenceBuild,
    SealedCase,
    SeedFamilyFixture,
    StageVerification,
    Workspace,
    WorkspaceFile,
    admit_family,
    load_seed_family,
    verify_stage,
)
from parallax.types import SourceId


def _case(case_id: str, **overrides: object) -> SealedCase:
    fields: dict[str, object] = {
        "case_id": case_id,
        "category": "core",
        "argv": ("total",),
        "stdin_text": "",
        "input_files": (),
        "expected_stdout": "0\n",
        "expected_exit_code": 0,
        "expect_stderr": False,
    }
    fields.update(overrides)
    return SealedCase.model_validate(fields)


def _checkpoint(index: int, operator: str, case_id: str) -> CheckpointSpec:
    return CheckpointSpec(
        index=index,
        operator=operator,
        public_spec=f"specification for stage {index}",
        max_output_bytes=4096,
        cases=(_case(case_id),),
    )


def _family(checkpoints: tuple[CheckpointSpec, ...]) -> CheckpointFamily:
    return CheckpointFamily(
        family_id=SourceId("ce-test"),
        contract=EntrypointContract(
            interpreter="python3",
            entry_file="tally.py",
            timeout_seconds=15.0,
        ),
        checkpoints=checkpoints,
    )


def test_fixture_loads_and_is_canonically_stable(seed_fixture) -> None:
    family = seed_fixture.family
    assert len(family.checkpoints) == 3
    assert tuple(item.operator for item in family.checkpoints) == (
        "core",
        "extension",
        "input-source",
    )
    reparsed = SeedFamilyFixture.model_validate_json(CHECKPOINT_FIXTURE.read_bytes())
    assert reparsed == seed_fixture
    assert canonical_digest(reparsed.family) == family.digest
    assert seed_fixture.references.family_digest == family.digest
    roundtrip = CheckpointFamily.model_validate_json(canonical_bytes(family))
    assert roundtrip.digest == family.digest


def test_workspace_rejects_traversal_disorder_and_nul() -> None:
    with pytest.raises(ValidationError):
        WorkspaceFile(path="../escape.py", content="")
    with pytest.raises(ValidationError):
        WorkspaceFile(path="/absolute.py", content="")
    with pytest.raises(ValidationError):
        WorkspaceFile(path="a//b.py", content="")
    with pytest.raises(ValidationError):
        WorkspaceFile(path="ok.py", content="bad\x00byte")
    ordered = (
        WorkspaceFile(path="a.py", content=""),
        WorkspaceFile(path="b.py", content=""),
    )
    with pytest.raises(ValidationError):
        Workspace(files=ordered[::-1])
    with pytest.raises(ValidationError):
        Workspace(files=(ordered[0], ordered[0]))
    assert Workspace.from_files({"b.py": "x", "a.py": "y"}).files[0].path == "a.py"
    assert EMPTY_WORKSPACE.content_bytes == 0


def test_family_shape_invariants() -> None:
    stages = (
        _checkpoint(1, "core", "c-1"),
        _checkpoint(2, "extension", "c-2"),
        _checkpoint(3, "refinement", "c-3"),
    )
    _family(stages)
    with pytest.raises(ValidationError):
        _family(stages[:2])
    with pytest.raises(ValidationError):
        _family((stages[0], _checkpoint(3, "extension", "c-2"), stages[2]))
    with pytest.raises(ValidationError):
        _family(
            (
                _checkpoint(1, "extension", "c-1"),
                _checkpoint(2, "core", "c-2"),
                stages[2],
            )
        )
    with pytest.raises(ValidationError):
        _family((stages[0], _checkpoint(2, "extension", "c-1"), stages[2]))
    with pytest.raises(ValidationError):
        CheckpointSpec(
            index=1,
            operator="core",
            public_spec="all functionality, no core case",
            max_output_bytes=4096,
            cases=(_case("only", category="functionality"),),
        )


def test_family_construction_rejects_sealed_leakage() -> None:
    stages = (
        _checkpoint(1, "core", "c-1"),
        _checkpoint(2, "extension", "c-2"),
        _checkpoint(3, "refinement", "c-3"),
    )
    leaky = CheckpointSpec(
        index=2,
        operator="extension",
        public_spec="the hidden grader runs c-3 against your tool",
        max_output_bytes=4096,
        cases=(_case("c-2"),),
    )
    with pytest.raises(ValidationError):
        _family((stages[0], leaky, stages[2]))


def test_obligations_accumulate_monotonically(seed_fixture) -> None:
    family = seed_fixture.family
    first = family.obligations(1)
    second = family.obligations(2)
    third = family.obligations(3)
    assert [case.case_id for _, case in first] == [
        "t1-total-basic",
        "t1-total-empty",
        "t1-total-malformed",
    ]
    assert set(first) <= set(second) <= set(third)
    assert len(third) == 10
    with pytest.raises(ValueError, match="out of range"):
        family.obligations(0)
    with pytest.raises(ValueError, match="out of range"):
        family.obligations(4)


def test_incremental_references_pass_strict_at_every_stage(seed_fixture) -> None:
    family = seed_fixture.family
    for checkpoint in family.checkpoints:
        verification = verify_stage(
            family,
            checkpoint.index,
            seed_fixture.references.stages[checkpoint.index - 1],
        )
        assert verification.strict_pass
        assert verification.isolated_pass
        assert verification.core_pass
        regressions = [
            result
            for result in verification.case_results
            if result.role == "regression"
        ]
        assert bool(regressions) == (checkpoint.index > 1)
        assert all(result.origin_index < checkpoint.index for result in regressions)


def test_regression_obligation_gates_later_checkpoints(seed_fixture) -> None:
    family = seed_fixture.family
    regressive = broken_total_workspace(seed_fixture.references.stages[1])
    verification = verify_stage(family, 2, regressive)
    assert verification.isolated_pass
    assert verification.core_pass
    assert not verification.strict_pass
    failed = {
        result.case_id
        for result in verification.case_results
        if result.detail != "pass"
    }
    assert failed == {"t1-total-basic", "t1-total-empty"}
    assert all(
        result.role == "regression"
        for result in verification.case_results
        if result.case_id in failed
    )


def test_empty_workspace_fails_the_core_checkpoint(seed_fixture) -> None:
    verification = verify_stage(seed_fixture.family, 1, EMPTY_WORKSPACE)
    assert not verification.strict_pass
    assert not verification.isolated_pass
    assert not verification.core_pass


def test_case_details_distinguish_failure_modes(seed_fixture) -> None:
    family = seed_fixture.family
    silent_error = Workspace.from_files({"tally.py": "import sys\nsys.exit(2)\n"})
    by_case = {
        result.case_id: result.detail
        for result in verify_stage(family, 1, silent_error).case_results
    }
    assert by_case["t1-total-basic"] == "exit-code-mismatch"
    assert by_case["t1-total-malformed"] == "stderr-missing"
    wrong_output = Workspace.from_files({"tally.py": "print('not a number')\n"})
    details = {
        result.case_id: result.detail
        for result in verify_stage(family, 1, wrong_output).case_results
    }
    assert details["t1-total-basic"] == "stdout-mismatch"


def test_timeout_is_a_case_failure_not_an_infrastructure_fault() -> None:
    family = CheckpointFamily(
        family_id=SourceId("ce-timeout"),
        contract=EntrypointContract(
            interpreter="python3",
            entry_file="spin.py",
            timeout_seconds=0.8,
        ),
        checkpoints=(
            CheckpointSpec(
                index=1,
                operator="core",
                public_spec="terminate promptly",
                max_output_bytes=4096,
                cases=(_case("spin-halts", expected_stdout="done\n"),),
            ),
            _checkpoint(2, "extension", "pad-1"),
            _checkpoint(3, "extension", "pad-2"),
        ),
    )
    spinning = Workspace.from_files({"spin.py": "while True:\n    pass\n"})
    verification = verify_stage(family, 1, spinning)
    assert verification.case_results[0].detail == "timeout"
    assert not verification.strict_pass


def test_verdict_vector_must_match_case_results(seed_fixture) -> None:
    family = seed_fixture.family
    honest = verify_stage(family, 2, seed_fixture.references.stages[1])
    with pytest.raises(ValidationError):
        StageVerification(
            index=honest.index,
            strict_pass=not honest.strict_pass,
            isolated_pass=honest.isolated_pass,
            core_pass=honest.core_pass,
            case_results=honest.case_results,
        )
    with pytest.raises(ValidationError):
        StageVerification(
            index=1,
            strict_pass=honest.strict_pass,
            isolated_pass=honest.isolated_pass,
            core_pass=honest.core_pass,
            case_results=honest.case_results,
        )


def test_admission_admits_the_seed_family(seed_fixture) -> None:
    receipt = admit_family(seed_fixture.family, seed_fixture.references)
    assert receipt.decision == "admitted"
    assert tuple(result.gate for result in receipt.gates) == GATES
    assert all(result.passed for result in receipt.gates)
    assert receipt.family_digest == seed_fixture.family.digest
    assert receipt.reference_digest == seed_fixture.references.digest


def test_admission_rejects_a_vacuous_checkpoint(seed_fixture) -> None:
    family = seed_fixture.family
    vacuous_stage = CheckpointSpec(
        index=3,
        operator="refinement",
        public_spec=family.checkpoints[2].public_spec,
        max_output_bytes=4096,
        cases=(
            _case(
                "t3-vacuous",
                argv=("total",),
                stdin_text="alpha 1\n",
                expected_stdout="1\n",
            ),
        ),
    )
    vacuous = CheckpointFamily(
        family_id=family.family_id,
        contract=family.contract,
        checkpoints=(*family.checkpoints[:2], vacuous_stage),
    )
    references = ReferenceBuild(
        family_digest=vacuous.digest,
        stages=seed_fixture.references.stages,
    )
    receipt = admit_family(vacuous, references)
    assert receipt.decision == "rejected"
    failed = {result.gate for result in receipt.gates if not result.passed}
    assert failed == {"no-op"}
    assert "stage 3" in next(
        result.detail for result in receipt.gates if result.gate == "no-op"
    )


def test_admission_rejects_a_broken_reference(seed_fixture) -> None:
    family = seed_fixture.family
    broken = ReferenceBuild(
        family_digest=family.digest,
        stages=(
            seed_fixture.references.stages[0],
            broken_total_workspace(seed_fixture.references.stages[1]),
            seed_fixture.references.stages[2],
        ),
    )
    receipt = admit_family(family, broken)
    assert receipt.decision == "rejected"
    failed = {result.gate for result in receipt.gates if not result.passed}
    assert failed == {"gold-incremental"}


def test_admission_rejects_misaligned_references(seed_fixture) -> None:
    family = seed_fixture.family
    misaligned = ReferenceBuild(
        family_digest=family.digest,
        stages=seed_fixture.references.stages[:2],
    )
    receipt = admit_family(family, misaligned)
    assert receipt.decision == "rejected"
    failed = {result.gate for result in receipt.gates if not result.passed}
    assert failed == {"completeness", "gold-incremental", "no-op"}
    rebound = ReferenceBuild(
        family_digest=canonical_digest("something else"),
        stages=seed_fixture.references.stages,
    )
    assert not admit_family(family, rebound).gates[1].passed


def test_admission_catches_leakage_in_unvalidated_families(seed_fixture) -> None:
    family = seed_fixture.family
    leaky_stage = family.checkpoints[0].model_copy(
        update={
            "public_spec": "hint: the sealed grader includes t2-top-tie",
        }
    )
    leaky = family.model_copy(
        update={"checkpoints": (leaky_stage, *family.checkpoints[1:])}
    )
    receipt = admit_family(leaky, seed_fixture.references)
    assert receipt.decision == "rejected"
    failed = {result.gate for result in receipt.gates if not result.passed}
    assert "leakage" in failed


def test_admission_receipt_decision_cannot_contradict_gates(
    seed_fixture,
) -> None:
    receipt = admit_family(seed_fixture.family, seed_fixture.references)
    with pytest.raises(ValidationError):
        AdmissionReceipt(
            family_digest=receipt.family_digest,
            reference_digest=receipt.reference_digest,
            gates=receipt.gates,
            decision="rejected",
        )
    with pytest.raises(ValidationError):
        AdmissionReceipt(
            family_digest=receipt.family_digest,
            reference_digest=receipt.reference_digest,
            gates=receipt.gates[:-1],
            decision="admitted",
        )
    flipped = (
        *receipt.gates[:-1],
        GateResult(gate="no-op", passed=False, detail="forced failure"),
    )
    with pytest.raises(ValidationError):
        AdmissionReceipt(
            family_digest=receipt.family_digest,
            reference_digest=receipt.reference_digest,
            gates=flipped,
            decision="admitted",
        )


def test_seed_loader_rejects_malformed_fixture(tmp_path) -> None:
    target = tmp_path / "broken.json"
    target.write_text('{"family": {}}', encoding="utf-8")
    with pytest.raises(ValueError, match="seed family fixture is invalid"):
        load_seed_family(target)
