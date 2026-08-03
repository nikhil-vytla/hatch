from __future__ import annotations

import json
import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from fractions import Fraction
from pathlib import Path
from typing import Any

from parallax.ids import digest_value

_NUMBER = r"[-+]?(?:\d[\d,]*)(?:\.\d+)?(?:/\d[\d,]*)?"
_ANSWER_PATTERNS = (
    re.compile(r"####\s*(" + _NUMBER + r")", re.IGNORECASE),
    re.compile(r"\\boxed\{\s*(" + _NUMBER + r")\s*\}", re.IGNORECASE),
    re.compile(r"<answer>\s*(" + _NUMBER + r")\s*</answer>", re.IGNORECASE),
    re.compile(r"\[answer\]\s*(" + _NUMBER + r")\s*\[/answer\]", re.IGNORECASE),
    re.compile(r"```(?:answer)?\s*(" + _NUMBER + r")\s*```", re.IGNORECASE),
    re.compile(
        r"(?:final\s+answer|answer)\s*(?:is|=|:)\s*(?:\$)?(" + _NUMBER + r")",
        re.IGNORECASE,
    ),
)
_ANY_NUMBER = re.compile(_NUMBER)


@dataclass(frozen=True)
class SourceTask:
    dataset: str
    revision: str
    split: str
    item_id: str
    question: str
    answer_authority: str
    evaluator: str = "gsm8k.native.v1"

    def __post_init__(self) -> None:
        if not all(
            value.strip()
            for value in (self.dataset, self.revision, self.split, self.item_id, self.question)
        ):
            raise ValueError("GSM8K source fields must be non-empty")
        object.__setattr__(self, "answer_authority", normalize_scalar(self.answer_authority))

    @property
    def source_digest(self) -> str:
        return digest_value(self.public_payload())

    @property
    def verifier_digest(self) -> str:
        return digest_value(self.sealed_payload())

    def public_payload(self) -> dict[str, str]:
        return {
            "dataset": self.dataset,
            "item_id": self.item_id,
            "question": self.question,
            "revision": self.revision,
            "split": self.split,
        }

    def safe_metadata(self) -> dict[str, str]:
        return {
            "dataset": self.dataset,
            "item_id": self.item_id,
            "revision": self.revision,
            "split": self.split,
        }

    def sealed_payload(self) -> dict[str, str]:
        return {
            "answer_authority": self.answer_authority,
            "evaluator": self.evaluator,
        }

    def score(self, response: str) -> bool:
        parsed = parse_final_answer(response)
        return parsed is not None and parsed == self.answer_authority


class Gsm8k:
    @staticmethod
    def item(
        *,
        dataset: str,
        revision: str,
        split: str,
        item_id: str,
        question: str,
        answer: str | int | float | Decimal,
    ) -> SourceTask:
        return SourceTask(
            dataset=dataset,
            revision=revision,
            split=split,
            item_id=item_id,
            question=question,
            answer_authority=normalize_scalar(answer),
        )

    @staticmethod
    def load(path: Path) -> SourceTask:
        value: Any = json.loads(path.read_text())
        if not isinstance(value, dict):
            raise ValueError("GSM8K fixture must be a JSON object")
        required = {"dataset", "revision", "split", "item_id", "question", "answer"}
        if set(value) != required:
            raise ValueError(f"GSM8K fixture keys must be exactly {sorted(required)}")
        return Gsm8k.item(
            dataset=_text(value, "dataset"),
            revision=_text(value, "revision"),
            split=_text(value, "split"),
            item_id=_text(value, "item_id"),
            question=_text(value, "question"),
            answer=value["answer"],
        )


def normalize_scalar(value: str | int | float | Decimal) -> str:
    if isinstance(value, bool):
        raise ValueError("boolean answers are not GSM8K scalars")
    text = str(value).strip()
    parsed = parse_final_answer(text)
    if parsed is None:
        raise ValueError(f"cannot normalize GSM8K answer: {value!r}")
    return parsed


def parse_final_answer(response: str) -> str | None:
    text = response.strip()
    if not text:
        return None
    for pattern in _ANSWER_PATTERNS:
        matches = pattern.findall(text)
        if matches:
            return _normalize_number(matches[-1])
    matches = _ANY_NUMBER.findall(text)
    if not matches:
        return None
    return _normalize_number(matches[-1])


def _normalize_number(value: str) -> str | None:
    compact = value.replace(",", "").strip()
    try:
        if "/" in compact:
            numerator, denominator = compact.split("/", 1)
            fraction = Fraction(Decimal(numerator)) / Fraction(Decimal(denominator))
            if fraction.denominator == 1:
                return str(fraction.numerator)
            return f"{fraction.numerator}/{fraction.denominator}"
        decimal = Decimal(compact)
    except (InvalidOperation, ValueError, ZeroDivisionError):
        return None
    if not decimal.is_finite():
        return None
    if decimal == decimal.to_integral():
        return str(decimal.to_integral())
    return format(decimal.normalize(), "f")


def _text(value: dict[str, Any], key: str) -> str:
    item = value.get(key)
    if not isinstance(item, str):
        raise ValueError(f"GSM8K fixture {key!r} must be a string")
    return item
