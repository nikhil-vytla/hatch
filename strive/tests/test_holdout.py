"""Holdout isolation: diagnosis and proposal never see non-visible evidence."""

from pathlib import Path

from strive.contracts import VISIBLE, Diagnosis
from strive.diagnose import SignatureDiagnoser, VisibleContext
from strive.loop import LoopConfig, run_cycle
from strive.model_proposer import build_prompt
from strive.propose import ProposalRequest, ProposalResult, RegistryProposer
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
    name = "spy"

    def __init__(self) -> None:
        self.requests: list[ProposalRequest] = []
        self._inner = RegistryProposer()

    def propose(self, request: ProposalRequest) -> ProposalResult:
        self.requests.append(request)
        return self._inner.propose(request)


def test_diagnosis_and_proposal_receive_visible_split_only(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts", SUM_INTEGERS_TASK.task_id)
    diagnoser = SpyDiagnoser()
    proposer = SpyProposer()
    config = LoopConfig(diagnoser=diagnoser, proposer=proposer)

    report = run_cycle(store, SUM_INTEGERS_TASK, config)
    assert report.decision is not None and report.decision.accepted  # slice intact

    visible_ids = {c.case_id for c in SUM_INTEGERS_TASK.visible_cases()}
    hidden_cases = [c for c in SUM_INTEGERS_TASK.cases if c.split != VISIBLE]
    assert hidden_cases  # the task really does have non-visible evidence

    contexts = diagnoser.contexts + [r.ctx for r in proposer.requests]
    for ctx in contexts:
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

    # the full ProposalRequest — including sanitized history and the exact
    # prompt a model proposer would build from it — leaks nothing hidden
    for request in proposer.requests:
        history_blob = " ".join(
            item.generation_id + (item.weakness_id or "") + item.description + item.outcome
            for item in request.history
        )
        prompt = build_prompt(request)
        for hidden in hidden_cases:
            assert hidden.case_id not in history_blob
            assert hidden.case_id not in prompt
            assert hidden.input_text not in prompt


def test_acceptance_still_uses_hidden_evidence(tmp_path: Path) -> None:
    """The gate sees what proposers cannot: decisions record held-out and
    adversarial split scores."""
    store = Store(tmp_path / "artifacts", SUM_INTEGERS_TASK.task_id)
    report = run_cycle(store, SUM_INTEGERS_TASK)
    assert report.decision is not None
    assert "held_out" in report.decision.baseline_split_scores
    assert "adversarial" in report.decision.candidate_split_scores


def test_history_outcomes_carry_visible_scores_only(tmp_path: Path) -> None:
    """Hidden-influenced overall scores must not flow back to proposers: the
    sanitized history reports visible-split score movement only."""
    from strive.loop import _proposal_history

    store = Store(tmp_path / "artifacts2", SUM_INTEGERS_TASK.task_id)
    report = run_cycle(store, SUM_INTEGERS_TASK)
    assert report.decision is not None

    history = _proposal_history(store, limit=5)
    assert history  # the accepted candidate appears
    for item in history:
        assert "visible" in item.outcome
        assert "overall" not in item.outcome
        assert "held" not in item.outcome
