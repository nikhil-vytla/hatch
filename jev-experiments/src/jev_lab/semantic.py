"""A deliberately small Pydantic-to-question compiler, not free-form extraction."""

from enum import Enum
from typing import Literal, get_args, get_origin

from pydantic import BaseModel, Field

from .core import choice, normalize, noul


def questions_for(model: type[BaseModel], prefix="") -> dict:
    questions = {}
    for name, field in model.model_fields.items():
        if not field.is_required():
            raise ValueError(f"Optional/defaulted semantic fields are unsupported: {name}")
        key, annotation = prefix + name, field.annotation
        if isinstance(annotation, type) and issubclass(annotation, BaseModel):
            questions.update(questions_for(annotation, key + "."))
            continue
        if not field.description:
            raise ValueError(f"{key} needs a field description containing its question")
        if annotation is bool or annotation is float:
            if annotation is float:
                bounds = {
                    type(m).__name__: getattr(m, type(m).__name__.lower(), None)
                    for m in field.metadata
                }
                if bounds.get("Ge") != 0 or bounds.get("Le") != 1:
                    raise ValueError(f"{key}: float must be a probability bounded by ge=0, le=1")
            questions[key] = noul(field.description)
        elif get_origin(annotation) is Literal:
            options = get_args(annotation)
            if not all(isinstance(x, str) for x in options):
                raise ValueError("Only string Literal choices are supported")
            questions[key] = choice(field.description, list(options))
        elif isinstance(annotation, type) and issubclass(annotation, Enum):
            if not all(isinstance(e.value, str) for e in annotation):
                raise ValueError("Only string-valued Enums are supported")
            questions[key] = choice(field.description, [e.value for e in annotation])
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
