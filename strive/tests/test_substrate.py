"""The run-scoped, semantically-verified event/CAS substrate (vNext).

Covers the floor and the verified view: allowlisted surfaces, exact
before/after with a replay, expected-head conflict checks, run-scoped
stable ids, command-digest uniqueness, one-terminal-completion, multiple
runs under one root, missing-CAS and semantic-corruption refusal, and exact
revert.
"""

from pathlib import Path

import pytest

from strive import codec
from strive.cas import hash_text
from strive.substrate import (
    ChangeApplied,
    CompositeChange,
    EventEnvelope,
    Substrate,
    SubstrateError,
    SurfaceBinding,
    SurfaceDelta,
    apply_change,
    canonical_state,
    new_run_id,
)
from strive.events import now_iso

TASK = "sum-integers"


def _code(ret: int) -> str:
    return f"def solve(input_text: str) -> int:\n    return {ret}\n"


def _open(root: Path, run_id: str | None = None) -> Substrate:
    return Substrate.open(root, TASK, run_id or new_run_id())


def _bind(sub: Substrate) -> None:
    code_ref = sub.objects.put_text(_code(0))
    prompt_ref = sub.objects.put_text("baseline proposal template")
    seed = canonical_state(
        {("strategy-code", "solve"): code_ref, ("prompt", "proposal-template"): prompt_ref}
    )
    sub.bind_policy(
        task_fingerprint="fp",
        policy_ref="manual-change@1",
        policy_digest="pd",
        config_ref=sub.objects.put_text("cfg"),
        prompt_refs={"refine": sub.objects.put_text("prompt-md")},
        seed=1, seed_state=seed,
        budget_ref=sub.objects.put_text("budget"),
        required_capabilities=(),
        run_metadata={"model": "none"},
    )


def _change(sub: Substrate, *, code: str, prompt: str) -> tuple[CompositeChange, dict[str, str]]:
    seed = sub.verify().seed_state.as_map()
    code_after, prompt_after = hash_text(code), hash_text(prompt)
    change = CompositeChange(
        change_id="c1",
        deltas=(
            SurfaceDelta("strategy-code", "solve", seed.get(("strategy-code", "solve")), code_after),
            SurfaceDelta("prompt", "proposal-template", seed.get(("prompt", "proposal-template")), prompt_after),
        ),
        summary="update code + prompt",
    )
    return change, {code_after: code, prompt_after: prompt}


def test_fresh_run_is_verifiable_and_unbound(tmp_path: Path) -> None:
    view = _open(tmp_path).verify()
    assert view.ok and view.bound is None and view.seq == 0


def test_bind_then_verify(tmp_path: Path) -> None:
    sub = _open(tmp_path)
    _bind(sub)
    view = sub.verify()
    assert view.ok and view.bound is not None
    assert view.bound.policy_ref == "manual-change@1"
    assert view.state.content_ref("strategy-code", "solve") is not None
    assert view.envelopes[0].event_id == f"{sub.run_id}#1"


def test_apply_replays_and_revert_restores_exactly(tmp_path: Path) -> None:
    sub = _open(tmp_path)
    _bind(sub)
    seed_ref = sub.verify().state_ref
    change, blobs = _change(sub, code=_code(1), prompt="new proposal template")
    sub.stage_change_closure(change, blobs)
    view = sub.apply(change=change, caused_by="cmd-apply")
    assert view.ok and "c1" in view.applied_change_ids
    view = sub.revert(change_id="c1", caused_by="cmd-revert")
    assert view.ok and "c1" in view.reverted_change_ids
    assert view.state_ref == seed_ref  # reverted EXACTLY to the seed


def test_non_allowlisted_surface_refused(tmp_path: Path) -> None:
    sub = _open(tmp_path)
    _bind(sub)
    bad = CompositeChange("bad", (SurfaceDelta("secret-keys", "prod", None, "aa" * 32),), "x")
    with pytest.raises(SubstrateError, match="not in the surface catalog"):
        sub.apply(change=bad, caused_by="c")


def test_apply_requires_full_cas_closure(tmp_path: Path) -> None:
    sub = _open(tmp_path)
    _bind(sub)
    change, _blobs = _change(sub, code=_code(9), prompt="p template")
    # NOT staged -> after_refs missing from CAS
    with pytest.raises(SubstrateError, match="un-staged CAS object"):
        sub.apply(change=change, caused_by="c")


def test_stage_closure_rejects_mismatched_content(tmp_path: Path) -> None:
    sub = _open(tmp_path)
    _bind(sub)
    change, _blobs = _change(sub, code=_code(9), prompt="p template")
    with pytest.raises(SubstrateError, match="does not hash to its ref"):
        sub.stage_change_closure(change, {"aa" * 32: "not the content"})


