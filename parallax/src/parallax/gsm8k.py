from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from pathlib import Path

from .canonical import canonical_bytes, content_id, sha256_digest
from .records import (
    AdmissionError,
    AssetEntry,
    AssetManifest,
    DomainSourceIdentity,
    GradeResult,
    ImplementationCommitment,
    InvalidSubmission,
    NativeTask,
    Provenance,
    PublicTaskIdentity,
    RuntimePolicy,
    SealedTaskIdentity,
    Verdict,
    VerifierCommitment,
)

_MAX_DIGITS = 100
PARSER_POLICY = {
    "schema": "parallax.gsm8k-final-answer-parser.v1",
    "marker": "FINAL_ANSWER: ",
    "grammar": "-?(0|[1-9][0-9]*)",
    "placement": "exactly one marker; marker line is final non-empty line",
    "maximum_digits": _MAX_DIGITS,
}
RUNTIME_POLICY = RuntimePolicy(
    implementation="CPython",
    python_requirement=">=3.11,<4",
    dependencies=(),
    network_allowed=False,
)
_FINAL_LINE = re.compile(r"FINAL_ANSWER: (-?(?:0|[1-9][0-9]*))\Z", re.ASCII)
_CANONICAL_INTEGER = re.compile(r"-?(?:0|[1-9][0-9]*)\Z", re.ASCII)


def parse_final_answer(output: str) -> str:
    if not isinstance(output, str):
        raise InvalidSubmission("submission must be text")
    if "\x00" in output:
        raise InvalidSubmission("submission contains NUL")
    lines = output.splitlines()
    nonempty = [line for line in lines if line.strip()]
    if not nonempty or output.count("FINAL_ANSWER:") != 1:
        raise InvalidSubmission("submission must contain exactly one final-answer marker")
    match = _FINAL_LINE.fullmatch(nonempty[-1])
    if match is None:
        raise InvalidSubmission("final non-empty line does not match the committed grammar")
    answer = match.group(1)
    if len(answer.lstrip("-")) > _MAX_DIGITS:
        raise InvalidSubmission("final answer exceeds the digit limit")
    return answer


def _answer_digest(answer: str) -> str:
    return sha256_digest(canonical_bytes({"schema": "parallax.gsm8k-answer-authority.v1", "answer": answer}))


def _implementation_digest() -> str:
    return sha256_digest(Path(__file__).read_bytes())


def verifier_commitment(answer: str, assets: AssetManifest) -> VerifierCommitment:
    if _CANONICAL_INTEGER.fullmatch(answer) is None:
        raise ValueError("answer authority must be a canonical integer")
    implementation = _implementation_digest()
    parser_policy_id = content_id("parser-policy", PARSER_POLICY)
    evaluator_policy_id = content_id(
        "evaluator-policy",
        {"schema": "parallax.gsm8k-exact-integer-evaluator.v1", "comparison": "canonical string equality"},
    )
    return VerifierCommitment(
        evaluator=ImplementationCommitment("gsm8k-native-evaluator", implementation, evaluator_policy_id),
        parser=ImplementationCommitment("gsm8k-final-answer-parser", implementation, parser_policy_id),
        answer_authority_digest=_answer_digest(answer),
        asset_manifest_id=assets.id,
        runtime_policy=RUNTIME_POLICY,
    )


def source_asset_manifest(
    source_bytes: bytes,
    *,
    origin: str,
    revision: str,
    license_id: str = "MIT",
) -> AssetManifest:
    entry = AssetEntry(
        name="source-row.public.json",
        media_type="application/json",
        byte_length=len(source_bytes),
        digest=sha256_digest(source_bytes),
        provenance=Provenance(origin, revision, license_id),
    )
    return AssetManifest((entry,))


def build_task(
    *,
    source: DomainSourceIdentity,
    prompt: str,
    answer_authority: str,
    assets: AssetManifest,
) -> NativeTask:
    verifier = verifier_commitment(answer_authority, assets)
    public = PublicTaskIdentity(source, prompt, assets.id)
    sealed = SealedTaskIdentity(public.id, verifier.id, _answer_digest(answer_authority))
    return NativeTask(public, sealed, verifier, assets, answer_authority)


def admit_task(task: NativeTask, available_assets: Mapping[str, bytes]) -> None:
    task.assets.verify_bytes(available_assets)
    expected = verifier_commitment(task.answer_authority, task.assets)
    if task.verifier != expected:
        raise AdmissionError("verifier, parser, answer, asset, or runtime commitment mismatch")
    expected_sealed = SealedTaskIdentity(task.public.id, task.verifier.id, _answer_digest(task.answer_authority))
    if task.sealed != expected_sealed:
        raise AdmissionError("sealed task identity mismatch")
    if task.public.public_asset_manifest_id != task.assets.id:
        raise AdmissionError("public task asset commitment mismatch")


def _result(verdict: Verdict, reason: str, task: NativeTask) -> GradeResult:
    evidence_id = content_id(
        "grade-evidence",
        {"public_task_id": task.public.id, "sealed_task_id": task.sealed.id, "verdict": verdict.value, "reason": reason},
    )
    return GradeResult(verdict, reason, evidence_id)


def _compare(prediction: str, authority: str) -> bool:
    return prediction == authority


def grade_gsm8k(
    task: NativeTask,
    submission: str,
    available_assets: Mapping[str, bytes],
    *,
    evaluator: Callable[[str, str], bool] = _compare,
) -> GradeResult:
    try:
        admit_task(task, available_assets)
    except Exception as error:
        return _result(Verdict.HARNESS_FAILURE, f"admission failed: {type(error).__name__}", task)
    try:
        prediction = parse_final_answer(submission)
    except InvalidSubmission as error:
        return _result(Verdict.INVALID_SUBMISSION, str(error), task)
    except Exception as error:
        return _result(Verdict.VERIFIER_FAILURE, f"parser fault: {type(error).__name__}", task)
    try:
        passed = evaluator(prediction, task.answer_authority)
        if not isinstance(passed, bool):
            raise TypeError("evaluator returned a non-boolean result")
    except Exception as error:
        return _result(Verdict.VERIFIER_FAILURE, f"evaluator fault: {type(error).__name__}", task)
    if passed:
        return _result(Verdict.PASS, "final answer matches authority", task)
    return _result(Verdict.TASK_FAILURE, "final answer does not match authority", task)
