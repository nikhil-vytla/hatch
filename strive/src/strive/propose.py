"""Proposal: map a diagnosed weakness to one bounded candidate change.

v0 uses a registry of textual patches keyed by weakness id. A patch applies
only if its target snippet occurs exactly once in the parent source; anything
else makes the proposer abstain. This keeps every mutation bounded and
auditable. Later milestones can register richer proposers (model-generated
patches, prompt edits, policy tweaks) behind the same interface.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from strive.diagnose import NEGATIVE_INTEGERS_DROPPED
from strive.types import Candidate, Diagnosis

STRATEGY_CODE_SURFACE = "strategy-code"


@dataclass(frozen=True)
class Patch:
    target: str
    replacement: str
    description: str


PATCH_REGISTRY: dict[str, Patch] = {
    NEGATIVE_INTEGERS_DROPPED: Patch(
        target='r"\\d+"',
        replacement='r"-?\\d+"',
        description="Widen the integer regex to capture an optional leading minus sign.",
    ),
}


def propose(
    diagnosis: Diagnosis,
    parent_generation_id: str,
    parent_source: str,
) -> Candidate | None:
    """Return one bounded candidate for the diagnosed weakness, or abstain."""
    patch = PATCH_REGISTRY.get(diagnosis.weakness_id)
    if patch is None:
        return None
    if parent_source.count(patch.target) != 1:
        return None
    return Candidate(
        candidate_id=f"cand-{uuid.uuid4().hex[:8]}",
        parent_generation_id=parent_generation_id,
        surface=STRATEGY_CODE_SURFACE,
        weakness_id=diagnosis.weakness_id,
        description=patch.description,
        source=parent_source.replace(patch.target, patch.replacement, 1),
    )
