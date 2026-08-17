"""Shared builder for COHERENT `CommandPayload`s in direct-substrate tests.

Verification now reconciles a payload's normalized anchors against its canonical
JSON (`_check_command_payload_coherence`), so a test that issues a command must
build a payload whose JSON exactly agrees with its normalized fields and carries
exactly its kind's keys — precisely mirroring the kernel's `_command_payload` +
`_command_identity_json`. Tests that deliberately forge an INCOHERENT payload
(to prove verify refuses it) construct `CommandPayload` directly instead.
"""

from __future__ import annotations

import json as _json

from strive.runtime import ENCODING, CommandPayload, strict_encode
from strive.substrate import CompositeChange, Substrate


def _canon(body: dict[str, object]) -> str:
    return _json.dumps(body, sort_keys=True, separators=(",", ":"))


def coherent_payload(
    sub: Substrate,
    cid: str,
    kind: str,
    *,
    change: CompositeChange | None = None,
    target: str | None = None,
    expected_state_ref: str | None = None,
    issue_state_ref: str | None = None,
    prompt_role: str | None = None,
    context_ref: str | None = None,
    after_seconds: float | None = None,
    reason: str | None = None,
    rationale: str = "",
    strategy_ref: str = "t",
    detail: str = "",
    content_blobs: dict[str, str] | None = None,
) -> CommandPayload:
    """A payload whose canonical JSON agrees exactly with its normalized fields,
    for every command kind. `change` supplies Apply/Evaluate's change subtree;
    `target` supplies Confirm/Revert's change id."""
    content_blobs = content_blobs or {}
    change_ref = sub.put(change) if change is not None else None
    target_change_id = change.change_id if change is not None else target
    norm_prompt = norm_ctx = norm_reason = None
    norm_after: float | None = None
    norm_expected: str | None = None
    norm_issue: str | None = None
    if kind == "ApplyChange":
        assert change is not None
        body: dict[str, object] = {
            "command_id": cid, "change": strict_encode(change),
            "content_blobs": content_blobs, "expected_state_ref": expected_state_ref,
            "strategy_ref": strategy_ref,
        }
        norm_expected = expected_state_ref
    elif kind == "EvaluateFork":
        assert change is not None
        body = {
            "command_id": cid, "candidate": strict_encode(change),
            "content_blobs": content_blobs, "detail": detail,
        }
        norm_issue = issue_state_ref
    elif kind == "RevertChange":
        body = {
            "command_id": cid, "change_id": target_change_id,
            "expected_state_ref": expected_state_ref,
        }
        norm_expected = expected_state_ref
    elif kind == "ConfirmChange":
        body = {"command_id": cid, "change_id": target_change_id, "rationale": rationale}
    elif kind == "RequestRefinement":
        body = {"command_id": cid, "prompt_role": prompt_role, "context_ref": context_ref}
        norm_prompt, norm_ctx = prompt_role, context_ref
    elif kind == "ScheduleTrigger":
        norm_reason = reason or ""
        norm_after = after_seconds if after_seconds is not None else 0.0
        body = {"command_id": cid, "after_seconds": norm_after, "reason": norm_reason}
    elif kind == "StopAdaptation":
        norm_reason = reason or ""
        body = {"command_id": cid, "reason": norm_reason}
    else:  # pragma: no cover - defensive
        raise ValueError(f"unknown command kind {kind!r}")
    return CommandPayload(
        command_id=cid, kind=kind, encoding=ENCODING,
        change_ref=change_ref, target_change_id=target_change_id,
        expected_state_ref=norm_expected, issue_state_ref=norm_issue,
        prompt_role=norm_prompt, context_ref=norm_ctx,
        after_seconds=norm_after, reason=norm_reason, json=_canon(body),
    )
