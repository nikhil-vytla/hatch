"""Prompt rendering and STRICT `RefinementProposal` decoding for the kernel's
`RequestRefinement` path.

The kernel renders the model prompt from the ACTIVE proposal-template surface
plus a policy-supplied context, so the active prompt genuinely shapes every
refinement (never round-trip-only). It then decodes the model's completion
STRICTLY into a typed `RefinementProposal`: any malformed, non-conforming, or
non-finite output is failure-as-data (`RefinementDecodeError`), never a
silently-coerced change. Surfaces are validated through the run's pinned
descriptors, so a proposal can never name an off-limits surface or install
content its surface validator would reject.
"""

from __future__ import annotations

import json
from typing import Any

from strive.cas import hash_text
from strive.runtime import REVIEW_VERDICTS, RefinementProposal, SurfaceEdit
from strive.surfaces import SurfaceCatalog, SurfaceValidationError


class RefinementDecodeError(Exception):
    """The model output was not a strict, conforming `RefinementProposal`."""


_TOP_KEYS = {
    "change_id", "edits", "rationale", "cited_evidence", "expected_outcomes",
    "uncertainty", "review_hint",
}
_EDIT_KEYS = {"surface_kind", "surface_name", "content"}


def render_prompt(active_template: str, context: str) -> str:
    """Assemble the model prompt from the ACTIVE proposal-template surface and
    the policy's context. Deterministic: the same inputs render the same bytes,
    so a resumed refinement re-derives the identical prompt."""
    return (
        f"{active_template.strip()}\n\n"
        "=== refinement context ===\n"
        f"{context.strip()}\n"
    )


def _reject_nonfinite(_token: str) -> Any:
    # json.loads calls parse_constant for NaN/Infinity/-Infinity — refuse them
    raise RefinementDecodeError("non-finite number (NaN/Infinity) is not permitted")


def _require_str(obj: dict[str, Any], key: str) -> str:
    value = obj.get(key)
    if not isinstance(value, str):
        raise RefinementDecodeError(f"field {key!r} must be a string")
    return value


def _require_str_tuple(obj: dict[str, Any], key: str) -> tuple[str, ...]:
    value = obj.get(key)
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise RefinementDecodeError(f"field {key!r} must be a list of strings")
    return tuple(value)


def decode_proposal(
    text: str,
    *,
    catalog: SurfaceCatalog,
    allowed_surfaces: frozenset[tuple[str, str]],
) -> tuple[RefinementProposal, dict[str, str]]:
    """Strictly decode `text` into a `(RefinementProposal, content_blobs)` pair.
    Each edit's content is content-addressed (`after_ref = hash_text(content)`)
    and returned in `content_blobs` for the kernel to stage. Raises
    `RefinementDecodeError` on any deviation."""
    try:
        data = json.loads(text, parse_constant=_reject_nonfinite)
    except json.JSONDecodeError as exc:
        raise RefinementDecodeError(f"model output is not valid JSON: {exc}") from None
    if not isinstance(data, dict):
        raise RefinementDecodeError("model output is not a JSON object")
    unknown = set(data) - _TOP_KEYS
    if unknown:
        raise RefinementDecodeError(f"unexpected field(s): {sorted(unknown)}")
    missing = _TOP_KEYS - set(data)
    if missing:
        raise RefinementDecodeError(f"missing field(s): {sorted(missing)}")

    change_id = _require_str(data, "change_id")
    rationale = _require_str(data, "rationale")
    cited = _require_str_tuple(data, "cited_evidence")
    outcomes = _require_str_tuple(data, "expected_outcomes")
    review_hint = _require_str(data, "review_hint")
    if review_hint not in REVIEW_VERDICTS:
        raise RefinementDecodeError(
            f"review_hint {review_hint!r} not one of {list(REVIEW_VERDICTS)}"
        )
    uncertainty = data.get("uncertainty")
    if isinstance(uncertainty, bool) or not isinstance(uncertainty, (int, float)):
        raise RefinementDecodeError("uncertainty must be a number")
    uncertainty = float(uncertainty)
    if not (0.0 <= uncertainty <= 1.0):
        raise RefinementDecodeError("uncertainty must be within [0, 1]")

    raw_edits = data.get("edits")
    if not isinstance(raw_edits, list):
        raise RefinementDecodeError("edits must be a list")
    # The decoder is role-agnostic: the refine role uses `edits` (with a `keep`
    # hint), the review role uses `review_hint` (edits only for `revise`). The
    # POLICY enforces the edit/hint coupling per role, not the kernel decoder.

    edits: list[SurfaceEdit] = []
    blobs: dict[str, str] = {}
    seen: set[tuple[str, str]] = set()
    for raw in raw_edits:
        if not isinstance(raw, dict) or set(raw) != _EDIT_KEYS:
            raise RefinementDecodeError(f"each edit must have exactly {sorted(_EDIT_KEYS)}")
        kind = raw["surface_kind"]
        name = raw["surface_name"]
        content = raw["content"]
        if not (isinstance(kind, str) and isinstance(name, str) and isinstance(content, str)):
            raise RefinementDecodeError("edit fields must be strings")
        if (kind, name) not in allowed_surfaces:
            raise RefinementDecodeError(
                f"edit names surface {(kind, name)} not pinned for this run"
            )
        if (kind, name) in seen:
            raise RefinementDecodeError(f"duplicate edit for surface {(kind, name)}")
        seen.add((kind, name))
        try:
            catalog.validate_content(kind, name, content)
        except SurfaceValidationError as exc:
            raise RefinementDecodeError(
                f"edit content for {(kind, name)} is structurally invalid: {exc}"
            ) from None
        after_ref = hash_text(content)
        blobs[after_ref] = content
        edits.append(SurfaceEdit(surface_kind=kind, surface_name=name, after_ref=after_ref))

    proposal = RefinementProposal(
        change_id=change_id,
        edits=tuple(edits),
        rationale=rationale,
        cited_evidence=cited,
        expected_outcomes=outcomes,
        uncertainty=uncertainty,
        review_hint=review_hint,
    )
    return proposal, blobs


__all__ = ["RefinementDecodeError", "decode_proposal", "render_prompt"]
