from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Literal

from pydantic import model_validator

from .canonical import atomic_write, canonical_bytes, canonical_digest
from .hud_compile import compile_hud
from .outcome import Outcome, RunFailure, Verdict
from .specs import EnvSpecV1, TaskSpecV1, freeze_swe_specs
from .swebench import SweScriptFamily
from .swebench_harness import (
    HarnessEvaluation,
    OfficialHarnessError,
    run_official_harness,
)
from .types import DigestText, NonEmptyText, SourceId, StrictModel

GateName = Literal["noop", "gold"]
AdmissionDecision = Literal["admitted", "admitted_flaky", "rejected"]
GATE_ORDER: tuple[GateName, ...] = ("noop", "gold")
IDENTITY_PATCH = (
    "diff --git a/.parallax_admission_noop b/.parallax_admission_noop\n"
    "new file mode 100644\n"
    "--- /dev/null\n"
    "+++ b/.parallax_admission_noop\n"
    "@@ -0,0 +1 @@\n"
    "+parallax admission identity probe\n"
)


class GateResultV1(StrictModel):
    gate: GateName
    passed: bool
    evidence: NonEmptyText
    attempts: tuple[Outcome, ...] = ()
    report_digests: tuple[DigestText, ...] = ()


class AdmissionRecordV1(StrictModel):
    kind: Literal["admission_record"] = "admission_record"
    schema_version: Literal[1] = 1
    source_id: SourceId
    spec_digest: DigestText | None = None
    environment_digest: DigestText | None = None
    bundle_digest: DigestText | None = None
    gates: tuple[GateResultV1, ...]
    decision: AdmissionDecision

    @model_validator(mode="after")
    def complete_decision(self):
        if tuple(gate.gate for gate in self.gates) != GATE_ORDER:
            raise ValueError("admission gates are incomplete or out of pipeline order")
        admitted = self.decision in {"admitted", "admitted_flaky"}
        if admitted and not all(
            (self.spec_digest, self.environment_digest, self.bundle_digest)
        ):
            raise ValueError("admitted record requires all identity digests")
        if admitted and not all(gate.passed for gate in self.gates):
            raise ValueError("admitted record contains a failed gate")
        if self.decision == "admitted_flaky":
            gold = self.gates[-1]
            if len(gold.attempts) < 2 or not isinstance(gold.attempts[0], RunFailure):
                raise ValueError(
                    "flaky admission requires a recovered gold run failure"
                )
        return self


class AdmittedSweFamily(StrictModel):
    family: SweScriptFamily
    admission: AdmissionRecordV1

    @model_validator(mode="after")
    def matching_admission(self):
        if self.admission.decision not in {"admitted", "admitted_flaky"}:
            raise ValueError("scheduling requires an admitted family")
        if self.admission.source_id != self.family.static.problem.record_id:
            raise ValueError("admission source differs from family")
        return self


def assert_admission_identity(admitted: AdmittedSweFamily) -> None:
    """Prove the admission receipt describes this exact family.

    Recompiling the bundle costs a file read and four artifact hashes, so it
    happens here, once per family at the point where spending is authorized,
    rather than inside a model validator on every construction.
    """
    task, environment = freeze_swe_specs(admitted.family)
    bundle = compile_hud(task, environment)
    record = admitted.admission
    if (
        record.spec_digest != task.spec_digest
        or record.environment_digest != environment.digest
        or record.bundle_digest != canonical_digest(bundle)
    ):
        raise ValueError(f"admission identity differs from family: {record.source_id}")


AdmissionHarness = Callable[
    [TaskSpecV1, EnvSpecV1, str, Path],
    HarnessEvaluation,
]


def _evidence(value: object) -> NonEmptyText:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def _gate(
    name: GateName,
    passed: bool,
    evidence: object,
    *,
    attempts: tuple[Outcome, ...] = (),
    reports: tuple[DigestText, ...] = (),
) -> GateResultV1:
    return GateResultV1(
        gate=name,
        passed=passed,
        evidence=_evidence(evidence),
        attempts=attempts,
        report_digests=reports,
    )


def construction_rejection(
    source_id: SourceId,
    error: Exception,
) -> AdmissionRecordV1:
    detail = {
        "not_run": "arm construction failed",
        "error_type": type(error).__name__,
        "message": str(error),
    }
    return AdmissionRecordV1(
        source_id=source_id,
        gates=tuple(_gate(name, False, detail) for name in GATE_ORDER),
        decision="rejected",
    )


def _execution_evidence(
    evaluation: HarnessEvaluation,
    *,
    patch_digest: DigestText,
) -> dict[str, object]:
    return {
        "fail_to_pass_success_count": len(evaluation.fail_to_pass_success),
        "image_digest": evaluation.image_digest,
        "harness_revision": evaluation.harness_revision,
        "pass_to_pass_success_count": len(evaluation.pass_to_pass_success),
        "patch_digest": patch_digest,
        "patch_successfully_applied": evaluation.patch_successfully_applied,
        "verdict": evaluation.outcome.verdict,
    }


