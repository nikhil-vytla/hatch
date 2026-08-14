"""The resumable policy command boundary, proved by `manual-change@1`.

The policy applies ONE coupled prompt+code change, records an OPTIONAL fork
observation, checkpoints each step, and reverts the change exactly — with no
universal empirical-authorization ceremony. Crash tests inject a fault at
the command-intent, change-application, checkpoint, and revert boundaries
and assert that resuming completes exactly once (no duplicate apply/revert,
final state restored to the seed).
"""

from pathlib import Path

import pytest

from strive import codec
from strive.kernel import ForkObservation, KernelServices, run_policy
from strive.policies import manual_change as mc
from strive.policy import default_catalog
from strive.substrate import (
    ChangeApplied,
    ChangeReverted,
    ObservationRecorded,
    PolicyBound,
    Substrate,
    SubstrateError,
)
from strive.tasks import SUM_INTEGERS_TASK as TASK

_BASELINE = (
    "import re\n\n\ndef solve(input_text: str) -> int:\n"
    '    return sum(int(t) for t in re.findall(r"\\d+", input_text))\n'
)


def _run(root: Path, *, seed: int = 7) -> tuple[KernelServices, object]:
    services = KernelServices.open(root, TASK, seed=seed)
    sub = services.substrate
    config = mc.load_config(mc.DEFAULT_CONFIG_PATH)
    seed_state = mc.seed_state(
        sub.objects, code=_BASELINE, prompt="baseline {parent_generation_id}"
    )
    report = run_policy(
        services, default_catalog(), "manual-change@1", config,
        prompt_refs=mc.prompt_refs(sub.objects), seed_state=seed_state,
        run_metadata={"model": "none"},
    )
    return services, report


def _entries(sub: Substrate) -> list[object]:
    return list(sub.journal.read().entries)


def _applied(sub: Substrate) -> int:
    return sum(isinstance(e, ChangeApplied) for e in _entries(sub))


def _reverted(sub: Substrate) -> int:
    return sum(isinstance(e, ChangeReverted) for e in _entries(sub))


# -- the happy path --------------------------------------------------------------------------------


def test_apply_observe_checkpoint_revert_without_promotion(tmp_path: Path) -> None:
    services, report = _run(tmp_path / "run")
    sub = services.substrate
    assert report.stopped_reason == "manual change complete"  # type: ignore[attr-defined]

    kinds = [type(e).__name__ for e in _entries(sub)]
    assert "PolicyBound" in kinds
    assert kinds.count("ChangeApplied") == 1
    assert kinds.count("ChangeReverted") == 1
    assert kinds.count("PolicyCheckpointed") >= 3  # checkpointed each step

    # the OPTIONAL comparative observation was recorded (a requested
    # mechanism, not a gate): the coupled change improves the fork score
    obs = [e for e in _entries(sub) if isinstance(e, ObservationRecorded)]
    assert len(obs) == 1
    fork: ForkObservation = codec.loads(
        sub.objects.get_text(obs[0].observation_ref), ForkObservation
    )
    assert fork.forked_overall > fork.current_overall

    # reverted EXACTLY: the final state equals the pinned seed state
    bound = next(e for e in _entries(sub) if isinstance(e, PolicyBound))
    assert sub.view().state_ref == bound.seed_state_ref


def test_identity_pins_policy_config_prompts_seed_not_model(tmp_path: Path) -> None:
    services, _ = _run(tmp_path / "run", seed=42)
    bound = next(e for e in _entries(services.substrate) if isinstance(e, PolicyBound))
    assert bound.policy_ref == "manual-change@1"
    assert bound.seed == 42
    assert "refine" in bound.prompt_refs and bound.config_ref
    # model/provider is reproducibility metadata, NOT harness identity
    assert bound.run_metadata == {"model": "none"}


def test_rerun_after_completion_is_idempotent(tmp_path: Path) -> None:
    root = tmp_path / "run"
    services, _ = _run(root)
    before = _entries(services.substrate)
    # a second full run resumes a completed run: no new authority effects
    services2, report2 = _run(root)
    assert report2.resumed is True  # type: ignore[attr-defined]
    after = _entries(services2.substrate)
    assert _applied(services2.substrate) == 1 and _reverted(services2.substrate) == 1
    assert len(after) == len(before)  # nothing re-appended


# -- crash injection -------------------------------------------------------------------------------


class _CrashOnce:
    """Wrap a bound method so it raises the first time its guard matches,
    then behaves normally (simulating a crash at a boundary)."""

    def __init__(self) -> None:
        self.fired = False


def _prepare(root: Path) -> tuple[KernelServices, object, object, dict[str, str], object]:
    services = KernelServices.open(root, TASK, seed=7)
    sub = services.substrate
    config = mc.load_config(mc.DEFAULT_CONFIG_PATH)
    seed_state = mc.seed_state(
        sub.objects, code=_BASELINE, prompt="baseline {parent_generation_id}"
    )
    prompts = mc.prompt_refs(sub.objects)
    return services, config, default_catalog(), prompts, seed_state


def _drive(services: KernelServices, config: object, catalog: object,
           prompts: dict[str, str], seed_state: object) -> object:
    return run_policy(
        services, catalog, "manual-change@1", config,  # type: ignore[arg-type]
        prompt_refs=prompts, seed_state=seed_state,  # type: ignore[arg-type]
        run_metadata={"model": "none"},
    )


