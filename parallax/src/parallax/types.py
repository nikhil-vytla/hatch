from __future__ import annotations

from typing import Annotated, NewType

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

NonEmptyText = Annotated[str, StringConstraints(min_length=1)]
DigestText = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
CanonicalIntegerText = Annotated[
    str,
    StringConstraints(pattern=r"^(?:0|-?[1-9][0-9]{0,99})$"),
]
NonNegativeInt = Annotated[int, Field(ge=0)]
PositiveInt = Annotated[int, Field(gt=0)]
Usd = Annotated[float, Field(ge=0, allow_inf_nan=False)]

SourceId = NewType("SourceId", NonEmptyText)
CanonicalInteger = NewType("CanonicalInteger", CanonicalIntegerText)
SourceAnswer = NewType("SourceAnswer", CanonicalInteger)
DesignDigest = NewType("DesignDigest", DigestText)
SourceDigest = NewType("SourceDigest", DigestText)
ModelConfigDigest = NewType("ModelConfigDigest", DigestText)
ArmConfigDigest = NewType("ArmConfigDigest", DigestText)
ConstructionSeed = NewType("ConstructionSeed", int)
TrialSeed = NewType("TrialSeed", int)
TrialIndex = NewType("TrialIndex", NonNegativeInt)


class StrictModel(BaseModel):
    model_config = ConfigDict(strict=True, frozen=True, extra="forbid")
