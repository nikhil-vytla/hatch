"""Per-command and fork-attempt STATE-MACHINE adversarial tests.

Each test forges a stream that violates one grammar rule (or exercises one
honest-budget behavior) and asserts verification refuses it — proving every
command and external attempt has exactly one verifiable lifecycle.
"""

from __future__ import annotations

import math
from pathlib import Path

import pytest

from strive import kernel
from strive.cas import hash_text
from strive.contracts import BudgetSpec, BudgetUsage
from strive.events import now_iso
from strive.kernel import KernelServices, run_policy
from strive.policies import manual_change as mc
from strive.policy import default_catalog
from strive.runtime import (
    ENCODING,
    FORK_DISPATCH,
    FORK_RESULT,
    FORK_SUMMARY,
    AttemptDispatched,
    AttemptRecord,
    CommandPayload,
    ConfigBlob,
    ForkObservation,
    StoredResult,
)
from strive.sandboxes import SandboxLimits, SandboxProvenance
from strive import codec
from strive.substrate import (
    ChangeConfirmed,
    CompositeChange,
    EventEnvelope,
    ObservationRecorded,
    PolicyCheckpointed,
    PolicyCommandCompleted,
    Substrate,
    SubstrateError,
    SurfaceDelta,
    canonical_state,
    new_run_id,
)
from strive.tasks import SUM_INTEGERS_TASK as TASK

_BASELINE = (
    "import re\n\n\ndef solve(input_text: str) -> int:\n"
    '    return sum(int(t) for t in re.findall(r"\\d+", input_text))\n'
)


# -- helpers --------------------------------------------------------------------------------------


def _bound(root: Path, run: str, *, required: tuple[str, ...] = ()) -> Substrate:
    sub = Substrate.open(root, "sum-integers", run)
    code_ref = sub.objects.put_text("def solve(input_text: str) -> int:\n    return 0\n")
    prompt_ref = sub.objects.put_text("baseline proposal template")
    seed = canonical_state(
        {("strategy-code", "solve"): code_ref, ("prompt", "proposal-template"): prompt_ref}
    )
    sub.bind_policy(
        task_fingerprint="fp", policy_ref="p@1", policy_digest="pd",
        config_ref=sub.put(ConfigBlob(ENCODING, "{}")),
        prompt_refs={"refine": sub.objects.put_text("md")},
        seed=1, seed_state=seed, budget_ref=sub.put(BudgetSpec()),
        required_capabilities=required, run_metadata={},
    )
    return sub


def _issue(sub: Substrate, cid: str, kind: str, change: CompositeChange | None = None) -> None:
    change_ref = sub.put(change) if change is not None else None
    ref = sub.put(CommandPayload(cid, kind, ENCODING, change_ref, "{}"))
    sub.issue_command(command_id=cid, command_kind=kind, command_ref=ref)


def _forge(sub: Substrate, body: object, caused_by: str | None) -> None:
    """Append a framing-valid envelope wrapping `body` DIRECTLY (bypassing the
    _emit preflight), so verify() can be attacked with a semantically bad log."""
    v = sub.verify()
    env = EventEnvelope(
        event_id=f"{sub.run_id}#{v.seq + 1}", run_id=sub.run_id, task_id=sub.task_id,
        seq=v.seq + 1, caused_by=caused_by, body_kind=codec.schema_of(type(body)),
        body_ref=sub.put(body), at=now_iso(),
    )
    sub.journal.append_batch([env], expected_head=v.head)


def _forge_obs(sub: Substrate, kind: str, inner: object, subject: str, caused_by: str) -> None:
    _forge(
        sub,
        ObservationRecorded(subject_state_ref=subject, observation_kind=kind,
                            observation_ref=sub.put(inner)),
        caused_by,
    )


def _prov(caps: tuple[str, ...]) -> SandboxProvenance:
    return SandboxProvenance(
        backend="process-fault-only@1", runtime_digest="d", component_digests={},
        enforced_capabilities=caps, mount_policy="none", network_policy="none",
        limits=SandboxLimits(),
    )


def _errors(sub: Substrate) -> list[str]:
    return list(sub.verify().errors)


def _fork_setup(sub: Substrate) -> tuple[CompositeChange, str, str]:
    """Issue an EvaluateFork 'k' with a proposed candidate; return
    (candidate change, base_ref, candidate_ref)."""
    v = sub.verify()
    seed = v.seed_state.as_map()
    code_after = hash_text("def solve(input_text: str) -> int:\n    return 1\n")
    candidate = CompositeChange(
        "cand",
        (SurfaceDelta("strategy-code", "solve", seed[("strategy-code", "solve")], code_after),),
        "candidate",
    )
    _issue(sub, "k", "EvaluateFork", candidate)
    sub.record_proposal(change=candidate, strategy_ref="fork", caused_by="k")
    sub.stage_change_closure(
        candidate, {code_after: "def solve(input_text: str) -> int:\n    return 1\n"}
    )
    base_ref = v.state_ref or ""
    from strive.substrate import apply_change

    candidate_ref = sub.put_state(apply_change(v.state, candidate, sub.catalog))
    return candidate, base_ref, candidate_ref


