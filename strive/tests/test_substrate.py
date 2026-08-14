"""The revision-native event/artifact substrate (vNext Phase A).

Covers the non-configurable floor: allowlisted surfaces, exact before/after
state, expected-head conflict checks, CAS-backed state materialization, and
exact revert — plus completed-command bookkeeping used for resume.
"""

from pathlib import Path

import pytest

from strive.substrate import (
    ChangeApplied,
    ChangeReverted,
    CompositeChange,
    Substrate,
    SubstrateError,
    SurfaceDelta,
    apply_change,
    canonical_state,
)

TASK = "sum-integers"


def _open(tmp_path: Path) -> Substrate:
    return Substrate.open(tmp_path / "run", TASK)


def _seed(sub: Substrate) -> None:
    code_ref = sub.objects.put_text("def solve(t):\n    return 0\n")
    prompt_ref = sub.objects.put_text("baseline {parent_generation_id}")
    seed_state = canonical_state(
        {("strategy-code", "solve"): code_ref, ("prompt", "proposal-template"): prompt_ref}
    )
    sub.bind_policy(
        policy_ref="manual-change@1",
        config_ref=sub.objects.put_text("cfg"),
        prompt_refs={"refine": sub.objects.put_text("prompt-md")},
        seed=1,
        seed_state=seed_state,
        run_metadata={"model": "none"},
    )


def _put(sub: Substrate, text: str) -> str:
    return sub.objects.put_text(text)


def _change(sub: Substrate, *, code: str, prompt: str) -> tuple[CompositeChange, dict[str, str]]:
    view = sub.view()
    current = view.state.as_map()
    from strive.cas import hash_text

    code_after, prompt_after = hash_text(code), hash_text(prompt)
    change = CompositeChange(
        change_id="c1",
        deltas=(
            SurfaceDelta("strategy-code", "solve",
                         current.get(("strategy-code", "solve")), code_after),
            SurfaceDelta("prompt", "proposal-template",
                         current.get(("prompt", "proposal-template")), prompt_after),
        ),
        summary="update code + prompt",
    )
    _put(sub, code)
    _put(sub, prompt)
    return change, {code_after: code, prompt_after: prompt}


def test_bind_then_state_materializes_from_seed(tmp_path: Path) -> None:
    sub = _open(tmp_path)
    _seed(sub)
    view = sub.view()
    assert view.bound is not None and view.bound.policy_ref == "manual-change@1"
    assert view.state.content_ref("strategy-code", "solve") is not None
    assert view.state_ref is not None


def test_apply_moves_state_and_revert_restores_exactly(tmp_path: Path) -> None:
    sub = _open(tmp_path)
    _seed(sub)
    seed_ref = sub.view().state_ref
    change, _blobs = _change(
        sub, code="def solve(t):\n    return 1\n", prompt="new {parent_generation_id}"
    )
    after = sub.apply(change=change)
    assert after != sub._load_state(seed_ref or "")
    assert any(isinstance(e, ChangeApplied) for e in sub.journal.read().entries)

    sub.revert(change_id="c1")
    assert any(isinstance(e, ChangeReverted) for e in sub.journal.read().entries)
    # reverted EXACTLY: current state ref equals the seed state ref
    assert sub.view().state_ref == seed_ref


def test_non_allowlisted_surface_is_refused(tmp_path: Path) -> None:
    sub = _open(tmp_path)
    _seed(sub)
    bad = CompositeChange(
        change_id="bad",
        deltas=(SurfaceDelta("secret-keys", "prod", None, "aa" * 32),),
        summary="exfiltrate",
    )
    with pytest.raises(SubstrateError, match="not allowlisted"):
        sub.apply(change=bad)


def test_stale_before_is_a_conflict(tmp_path: Path) -> None:
    sub = _open(tmp_path)
    _seed(sub)
    # a delta whose before_ref does not match the current content
    change = CompositeChange(
        change_id="stale",
        deltas=(SurfaceDelta("strategy-code", "solve", "zz" * 32, "aa" * 32),),
        summary="stale before",
    )
    with pytest.raises(SubstrateError, match="stale before-state"):
        sub.apply(change=change)


def test_expected_head_conflict_check(tmp_path: Path) -> None:
    sub = _open(tmp_path)
    _seed(sub)
    stale_head = sub.view().head
    # advance the journal (an observation)
    sub.record_observation(observation_kind="note", observation="a-note")
    change, _b = _change(
        sub, code="def solve(t):\n    return 2\n", prompt="p {parent_generation_id}"
    )
    with pytest.raises(SubstrateError, match="advanced"):
        sub.apply(change=change, expected_head=stale_head)


def test_completed_command_ids_track_resume_state(tmp_path: Path) -> None:
    sub = _open(tmp_path)
    _seed(sub)
    sub.issue_command(command_id="x1", command_kind="ApplyChange", command="payload")
    assert "x1" not in sub.completed_command_ids()
    sub.complete_command(command_id="x1", outcome="ok", result=None)
    assert "x1" in sub.completed_command_ids()


def test_double_bind_is_refused(tmp_path: Path) -> None:
    sub = _open(tmp_path)
    _seed(sub)
    with pytest.raises(SubstrateError, match="already bound"):
        _seed(sub)


def test_pure_apply_change_helper_is_exact() -> None:
    state = canonical_state({("strategy-code", "solve"): "aa" * 32})
    change = CompositeChange(
        change_id="c",
        deltas=(SurfaceDelta("strategy-code", "solve", "aa" * 32, "bb" * 32),),
        summary="x",
    )
    moved = apply_change(state, change)
    assert moved.content_ref("strategy-code", "solve") == "bb" * 32
    # inverting restores exactly
    restored = apply_change(moved, change.invert())
    assert restored == state
