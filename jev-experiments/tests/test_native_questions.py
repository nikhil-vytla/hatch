"""Native question transport conformance without a provider or model invocation."""

import json
from enum import Enum
from typing import Literal
from unittest.mock import AsyncMock

import pytest
from pydantic import BaseModel, ConfigDict, Field, create_model

from jev_lab.core import Client, Question, choice, normalize, noul, score
from jev_lab.semantic import decode, questions_for


@pytest.mark.parametrize(
    "entry",
    [None, "Describe it", [], {}, ["one", None], {"boundary": [None, True, 3, {"example": "x"}]}],
)
def test_native_entries_survive_every_question_field(entry):
    questions = [
        choice(entry, {"a": entry, "b": None}),
        score(entry, [entry, None]),
        noul(entry, {"true": entry, "false": None}),
    ]
    for question in questions:
        assert Question.model_validate(question).to_wire() == question
        assert "instructions" in question
        assert question["instructions"] == entry
        assert json.loads(json.dumps(question)) == question


@pytest.mark.parametrize(
    "invalid",
    [
        3,
        0.25,
        True,
        ("tuple",),
        {1: "integer key"},
        {"not_json": {"a", "b"}},
        {"infinite": float("inf")},
    ],
)
def test_entry_validation_rejects_coercions_and_non_json(invalid):
    for make in [
        lambda: noul(invalid),
        lambda: choice("Choose", {"a": invalid, "b": "B"}),
        lambda: score("Rate", [invalid, "Other"]),
        lambda: noul("Check", {"true": invalid, "false": "No"}),
    ]:
        with pytest.raises(ValueError):
            make()


def test_limits_are_specific_to_primitive():
    assert len(score("Rate", [str(i) for i in range(10)])["criteria"]) == 10
    assert len(choice("Choose", {str(i): None for i in range(255)})["criteria"]) == 255
    for count in [0, 1, 11, 255]:
        with pytest.raises(ValueError, match="2..10"):
            score("Rate", [str(i) for i in range(count)])
    with pytest.raises(ValueError, match="2..255"):
        choice("Choose", {str(i): None for i in range(256)})


@pytest.mark.parametrize(
    "criteria",
    [
        {"true": "Yes"},
        {"true": None, "false": None, "other": None},
        ["No", "Yes"],
        {True: "Yes", False: "No"},
    ],
)
def test_noul_requires_exact_named_boundary(criteria):
    with pytest.raises(ValueError):
        noul("Check", criteria)


def test_unknown_fields_are_rejected_and_absent_criteria_stays_absent():
    assert noul(None) == {"type": "noul", "instructions": None}
    with pytest.raises(ValueError):
        Question.model_validate({"type": "noul", "instructions": "Check", "rubric": "Lost?"})
    with pytest.raises(ValueError):
        Question.model_validate({"type": "noul"})
    with pytest.raises(ValueError):
        Question.model_validate({"type": "noul", "instructions": "Check", "criteria": None})


@pytest.mark.asyncio
async def test_client_preserves_exact_native_wire_and_complete_output():
    levels = [{"severity": "none"}, ["workaround", None], "blocked"]
    questions = {
        "choice": choice({"task": "choose", "context": None}, {"x": ["X"], "y": None}),
        "score": score(None, levels),
        "noul": noul(["boundary"], {"true": {"has": "evidence"}, "false": None}),
    }
    raw = {
        "model": "fixture-model",
        "answers": {
            "choice": {
                "type": "choice",
                "choice": "x",
                "probabilities": {"x": 0.6, "y": 0.4},
                "confidence": 0.2,
                "legend": questions["choice"]["criteria"],
            },
            "score": {
                "type": "score",
                "score": 1.6,
                "probabilities": {"0": 0.1, "1": 0.2, "2": 0.7},
                "legend": {str(i): v for i, v in enumerate(levels)},
                "confidence": 0.4,
            },
            "noul": {"type": "noul", "noul": 0.35, "legend": questions["noul"]["criteria"]},
        },
        "usage": {"input_tokens": 50, "output_tokens": 10},
    }
    client = object.__new__(Client)
    client.request = AsyncMock(return_value={"raw": raw, "latency_ms": 10})
    result = await client.evaluate({"document": "fixture"}, questions)
    assert client.request.call_args.args[1]["questions"] == questions
    assert client.request.call_args.args[1]["state"] == {"document": "fixture"}
    answer = result["answers"]["score"]
    assert answer["value"] == 1.6
    assert answer["argmax"] == 2
    assert answer["legend"] == raw["answers"]["score"]["legend"]
    assert answer["confidenceDefinition"] == "provider-distribution-confidence"
    assert result["answers"]["noul"]["probabilityTrue"] == 0.35
    assert result["answers"]["noul"]["probabilities"] == {"false": 0.65, "true": 0.35}
    assert result["raw"] is raw
    for key in questions:
        assert result["answers"][key]["legend"] == raw["answers"][key]["legend"]


