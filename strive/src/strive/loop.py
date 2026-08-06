"""The evolution loop orchestrator.

One cycle walks the long-term loop end to end:

    execute -> observe -> evaluate -> diagnose -> propose -> validate
            -> accept/reject -> retain

Every stage's inputs and outputs land in the run's event stream, and every
candidate — accepted or rejected — is retained in the ledger with lineage.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from strive.decide import decide
from strive.diagnose import diagnose
from strive.evaluate import evaluate
from strive.events import EventLog
from strive.propose import STRATEGY_CODE_SURFACE, propose
from strive.sandbox import run_strategy
from strive.store import Store
from strive.tasks import BASELINE_STRATEGY_SOURCE
from strive.types import Candidate, Decision, Diagnosis, Evaluation, Task


@dataclass(frozen=True)
class LoopConfig:
    sandbox_timeout_s: float = 10.0


@dataclass(frozen=True)
class CycleReport:
    run_id: str
    active_generation_before: str
    baseline_evaluation: Evaluation
    diagnosis: Diagnosis | None
    candidate: Candidate | None
    candidate_evaluation: Evaluation | None
    decision: Decision | None
    active_generation_after: str


def ensure_seeded(store: Store) -> None:
    """Install the baseline strategy as generation zero if the store is empty."""
    if store.active_generation() is None:
        store.add_generation(
            BASELINE_STRATEGY_SOURCE,
            parent_id=None,
            origin="seed",
            surface=STRATEGY_CODE_SURFACE,
            weakness_id=None,
            decision=None,
            activate=True,
        )


def run_cycle(store: Store, task: Task, config: LoopConfig = LoopConfig()) -> CycleReport:
    ensure_seeded(store)
    active = store.active_generation()
    assert active is not None  # ensure_seeded guarantees this

    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:6]
    events = EventLog(store.runs_dir / run_id / "events.jsonl")
    events.emit(
        "cycle_started",
        run_id=run_id,
        task_id=task.task_id,
        active_generation=active.generation_id,
    )

    # execute + observe
    baseline_run = run_strategy(
        store.strategy_path(active), task.cases, timeout_s=config.sandbox_timeout_s
    )
    for result in baseline_run.case_results:
        events.emit(
            "case_executed",
            case_id=result.case_id,
            output=result.output,
            error=result.error,
            duration_ms=result.duration_ms,
        )
    if not baseline_run.ok:
        events.emit("execution_failed", failure=baseline_run.failure)

    # evaluate
    baseline_eval = evaluate(task, baseline_run)
    events.emit(
        "evaluated",
        generation=active.generation_id,
        score=baseline_eval.score,
        failing_case_ids=list(baseline_eval.failing_case_ids),
    )

    # diagnose
    diagnosis = diagnose(task, baseline_eval)
    if diagnosis is None:
        events.emit("no_weakness_detected")
        events.emit("cycle_completed", accepted=False)
        return CycleReport(
            run_id=run_id,
            active_generation_before=active.generation_id,
            baseline_evaluation=baseline_eval,
            diagnosis=None,
            candidate=None,
            candidate_evaluation=None,
            decision=None,
            active_generation_after=active.generation_id,
        )
    events.emit(
        "weakness_detected",
        weakness_id=diagnosis.weakness_id,
        description=diagnosis.description,
        evidence_case_ids=list(diagnosis.evidence_case_ids),
    )

    # propose
    candidate = propose(
        diagnosis, active.generation_id, store.strategy_source(active)
    )
    if candidate is None:
        events.emit("no_candidate_proposed", weakness_id=diagnosis.weakness_id)
        events.emit("cycle_completed", accepted=False)
        return CycleReport(
            run_id=run_id,
            active_generation_before=active.generation_id,
            baseline_evaluation=baseline_eval,
            diagnosis=diagnosis,
            candidate=None,
            candidate_evaluation=None,
            decision=None,
            active_generation_after=active.generation_id,
        )
    events.emit(
        "candidate_proposed",
        candidate_id=candidate.candidate_id,
        surface=candidate.surface,
        weakness_id=candidate.weakness_id,
        description=candidate.description,
    )

    # validate: run the candidate in its own sandboxed process
    candidate_path = store.runs_dir / run_id / "candidate.py"
    candidate_path.write_text(candidate.source, encoding="utf-8")
    candidate_run = run_strategy(
        candidate_path, task.cases, timeout_s=config.sandbox_timeout_s
    )
    candidate_eval = evaluate(task, candidate_run)
    events.emit(
        "validated",
        candidate_id=candidate.candidate_id,
        sandbox_ok=candidate_run.ok,
        sandbox_failure=candidate_run.failure,
        score=candidate_eval.score,
        failing_case_ids=list(candidate_eval.failing_case_ids),
    )

    # accept/reject
    decision = decide(baseline_eval, candidate_eval)
    events.emit(
        "decision",
        candidate_id=candidate.candidate_id,
        accepted=decision.accepted,
        reason=decision.reason,
        baseline_score=decision.baseline_score,
        candidate_score=decision.candidate_score,
    )

    # retain: every candidate is journaled with lineage, accepted or not
    record = store.add_generation(
        candidate.source,
        parent_id=active.generation_id,
        origin="evolved",
        surface=candidate.surface,
        weakness_id=candidate.weakness_id,
        decision=decision,
        activate=decision.accepted,
    )
    events.emit(
        "retained",
        generation_id=record.generation_id,
        parent_id=record.parent_id,
        activated=decision.accepted,
    )
    events.emit("cycle_completed", accepted=decision.accepted)

    after = store.active_generation()
    assert after is not None
    return CycleReport(
        run_id=run_id,
        active_generation_before=active.generation_id,
        baseline_evaluation=baseline_eval,
        diagnosis=diagnosis,
        candidate=candidate,
        candidate_evaluation=candidate_eval,
        decision=decision,
        active_generation_after=after.generation_id,
    )