def _noop_gate(
    task: TaskSpecV1,
    environment: EnvSpecV1,
    run_directory: Path,
    run_harness: AdmissionHarness,
) -> GateResultV1:
    patch_digest = canonical_digest(IDENTITY_PATCH)
    try:
        evaluation = run_harness(task, environment, IDENTITY_PATCH, run_directory)
    except OfficialHarnessError as error:
        failure = RunFailure(
            failure_kind="verifier",
            error_type=type(error).__name__,
            message=str(error),
        )
        return _gate(
            "noop",
            False,
            {"identity_patch_digest": patch_digest, "message": str(error)},
            attempts=(failure,),
        )
    passed = (
        evaluation.outcome.verdict != Verdict.PASS
        and not evaluation.fail_to_pass_success
        and evaluation.patch_successfully_applied
    )
    return _gate(
        "noop",
        passed,
        _execution_evidence(evaluation, patch_digest=patch_digest),
        attempts=(evaluation.outcome,),
        reports=(evaluation.report_digest,),
    )


def _gold_gate(
    task: TaskSpecV1,
    environment: EnvSpecV1,
    run_directory: Path,
    run_harness: AdmissionHarness,
) -> GateResultV1:
    patch_digest = canonical_digest(task.sealed.gold_patch)
    attempts: list[Outcome] = []
    reports: list[DigestText] = []
    last_evidence: object = {"message": "gold check did not run"}
    for attempt in range(1, 4):
        try:
            evaluation = run_harness(
                task,
                environment,
                task.sealed.gold_patch,
                run_directory / f"attempt-{attempt}",
            )
        except OfficialHarnessError as error:
            attempts.append(
                RunFailure(
                    failure_kind="verifier",
                    error_type=type(error).__name__,
                    message=str(error),
                )
            )
            last_evidence = {
                "attempt": attempt,
                "gold_patch_digest": patch_digest,
                "message": str(error),
            }
            continue
        attempts.append(evaluation.outcome)
        reports.append(evaluation.report_digest)
        last_evidence = _execution_evidence(
            evaluation,
            patch_digest=patch_digest,
        )
        return _gate(
            "gold",
            evaluation.outcome.verdict == Verdict.PASS,
            last_evidence,
            attempts=tuple(attempts),
            reports=tuple(reports),
        )
    return _gate(
        "gold",
        False,
        last_evidence,
        attempts=tuple(attempts),
        reports=tuple(reports),
    )


def admit_swe_family(
    family: SweScriptFamily,
    *,
    work_directory: Path,
    harness_source_directory: Path | None = None,
    run_harness: AdmissionHarness | None = None,
) -> AdmissionRecordV1:
    # compile_hud is the gate for sealed leakage and arm/environment budget
    # agreement: it raises rather than returning a bundle that violates them.
    task, environment = freeze_swe_specs(family)
    bundle = compile_hud(task, environment)
    if run_harness is None:

        def invoke(
            selected_task: TaskSpecV1,
            selected_environment: EnvSpecV1,
            patch: str,
            run_directory: Path,
        ) -> HarnessEvaluation:
            return run_official_harness(
                selected_task,
                selected_environment,
                patch,
                model="parallax-admission-reference",
                run_directory=run_directory,
                harness_source_directory=harness_source_directory,
            )

        run_harness = invoke
    noop = _noop_gate(
        task,
        environment,
        work_directory / "noop",
        run_harness,
    )
    gold = _gold_gate(
        task,
        environment,
        work_directory / "gold",
        run_harness,
    )
    passed = noop.passed and gold.passed
    flaky = gold.passed and any(isinstance(item, RunFailure) for item in gold.attempts)
    decision: AdmissionDecision = (
        "admitted_flaky" if passed and flaky else "admitted" if passed else "rejected"
    )
    return AdmissionRecordV1(
        source_id=family.static.problem.record_id,
        spec_digest=task.spec_digest,
        environment_digest=environment.digest,
        bundle_digest=canonical_digest(bundle),
        gates=(noop, gold),
        decision=decision,
    )


def write_admission_record(record: AdmissionRecordV1, path: Path) -> None:
    if path.exists():
        existing = AdmissionRecordV1.model_validate_json(path.read_bytes())
        if existing != record:
            raise FileExistsError(f"admission evidence differs: {path}")
        return
    atomic_write(path, canonical_bytes(record) + b"\n")


def read_admission_record(path: Path) -> AdmissionRecordV1:
    return AdmissionRecordV1.model_validate_json(path.read_bytes())
