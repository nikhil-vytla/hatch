"""Adversarial floor tests for the vNext substrate + kernel.

Each test attacks one guarantee the corrections added: exact run identity and
traversal safety, a closed body union, corrupt-but-present CAS, verify purity
(no read-side CAS writes), arbitrary/duplicate revert refusal, kernel command
re-derivation identity, budgets that survive restart without reset or
expansion, hyphenated task discovery via the binding index (never string
parsing), and trusted structural validation of surface content.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from strive import codec, kernel
from strive.cas import hash_text
from strive.contracts import BudgetSpec, BudgetUsage
from strive.events import now_iso
from strive.kernel import KernelError, KernelServices, run_policy
from strive.policies import manual_change as mc
from strive.policy import StopAdaptation, default_catalog
from strive.substrate import (
    EMPTY_STATE,
    CompositeChange,
    EventEnvelope,
    Substrate,
    SubstrateError,
    SurfaceDelta,
    canonical_state,
    new_run_id,
    validate_run_id,
)
from strive.tasks import SUM_INTEGERS_TASK as TASK

_BASELINE = (
    "import re\n\n\ndef solve(input_text: str) -> int:\n"
    '    return sum(int(t) for t in re.findall(r"\\d+", input_text))\n'
)


# -- shared helpers ---------------------------------------------------------------------------------


def _bound_sub(root: Path, run_id: str, *, task: str = "sum-integers") -> Substrate:
    """A minimally-bound substrate (no kernel), used to attack verify()."""
    sub = Substrate.open(root, task, run_id)
    code_ref = sub.objects.put_text("def solve(input_text: str) -> int:\n    return 0\n")
    prompt_ref = sub.objects.put_text("baseline proposal template")
    seed = canonical_state(
        {("strategy-code", "solve"): code_ref, ("prompt", "proposal-template"): prompt_ref}
    )
    sub.bind_policy(
        task_fingerprint="fp", policy_ref="p@1", policy_digest="pd",
        config_ref=sub.objects.put_text("cfg"),
        prompt_refs={"refine": sub.objects.put_text("prompt-md")},
        seed=1, seed_state=seed,
        budget_ref=sub.objects.put_text("budget"),
        required_capabilities=(), run_metadata={},
    )
    return sub


def _drive(root: Path, run_id: str, *, executions: int = 128) -> object:
    services = KernelServices.open(
        root, TASK, run_id, seed=7, budget=BudgetSpec(executions=executions)
    )
    objects = services.substrate.objects
    return run_policy(
        services, default_catalog(), "manual-change@1",
        mc.load_config(mc.DEFAULT_CONFIG_PATH),
        prompt_refs=mc.prompt_refs(objects),
        seed_state=mc.seed_state(objects, code=_BASELINE, prompt="base proposal template"),
        run_metadata={},
    )


# -- exact run identity + traversal -----------------------------------------------------------------


@pytest.mark.parametrize("bad", ["../evil", "a/b", "..", "run/../x", "", "a" * 200, "\\x"])
def test_bad_run_ids_rejected(bad: str) -> None:
    with pytest.raises(SubstrateError):
        validate_run_id(bad)


def test_hyphenated_run_ids_and_tasks_are_allowed() -> None:
    validate_run_id("sum-integers-run-01")
    validate_run_id("run-abc.def_ghi-123")


def test_open_refuses_traversal_run_id(tmp_path: Path) -> None:
    with pytest.raises(SubstrateError):
        Substrate.open(tmp_path, "sum-integers", "../evil")


def test_hyphenated_task_discovered_from_binding_not_parsing(tmp_path: Path) -> None:
    run = new_run_id()  # opaque id encodes no task
    _bound_sub(tmp_path, run, task="multi-word-hyphenated-task")
    # discovery reads the binding index; it never string-parses the run id
    discovered = Substrate.discover(tmp_path, run)
    assert discovered.task_id == "multi-word-hyphenated-task"
    assert discovered.verify().ok


def test_task_spoofing_is_detected(tmp_path: Path) -> None:
    run = new_run_id()
    _bound_sub(tmp_path, run, task="sum-integers")
    # an attacker reopens the SAME run claiming a different task
    spoof = Substrate.open(tmp_path, "max-integers", run)
    view = spoof.verify()
    assert not view.ok
    assert any("task" in e for e in view.errors)


def test_binding_index_tamper_is_detected(tmp_path: Path) -> None:
    run = new_run_id()
    sub = _bound_sub(tmp_path, run)
    binding_path = tmp_path / "runs" / f"{run}.binding.json"
    binding_path.write_text(
        binding_path.read_text().replace("sum-integers", "max-integers")
    )
    view = sub.verify()
    assert not view.ok
    assert any("binding" in e or "task" in e for e in view.errors)


# -- closed body union + corrupt CAS ----------------------------------------------------------------


def test_unknown_body_kind_is_refused(tmp_path: Path) -> None:
    run = new_run_id()
    sub = _bound_sub(tmp_path, run)
    view = sub.verify()
    # a registered dataclass that is NOT part of the substrate body union
    body = BudgetUsage(executions=1)
    env = EventEnvelope(
        event_id=f"{run}#{view.seq + 1}", run_id=run, task_id="sum-integers",
        seq=view.seq + 1, caused_by=None, body_kind=codec.schema_of(BudgetUsage),
        body_ref=sub.put(body), at=now_iso(),
    )
    sub.journal.append_batch([env], expected_head=view.head)
    after = sub.verify()
    assert not after.ok
    assert any("closed substrate body union" in e for e in after.errors)


def test_corrupt_but_present_cas_refuses_and_hides_state(tmp_path: Path) -> None:
    run = new_run_id()
    sub = _bound_sub(tmp_path, run)
    bound_env = sub.verify().envelopes[0]
    sub.objects._path(bound_env.body_ref).write_text("garbage-not-json")
    view = sub.verify()
    assert not view.ok
    # NEVER expose active state from an unverifiable stream
    assert view.state == EMPTY_STATE and view.state_ref is None


# -- verify purity ----------------------------------------------------------------------------------


def _object_files(root: Path) -> set[str]:
    objects = root / "objects"
    return {str(p.relative_to(objects)) for p in objects.rglob("*") if p.is_file()}


def test_verify_is_pure_no_readside_cas_writes(tmp_path: Path) -> None:
    run = new_run_id()
    sub = _bound_sub(tmp_path, run)
    # apply one change so verify's replay path runs
    seed = sub.verify().seed_state.as_map()
    code_after = hash_text("def solve(input_text: str) -> int:\n    return 5\n")
    prompt_after = hash_text("revised template")
    change = CompositeChange(
        change_id="c1",
        deltas=(
            SurfaceDelta("strategy-code", "solve", seed[("strategy-code", "solve")], code_after),
            SurfaceDelta("prompt", "proposal-template", seed[("prompt", "proposal-template")], prompt_after),
        ),
        summary="x",
    )
    sub.stage_change_closure(
        change,
        {code_after: "def solve(input_text: str) -> int:\n    return 5\n",
         prompt_after: "revised template"},
    )
    sub.apply(change=change, caused_by="cmd")
    before = _object_files(tmp_path)
    for _ in range(5):
        assert sub.verify().ok
    assert _object_files(tmp_path) == before  # verify wrote nothing


# -- arbitrary / duplicate revert -------------------------------------------------------------------


def test_revert_of_never_applied_change_refused(tmp_path: Path) -> None:
    run = new_run_id()
    sub = _bound_sub(tmp_path, run)
    with pytest.raises(SubstrateError, match="no applied change"):
        sub.revert(change_id="ghost", caused_by="c")


def test_double_revert_refused(tmp_path: Path) -> None:
    run = new_run_id()
    sub = _bound_sub(tmp_path, run)
    seed = sub.verify().seed_state.as_map()
    code_after = hash_text("def solve(input_text: str) -> int:\n    return 7\n")
    change = CompositeChange(
        change_id="c1",
        deltas=(SurfaceDelta("strategy-code", "solve", seed[("strategy-code", "solve")], code_after),),
        summary="x",
    )
    sub.stage_change_closure(change, {code_after: "def solve(input_text: str) -> int:\n    return 7\n"})
    sub.apply(change=change, caused_by="a")
    sub.revert(change_id="c1", caused_by="r1")
    with pytest.raises(SubstrateError, match="already reverted"):
        sub.revert(change_id="c1", caused_by="r2")


# -- kernel command re-derivation identity ----------------------------------------------------------


def test_kernel_refuses_changed_rederived_command(tmp_path: Path) -> None:
    run = new_run_id()
    _bound_sub(tmp_path, run)  # a bound, verifiable run
    services = KernelServices.open(tmp_path, TASK, run, budget=BudgetSpec(executions=8))
    sub = services.substrate
    command = StopAdaptation(command_id=f"{run}:x", reason="r")
    # an intent already recorded under a DIFFERENT payload digest
    sub.issue_command(command_id=command.command_id, command_kind="StopAdaptation",
                      command_ref="aa" * 32)
    view = sub.verify()
    with pytest.raises(KernelError, match="different payload digest"):
        kernel._run_command(services, view, command)


# -- budgets survive restart ------------------------------------------------------------------------


def test_budget_not_reset_on_resume(tmp_path: Path) -> None:
    run = new_run_id()
    r1 = _drive(tmp_path, run)
    used = r1.usage.executions  # type: ignore[attr-defined]
    assert used > 0
    r2 = _drive(tmp_path, run)  # resume a completed run
    # cumulative spend is re-seeded from the durable per-fork usage, not reset
    assert r2.usage.executions >= used  # type: ignore[attr-defined]
    assert r2.resumed is True  # type: ignore[attr-defined]


def test_budget_cannot_be_expanded_on_resume(tmp_path: Path) -> None:
    run = new_run_id()
    _drive(tmp_path, run, executions=128)
    with pytest.raises(KernelError, match="budget"):
        _drive(tmp_path, run, executions=9999)


# -- trusted structural validation of surface content -----------------------------------------------


def test_bind_rejects_structurally_invalid_seed_code(tmp_path: Path) -> None:
    run = new_run_id()
    sub = Substrate.open(tmp_path, "sum-integers", run)
    code_ref = sub.objects.put_text("def solve(t):\n    return 0\n")  # wrong param name
    prompt_ref = sub.objects.put_text("p")
    seed = canonical_state(
        {("strategy-code", "solve"): code_ref, ("prompt", "proposal-template"): prompt_ref}
    )
    with pytest.raises(SubstrateError, match="invalid"):
        sub.bind_policy(
            task_fingerprint="fp", policy_ref="p@1", policy_digest="pd",
            config_ref=sub.objects.put_text("cfg"),
            prompt_refs={"refine": sub.objects.put_text("md")},
            seed=1, seed_state=seed, budget_ref=sub.objects.put_text("b"),
            required_capabilities=(), run_metadata={},
        )


def test_stage_closure_rejects_structurally_invalid_code(tmp_path: Path) -> None:
    run = new_run_id()
    sub = _bound_sub(tmp_path, run)
    seed = sub.verify().seed_state.as_map()
    bad = "def solve(t):\n    return 0\n"  # wrong param name
    bad_ref = hash_text(bad)
    change = CompositeChange(
        change_id="c1",
        deltas=(SurfaceDelta("strategy-code", "solve", seed[("strategy-code", "solve")], bad_ref),),
        summary="x",
    )
    with pytest.raises(SubstrateError, match="invalid"):
        sub.stage_change_closure(change, {bad_ref: bad})