def _attempt(cid: str, label: str, state_ref: str, *, usage: BudgetUsage | None = None,
             caps: tuple[str, ...] = ()) -> AttemptRecord:
    return AttemptRecord(
        command_id=cid, label=label, state_ref=state_ref, overall=1.0, ok=True,
        provenance=_prov(caps), failure=None, denials=(),
        usage=usage or BudgetUsage(executions=1),
    )


# -- command grammar --------------------------------------------------------------------------------


def test_ok_terminal_without_required_effect_refused(tmp_path: Path) -> None:
    sub = _bound(tmp_path, new_run_id())
    _issue(sub, "k", "ConfirmChange")
    result = StoredResult("k", "ConfirmChange", "ok", "0:x", "", None, None, {}, BudgetUsage())
    _forge(sub, PolicyCommandCompleted("k", "ok", sub.put(result)), "k")
    assert any("do not equal the required grammar" in e for e in _errors(sub))


def test_ok_terminal_without_stored_result_refused(tmp_path: Path) -> None:
    sub = _bound(tmp_path, new_run_id())
    _issue(sub, "k", "StopAdaptation")
    _forge(sub, PolicyCommandCompleted("k", "ok", None), "k")
    assert any("successful terminal has no StoredResult" in e for e in _errors(sub))


def test_effect_after_terminal_refused(tmp_path: Path) -> None:
    sub = _bound(tmp_path, new_run_id())
    _issue(sub, "k", "StopAdaptation")
    result = StoredResult("k", "StopAdaptation", "ok", "0:x", "", None, None, {}, BudgetUsage())
    _forge(sub, PolicyCommandCompleted("k", "ok", sub.put(result)), "k")
    # any effect caused by k AFTER its terminal is refused
    _forge(sub, ChangeConfirmed("c", "after"), "k")
    assert any("AFTER its terminal" in e for e in _errors(sub))


def test_failed_with_success_effect_refused(tmp_path: Path) -> None:
    from strive.substrate import OperationFailed

    sub = _bound(tmp_path, new_run_id())
    cand, base_ref, cand_ref = _fork_setup(sub)  # EvaluateFork k + proposed candidate
    # a fork SUMMARY (a success token) under a FAILED terminal is contradictory
    summary = ForkObservation(
        "cand", _attempt("k", "base", base_ref), _attempt("k", "candidate", cand_ref),
        improved=False, detail="",
    )
    _forge_obs(sub, FORK_SUMMARY, summary, cand_ref, "k")
    _forge(sub, OperationFailed("k", "EvaluateFork", "boom"), "k")
    result = StoredResult("k", "EvaluateFork", "failed", "0:x", "", None, None, {}, BudgetUsage())
    _forge(sub, PolicyCommandCompleted("k", "failed", sub.put(result)), "k")
    assert any("has a success effect" in e for e in _errors(sub))


def test_wrong_stored_result_observation_on_non_fork_refused(tmp_path: Path) -> None:
    sub = _bound(tmp_path, new_run_id())
    _issue(sub, "k", "StopAdaptation")
    # a StopAdaptation must not carry a fork observation_ref in its result
    result = StoredResult("k", "StopAdaptation", "ok", "0:x", "", None, "ab" * 32, {}, BudgetUsage())
    _forge(sub, PolicyCommandCompleted("k", "ok", sub.put(result)), "k")
    assert any("observation_ref on a non-fork" in e for e in _errors(sub))


def test_duplicate_checkpoint_of_one_command_refused(tmp_path: Path) -> None:
    from strive.runtime import PolicyStateBlob

    sub = _bound(tmp_path, new_run_id())
    seed_ref = sub.verify().state_ref or ""
    _issue(sub, "k", "StopAdaptation")
    result = StoredResult("k", "StopAdaptation", "ok", "0:x", "", None, None, {}, BudgetUsage())
    _forge(sub, PolicyCommandCompleted("k", "ok", sub.put(result)), "k")
    ps = sub.put(PolicyStateBlob(ENCODING, "{}"))
    _forge(sub, PolicyCheckpointed(ps, seed_ref, "k"), "k")
    _forge(sub, PolicyCheckpointed(ps, seed_ref, "k"), "k")  # SECOND checkpoint for k
    assert any("consumed by more than one checkpoint" in e for e in _errors(sub))


# -- fork attempt lifecycle -------------------------------------------------------------------------


