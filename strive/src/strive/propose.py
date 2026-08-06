"""Proposal: map a diagnosed weakness to one bounded candidate change.

Proposers receive the same visible-only context as diagnosis (holdout
isolation) plus the diagnosis itself, and return a proposal carrying full
replacement source text. The kernel content-addresses the source and builds
the Candidate record; proposers never touch the store.

The registry proposer keeps v0 semantics: one weakness ↦ one textual patch
that must match exactly once in the parent source, otherwise it abstains.
A model-backed proposer plugs in behind the same protocol next phase.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from strive.contracts import Diagnosis
from strive.diagnose import NEGATIVE_INTEGERS_DROPPED, VisibleContext

STRATEGY_CODE_SURFACE = "strategy-code"


@dataclass(frozen=True)
class Proposal:
    surface: str
    weakness_id: str
    description: str
    source: str


class Proposer(Protocol):
    def propose(self, ctx: VisibleContext, diagnosis: Diagnosis) -> Proposal | None: ...


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


class RegistryProposer:
    def propose(self, ctx: VisibleContext, diagnosis: Diagnosis) -> Proposal | None:
        patch = PATCH_REGISTRY.get(diagnosis.weakness_id)
        if patch is None:
            return None
        if ctx.parent_source.count(patch.target) != 1:
            return None
        return Proposal(
            surface=STRATEGY_CODE_SURFACE,
            weakness_id=diagnosis.weakness_id,
            description=patch.description,
            source=ctx.parent_source.replace(patch.target, patch.replacement, 1),
        )