@pytest.mark.parametrize("kind", ["choice", "noul", "score"])
def test_all_native_legends_reject_changed_descriptions_and_lossy_shapes(kind):
    question = (
        choice("Choose", {"a": {"enabled": True}, "b": None})
        if kind == "choice"
        else noul("Check", {"true": {"enabled": True}, "false": None})
        if kind == "noul"
        else score("Rate", [{"enabled": True}, None])
    )
    legend = question["criteria"] if kind != "score" else {"0": question["criteria"][0], "1": None}
    answer = (
        {"type": kind, "choice": "a", "probabilities": {"a": 0.6, "b": 0.4}}
        if kind == "choice"
        else {"type": kind, "noul": 0.6}
        if kind == "noul"
        else {"type": kind, "score": 0.4, "probabilities": {"0": 0.6, "1": 0.4}}
    )
    first = next(iter(legend))
    for bad in [
        {**legend, first: {"enabled": 1}},
        {**legend, first: True},
        {**legend, "extra": None},
    ]:
        with pytest.raises(ValueError, match="legend"):
            normalize({"answers": {"q": {**answer, "legend": bad}}}, {"q": question})
    assert (
        normalize({"answers": {"q": {**answer, "legend": legend}}}, {"q": question})["q"]["legend"]
        == legend
    )


@pytest.mark.asyncio
async def test_invalid_input_does_not_reach_transport():
    client = object.__new__(Client)
    client.request = AsyncMock()
    cyclic = {}
    cyclic["self"] = cyclic
    for state, questions in [
        ({1: "coerced"}, {"q": noul("Check")}),
        (cyclic, {"q": noul("Check")}),
        ("state", {"q": {"type": "score", "instructions": "Rate", "criteria": ["x"] * 11}}),
        ("state", {1: noul("Check")}),
    ]:
        with pytest.raises(ValueError):
            await client.evaluate(state, questions)
    client.request.assert_not_called()


@pytest.mark.parametrize(
    "probabilities",
    [
        None,
        [0.5, 0.5],
        {"a": 0.5},
        {"a": True, "b": 0},
        {"a": float("nan"), "b": 1},
        {"a": 0.1, "b": 0.1},
        {"a": 0.5, "b": 0.5, "c": 0},
    ],
)
def test_complete_numeric_distributions_are_required(probabilities):
    with pytest.raises(ValueError, match="distribution"):
        normalize(
            {"answers": {"q": {"type": "choice", "choice": "a", "probabilities": probabilities}}},
            {"q": choice("Choose", ["a", "b"])},
        )


@pytest.mark.parametrize("value", [True, "0.5", float("inf"), float("nan"), -1, 2])
def test_noul_is_a_probability_not_a_coerced_boolean(value):
    with pytest.raises(ValueError):
        normalize({"answers": {"q": {"type": "noul", "noul": value}}}, {"q": noul("Check")})


