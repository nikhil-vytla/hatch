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
# Temperature is causally real and is preregistered. There is deliberately no
# per-trial seed type: the gateway accepts `seed` and silently ignores it (same
# seed, different completions, verified empirically), so a seed field in a
# preregistered plan would promise a reproducibility we cannot deliver. Trials
# are samples from one sampling distribution, not replicates.
Temperature = Annotated[float, Field(ge=0, le=2, allow_inf_nan=False)]

SourceId = NewType("SourceId", NonEmptyText)
CanonicalInteger = NewType("CanonicalInteger", CanonicalIntegerText)
SourceAnswer = NewType("SourceAnswer", CanonicalInteger)
DesignDigest = NewType("DesignDigest", DigestText)
SourceDigest = NewType("SourceDigest", DigestText)
ModelConfigDigest = NewType("ModelConfigDigest", DigestText)
ConditionDigest = NewType("ConditionDigest", DigestText)
ConstructionSeed = NewType("ConstructionSeed", int)
TrialIndex = NewType("TrialIndex", NonNegativeInt)


class StrictModel(BaseModel):
    model_config = ConfigDict(strict=True, frozen=True, extra="forbid")