def test_result_before_dispatch_refused(tmp_path: Path) -> None:
    sub = _bound(tmp_path, new_run_id())
    _, base_ref, _ = _fork_setup(sub)
    _forge_obs(sub, FORK_RESULT, _attempt("k", "base", base_ref), base_ref, "k")  # no dispatch
    assert any("result without a dispatch" in e for e in _errors(sub))


def test_duplicate_dispatch_refused(tmp_path: Path) -> None:
    sub = _bound(tmp_path, new_run_id())
    _, base_ref, _ = _fork_setup(sub)
    disp = AttemptDispatched("k", "base", base_ref, 1, 1.0, 1)
    _forge_obs(sub, FORK_DISPATCH, disp, base_ref, "k")
    _forge_obs(sub, FORK_DISPATCH, disp, base_ref, "k")
    assert any("duplicate 'base' dispatch" in e for e in _errors(sub))


def test_subject_state_mismatch_refused(tmp_path: Path) -> None:
    sub = _bound(tmp_path, new_run_id())
    _, base_ref, cand_ref = _fork_setup(sub)
    # dispatch's own state_ref disagrees with the ObservationRecorded subject
    disp = AttemptDispatched("k", "base", base_ref, 1, 1.0, 1)
    _forge_obs(sub, FORK_DISPATCH, disp, cand_ref, "k")  # subject != disp.state_ref
    assert any("dispatch state_ref != subject_state_ref" in e for e in _errors(sub))


def test_result_mismatched_to_dispatch_refused(tmp_path: Path) -> None:
    sub = _bound(tmp_path, new_run_id())
    _, base_ref, cand_ref = _fork_setup(sub)
    _forge_obs(sub, FORK_DISPATCH, AttemptDispatched("k", "base", base_ref, 1, 1.0, 1), base_ref, "k")
    # result for the same label but a DIFFERENT state ref
    _forge_obs(sub, FORK_RESULT, _attempt("k", "base", cand_ref), cand_ref, "k")
    assert any("does not match its dispatch" in e for e in _errors(sub))


def test_forged_summary_disagreeing_with_results_refused(tmp_path: Path) -> None:
    sub = _bound(tmp_path, new_run_id())
    cand, base_ref, cand_ref = _fork_setup(sub)
    base = _attempt("k", "base", base_ref)
    candidate = _attempt("k", "candidate", cand_ref)
    _forge_obs(sub, FORK_DISPATCH, AttemptDispatched("k", "base", base_ref, 1, 1.0, 1), base_ref, "k")
    _forge_obs(sub, FORK_RESULT, base, base_ref, "k")
    _forge_obs(sub, FORK_DISPATCH, AttemptDispatched("k", "candidate", cand_ref, 1, 1.0, 1), cand_ref, "k")
    _forge_obs(sub, FORK_RESULT, candidate, cand_ref, "k")
    # a summary whose base record disagrees with the durable base result
    forged_base = _attempt("k", "base", base_ref, usage=BudgetUsage(executions=999))
    summary = ForkObservation("cand", forged_base, candidate, improved=False, detail="")
    _forge_obs(sub, FORK_SUMMARY, summary, cand_ref, "k")
    assert any("summary base != the durable base result" in e for e in _errors(sub))


def test_base_after_candidate_refused(tmp_path: Path) -> None:
    sub = _bound(tmp_path, new_run_id())
    _, base_ref, cand_ref = _fork_setup(sub)
    _forge_obs(sub, FORK_DISPATCH, AttemptDispatched("k", "candidate", cand_ref, 1, 1.0, 1), cand_ref, "k")
    _forge_obs(sub, FORK_DISPATCH, AttemptDispatched("k", "base", base_ref, 1, 1.0, 1), base_ref, "k")
    assert any("base must be dispatched before candidate" in e for e in _errors(sub))


def test_weaker_than_required_provenance_refused(tmp_path: Path) -> None:
    sub = _bound(tmp_path, new_run_id(), required=("network_denied",))
    _, base_ref, _ = _fork_setup(sub)
    _forge_obs(sub, FORK_DISPATCH, AttemptDispatched("k", "base", base_ref, 1, 1.0, 1), base_ref, "k")
    # a result whose provenance does NOT enforce the run's required capability
    _forge_obs(sub, FORK_RESULT, _attempt("k", "base", base_ref, caps=()), base_ref, "k")
    assert any("lacks required capabilities" in e for e in _errors(sub))