def test_response_cannot_change_the_rubric_or_hide_extra_answers():
    question = score("Rate", ["low", "high"])
    answer = {
        "type": "score",
        "score": 0.8,
        "probabilities": {"0": 0.2, "1": 0.8},
        "legend": {"0": "bad", "1": "high"},
    }
    with pytest.raises(ValueError, match="legend"):
        normalize({"answers": {"q": answer}}, {"q": question})
    with pytest.raises(ValueError, match="exactly"):
        normalize(
            {"answers": {"q": {"type": "noul", "noul": 0.5}, "other": {}}}, {"q": noul("Check")}
        )


def test_explicit_two_level_score_precedes_probability_inference():
    levels = [{"when": "routine"}, ["severe", None]]
    model = create_model(
        "Severity",
        severity=(
            float,
            Field(
                ge=0,
                le=1,
                json_schema_extra={
                    "x-jev-instructions": None,
                    "x-jev-levels": levels,
                },
            ),
        ),
    )
    questions = questions_for(model)
    assert questions == {"severity": {"type": "score", "instructions": None, "criteria": levels}}
    value = decode(
        model,
        {
            "severity": {
                "type": "score",
                "value": 0.35,
                "probabilities": {"0": 0.65, "1": 0.35},
                "legend": {"0": levels[0], "1": levels[1]},
            }
        },
    )
    assert value.severity == 0.35


def test_pydantic_annotations_preserve_native_boundaries_and_choice_subtrees():
    class Category(str, Enum):
        A = "a"
        B = "b"

    class Annotated(BaseModel):
        category: Category = Field(
            json_schema_extra={
                "x-jev-instructions": {"task": ["choose", None]},
                "x-jev-criteria": {"a": {"subtree": [True, 2]}, "b": None},
            }
        )
        relevant: bool = Field(
            description="Relevant?",
            json_schema_extra={
                "x-jev-criteria": {"true": {"evidence": ["quoted"]}, "false": None},
            },
        )

    questions = questions_for(Annotated)
    assert questions["category"]["instructions"] == {"task": ["choose", None]}
    assert questions["category"]["criteria"] == {"a": {"subtree": [True, 2]}, "b": None}
    assert questions["relevant"]["criteria"] == {"true": {"evidence": ["quoted"]}, "false": None}


@pytest.mark.parametrize(
    "annotation,extra,bounds",
    [
        (bool, {"x-jev-levels": ["no", "yes"]}, {}),
        (
            float,
            {"x-jev-levels": ["low", "high"], "x-jev-criteria": {"true": "yes", "false": "no"}},
            {"ge": 0, "le": 1},
        ),
        (float, {"x-jev-levels": ["x"] * 11}, {"ge": 0, "le": 10}),
        (float, {"x-jev-levels": ["low", "high"]}, {"ge": 0, "le": 2}),
        (int, {"x-jev-levels": ["low", "high"]}, {"ge": 0, "le": 1}),
        (bool, {"x-jev-critera": {"true": "yes", "false": "no"}}, {}),
        (bool, {"x-jev-criteria": None}, {}),
        (Literal["a", "b"], {"x-jev-criteria": ["a", "b"]}, {}),
        (Literal["a", "b"], {"x-jev-criteria": {"a": "A", "different": "B"}}, {}),
    ],
)
def test_pydantic_rejects_unknown_misplaced_or_lossy_annotations(annotation, extra, bounds):
    model = create_model(
        "Invalid", value=(annotation, Field(description="Check", json_schema_extra=extra, **bounds))
    )
    with pytest.raises(ValueError):
        questions_for(model)


def test_pydantic_rejects_semantic_annotations_on_objects():
    class Nested(BaseModel):
        value: bool = Field(description="Check")

    class Root(BaseModel):
        model_config = ConfigDict(json_schema_extra={"x-jev-instructions": "Lost?"})
        value: bool = Field(description="Check")

    wrapper = create_model(
        "Wrapper", value=(Nested, Field(json_schema_extra={"x-jev-instructions": "Lost?"}))
    )
    for model in [Root, wrapper]:
        with pytest.raises(ValueError, match="decision fields"):
            questions_for(model)
