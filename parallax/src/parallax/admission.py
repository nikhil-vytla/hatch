"""Admission: prove a task's verifier discriminates before paying to run it.

Two gates remain, and both cost real compute because both actually run the
official harness. `noop` applies a patch that changes nothing and requires the
verifier to fail it; `gold` applies the reference solution and requires the
verifier to pass it. Together they establish that the sealed authority responds
to the thing being measured, which is the only claim admission was ever able to
support.

Four other gates were deleted. `arm_completeness` and `budget_match` re-checked
Pydantic validators and, worse, checked shape rather than meaning: `budget_match`
compared turn counts and per-turn allowances, which is why it certified a
control arm that delivered the whole issue statement in both turns and therefore
accumulated no information at all. `schema` round-tripped models through their
own serializer and compared digests. `sealed_leakage` was unreachable —
`compile_bundle` raises on a leak, so a record could only ever be written with
that gate passing.

Admission binds the task spec and the environment, not the compiled bundle.
Those are the two things the gates exercise; the bundle also contains whichever
conditions an experiment happened to compile, and binding it meant that editing
an unrelated condition invalidated a completed admission.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Literal, Self

from pydantic import model_validator

from .canonical import atomic_write, canonical_bytes, canonical_digest
from .outcome import Outcome, RunFailure, Verdict
from .swebench import SweBenchTask
from .swebench_harness import (
    HarnessEvaluation,
    OfficialHarnessError,
    run_official_harness,
)
from .swebench_specs import SweEnvSpec, SweTaskSpec, freeze_swe_task
from .types import DigestText, NonEmptyText, SourceId, StrictModel

GateName = Literal["noop", "gold"]
AdmissionDecision = Literal["admitted", "admitted_flaky", "rejected"]
GATE_ORDER: tuple[GateName, ...] = ("noop", "gold")
GOLD_ATTEMPTS = 3
IDENTITY_PATCH = (
    "diff --git a/.parallax_admission_noop b/.parallax_admission_noop\n"
    "new file mode 100644\n"
    "--- /dev/null\n"
    "+++ b/.parallax_admission_noop\n"
    "@@ -0,0 +1 @@\n"
    "+parallax admission identity probe\n"
)

AdmissionHarness = Callable[
    [SweTaskSpec, SweEnvSpec, str, Path],
    HarnessEvaluation,
]


class AdmissionError(ValueError):
    pass


class GateResult(StrictModel):
    gate: GateName
    passed: bool
    evidence: NonEmptyText
    attempts: tuple[Outcome, ...] = ()
    report_digests: tuple[DigestText, ...] = ()


class AdmissionRecord(StrictModel):
    kind: Literal["admission_record"] = "admission_record"
    schema_version: Literal[2] = 2
    source_id: SourceId
    spec_digest: DigestText | None = None
    environment_digest: DigestText | None = None
    gates: tuple[GateResult, ...]
    decision: AdmissionDecision

    @model_validator(mode="after")
    def complete_decision(self) -> Self:
        if tuple(gate.gate for gate in self.gates) != GATE_ORDER:
            raise ValueError("admission gates are incomplete or out of pipeline order")
        admitted = self.decision in {"admitted", "admitted_flaky"}
        if admitted and not all((self.spec_digest, self.environment_digest)):
            raise ValueError("admitted record requires both identity digests")
        if admitted and not all(gate.passed for gate in self.gates):
            raise ValueError("admitted record contains a failed gate")
        if self.decision == "admitted_flaky":
            gold = self.gates[-1]
            if len(gold.attempts) < 2 or not isinstance(gold.attempts[0], RunFailure):
                raise ValueError(
                    "flaky admission requires a recovered gold run failure"
                )
        return self

    @property
    def admitted(self) -> bool:
        return self.decision in {"admitted", "admitted_flaky"}


def check_admission(
    spec: SweTaskSpec,
    environment: SweEnvSpec,
    record: AdmissionRecord,
) -> None:
    """Refuse to schedule a task whose committed admission does not match it.

    This is a function rather than a model validator because the check needs the
    specs, and reconstructing them inside a validator meant re-running the
    compiler on every deserialization of a stored record.
    """

    if not record.admitted:
        raise AdmissionError(f"{record.source_id} was not admitted")
    if record.source_id != spec.public.record_id:
        raise AdmissionError("admission record is for a different task")
    if record.spec_digest != spec.spec_digest:
        raise AdmissionError(
            f"{record.source_id}: admitted spec digest {record.spec_digest} "
            f"differs from {spec.spec_digest}"
        )
    if record.environment_digest != environment.digest:
        raise AdmissionError(
            f"{record.source_id}: admitted environment digest "
            f"{record.environment_digest} differs from {environment.digest}"
        )


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
) -> GateResult:
    return GateResult(
        gate=name,
        passed=passed,
        evidence=_evidence(evidence),
        attempts=attempts,
        report_digests=reports,
    )


def construction_rejection(
    source_id: SourceId,
    error: Exception,
) -> AdmissionRecord:
    detail = {"error_type": type(error).__name__, "message": str(error)}
    return AdmissionRecord(
        source_id=source_id,
        gates=tuple(
            _gate(name, False, {"not_run": "construction failed", **detail})
            for name in GATE_ORDER
        ),
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
    task: SweTaskSpec,
    environment: SweEnvSpec,
    run_directory: Path,
    run_harness: AdmissionHarness,
) -> GateResult:
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
    task: SweTaskSpec,
    environment: SweEnvSpec,
    run_directory: Path,
    run_harness: AdmissionHarness,
) -> GateResult:
    patch_digest = canonical_digest(task.sealed.gold_patch)
    attempts: list[Outcome] = []
    reports: list[DigestText] = []
    last_evidence: object = {"message": "gold check did not run"}
    for attempt in range(1, GOLD_ATTEMPTS + 1):
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
        return _gate(
            "gold",
            evaluation.outcome.verdict == Verdict.PASS,
            _execution_evidence(evaluation, patch_digest=patch_digest),
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


def admit_swe_task(
    task: SweBenchTask,
    *,
    work_directory: Path,
    harness_source_directory: Path | None = None,
    run_harness: AdmissionHarness | None = None,
) -> tuple[AdmissionRecord, SweTaskSpec, SweEnvSpec]:
    """Run both gates against one task and return the record with its specs."""

    spec, environment = freeze_swe_task(task)
    if run_harness is None:

        def invoke(
            selected_task: SweTaskSpec,
            selected_environment: SweEnvSpec,
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
    noop = _noop_gate(spec, environment, work_directory / "noop", run_harness)
    gold = _gold_gate(spec, environment, work_directory / "gold", run_harness)
    passed = noop.passed and gold.passed
    flaky = gold.passed and any(isinstance(item, RunFailure) for item in gold.attempts)
    decision: AdmissionDecision = (
        "admitted_flaky" if passed and flaky else "admitted" if passed else "rejected"
    )
    return (
        AdmissionRecord(
            source_id=spec.public.record_id,
            spec_digest=spec.spec_digest,
            environment_digest=environment.digest,
            gates=(noop, gold),
            decision=decision,
        ),
        spec,
        environment,
    )


def write_admission_record(record: AdmissionRecord, path: Path) -> None:
    if path.exists():
        existing = AdmissionRecord.model_validate_json(path.read_bytes())
        if existing != record:
            raise FileExistsError(f"admission evidence differs: {path}")
        return
    atomic_write(path, canonical_bytes(record) + b"\n")


def read_admission_record(path: Path) -> AdmissionRecord:
    return AdmissionRecord.model_validate_json(path.read_bytes())
