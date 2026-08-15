"""The result-driven, resumable policy kernel, proved by `manual-change@1`.

Covers: the happy path (propose→fork→apply→revert→stop, exact revert),
identity enforcement on resume, budget charging, fork reaction through the
reducer (success AND failure), idempotent completed re-runs, and crash
injection after EVERY command effect (including a fork crash) with exact
resume and no duplicated effects, observations, or spend.
"""

from pathlib import Path

import pytest

from strive import codec
from strive.contracts import BudgetSpec
from strive.kernel import (
    ForkObservation,
    KernelError,
    KernelServices,
    RunReport,
    run_policy,
)
from strive.policies import manual_change as mc
from strive.policy import conformance_violations, default_catalog
from strive.substrate import (
    ChangeApplied,
    ChangeProposed,
    ChangeReverted,
    ObservationRecorded,
    Substrate,
    new_run_id,
)
from strive.tasks import SUM_INTEGERS_TASK as TASK

_BASELINE = (
    "import re\n\n\ndef solve(input_text: str) -> int:\n"
    '    return sum(int(t) for t in re.findall(r"\\d+", input_text))\n'
)


def _services(root: Path, run_id: str) -> KernelServices:
    return KernelServices.open(
        root, TASK, run_id, seed=7, budget=BudgetSpec(executions=128)
    )


def _drive(root: Path, run_id: str, *, config: object | None = None) -> RunReport:
    services = _services(root, run_id)
    objects = services.substrate.objects
    cfg = config or mc.load_config(mc.DEFAULT_CONFIG_PATH)
    seed_state = mc.seed_state(objects, code=_BASELINE, prompt="base {parent_generation_id}")
    return run_policy(
        services, default_catalog(), "manual-change@1", cfg,
        prompt_refs=mc.prompt_refs(objects), seed_state=seed_state,
        run_metadata={"model": "none"},
    )


def _bodies(root: Path, run_id: str) -> list[object]:
    return list(Substrate.open(root, TASK.task_id, run_id).verify().bodies)


def _count(root: Path, run_id: str, kind: type) -> int:
    return sum(isinstance(b, kind) for b in _bodies(root, run_id))


def _final_exact(root: Path, run_id: str) -> None:
    view = Substrate.open(root, TASK.task_id, run_id).verify()
    assert view.ok, view.errors
    assert _count(root, run_id, ChangeApplied) == 1
    assert _count(root, run_id, ChangeReverted) == 1
    assert view.bound is not None
    assert view.state_ref == view.bound.seed_state_ref  # reverted exactly


# -- happy path -----------------------------------------------------------------------------------


def test_descriptor_conformance() -> None:
    assert conformance_violations(mc.DESCRIPTOR) == []


def test_full_run_proposes_forks_applies_reverts_exactly(tmp_path: Path) -> None:
    run = new_run_id(TASK.task_id)
    report = _drive(tmp_path, run)
    assert report.stopped_reason == "manual change complete"
    assert report.usage.executions > 0  # budget charged
    assert _count(tmp_path, run, ChangeProposed) == 1
    assert _count(tmp_path, run, ObservationRecorded) == 1
    _final_exact(tmp_path, run)
    # the fork observation pins BOTH exact state refs and improved=True
    obs = next(b for b in _bodies(tmp_path, run) if isinstance(b, ObservationRecorded))
    sub = Substrate.open(tmp_path, TASK.task_id, run)
    fork: ForkObservation = codec.loads(sub.objects.get_text(obs.observation_ref), ForkObservation)
    assert fork.base_state_ref and fork.candidate_state_ref
    assert fork.improved and fork.candidate_overall > fork.base_overall


def test_idempotent_rerun_of_completed_run(tmp_path: Path) -> None:
    run = new_run_id(TASK.task_id)
    _drive(tmp_path, run)
    before = len(_bodies(tmp_path, run))
    report2 = _drive(tmp_path, run)
    assert report2.resumed is True
    assert len(_bodies(tmp_path, run)) == before  # nothing re-appended
    _final_exact(tmp_path, run)


def test_fork_failure_stops_without_applying(tmp_path: Path) -> None:
    """When the fork does NOT improve, the reducer routes to StopAdaptation
    and no change is applied — the policy reacts to the fork through reduce."""
    # a target that is worse than the baseline on the signed-integer task
    worse = mc.ManualChangeConfig(
        summary="a strictly worse strategy",
        target_prompt="worse {parent_generation_id}",
        target_strategy="def solve(input_text: str) -> int:\n    return 0\n",
    )
    run = new_run_id(TASK.task_id)
    report = _drive(tmp_path, run, config=worse)
    assert "did not improve" in report.stopped_reason
    assert _count(tmp_path, run, ObservationRecorded) == 1
    assert _count(tmp_path, run, ChangeApplied) == 0
    view = Substrate.open(tmp_path, TASK.task_id, run).verify()
    assert view.state_ref == view.bound.seed_state_ref  # type: ignore[union-attr]


