"""Task-scoped state: one artifact root, many tasks, zero cross-contamination.
Plus writer-lock head checks and the on-demand audit holdout."""

from pathlib import Path

import pytest

from strive.contracts import AUDIT
from strive.loop import audit_generation, run_cycle
from strive.store import Store, StoreError
from strive.tasks import MAX_INTEGERS_TASK, SUM_INTEGERS_TASK
from strive.diagnose import EvidenceDiagnoser
from strive.fakemodel import scripted_fixture_adapter
from strive.loop import LoopConfig
from strive.model_proposer import ModelProposer
from strive.contracts import BudgetSpec


def _model_config() -> LoopConfig:
    return LoopConfig(
        proposer=ModelProposer(),
        diagnoser=EvidenceDiagnoser(),
        model_adapter=scripted_fixture_adapter(),
        budget=BudgetSpec(model_calls=4),
    )


def test_sequential_tasks_share_a_root_without_contamination(tmp_path: Path) -> None:
    root = tmp_path / "artifacts"

    sum_store = Store(root, SUM_INTEGERS_TASK.task_id)
    sum_report = run_cycle(sum_store, SUM_INTEGERS_TASK)
    assert sum_report.decision is not None and sum_report.decision.accepted

    max_store = Store(root, MAX_INTEGERS_TASK.task_id)
    max_report = run_cycle(max_store, MAX_INTEGERS_TASK, _model_config())
    assert max_report.decision is not None and max_report.decision.accepted

    # each task has its own journal, incumbent, and lineage
    assert sum_store.ledger_path != max_store.ledger_path
    sum_active = Store(root, SUM_INTEGERS_TASK.task_id).active_generation()
    max_active = Store(root, MAX_INTEGERS_TASK.task_id).active_generation()
    assert sum_active is not None and sum_active.task_id == "sum-integers"
    assert max_active is not None and max_active.task_id == "max-integers"
    assert "sum(" in sum_store.source_of(sum_active)
    assert "max(" in max_store.source_of(max_active)

    # every record carries its task identity and fingerprint
    for generation in sum_store.generations().values():
        assert generation.task_id == "sum-integers"
        assert generation.task_fingerprint == SUM_INTEGERS_TASK.fingerprint()
    assert all(
        a.task_id == "sum-integers"
        for a in [sum_store.active_activation()]
        if a is not None
    )

    # one task's generation ids cannot be resolved through another task's store
    # (same-numbered ids exist in both ledgers but never cross)
    assert sum_store.generation("gen-0001").task_id == "sum-integers"
    assert max_store.generation("gen-0001").task_id == "max-integers"


