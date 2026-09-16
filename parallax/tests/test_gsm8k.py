from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

import parallax.gsm8k as gsm8k
from parallax.canonical import canonical_digest
from parallax.gsm8k import (
    CONTRACT,
    SUBMISSION_MARKER,
    Gsm8kError,
    Gsm8kTask,
    Verdict,
    load_gsm8k,
    parse_final_answer,
    parse_source_answer,
    verify,
)
from parallax.types import SourceAnswer, SourceId

FIXTURE = Path(__file__).parent / "fixtures" / "gsm8k.jsonl"


def test_loads_real_shaped_row_and_derives_authority() -> None:
    problem = load_gsm8k(FIXTURE)[0]

    assert problem == Gsm8kTask(
        record_id=SourceId("gsm8k-1"),
        question=(
            "Janet's ducks lay 16 eggs per day. She eats 3 for breakfast and "
            "bakes muffins with 4. She sells each remaining egg for $2. "
            "How many dollars does she make each day?"
        ),
        answer=SourceAnswer("18"),
    )


@pytest.mark.parametrize(
    ("source", "message"),
    [
        ("work\n#### 01", "canonical integer"),
        ("work\n#### 1.0", "canonical integer"),
        ("work\n#### 1\nfloating text", "final non-empty line"),
        ("#### 1\n#### 1", "exactly one"),
        ("work only", "exactly one"),
    ],
)
def test_rejects_malformed_duplicate_or_floating_authority(
    source: str, message: str
) -> None:
    with pytest.raises(Gsm8kError, match=message):
        parse_source_answer(source)


def test_rejects_duplicate_questions(tmp_path: Path) -> None:
    row = {"question": "Unique?", "answer": "work\n#### 1"}
    path = tmp_path / "duplicate.jsonl"
    path.write_text(json.dumps(row) + "\n" + json.dumps(row) + "\n", encoding="utf-8")

    with pytest.raises(Gsm8kError, match="duplicate question"):
        load_gsm8k(path)


def test_submission_policy_distinguishes_pass_wrong_and_invalid() -> None:
    problem = load_gsm8k(FIXTURE)[0]

    assert parse_final_answer("Reasoning.\nFINAL_ANSWER: 18") == "18"
    assert verify(problem, "FINAL_ANSWER: 18").verdict is Verdict.PASS
    assert verify(problem, "FINAL_ANSWER: 17").verdict is Verdict.WRONG
    assert verify(problem, "18").verdict is Verdict.INVALID
    assert verify(problem, "FINAL_ANSWER: 018").verdict is Verdict.INVALID


def test_problem_rejects_invalid_authority_at_construction() -> None:
    with pytest.raises(ValidationError, match="canonical integer"):
        Gsm8kTask(
            record_id=SourceId("bad"),
            question="Question?",
            answer=SourceAnswer("not-an-answer"),
        )

    with pytest.raises(ValidationError, match="at least 1 character"):
        Gsm8kTask(
            record_id=SourceId(""),
            question="Question?",
            answer=SourceAnswer("1"),
        )


@pytest.mark.parametrize(
    "row",
    [
        {"question": 1, "answer": "work\n#### 1"},
        {"question": "Question?", "answer": "work\n#### 1", "extra": True},
    ],
)
def test_gsm8k_boundary_is_strict_and_forbids_extras(
    tmp_path: Path,
    row: dict[str, object],
) -> None:
    path = tmp_path / "invalid.jsonl"
    path.write_text(json.dumps(row) + "\n", encoding="utf-8")

    with pytest.raises(Gsm8kError, match="line 1"):
        load_gsm8k(path)


def test_grade_trusts_validated_source_authority(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    problem = load_gsm8k(FIXTURE)[0]
    original = gsm8k.validate_answer
    calls = 0

    def tracked(value: object) -> object:
        nonlocal calls
        calls += 1
        return original(value)

    monkeypatch.setattr(gsm8k, "validate_answer", tracked)

    assert verify(problem, "FINAL_ANSWER: 18").verdict is Verdict.PASS
    assert calls == 1


def test_domain_models_are_frozen() -> None:
    problem = load_gsm8k(FIXTURE)[0]

    with pytest.raises(ValidationError, match="frozen"):
        problem.question = "Changed?"


def test_the_grader_and_the_instructions_cannot_drift_apart() -> None:
    """The contract names the marker the parser requires.

    A full round graded every episode on a `FINAL_ANSWER:` line that no prompt
    ever asked for. Both now come from one constant, and the contract is inside
    the verifier digest, so changing what the grader accepts changes the task's
    identity rather than silently regrading old evidence.
    """

    assert SUBMISSION_MARKER in CONTRACT.instructions
    assert CONTRACT.required_markers == (SUBMISSION_MARKER,)
    task = load_gsm8k(FIXTURE)[0]
    assert task.agent_contract == CONTRACT
    relaxed = CONTRACT.model_copy(update={"required_markers": ()})
    assert canonical_digest(relaxed.model_dump(mode="json")) != canonical_digest(
        CONTRACT.model_dump(mode="json")
    )


def test_a_fenced_submission_is_read_rather_than_failed() -> None:
    """`swebench.py` tolerated fences; the GSM8K parser did not, until now."""

    assert parse_final_answer("Work.\nFINAL_ANSWER: 42") == "42"
    assert parse_final_answer("```\nWork.\nFINAL_ANSWER: 42\n```") == "42"
    assert parse_final_answer("```text\nWork.\nFINAL_ANSWER: 42\n```") == "42"
