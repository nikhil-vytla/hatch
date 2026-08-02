from __future__ import annotations

import sys
from collections.abc import Callable, Mapping
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


def _make_engine() -> tuple[object, ...]:
    canonicalize = canonical_bytes
    code_type = CodeType
    digest_bytes = sha256_digest
    make_content_id = content_id
    runtime_module = sys
    marker = "FINAL_ANSWER: "
    maximum_digits = 100
    parser_policy_items = (
        ("grammar", "0|-?[1-9][0-9]*"),
        ("marker", marker),
        ("maximum_digits", maximum_digits),
        ("placement", "exactly one marker; marker line is final non-empty line"),
        ("schema", "parallax.gsm8k-final-answer-parser.v2"),
        ("whitespace", "no whitespace inside the marker line or answer"),
    )
    evaluator_policy_items = (
        ("comparison", "validated canonical string equality"),
        ("schema", "parallax.gsm8k-exact-integer-evaluator.v2"),
    )

    def runtime_policy() -> RuntimePolicy:
        version = runtime_module.version_info
        if runtime_module.implementation.name != "cpython":
            raise RuntimeError("native GSM8K grading requires CPython")
        cache_tag = runtime_module.implementation.cache_tag
        if cache_tag is None:
            raise RuntimeError("runtime has no implementation cache tag")
        return RuntimePolicy(
            implementation=runtime_module.implementation.name,
            version=f"{version.major}.{version.minor}.{version.micro}",
            cache_tag=cache_tag,
            dependencies=(),
        )

    def validate_answer(answer: str) -> str:
        if not isinstance(answer, str):
            raise ValueError("answer must be text")
        if not answer or answer != answer.strip() or "\x00" in answer:
            raise ValueError("answer must be non-empty, unpadded, and NUL-free")
        unsigned = answer[1:] if answer.startswith("-") else answer
        if not unsigned or not unsigned.isascii() or not unsigned.isdigit():
            raise ValueError("answer must contain only an optional minus and ASCII digits")
        if len(unsigned) > maximum_digits:
            raise ValueError("answer exceeds the 100-digit limit")
        if len(unsigned) > 1 and unsigned.startswith("0"):
            raise ValueError("answer must not contain leading zeros")
        if answer == "-0":
            raise ValueError("negative zero is not canonical")
        return answer

    def parse(output: str) -> str:
        if not isinstance(output, str):
            raise InvalidSubmission("submission must be text")
        if "\x00" in output:
            raise InvalidSubmission("submission contains NUL")
        lines = output.splitlines()
        nonempty = [line for line in lines if line.strip()]
        if not nonempty or output.count(marker) != 1:
            raise InvalidSubmission("submission must contain exactly one final-answer marker")
        final_line = nonempty[-1]
        if not final_line.startswith(marker):
            raise InvalidSubmission("final non-empty line does not start with the committed marker")
        answer = final_line[len(marker) :]
        if final_line != marker + answer:
            raise InvalidSubmission("final answer line is not canonical")
        try:
            return validate_answer(answer)
        except ValueError as error:
            raise InvalidSubmission(str(error)) from error

    def evaluate(prediction: str, authority: str) -> bool:
        return prediction == authority

    def code_record(code: CodeType) -> dict[str, object]:
        constants: list[object] = []
        for constant in code.co_consts:
            if isinstance(constant, code_type):
                constants.append({"code": code_record(constant)})
            elif isinstance(constant, bytes):
                constants.append({"bytes_digest": digest_bytes(constant), "byte_length": len(constant)})
            elif constant is None or isinstance(constant, (bool, int, str)):
                constants.append(constant)
            elif isinstance(constant, tuple):
                constants.append(list(constant))
            else:
                raise TypeError(f"unsupported code constant: {type(constant).__name__}")
        return {
            "argcount": code.co_argcount,
            "bytecode_digest": digest_bytes(code.co_code),
            "cellvars": code.co_cellvars,
            "constants": constants,
            "exceptiontable_digest": digest_bytes(code.co_exceptiontable),
            "flags": code.co_flags,
            "freevars": code.co_freevars,
            "kwonlyargcount": code.co_kwonlyargcount,
            "names": code.co_names,
            "nlocals": code.co_nlocals,
            "posonlyargcount": code.co_posonlyargcount,
            "stacksize": code.co_stacksize,
            "varnames": code.co_varnames,
        }

    def function_digest(function: FunctionType, transitive: tuple[FunctionType, ...]) -> str:
        body = {
            "function": code_record(function.__code__),
            "runtime": runtime_policy(),
            "schema": "parallax.loaded-python-function.v1",
            "transitive": tuple(code_record(item.__code__) for item in transitive),
        }
        return digest_bytes(canonicalize(body))

    def answer_digest(answer: str) -> str:
        validated = validate_answer(answer)
        return digest_bytes(
            canonicalize(
                {"schema": "parallax.gsm8k-answer-authority.v2", "answer": validated}
            )
        )

    def commitment(answer: str, assets: AssetManifest) -> VerifierCommitment:
        validated = validate_answer(answer)
        parser_policy = dict(parser_policy_items)
        evaluator_policy = dict(evaluator_policy_items)
        return VerifierCommitment(
            evaluator=ImplementationCommitment(
                "gsm8k-native-evaluator",
                function_digest(
                    cast(FunctionType, evaluate),
                    (cast(FunctionType, validate_answer),),
                ),
                make_content_id("evaluator-policy", evaluator_policy),
            ),
            parser=ImplementationCommitment(
                "gsm8k-final-answer-parser",
                function_digest(
                    cast(FunctionType, parse),
                    (cast(FunctionType, validate_answer),),
                ),
                make_content_id("parser-policy", parser_policy),
            ),
            answer_authority_digest=answer_digest(validated),
            asset_manifest_id=assets.id,
            runtime_policy=runtime_policy(),
        )

    def admit(task: NativeTask, available_assets: Mapping[str, bytes]) -> None:
        task.assets.verify_bytes(available_assets)
        try:
            expected = commitment(task.answer_authority, task.assets)
        except (TypeError, ValueError, RuntimeError) as error:
            raise AdmissionError("answer, implementation, or runtime is invalid") from error
        if task.verifier != expected:
            raise AdmissionError(
                "verifier, parser, answer, asset, implementation, or runtime commitment mismatch"
            )
        expected_sealed = SealedTaskIdentity(
            task.public.id,
            task.verifier.id,
            answer_digest(task.answer_authority),
        )
        if task.sealed != expected_sealed:
            raise AdmissionError("sealed task identity mismatch")
        if task.public.public_asset_manifest_id != task.assets.id:
            raise AdmissionError("public task asset commitment mismatch")

    def result(verdict: Verdict, reason: str, task: NativeTask) -> GradeResult:
        evidence_id = make_content_id(
            "grade-evidence",
            {
                "public_task_id": task.public.id,
                "reason": reason,
                "sealed_task_id": task.sealed.id,
                "verdict": verdict.value,
            },
        )
        return GradeResult(verdict, reason, evidence_id)

    def grade(
        task: NativeTask,
        submission: str,
        available_assets: Mapping[str, bytes],
    ) -> GradeResult:
        try:
            admit(task, available_assets)
        except Exception as error:
            return result(Verdict.HARNESS_FAILURE, f"admission failed: {type(error).__name__}", task)
        try:
            prediction = parse(submission)
        except InvalidSubmission as error:
            return result(Verdict.INVALID_SUBMISSION, str(error), task)
        except Exception as error:
            return result(Verdict.VERIFIER_FAILURE, f"parser fault: {type(error).__name__}", task)
        try:
            passed = evaluate(prediction, task.answer_authority)
        except Exception as error:
            return result(Verdict.VERIFIER_FAILURE, f"evaluator fault: {type(error).__name__}", task)
        if passed:
            return result(Verdict.PASS, "final answer matches authority", task)
        return result(Verdict.TASK_FAILURE, "final answer does not match authority", task)

    return (
        answer_digest,
        admit,
        commitment,
        grade,
        parse,
        runtime_policy,
        validate_answer,
        dict(parser_policy_items),
    )


_engine = _make_engine()
_answer_digest = cast(Callable[[str], str], _engine[0])
admit_task = cast(Callable[[NativeTask, Mapping[str, bytes]], None], _engine[1])
verifier_commitment = cast(Callable[[str, AssetManifest], VerifierCommitment], _engine[2])
grade_gsm8k = cast(
    Callable[[NativeTask, str, Mapping[str, bytes]], GradeResult],
    _engine[3],
)
parse_final_answer = cast(Callable[[str], str], _engine[4])
_runtime_policy = cast(Callable[[], RuntimePolicy], _engine[5])
_validate_answer = cast(Callable[[str], str], _engine[6])
PARSER_POLICY = cast(dict[str, object], _engine[7])
RUNTIME_POLICY = _runtime_policy()
del _engine, _make_engine


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

# synthetic post-import disk mutation
