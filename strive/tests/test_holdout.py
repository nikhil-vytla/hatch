"""Holdout isolation: diagnosis and proposal never see non-visible evidence."""

from pathlib import Path

from strive.contracts import VISIBLE, Diagnosis
from strive.diagnose import SignatureDiagnoser, VisibleContext
from strive.loop import LoopConfig, run_cycle
from strive.propose import Proposal, RegistryProposer
from strive.store import Store
from strive.tasks import SUM_INTEGERS_TASK


class SpyDiagnoser:
    def __init__(self) -> None:
        self.contexts: list[VisibleContext] = []
        self._inner = SignatureDiagnoser()

    def diagnose(self, ctx: VisibleContext) -> Diagnosis | None:
        self.contexts.append(ctx)
        return self._inner.diagnose(ctx)


class SpyProposer:
    def __init__(self) -> None:
        self.contexts: list[VisibleContext] = []
        self._inner = RegistryProposer()

    def propose(self, ctx: VisibleContext, diagnosis: Diagnosis) -> Proposal | None:
        self.contexts.append(ctx)
        return self._inner.propose(ctx, diagnosis)


def test_diagnosis_and_proposal_receive_visible_split_only(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts")
    diagnoser = SpyDiagnoser()
    proposer = SpyProposer()
    config = LoopConfig(diagnoser=diagnoser, proposer=proposer)

    report = run_cycle(store, SUM_INTEGERS_TASK, config)
    assert report.decision is not None and report.decision.accepted  # slice intact

    visible_ids = {c.case_id for c in SUM_INTEGERS_TASK.visible_cases()}
    hidden_cases = [c for c in SUM_INTEGERS_TASK.cases if c.split != VISIBLE]
    assert hidden_cases  # the task really does have non-visible evidence

    for ctx in diagnoser.contexts + proposer.contexts:
        # the case list is exactly the visible split
        assert {c.case_id for c in ctx.cases} == visible_ids
        assert all(c.split == VISIBLE for c in ctx.cases)
        # the evaluation view contains no non-visible case or split
        assert {ce.case_id for ce in ctx.evaluation.case_evaluations} <= visible_ids
        assert set(ctx.evaluation.split_scores) == {VISIBLE}
        # no hidden input text leaks through any string field
        blob = ctx.parent_source + ctx.evaluation.feedback + " ".join(
            ce.feedback + (ce.error or "") for ce in ctx.evaluation.case_evaluations
        )
        for hidden in hidden_cases:
            assert hidden.case_id not in blob
            assert hidden.input_text not in blob


def test_acceptance_still_uses_hidden_evidence(tmp_path: Path) -> None:
    """The gate sees what proposers cannot: decisions record held-out and
    adversarial split scores."""
    store = Store(tmp_path / "artifacts")
    report = run_cycle(store, SUM_INTEGERS_TASK)
    assert report.decision is not None
    assert "held_out" in report.decision.baseline_split_scores
    assert "adversarial" in report.decision.candidate_split_scores
