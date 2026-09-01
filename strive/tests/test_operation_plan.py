"""Area 1 adversarial proof: the policy-neutral, pinned CAS operation plan.

Every operation is produced by a versioned, pinned CAS plan; hidden data is
absent from the policy API; the protected evidence and the policy-visible
projection are separate; and only comparable, valid evidence drives adaptation.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from strive.contracts import (
    CaseEvaluation,
    Evaluation,
    ExecutionReport,
    CaseOutcome,
)
from strive.kernel import KernelError, KernelServices
from strive.operate import (
    OperationCatalog,
    TaskSuiteOperationDescriptor,
)
from strive.runtime import (
    OP_BEHAVIORAL,
    OP_INFRASTRUCTURE,
    OPERATION_PROJECTION,
    OperationPlan,
    OperationProjection,
    PolicyVisibleOperationContext,
)
from strive.substrate import ObservationRecorded, Substrate, new_run_id
from strive.tasks import SUM_INTEGERS_TASK as TASK
from strive import codec

# reuse the continual-refine E2E harness helpers
from test_continual_refine import _drive, _services, _view


def _context(task: object, *, env: str = "backend@1|capA") -> PolicyVisibleOperationContext:
    return PolicyVisibleOperationContext(
        task_fingerprint=task.fingerprint(),  # type: ignore[attr-defined]
        environment_fingerprint=env,
        seed=7,
        visible_cases=task.visible_cases(),  # type: ignore[attr-defined]
    )


# -- deterministic, pinned plan; hidden data absent -----------------------------------------------


def test_plan_is_deterministic_and_manifest_is_opaque() -> None:
    task = TASK
    desc = TaskSuiteOperationDescriptor()
    plan_a = desc.create_plan(_context(task))
    plan_b = desc.create_plan(_context(task))
    assert plan_a == plan_b  # deterministic
    # the manifest is OPAQUE (op-N) and has exactly the visible cases — never a
    # hidden / held-out / audit case id
    assert [c.case_id for c in plan_a.manifest] == [
        f"op-{i}" for i in range(len(task.visible_cases()))
    ]
    assert len(plan_a.manifest) == len(task.visible_cases())
    hidden_inputs = {c.input_text for c in task.cases if c.split not in ("visible",)}
    visible_inputs = {c.input_text for c in task.visible_cases()}
    manifest_inputs = {c.input_text for c in plan_a.manifest}
    assert manifest_inputs <= visible_inputs  # only visible inputs entered the plan
    assert manifest_inputs.isdisjoint(hidden_inputs - visible_inputs)


def test_context_carries_only_visible_cases() -> None:
    task = TASK
    ctx = _context(task)
    ctx_ids = {c.case_id for c in ctx.visible_cases}
    hidden_ids = {c.case_id for c in task.cases if c.split == "held_out" or c.split == "audit"}
    assert ctx_ids.isdisjoint(hidden_ids)  # the descriptor API never sees hidden data


def test_regime_change_yields_a_different_plan() -> None:
    task = TASK
    desc = TaskSuiteOperationDescriptor()
    a = desc.create_plan(_context(task, env="backend@1|capA"))
    b = desc.create_plan(_context(task, env="deno-pyodide@1|secure"))
    assert a.regime != b.regime  # a different execution regime is a new window


def test_observe_intent_pins_the_plan_ref(tmp_path: Path) -> None:
    from strive.runtime import CommandPayload

    run = new_run_id()
    _drive(tmp_path, run)
    sub = Substrate.discover(tmp_path, run)
    view = sub.verify()
    # every issued ObserveCurrentState pins a plan_ref in its canonical intent
    observes = [i for cid, i in view.issued.items() if i.command_kind == "ObserveCurrentState"]
    assert observes
    for issued in observes:
        payload = codec.loads(sub.objects.get_text(issued.command_ref), CommandPayload)
        assert payload.plan_ref is not None
        plan = codec.loads(sub.objects.get_text(payload.plan_ref), OperationPlan)
        assert plan.descriptor_ref == "task-suite@1"


# -- protected evidence vs policy-visible projection ----------------------------------------------


def test_projection_is_policy_visible_only(tmp_path: Path) -> None:
    run = new_run_id()
    _drive(tmp_path, run)
    view = _view(tmp_path, run)
    projections = [
        codec.loads(view.read_text(b.observation_ref), OperationProjection)
        for b in view.bodies
        if isinstance(b, ObservationRecorded) and b.observation_kind == OPERATION_PROJECTION
    ]
    assert projections
    task = TASK
    raw_inputs = {c.input_text for c in task.cases}
    for proj in projections:
        for vc in proj.cases:
            # the projection exposes opaque id + expected/got + a SAFE error class
            assert vc.case_id.startswith("op-")
            # it never leaks raw protected input text
            assert getattr(vc, "input_text", None) is None
            if vc.error_kind is not None:
                assert vc.error_kind not in raw_inputs


# -- validity: an invalid/incomplete attempt publishes no aggregate -------------------------------


def _report(*, ok: bool, outcomes: tuple[CaseOutcome, ...], fault: str | None = None) -> ExecutionReport:
    from strive.contracts import FailureRecord
    return ExecutionReport(
        ok=ok, generation_id="operation-current", outcomes=outcomes,
        failure=None if ok else FailureRecord("crash", "x"),
        fault_origin=fault,
    )


def _evaluation(n_pass: int, n_total: int) -> Evaluation:
    ces = tuple(
        CaseEvaluation(
            case_id=f"op-{i}", split="operation", passed=(i < n_pass),
            score=1.0 if i < n_pass else 0.0, expected=i, output=i if i < n_pass else None,
            error=None, feedback="",
        )
        for i in range(n_total)
    )
    overall = n_pass / n_total if n_total else 0.0
    return Evaluation(overall_score=overall, split_scores={}, feedback="", case_evaluations=ces)


def test_all_required_complete_attempt_is_valid_and_aggregates() -> None:
    task = TASK
    desc = TaskSuiteOperationDescriptor()
    plan = desc.create_plan(_context(task))
    n = len(plan.manifest)
    outcomes = tuple(CaseOutcome(f"op-{i}", i, None, 1.0) for i in range(n))
    proj = desc.project(
        plan, command_id="c", state_ref="s",
        report=_report(ok=True, outcomes=outcomes), evaluation=_evaluation(n, n),
        origin=OP_BEHAVIORAL,
    )
    assert proj.valid and proj.overall is not None
    assert proj.coverage_completed == proj.coverage_total == n


def test_all_required_incomplete_attempt_publishes_no_aggregate() -> None:
    task = TASK
    desc = TaskSuiteOperationDescriptor()
    plan = desc.create_plan(_context(task))
    n = len(plan.manifest)
    # only the first case ran (a boundary fault stopped the rest)
    outcomes = (CaseOutcome("op-0", 0, None, 1.0),)
    proj = desc.project(
        plan, command_id="c", state_ref="s",
        report=_report(ok=False, outcomes=outcomes, fault="unknown"),
        evaluation=_evaluation(0, n), origin=OP_INFRASTRUCTURE,
    )
    assert not proj.valid
    assert proj.overall is None  # NO normal aggregate for an incomplete attempt
    assert proj.coverage_completed == 1 and proj.coverage_total == n


# -- descriptor/config drift refuses resume without mutation --------------------------------------


class _DriftDescriptor(TaskSuiteOperationDescriptor):
    """Same name (so the catalog resolves it) but a mutated config digest, so its
    plan bytes — and thus the pinned plan_ref — differ."""

    config_digest = "task-suite-config@DRIFTED"


def test_descriptor_config_drift_refuses_resume(tmp_path: Path) -> None:
    import strive.kernel as kmod

    run = new_run_id()
    a = _services(tmp_path, run)  # default catalog (task-suite-config@1)
    original = kmod._run_attempt

    def _crash(*args: object, **kwargs: object) -> object:
        if kwargs.get("gen_prefix") == "operation":
            raise KeyboardInterrupt("crash during the operation")
        return original(*args, **kwargs)  # type: ignore[arg-type]

    kmod._run_attempt = _crash  # type: ignore[assignment]
    try:
        with pytest.raises(KeyboardInterrupt):
            _drive(tmp_path, run, services=a)
    finally:
        kmod._run_attempt = original

    # resume with a DRIFTED descriptor config: the re-derived plan_ref differs, so
    # the pinned intent's payload digest no longer matches — refused, no mutation
    from strive.contracts import BudgetSpec

    b = KernelServices.open(
        tmp_path, TASK, run, seed=7,
        sandbox_backend="process-fault-only@1", trusted=True,
        allow_insecure_execution=True,
        budget=BudgetSpec(model_calls=8, executions=512),  # match the bound run
        operation_catalog=OperationCatalog([_DriftDescriptor()]),
    )
    with pytest.raises(KernelError, match="different payload digest"):
        _drive(tmp_path, run, services=b)


# -- validity: partial-allowed vs indivisible -----------------------------------------------------


class _PartialDescriptor(TaskSuiteOperationDescriptor):
    name = "task-suite@1"  # resolvable; only validity differs for these unit tests
    validity = "partial-allowed"


class _IndivisibleDescriptor(TaskSuiteOperationDescriptor):
    name = "task-suite@1"
    indivisible = True


def test_partial_allowed_scores_only_completed_cases() -> None:
    # an incomplete attempt under partial-allowed is VALID and aggregates over the
    # cases that RAN — un-run cases are excluded, never floored.
    task = TASK
    desc = _PartialDescriptor()
    plan = desc.create_plan(_context(task))
    n = len(plan.manifest)
    assert n >= 2
    # only the first two cases ran, both correct
    outcomes = tuple(CaseOutcome(f"op-{i}", plan.manifest[i].expected, None, 1.0) for i in range(2))
    proj = desc.project(
        plan, command_id="c", state_ref="s",
        report=_report(ok=False, outcomes=outcomes, fault="unknown"),
        evaluation=_evaluation(0, n), origin=OP_BEHAVIORAL,
    )
    assert proj.valid  # partial-allowed with >=1 completed behavioral case
    assert proj.overall == 1.0  # 2/2 completed cases passed — un-run excluded
    assert proj.coverage_completed == 2 and proj.coverage_total == n


def test_indivisible_floors_completed_cases_on_a_partial_attempt() -> None:
    # an indivisible plan floors ALL cases when the attempt is partial/faulted:
    # no case is credited and no aggregate is published.
    task = TASK
    desc = _IndivisibleDescriptor()
    plan = desc.create_plan(_context(task))
    n = len(plan.manifest)
    outcomes = tuple(CaseOutcome(f"op-{i}", plan.manifest[i].expected, None, 1.0) for i in range(2))
    proj = desc.project(
        plan, command_id="c", state_ref="s",
        report=_report(ok=False, outcomes=outcomes, fault="unknown"),
        evaluation=_evaluation(0, n), origin=OP_BEHAVIORAL,
    )
    assert not proj.valid
    assert proj.overall is None
    assert not any(vc.passed for vc in proj.cases)  # completed cases floored


# -- policy/review consumes only the projection ---------------------------------------------------


def test_policy_reads_only_the_projection_never_protected_evidence() -> None:
    # STRUCTURAL proof: the continual-refine policy's operation readers consume
    # OperationProjection exclusively — they never decode the protected
    # AttemptRecord or read OPERATION_RESULT.
    import strive.policies.continual_refine as cr

    src = Path(cr.__file__).read_text(encoding="utf-8")
    assert "OperationProjection" in src
    assert "OPERATION_PROJECTION" in src
    # it never DECODES the protected AttemptRecord nor reads the OPERATION_RESULT
    # observation (those live behind the kernel; only the projection is consumed)
    assert ", AttemptRecord)" not in src  # no `codec.loads(..., AttemptRecord)`
    assert "OPERATION_RESULT" not in src


# -- plan corruption is refused, not silently run -------------------------------------------------


def test_corrupted_pinned_plan_fails_closed(tmp_path: Path) -> None:
    import strive.kernel as kmod
    from strive.runtime import CommandPayload

    run = new_run_id()
    a = _services(tmp_path, run)
    original = kmod._run_attempt

    def _crash(*args: object, **kwargs: object) -> object:
        if kwargs.get("gen_prefix") == "operation":
            raise KeyboardInterrupt("crash before the operation result")
        return original(*args, **kwargs)  # type: ignore[arg-type]

    kmod._run_attempt = _crash  # type: ignore[assignment]
    try:
        with pytest.raises(KeyboardInterrupt):
            _drive(tmp_path, run, services=a)
    finally:
        kmod._run_attempt = original

    # CORRUPT the pinned plan object in CAS, then resume: the observe must fail
    # closed (never silently proceed on a corrupt plan)
    sub = Substrate.discover(tmp_path, run)
    view = sub.verify()
    issued = next(i for i in view.issued.values() if i.command_kind == "ObserveCurrentState")
    payload = codec.loads(sub.objects.get_text(issued.command_ref), CommandPayload)
    assert payload.plan_ref is not None
    plan_path = sub.objects._path(payload.plan_ref)
    plan_path.write_text("{not a valid operation plan}", encoding="utf-8")

    with pytest.raises(Exception):  # noqa: B017 — corruption must not silently pass
        _drive(tmp_path, run)
