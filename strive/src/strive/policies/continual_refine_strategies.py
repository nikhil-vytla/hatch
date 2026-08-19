"""Surface strategies for `continual-refine@1`.

A `SurfaceStrategy` ANALYZES an immutable view and PROPOSES a change for ONE
surface — it never mutates state and never emits a lifecycle command (the
orchestrating policy alone does that). Here each strategy turns a model
`RefinementProposal` into the delta for its surface; the orchestrator merges
the enabled strategies' deltas into ONE atomic coupled change.

This module is declared in the policy's `dependency_modules`, so its full
source is folded into the pinned policy digest — a change here is detected on
resume even though it lives outside the policy's own module.
"""

from __future__ import annotations

from strive import codec
from strive.policy import RunView
from strive.runtime import REFINE_RESULT, ModelResult, RefinementProposal
from strive.substrate import CompositeChange, ObservationRecorded, SurfaceDelta

CODE_SURFACE = ("strategy-code", "solve")
PROMPT_SURFACE = ("prompt", "proposal-template")


def proposal_for(view: RunView, refine_cid: str) -> RefinementProposal | None:
    """The `RefinementProposal` a specific refine command produced, resolved
    from the durable `ModelResult` it journaled (read-only CAS access). None if
    the command has no successful, proposal-bearing result yet."""
    for body in view.bodies:
        if not (isinstance(body, ObservationRecorded) and body.observation_kind == REFINE_RESULT):
            continue
        result = codec.loads(view.read_text(body.observation_ref), ModelResult)
        if result.command_id != refine_cid or result.proposal_ref is None:
            continue
        return codec.loads(view.read_text(result.proposal_ref), RefinementProposal)
    return None


class SurfaceRefinementStrategy:
    """Emits the delta for ONE pinned surface from a `RefinementProposal` — the
    before ref is the surface's CURRENT content, the after ref the proposal's
    edit. Returns None when the proposal does not touch this surface."""

    def __init__(self, name: str, surface: tuple[str, str]) -> None:
        self.name = name
        self.surface = surface

    def delta_for(
        self, view: RunView, proposal: RefinementProposal
    ) -> SurfaceDelta | None:
        edit = next(
            (
                e for e in proposal.edits
                if (e.surface_kind, e.surface_name) == self.surface
            ),
            None,
        )
        if edit is None:
            return None
        before = view.state.content_ref(*self.surface)
        return SurfaceDelta(self.surface[0], self.surface[1], before, edit.after_ref)

    def propose(self, view: RunView) -> CompositeChange | None:
        """`SurfaceStrategy` conformance: propose a single-surface change from
        the MOST RECENT proposal-bearing model result in the view."""
        proposal = _latest_proposal(view)
        if proposal is None:
            return None
        delta = self.delta_for(view, proposal)
        if delta is None:
            return None
        return CompositeChange(proposal.change_id, (delta,), proposal.rationale)


def _latest_proposal(view: RunView) -> RefinementProposal | None:
    latest: RefinementProposal | None = None
    for body in view.bodies:
        if not (isinstance(body, ObservationRecorded) and body.observation_kind == REFINE_RESULT):
            continue
        result = codec.loads(view.read_text(body.observation_ref), ModelResult)
        if result.proposal_ref is None:
            continue
        latest = codec.loads(view.read_text(result.proposal_ref), RefinementProposal)
    return latest


def code_strategy() -> SurfaceRefinementStrategy:
    return SurfaceRefinementStrategy("strategy-code", CODE_SURFACE)


def prompt_strategy() -> SurfaceRefinementStrategy:
    return SurfaceRefinementStrategy("prompt", PROMPT_SURFACE)


__all__ = [
    "CODE_SURFACE",
    "PROMPT_SURFACE",
    "SurfaceRefinementStrategy",
    "code_strategy",
    "prompt_strategy",
    "proposal_for",
]
