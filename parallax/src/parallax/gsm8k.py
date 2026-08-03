from __future__ import annotations

import sys
from collections.abc import Mapping
from types import CodeType, FunctionType
from typing import cast

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

_MARKER = "FINAL_ANSWER: "
_MAXIMUM_DIGITS = 100
PARSER_POLICY = {
    "grammar": "0|-?[1-9][0-9]*",
    "marker": _MARKER,
    "maximum_digits": _MAXIMUM_DIGITS,
    "placement": "exactly one marker; marker line is final non-empty line",
    "schema": "parallax.gsm8k-final-answer-parser.v2",
    "whitespace": "no whitespace inside the marker line or answer",
}
_EVALUATOR_POLICY = {
    "comparison": "validated canonical string equality",
    "schema": "parallax.gsm8k-exact-integer-evaluator.v2",
}


def _runtime_policy() -> RuntimePolicy:
    version = sys.version_info
    if sys.implementation.name != "cpython":
        raise RuntimeError("native GSM8K grading requires CPython")
    cache_tag = sys.implementation.cache_tag
    if cache_tag is None:
        raise RuntimeError("runtime has no implementation cache tag")
    return RuntimePolicy(
        implementation=sys.implementation.name,
        version=f"{version.major}.{version.minor}.{version.micro}",
        cache_tag=cache_tag,
        dependencies=(),
    )


RUNTIME_POLICY = _runtime_policy()


def _validate_answer(answer: str) -> str:
    if not isinstance(answer, str):
        raise ValueError("answer must be text")
    if not answer or answer != answer.strip() or "\x00" in answer:
        raise ValueError("answer must be non-empty, unpadded, and NUL-free")
    unsigned = answer[1:] if answer.startswith("-") else answer
    if not unsigned or not unsigned.isascii() or not unsigned.isdigit():
        raise ValueError("answer must contain only an optional minus and ASCII digits")
    if len(unsigned) > _MAXIMUM_DIGITS:
        raise ValueError("answer exceeds the 100-digit limit")
    if len(unsigned) > 1 and unsigned.startswith("0"):
        raise ValueError("answer must not contain leading zeros")
    if answer == "-0":
        raise ValueError("negative zero is not canonical")
    return answer


def _parse_final_answer(output: str) -> str:
    if not isinstance(output, str):
        raise InvalidSubmission("submission must be text")
    if "\x00" in output:
        raise InvalidSubmission("submission contains NUL")
    lines = output.splitlines()
    nonempty = [line for line in lines if line.strip()]
    if not nonempty or output.count(_MARKER) != 1:
        raise InvalidSubmission("submission must contain exactly one final-answer marker")
    final_line = nonempty[-1]
    if not final_line.startswith(_MARKER):
        raise InvalidSubmission("final non-empty line does not start with the committed marker")
    answer = final_line[len(_MARKER) :]
    try:
        return _validate_answer(answer)
    except ValueError as error:
        raise InvalidSubmission(str(error)) from error


def parse_final_answer(output: str) -> str:
    """Parse a model submission with the admitted GSM8K policy."""

    return _parse_final_answer(output)


def _evaluate(prediction: str, authority: str) -> bool:
    return prediction == authority


def _code_record(code: CodeType) -> dict[str, object]:
    constants: list[object] = []
    for constant in code.co_consts:
        if isinstance(constant, CodeType):
            constants.append({"code": _code_record(constant)})
        elif isinstance(constant, bytes):
            constants.append(
                {"bytes_digest": sha256_digest(constant), "byte_length": len(constant)}
            )
        elif constant is None or isinstance(constant, (bool, int, str)):
            constants.append(constant)
        elif isinstance(constant, tuple):
            constants.append(list(constant))
        else:
            raise TypeError(f"unsupported code constant: {type(constant).__name__}")
    return {
        "argcount": code.co_argcount,
        "bytecode_digest": sha256_digest(code.co_code),
        "cellvars": code.co_cellvars,
        "constants": constants,
        "exceptiontable_digest": sha256_digest(code.co_exceptiontable),
        "flags": code.co_flags,
        "freevars": code.co_freevars,
        "kwonlyargcount": code.co_kwonlyargcount,
        "names": code.co_names,
        "nlocals": code.co_nlocals,
        "posonlyargcount": code.co_posonlyargcount,
        "stacksize": code.co_stacksize,
        "varnames": code.co_varnames,
    }