def test_store_task_binding_is_checked_by_the_loop(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts", SUM_INTEGERS_TASK.task_id)
    with pytest.raises(StoreError, match="bound to task"):
        run_cycle(store, MAX_INTEGERS_TASK)


def test_activation_head_check_refuses_concurrent_change(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts", SUM_INTEGERS_TASK.task_id)
    run_cycle(store, SUM_INTEGERS_TASK)  # gen-0001 active
    active = store.active_generation()
    assert active is not None

    with pytest.raises(StoreError, match="head check failed"):
        store.activate(
            "gen-0000",
            reason="promote",
            policy="manual",
            expected_active="gen-9999",  # caller's view is stale
        )
    # and with the correct expectation it succeeds
    store.activate(
        "gen-0000",
        reason="rollback",
        policy="manual",
        expected_active=active.generation_id,
    )


# -- audit holdout ---------------------------------------------------------------


def test_audit_split_is_excluded_from_routine_cycles(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts", SUM_INTEGERS_TASK.task_id)
    report = run_cycle(store, SUM_INTEGERS_TASK)
    audit_ids = {c.case_id for c in SUM_INTEGERS_TASK.audit_cases()}
    assert audit_ids  # the task really declares audit cases

    evaluated = {ce.case_id for ce in report.evaluation.case_evaluations}
    assert evaluated.isdisjoint(audit_ids)
    assert AUDIT not in report.evaluation.split_scores
    assert report.decision is not None
    assert AUDIT not in report.decision.baseline_split_scores
    assert AUDIT not in report.decision.candidate_split_scores


def test_audit_runs_on_demand_and_scores_the_holdout(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts", SUM_INTEGERS_TASK.task_id)
    run_cycle(store, SUM_INTEGERS_TASK)  # accepted fix is active

    audit = audit_generation(store, SUM_INTEGERS_TASK)
    assert audit.evaluation.overall_score == 1.0  # the fix holds on the audit set
    assert {ce.split for ce in audit.evaluation.case_evaluations} == {AUDIT}

    # the weaker seed shows the difference on the same holdout
    seed_audit = audit_generation(store, SUM_INTEGERS_TASK, "gen-0000")
    assert seed_audit.evaluation.overall_score < 1.0


def test_binding_guard_covers_every_public_operation(tmp_path: Path) -> None:
    from strive.loop import (
        audit_generation as audit_op,
        compare_generations,
        promote_generation,
        replay_run,
    )

    store = Store(tmp_path / "artifacts", SUM_INTEGERS_TASK.task_id)
    report = run_cycle(store, SUM_INTEGERS_TASK)
    for operation in (
        lambda: run_cycle(store, MAX_INTEGERS_TASK),
        lambda: audit_op(store, MAX_INTEGERS_TASK),
        lambda: compare_generations(store, MAX_INTEGERS_TASK, "gen-0000", "gen-0001"),
        lambda: promote_generation(store, MAX_INTEGERS_TASK, "gen-0000"),
        lambda: replay_run(store, MAX_INTEGERS_TASK, report.run_id),
    ):
        with pytest.raises(StoreError, match="bound to task"):
            operation()


def test_foreign_records_in_a_task_ledger_are_rejected_on_read(tmp_path: Path) -> None:
    from strive import codec
    from strive.contracts import Activation
    from strive.events import now_iso

    store = Store(tmp_path / "artifacts", SUM_INTEGERS_TASK.task_id)
    run_cycle(store, SUM_INTEGERS_TASK)
    foreign = Activation(
        generation_id="gen-0000",
        task_id="max-integers",  # wrong task smuggled into this ledger
        reason="promote",
        mode="durable",
        at=now_iso(),
        policy="manual",
    )
    with store.ledger_path.open("a") as handle:
        handle.write(codec.dumps(foreign) + "\n")
    from strive.store import LedgerError

    with pytest.raises(LedgerError, match="task-isolation violation"):
        Store(tmp_path / "artifacts", SUM_INTEGERS_TASK.task_id).entries()


def test_fingerprint_drift_blocks_mutation_until_acknowledged(tmp_path: Path) -> None:
    import dataclasses

    from strive.loop import LoopConfig, audit_generation as audit_op, replay_run

    store = Store(tmp_path / "artifacts", SUM_INTEGERS_TASK.task_id)
    report = run_cycle(store, SUM_INTEGERS_TASK)

    drifted_task = dataclasses.replace(SUM_INTEGERS_TASK, version=99)
    assert drifted_task.fingerprint() != SUM_INTEGERS_TASK.fingerprint()

    # mutating operation refuses
    with pytest.raises(StoreError, match="task-SPEC drift"):
        run_cycle(store, drifted_task)
    # read-only operations proceed (their reports carry drift information)
    replay = replay_run(store, drifted_task, report.run_id)
    assert replay.task_drift
    audit_op(store, drifted_task)

    # acknowledged mutation proceeds and is journaled
    acknowledged = run_cycle(
        store, drifted_task, LoopConfig(acknowledge_task_drift=True)
    )
    assert acknowledged.run_id
    assert any(i.kind == "task-drift-acknowledged" for i in store.interventions())


def test_promote_journals_drift_acknowledgement_like_run(tmp_path: Path) -> None:
    import dataclasses

    from strive.loop import LoopConfig, promote_generation

    store = Store(tmp_path / "artifacts", SUM_INTEGERS_TASK.task_id)
    run_cycle(store, SUM_INTEGERS_TASK)  # gen-0001 active
    store.rollback()  # gen-0000 active; gen-0001 is a promotable target

    drifted_task = dataclasses.replace(SUM_INTEGERS_TASK, version=99)

    # refused without acknowledgement
    with pytest.raises(StoreError, match="task-SPEC drift"):
        promote_generation(store, drifted_task, "gen-0001")
    assert not any(
        i.kind == "task-drift-acknowledged" for i in store.interventions()
    )

    # allowed with acknowledgement, and the same durable intervention as `run`
    activation, decision = promote_generation(
        store,
        drifted_task,
        "gen-0001",
        config=LoopConfig(acknowledge_task_drift=True),
    )
    assert decision is not None and decision.accepted
    assert activation.generation_id == "gen-0001"
    acknowledgements = [
        i for i in store.interventions() if i.kind == "task-drift-acknowledged"
    ]
    assert len(acknowledgements) == 1


def test_no_drift_acknowledgement_journaled_when_fingerprints_match(
    tmp_path: Path,
) -> None:
    from strive.loop import LoopConfig, promote_generation

    store = Store(tmp_path / "artifacts", SUM_INTEGERS_TASK.task_id)
    run_cycle(store, SUM_INTEGERS_TASK, LoopConfig(acknowledge_task_drift=True))
    store.rollback()
    promote_generation(
        store,
        SUM_INTEGERS_TASK,
        "gen-0001",
        config=LoopConfig(acknowledge_task_drift=True),
    )
    # the flag was set but no drift existed: nothing spurious in the journal
    assert not any(
        i.kind == "task-drift-acknowledged" for i in store.interventions()
    )
