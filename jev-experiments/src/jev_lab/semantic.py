"""A deliberately small Pydantic-to-question compiler, not free-form extraction."""

from enum import Enum
from typing import Literal, get_args, get_origin

from pydantic import BaseModel, Field

from .core import choice, normalize, noul, score, validate_json


def _annotations(extra, key):
    if extra is None:
        return {}
    if not isinstance(extra, dict):
        raise ValueError(f"Unsupported dynamic schema annotations at {key}")
    validate_json(extra)
    result = {name: value for name, value in extra.items() if name.startswith("x-jev-")}
    if set(result) - {"x-jev-instructions", "x-jev-criteria", "x-jev-levels"}:
        raise ValueError(f"Unknown Jev annotation at {key}")
    return result


def questions_for(model: type[BaseModel], prefix="") -> dict:
    if _annotations(model.model_config.get("json_schema_extra"), prefix or "root"):
        raise ValueError("Jev annotations belong on decision fields, not objects")
    questions = {}
    for name, field in model.model_fields.items():
        if not field.is_required():
            raise ValueError(f"Optional/defaulted semantic fields are unsupported: {name}")
        key, annotation = prefix + name, field.annotation
        extras = _annotations(field.json_schema_extra, key)
        if isinstance(annotation, type) and issubclass(annotation, BaseModel):
            if extras:
                raise ValueError(f"Jev annotations belong on decision fields: {key}")
            questions.update(questions_for(annotation, key + "."))
            continue
        if "x-jev-instructions" not in extras and (
            not isinstance(field.description, str) or not field.description.strip()
        ):
            raise ValueError(f"{key} needs a field description containing its question")
        instructions = extras.get("x-jev-instructions", field.description)
        if "x-jev-criteria" in extras and not isinstance(extras["x-jev-criteria"], dict):
            raise ValueError(f"Explicit criteria must be a named object: {key}")
        bounds = {
            type(m).__name__: getattr(m, type(m).__name__.lower(), None)
            for m in field.metadata
        }
        if "x-jev-levels" in extras:
            if annotation is not float or "x-jev-criteria" in extras:
                raise ValueError(f"Score levels require a float field and no other criteria: {key}")
            question = score(instructions, extras["x-jev-levels"])
            if bounds.get("Ge") != 0 or bounds.get("Le") != len(question["criteria"]) - 1:
                raise ValueError(f"Score bounds must be ge=0, le=level count minus one: {key}")
            questions[key] = question
        elif annotation is bool or annotation is float:
            if annotation is float and (bounds.get("Ge") != 0 or bounds.get("Le") != 1):
                raise ValueError(f"{key}: float must be a probability bounded by ge=0, le=1")
            criteria = extras.get("x-jev-criteria")
            questions[key] = noul(instructions, criteria)
        elif get_origin(annotation) is Literal:
            options = get_args(annotation)
            if not all(isinstance(x, str) for x in options):
                raise ValueError("Only string Literal choices are supported")
            questions[key] = choice(instructions, extras.get("x-jev-criteria", list(options)))
            if set(questions[key]["criteria"]) != set(options):
                raise ValueError(f"Choice criteria must match the field's options exactly: {key}")
        elif isinstance(annotation, type) and issubclass(annotation, Enum):
            if not all(isinstance(e.value, str) for e in annotation):
                raise ValueError("Only string-valued Enums are supported")
            options = [e.value for e in annotation]
            questions[key] = choice(instructions, extras.get("x-jev-criteria", options))
            if set(questions[key]["criteria"]) != set(options):
                raise ValueError(f"Choice criteria must match the field's options exactly: {key}")
        else:
            raise ValueError(f"Unsupported semantic field: {key}, {annotation}")
    return questions


def decode(model: type[BaseModel], answers: dict, prefix=""):
    if not prefix:
        questions = questions_for(model)
        raw = {
            key: {
                "type": answer["type"],
                answer["type"]: answer["value"],
                "probabilities": answer.get("probabilities"),
                "confidence": answer.get("confidence"),
                **({"legend": answer["legend"]} if "legend" in answer else {}),
            }
            for key, answer in answers.items()
        }
        normalize({"answers": raw}, questions)
    values = {}
    for name, field in model.model_fields.items():
        key = prefix + name
        if isinstance(field.annotation, type) and issubclass(field.annotation, BaseModel):
            values[name] = decode(field.annotation, answers, key + ".")
        else:
            value = answers[key]["value"]
            values[name] = value >= 0.5 if field.annotation is bool else value
    return model.model_validate(values)


class Ticket(BaseModel):
    area: Literal["billing", "technical", "account", "other"] = Field(
        description="Which team should handle the customer's primary request?"
    )
    refund: bool = Field(description="Does the customer explicitly request money back?")
    missing_context: float = Field(
        ge=0,
        le=1,
        description=("Is the message too vague to identify any concrete customer problem?"),
    )
