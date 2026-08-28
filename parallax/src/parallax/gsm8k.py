"""GSM8K as a `Task`: the question is public, the `#### <integer>` is sealed."""

from __future__ import annotations

import re
from pathlib import Path

from pydantic import ValidationError, field_validator

from .canonical import canonical_digest
from .outcome import Outcome, RunFailure, Verdict, Verification
from .provider import unfence
from .task import AgentContract
from .types import (
    CanonicalInteger,
    DigestText,
    SourceAnswer,
    SourceId,
    StrictModel,
)

SOURCE_MARKER = "#### "
SUBMISSION_MARKER = "FINAL_ANSWER: "
MAXIMUM_DIGITS = 100
_INTEGER = re.compile(r"0|-?[1-9][0-9]*")

CONTRACT = AgentContract(
    instructions=(
        f"Finish your reply with a line reading exactly `{SUBMISSION_MARKER}"
        "<integer>` and nothing after it. The integer must be plain digits with "
        "an optional leading minus: no commas, no units, no currency symbol, no "
        "leading zeros. Anything else is graded as invalid."
    ),
    required_markers=(SUBMISSION_MARKER,),
)


class Gsm8kError(ValueError):
    pass


class Gsm8kTask(StrictModel):
    record_id: SourceId
    question: str
    answer: SourceAnswer

    @field_validator("question")
    @classmethod
    def valid_question(cls, value: str) -> str:
        if not value.strip():
            raise Gsm8kError("problem id and question must be non-empty")
        if value != value.strip() or "\x00" in value:
            raise Gsm8kError("question has invalid padding or NUL")
        return value

    @field_validator("answer", mode="before")
    @classmethod
    def valid_answer(cls, value: object) -> SourceAnswer:
        return SourceAnswer(validate_answer(value))

    @property
    def task_id(self) -> SourceId:
        return self.record_id

    @property
    def public_digest(self) -> DigestText:
        return canonical_digest({"id": self.record_id, "question": self.question})

    @property
    def verifier_digest(self) -> DigestText:
        return canonical_digest(
            {
                "contract": CONTRACT.model_dump(mode="json"),
                "grader": "gsm8k-final-answer",
                "answer": self.answer,
            }
        )

    @property
    def agent_contract(self) -> AgentContract:
        return CONTRACT


class _Gsm8kRow(StrictModel):
    question: str
    answer: SourceAnswer

    @field_validator("question")
    @classmethod
    def valid_question(cls, value: str) -> str:
        if not value.strip():
            raise Gsm8kError("question must be non-empty text")
        if value != value.strip() or "\x00" in value:
            raise Gsm8kError("question has invalid padding or NUL")
        return value

    @field_validator("answer", mode="before")
    @classmethod
    def source_answer(cls, value: object) -> SourceAnswer:
        return parse_source_answer(value)


def validate_answer(value: object) -> CanonicalInteger:
    if not isinstance(value, str):
        raise Gsm8kError("answer must be text")
    if not _INTEGER.fullmatch(value):
        raise Gsm8kError("answer must be a canonical integer")
    digits = value.removeprefix("-")
    if len(digits) > MAXIMUM_DIGITS:
        raise Gsm8kError("answer exceeds the 100-digit limit")
    return CanonicalInteger(value)


def _last_nonempty_line(text: str, marker: str, label: str) -> CanonicalInteger:
    if "\x00" in text:
        raise Gsm8kError(f"{label} contains NUL")
    if text.count(marker) != 1:
        raise Gsm8kError(f"{label} must contain exactly one {marker.strip()} marker")
    nonempty = [line for line in text.splitlines() if line.strip()]
    if not nonempty or not nonempty[-1].startswith(marker):
        raise Gsm8kError(f"{label} marker must start the final non-empty line")
    line = nonempty[-1]
    value = line[len(marker) :]
    if line != marker + value or value != value.strip():
        raise Gsm8kError(f"{label} marker line contains invalid whitespace")
    return validate_answer(value)


def parse_source_answer(text: object) -> SourceAnswer:
    if not isinstance(text, str):
        raise Gsm8kError("source answer must be text")
    return SourceAnswer(_last_nonempty_line(text, SOURCE_MARKER, "source answer"))


def parse_final_answer(text: object) -> CanonicalInteger:
    if not isinstance(text, str):
        raise Gsm8kError("submission must be text")
    return _last_nonempty_line(unfence(text), SUBMISSION_MARKER, "submission")


def load_gsm8k(path: Path) -> tuple[Gsm8kTask, ...]:
    tasks: list[Gsm8kTask] = []
    questions: set[str] = set()
    with path.open(encoding="utf-8") as source:
        for line_number, line in enumerate(source, 1):
            if not line.strip():
                raise Gsm8kError(f"line {line_number}: blank rows are not allowed")
            try:
                row = _Gsm8kRow.model_validate_json(line)
            except ValidationError as error:
                detail = error.errors(include_url=False)[0]["msg"]
                raise Gsm8kError(f"line {line_number}: {detail}") from error
            task = Gsm8kTask(
                record_id=SourceId(f"gsm8k-{line_number}"),
                question=row.question,
                answer=row.answer,
            )
            if task.question in questions:
                raise Gsm8kError(f"line {line_number}: duplicate question")
            questions.add(task.question)
            tasks.append(task)
    if not tasks:
        raise Gsm8kError("dataset is empty")
    return tuple(tasks)


def verify(task: Gsm8kTask, submission: str) -> Outcome:
    """Grade one submission against the sealed answer.

    A malformed submission is `invalid` rather than a run failure: the model
    was reachable and answered, it just did not answer in the required form.
    Only a fault in the harness itself is a `RunFailure`.
    """

    try:
        prediction = parse_final_answer(submission)
    except Gsm8kError as error:
        return Verification(verdict=Verdict.INVALID, reason=str(error))
    except Exception as error:  # pragma: no cover - defensive
        return RunFailure(
            failure_kind="verifier",
            error_type=type(error).__name__,
            message=str(error),
        )
    if prediction == task.answer:
        return Verification(
            verdict=Verdict.PASS,
            reason="final answer matches source authority",
        )
    return Verification(
        verdict=Verdict.WRONG,
        reason="final answer does not match source authority",
    )