def _function_digest(function: FunctionType, transitive: tuple[FunctionType, ...]) -> str:
    body = {
        "function": _code_record(function.__code__),
        "runtime": _runtime_policy(),
        "schema": "parallax.loaded-python-function.v1",
        "transitive": tuple(_code_record(item.__code__) for item in transitive),
    }
    return sha256_digest(canonical_bytes(body))


def _answer_digest(answer: str) -> str:
    validated = _validate_answer(answer)
    return sha256_digest(
        canonical_bytes(
            {"schema": "parallax.gsm8k-answer-authority.v2", "answer": validated}
        )
    )


def verifier_commitment(answer: str, assets: AssetManifest) -> VerifierCommitment:
    """Describe loaded verifier semantics for trusted-controller drift detection."""

    validated = _validate_answer(answer)
    return VerifierCommitment(
        evaluator=ImplementationCommitment(
            "gsm8k-native-evaluator",
            _function_digest(
                cast(FunctionType, _evaluate),
                (cast(FunctionType, _validate_answer),),
            ),
            content_id("evaluator-policy", _EVALUATOR_POLICY),
        ),
        parser=ImplementationCommitment(
            "gsm8k-final-answer-parser",
            _function_digest(
                cast(FunctionType, _parse_final_answer),
                (cast(FunctionType, _validate_answer),),
            ),
            content_id("parser-policy", PARSER_POLICY),
        ),
        answer_authority_digest=_answer_digest(validated),
        asset_manifest_id=assets.id,
        runtime_policy=_runtime_policy(),
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
    validated_answer = _validate_answer(answer_authority)
    verifier = verifier_commitment(validated_answer, assets)
    public = PublicTaskIdentity(source, prompt, assets.id)
    sealed = SealedTaskIdentity(public.id, verifier.id, _answer_digest(validated_answer))
    return NativeTask(public, sealed, verifier, assets, validated_answer)


def admit_task(task: NativeTask, available_assets: Mapping[str, bytes]) -> None:
    task.assets.verify_bytes(available_assets)
    try:
        expected = verifier_commitment(task.answer_authority, task.assets)
    except (TypeError, ValueError, RuntimeError) as error:
        raise AdmissionError("answer, implementation, or runtime is invalid") from error
    if task.verifier != expected:
        raise AdmissionError(
            "verifier, parser, answer, asset, implementation, or runtime commitment mismatch"
        )
    expected_sealed = SealedTaskIdentity(
        task.public.id,
        task.verifier.id,
        _answer_digest(task.answer_authority),
    )
    if task.sealed != expected_sealed:
        raise AdmissionError("sealed task identity mismatch")
    if task.public.public_asset_manifest_id != task.assets.id:
        raise AdmissionError("public task asset commitment mismatch")


def _result(verdict: Verdict, reason: str, task: NativeTask) -> GradeResult:
    evidence_id = content_id(
        "grade-evidence",
        {
            "public_task_id": task.public.id,
            "reason": reason,
            "sealed_task_id": task.sealed.id,
            "verdict": verdict.value,
        },
    )
    return GradeResult(verdict, reason, evidence_id)


def grade_gsm8k(
    task: NativeTask,
    submission: str,
    available_assets: Mapping[str, bytes],
) -> GradeResult:
    """Grade untrusted data inside a trusted controller process."""

    try:
        admit_task(task, available_assets)
    except Exception as error:
        return _result(Verdict.HARNESS_FAILURE, f"admission failed: {type(error).__name__}", task)
    try:
        prediction = _parse_final_answer(submission)
    except InvalidSubmission as error:
        return _result(Verdict.INVALID_SUBMISSION, str(error), task)
    except Exception as error:
        return _result(Verdict.VERIFIER_FAILURE, f"parser fault: {type(error).__name__}", task)
    try:
        passed = _evaluate(prediction, task.answer_authority)
    except Exception as error:
        return _result(Verdict.VERIFIER_FAILURE, f"evaluator fault: {type(error).__name__}", task)
    if passed:
        return _result(Verdict.PASS, "final answer matches authority", task)
    return _result(Verdict.TASK_FAILURE, "final answer does not match authority", task)