@pytest.mark.parametrize("bad", [
    BudgetUsage(executions=-1),
    BudgetUsage(wall_time_s=math.inf),
    BudgetUsage(output_bytes=-5),
])
def test_negative_or_nonfinite_usage_refused(tmp_path: Path, bad: BudgetUsage) -> None:
    sub = _bound(tmp_path, new_run_id())
    _, base_ref, _ = _fork_setup(sub)
    _forge_obs(sub, FORK_DISPATCH, AttemptDispatched("k", "base", base_ref, 1, 1.0, 1), base_ref, "k")
    _forge_obs(sub, FORK_RESULT, _attempt("k", "base", base_ref, usage=bad), base_ref, "k")
    errs = _errors(sub)
    assert any("is negative" in e or "is not finite" in e for e in errs)


# -- honest budgets ---------------------------------------------------------------------------------


def test_open_dispatch_reserves_wall_and_output_not_just_executions(tmp_path: Path) -> None:
    """An OPEN dispatch (no result) reserves executions AND wall AND output."""
    run = new_run_id()
    sub = _bound(tmp_path, run)
    _, base_ref, _ = _fork_setup(sub)
    _forge_obs(
        sub, FORK_DISPATCH, AttemptDispatched("k", "base", base_ref, 5, 50.0, 500),
        base_ref, "k",
    )  # dispatched, no result => open
    assert sub.verify().ok  # an open dispatch is a valid in-progress state
    services = KernelServices.open(tmp_path, TASK, run, budget=BudgetSpec())
    kernel._seed_meter(services, services.substrate.verify())
    usage = services.meter.usage()
    assert usage.executions >= 5
    assert usage.output_bytes >= 500
    assert usage.wall_time_s >= 50.0  # WALL reserved, not just executions


def test_actual_stdout_is_accounted_for_a_printing_strategy(tmp_path: Path) -> None:
    """A strategy that prints is charged its ACTUAL captured stdout bytes — not
    a count derived from error strings (which would be zero for a clean run)."""
    run = new_run_id()
    printer = (
        "def solve(input_text: str) -> int:\n"
        "    print('X' * 500)\n"
        "    return 0\n"
    )
    cfg = mc.ManualChangeConfig(
        summary="a loud strategy", target_prompt="loud proposal template",
        target_strategy=printer,
    )
    services = KernelServices.open(tmp_path, TASK, run, seed=7, budget=BudgetSpec(executions=128))
    objects = services.substrate.objects
    run_policy(
        services, default_catalog(), "manual-change@1", cfg,
        prompt_refs=mc.prompt_refs(objects),
        seed_state=mc.seed_state(objects, code=_BASELINE, prompt="base proposal template"),
        run_metadata={},
    )
    sub = Substrate.discover(tmp_path, run)
    # the CANDIDATE attempt (the printing strategy) must have accounted real bytes
    candidate = None
    for env, body in zip(sub.verify().envelopes, sub.verify().bodies):
        if isinstance(body, ObservationRecorded) and body.observation_kind == FORK_RESULT:
            rec = codec.loads(sub.objects.get_text(body.observation_ref), AttemptRecord)
            if rec.label == "candidate":
                candidate = rec
    assert candidate is not None
    assert candidate.usage.output_bytes >= 500  # actual printed bytes, not 0


# -- evaluation-semantics drift ---------------------------------------------------------------------


def test_selection_drift_rejected_on_resume(tmp_path: Path) -> None:
    """Changing which cases a fork scores (case-selection) shifts the task
    fingerprint, so a resume with a drifted selection is rejected."""
    import dataclasses

    from strive.tasks import Task

    class _DriftSelection(Task):
        def selection_cases(self) -> tuple[object, ...]:  # type: ignore[override]
            return self.cases[:1]  # a DIFFERENT selection rule

    run = new_run_id()
    services = KernelServices.open(tmp_path, TASK, run, seed=7, budget=BudgetSpec(executions=128))
    objects = services.substrate.objects
    run_policy(
        services, default_catalog(), "manual-change@1",
        mc.load_config(mc.DEFAULT_CONFIG_PATH),
        prompt_refs=mc.prompt_refs(objects),
        seed_state=mc.seed_state(objects, code=_BASELINE, prompt="base proposal template"),
        run_metadata={},
    )
    drift = _DriftSelection(
        task_id=TASK.task_id, version=TASK.version, description=TASK.description,
        signature=TASK.signature, primitive_catalog=TASK.primitive_catalog,
        seed_source=TASK.seed_source, cases=TASK.cases,
    )
    assert drift.fingerprint() != TASK.fingerprint()
    resumed = KernelServices.open(tmp_path, drift, run, seed=7, budget=BudgetSpec(executions=128))
    o2 = resumed.substrate.objects
    with pytest.raises(kernel.KernelError, match="fingerprint"):
        run_policy(
            resumed, default_catalog(), "manual-change@1",
            mc.load_config(mc.DEFAULT_CONFIG_PATH),
            prompt_refs=mc.prompt_refs(o2),
            seed_state=mc.seed_state(o2, code=_BASELINE, prompt="base proposal template"),
            run_metadata={},
        )