def _resume(root: Path) -> KernelServices:
    services = KernelServices.open(root, TASK, seed=7)
    config = mc.load_config(mc.DEFAULT_CONFIG_PATH)
    # seed_state is only used on first bind; on resume it is ignored, but the
    # content must exist — re-stage it deterministically
    seed_state = mc.seed_state(
        services.substrate.objects, code=_BASELINE,
        prompt="baseline {parent_generation_id}",
    )
    run_policy(
        services, default_catalog(), "manual-change@1", config,
        prompt_refs=mc.prompt_refs(services.substrate.objects),
        seed_state=seed_state, run_metadata={"model": "none"},
    )
    return services


def _final_ok(services: KernelServices) -> None:
    sub = services.substrate
    assert _applied(sub) == 1, "change applied more than once across the crash"
    assert _reverted(sub) == 1, "change reverted more than once across the crash"
    bound = next(e for e in _entries(sub) if isinstance(e, PolicyBound))
    assert sub.view().state_ref == bound.seed_state_ref  # reverted exactly


def test_crash_at_change_application_resumes_exactly(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Crash AFTER ChangeApplied but BEFORE its completion: resume must not
    re-apply — it detects the effect and only records completion."""
    root = tmp_path / "run"
    services, config, catalog, prompts, seed_state = _prepare(root)

    crash = _CrashOnce()
    real_complete = Substrate.complete_command

    def flaky(self: Substrate, *, command_id: str, outcome: str, result: object) -> str:
        if command_id == "mc-apply" and not crash.fired:
            crash.fired = True
            raise RuntimeError("crash between apply effect and completion")
        return real_complete(self, command_id=command_id, outcome=outcome, result=result)

    monkeypatch.setattr(Substrate, "complete_command", flaky)
    with pytest.raises(RuntimeError, match="crash between apply"):
        _drive(services, config, catalog, prompts, seed_state)
    # the effect is present, the completion is not
    assert _applied(services.substrate) == 1
    monkeypatch.undo()

    _final_ok(_resume(root))


def test_crash_at_command_intent_resumes_exactly(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Crash AFTER the command intent is journaled but BEFORE the effect:
    resume performs the effect exactly once."""
    root = tmp_path / "run"
    services, config, catalog, prompts, seed_state = _prepare(root)

    crash = _CrashOnce()
    real_apply = Substrate.apply

    def flaky(self: Substrate, *, change: object, expected_head: object = None) -> object:
        if not crash.fired:
            crash.fired = True
            raise RuntimeError("crash after intent, before apply effect")
        return real_apply(self, change=change, expected_head=expected_head)  # type: ignore[arg-type]

    monkeypatch.setattr(Substrate, "apply", flaky)
    # an uncaught fault (process "crash") after the intent is journaled but
    # before the effect: it propagates, and the command is not completed
    with pytest.raises(RuntimeError, match="crash after intent"):
        _drive(services, config, catalog, prompts, seed_state)
    assert _applied(services.substrate) == 0  # effect never happened
    monkeypatch.undo()

    _final_ok(_resume(root))


def test_crash_at_checkpoint_resumes_exactly(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Crash at the checkpoint boundary: resume re-derives the same step, its
    commands are already completed (skipped), and it re-checkpoints."""
    root = tmp_path / "run"
    services, config, catalog, prompts, seed_state = _prepare(root)

    crash = _CrashOnce()
    real_ckpt = Substrate.checkpoint

    def flaky(self: Substrate, *, policy_state_ref: str, expected_head: object = None) -> str:
        applied_now = any(isinstance(e, ChangeApplied) for e in self.journal.read().entries)
        if applied_now and not crash.fired:
            crash.fired = True
            raise RuntimeError("crash at checkpoint after apply")
        return real_ckpt(self, policy_state_ref=policy_state_ref, expected_head=expected_head)  # type: ignore[arg-type]

    monkeypatch.setattr(Substrate, "checkpoint", flaky)
    with pytest.raises(RuntimeError, match="crash at checkpoint"):
        _drive(services, config, catalog, prompts, seed_state)
    assert _applied(services.substrate) == 1
    monkeypatch.undo()

    _final_ok(_resume(root))


def test_crash_at_revert_resumes_exactly(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Crash AFTER ChangeReverted but BEFORE its completion: resume detects
    the revert effect and only records completion (no double revert)."""
    root = tmp_path / "run"
    services, config, catalog, prompts, seed_state = _prepare(root)

    crash = _CrashOnce()
    real_complete = Substrate.complete_command

    def flaky(self: Substrate, *, command_id: str, outcome: str, result: object) -> str:
        if command_id == "mc-revert" and not crash.fired:
            crash.fired = True
            raise RuntimeError("crash between revert effect and completion")
        return real_complete(self, command_id=command_id, outcome=outcome, result=result)

    monkeypatch.setattr(Substrate, "complete_command", flaky)
    with pytest.raises(RuntimeError, match="crash between revert"):
        _drive(services, config, catalog, prompts, seed_state)
    assert _reverted(services.substrate) == 1
    monkeypatch.undo()

    _final_ok(_resume(root))