def test_command_id_reuse_with_different_payload_fails_closed(tmp_path: Path) -> None:
    sub = _open(tmp_path)
    _bind(sub)
    sub.issue_command(command_id="k", command_kind="X", command_ref="aa" * 32)
    with pytest.raises(SubstrateError, match="reused with a different payload"):
        sub.issue_command(command_id="k", command_kind="X", command_ref="bb" * 32)


def test_duplicate_terminal_completion_refused(tmp_path: Path) -> None:
    sub = _open(tmp_path)
    _bind(sub)
    sub.issue_command(command_id="k", command_kind="X", command_ref="aa" * 32)
    sub.complete_command(command_id="k", outcome="ok", result=None)
    with pytest.raises(SubstrateError, match="already has a terminal completion"):
        sub.complete_command(command_id="k", outcome="ok", result=None)


def test_concurrent_heads_conflict(tmp_path: Path) -> None:
    root = tmp_path / "root"
    run = new_run_id()
    a = Substrate.open(root, TASK, run)
    _bind(a)
    stale = a.verify().head
    b = Substrate.open(root, TASK, run)  # a second handle on the same run
    a.confirm_change(change_id="none", rationale="advance", caused_by="cmd")  # a advances
    change, blobs = _change(b, code=_code(2), prompt="q template")
    b.stage_change_closure(change, blobs)
    with pytest.raises(SubstrateError, match="stale|advanced"):
        b.apply(change=change, caused_by="c", expected_head=stale)


def test_multiple_runs_under_one_root_are_independent(tmp_path: Path) -> None:
    root = tmp_path / "root"
    a = Substrate.open(root, TASK, new_run_id())
    _bind(a)
    b = Substrate.open(root, TASK, new_run_id())
    _bind(b)
    assert len(Substrate.list_runs(root)) == 2
    # advancing one run does not touch the other's head
    a.confirm_change(change_id="x", rationale="r", caused_by="c")
    assert a.verify().seq == 2 and b.verify().seq == 1


def test_missing_cas_object_refuses_mutation(tmp_path: Path) -> None:
    sub = _open(tmp_path)
    _bind(sub)
    # delete the bound config object from CAS -> closure broken
    bound = sub.verify().bound
    assert bound is not None
    sub.objects._path(bound.config_ref).unlink()
    view = sub.verify()
    assert not view.ok and any("config" in e for e in view.errors)
    with pytest.raises(SubstrateError, match="refused"):
        sub.confirm_change(change_id="x", rationale="r", caused_by="c")


def test_semantic_corruption_is_refused_not_quarantined(tmp_path: Path) -> None:
    sub = _open(tmp_path)
    _bind(sub)
    view = sub.verify()
    # forge a framing-valid envelope whose ChangeApplied body has a WRONG
    # after_state_ref (bypassing sub.apply's correct computation)
    forged_after = sub.put_state(canonical_state({("strategy-code", "solve"): "cc" * 32}))
    body = ChangeApplied(
        change_id="forged", change_ref=sub.put(
            CompositeChange("forged", (SurfaceDelta("strategy-code", "solve", None, "cc" * 32),), "x")
        ),
        before_state_ref=view.state_ref or "", after_state_ref=forged_after,
    )
    env = EventEnvelope(
        event_id=f"{sub.run_id}#{view.seq + 1}", run_id=sub.run_id, task_id=TASK,
        seq=view.seq + 1, caused_by="forger", body_kind=codec.schema_of(ChangeApplied),
        body_ref=sub.put(body), at=now_iso(),
    )
    sub.journal.append_batch([env], expected_head=view.head)
    after = sub.verify()
    assert not after.ok
    assert any("replay" in e or "before_state_ref" in e or "stale" in e for e in after.errors)
    # semantic corruption is REFUSED, not auto-quarantined (framing is intact)
    assert sub.repair("x") is None
    with pytest.raises(SubstrateError, match="refused"):
        sub.confirm_change(change_id="x", rationale="r", caused_by="c")


def test_pure_apply_change_is_invertible() -> None:
    state = canonical_state({("strategy-code", "solve"): "aa" * 32})
    change = CompositeChange("c", (SurfaceDelta("strategy-code", "solve", "aa" * 32, "bb" * 32),), "x")
    moved = apply_change(state, change)
    assert moved.content_ref("strategy-code", "solve") == "bb" * 32
    assert apply_change(moved, change.invert()) == state
