"""Campaign influence permissions, not grants to retrieve protected bytes."""

from dataclasses import dataclass
from enum import StrEnum
from types import MappingProxyType
from typing import Final, Mapping


class FeedbackContract(StrEnum):
    A = "A"
    B = "B"
    C = "C"


class EvidencePool(StrEnum):
    DEVELOPMENT = "development"
    VALIDATION = "validation"
    AUDIT = "audit"
    PRIVATE_VETO = "private_veto"
    OPERATIONAL_FAILURES = "operational_failures"


@dataclass(frozen=True, slots=True)
class FeedbackAccess:
    implemented: bool
    adaptation: frozenset[EvidencePool]
    selection: frozenset[EvidencePool]
    conditional_on_manifest_grant: frozenset[EvidencePool]


FEEDBACK_ACCESS_MATRIX: Final[Mapping[FeedbackContract, FeedbackAccess]] = MappingProxyType({
    FeedbackContract.A: FeedbackAccess(
        True,
        frozenset({EvidencePool.DEVELOPMENT, EvidencePool.OPERATIONAL_FAILURES}),
        frozenset({EvidencePool.DEVELOPMENT, EvidencePool.OPERATIONAL_FAILURES}),
        frozenset({EvidencePool.DEVELOPMENT, EvidencePool.OPERATIONAL_FAILURES}),
    ),
    FeedbackContract.B: FeedbackAccess(
        True,
        frozenset({EvidencePool.DEVELOPMENT, EvidencePool.VALIDATION, EvidencePool.OPERATIONAL_FAILURES}),
        frozenset({EvidencePool.DEVELOPMENT, EvidencePool.VALIDATION, EvidencePool.OPERATIONAL_FAILURES}),
        frozenset({EvidencePool.DEVELOPMENT, EvidencePool.VALIDATION, EvidencePool.OPERATIONAL_FAILURES}),
    ),
    # C requires a future control channel and fresh audit. No speculative grant.
    FeedbackContract.C: FeedbackAccess(False, frozenset(), frozenset(), frozenset()),
})