# -- identity on resume ---------------------------------------------------------------------------


def test_binding_mismatch_is_rejected(tmp_path: Path) -> None:
    run = new_run_id(TASK.task_id)
    _drive(tmp_path, run)
    other = mc.ManualChangeConfig(
        summary="different", target_prompt="x {parent_generation_id}",
        target_strategy="def solve(t):\n    return 3\n",
    )
    with pytest.raises(KernelError, match="config does not match"):
        _drive(tmp_path, run, config=other)


def test_seed_mismatch_is_rejected(tmp_path: Path) -> None:
    run = new_run_id(TASK.task_id)
    _drive(tmp_path, run)
    services = KernelServices.open(tmp_path, TASK, run, seed=999, budget=BudgetSpec(executions=64))
    objects = services.substrate.objects
    with pytest.raises(KernelError, match="seed"):
        run_policy(
            services, default_catalog(), "manual-change@1",
            mc.load_config(mc.DEFAULT_CONFIG_PATH),
            prompt_refs=mc.prompt_refs(objects),
            seed_state=mc.seed_state(objects, code=_BASELINE, prompt="base {parent_generation_id}"),
            run_metadata={},
        )


# -- crash injection: after every command effect --------------------------------------------------


class _Boom(Exception):
    pass


def _crash_after(monkeypatch: pytest.MonkeyPatch, target_command: str) -> dict[str, bool]:
    """Make `complete_command` raise ONCE for `target_command` (a crash after
    the effect, before the terminal completion)."""
    state = {"fired": False}
    real = Substrate.complete_command

    def flaky(self: Substrate, *, command_id: str, outcome: str, result: object) -> object:
        if command_id.endswith(target_command) and not state["fired"]:
            state["fired"] = True
            raise _Boom(f"crash after {target_command} effect")
        return real(self, command_id=command_id, outcome=outcome, result=result)

    monkeypatch.setattr(Substrate, "complete_command", flaky)
    return state


@pytest.mark.parametrize("boundary", ["fork", "apply", "revert", "stop-done"])
def test_crash_after_each_effect_resumes_exactly(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, boundary: str
) -> None:
    run = new_run_id(TASK.task_id)
    state = _crash_after(monkeypatch, boundary)
    with pytest.raises(_Boom):
        _drive(tmp_path, run)
    assert state["fired"]
    monkeypatch.undo()
    report = _drive(tmp_path, run)  # resume
    assert report.resumed is True
    _final_exact(tmp_path, run)
    # the effect that was mid-completion was not duplicated
    assert _count(tmp_path, run, ObservationRecorded) == 1
    assert _count(tmp_path, run, ChangeProposed) == 1


def test_fork_crash_does_not_duplicate_execution(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A crash after the fork observation (before completion) must not re-run
    the executor on resume — exactly one fork observation survives."""
    run = new_run_id(TASK.task_id)
    _crash_after(monkeypatch, "fork")
    with pytest.raises(_Boom):
        _drive(tmp_path, run)
    # the observation was recorded before the crash
    assert _count(tmp_path, run, ObservationRecorded) == 1
    monkeypatch.undo()
    _drive(tmp_path, run)  # resume: fork must NOT execute again
    assert _count(tmp_path, run, ObservationRecorded) == 1
    _final_exact(tmp_path, run)


def test_crash_before_apply_effect_still_applies_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A crash AFTER the intent but BEFORE the apply effect (uncaught) leaves
    no ChangeApplied; resume applies exactly once."""
    run = new_run_id(TASK.task_id)
    state = {"fired": False}
    real = Substrate.apply

    def flaky(self: Substrate, *, change: object, caused_by: str, expected_head: object = None) -> object:
        if not state["fired"]:
            state["fired"] = True
            raise _Boom("crash before apply effect")
        return real(self, change=change, caused_by=caused_by, expected_head=expected_head)  # type: ignore[arg-type]

    monkeypatch.setattr(Substrate, "apply", flaky)
    with pytest.raises(_Boom):
        _drive(tmp_path, run)
    assert _count(tmp_path, run, ChangeApplied) == 0
    monkeypatch.undo()
    _drive(tmp_path, run)
    _final_exact(tmp_path, run)
