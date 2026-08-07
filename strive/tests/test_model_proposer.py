"""Model-backed proposal pipeline: the stage-2b demonstration matrix.

Everything here runs offline against the deterministic fake adapter; the
fake demonstrates pipeline correctness (validation, gating, journaling,
replay), not model capability.
"""

import json
import re
from pathlib import Path

from strive.contracts import (
    FAILURE_BUDGET_EXHAUSTED,
    FAILURE_PROPOSAL_FORBIDDEN,
    FAILURE_PROPOSAL_MALFORMED,
    FAILURE_PROPOSAL_SCHEMA_INVALID,
    FAILURE_PROPOSAL_STALE,
    FAILURE_PROPOSAL_TRUNCATED,
    BudgetSpec,
    HELD_OUT,
    ModelRequest,
    VISIBLE,
)
from strive.diagnose import EvidenceDiagnoser
from strive.events import EventLog
from strive.fakemodel import demo_adapter
from strive.loop import LoopConfig, replay_run, run_cycle
from strive.model import FakeModelAdapter, ModelAdapter
from strive.model_proposer import ModelProposer
from strive.propose import ProposalRequest, ProposalResult, Proposer, RegistryProposer
from strive.store import Store
from strive.tasks import MAX_INTEGERS_TASK, SUM_INTEGERS_TASK

_PARENT_RE = re.compile(r"generation (gen-\d{4})")


def _model_config(adapter: ModelAdapter, **overrides: object) -> LoopConfig:
    config = LoopConfig(
        proposer=ModelProposer(),
        diagnoser=EvidenceDiagnoser(),
        model_adapter=adapter,
        budget=BudgetSpec(model_calls=4),
    )
    for key, value in overrides.items():
        setattr(config, key, value)
    return config


def _scripted_source_adapter(source: str) -> FakeModelAdapter:
    """A fake that answers with a schema-valid proposal carrying `source`."""

    def responder(request: ModelRequest) -> str:
        match = _PARENT_RE.search(request.prompt)
        assert match is not None
        return json.dumps(
            {
                "parent_generation_id": match.group(1),
                "summary": "scripted test proposal",
                "rationale": "test fixture",
                "trace_evidence": [],
                "expected_outcome": "test",
                "source": source,
                "changed_surfaces": ["strategy-code"],
                "risks": [],
                "assumptions": [],
            }
        )

    return FakeModelAdapter(responder=responder)


# -- demonstrations 1 + 2: non-planted weakness fixed and promoted ---------------


def test_fake_model_fixes_non_planted_weakness_and_is_promoted(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts")
    report = run_cycle(store, MAX_INTEGERS_TASK, _model_config(demo_adapter()))

    # the seed fails on multi-digit maxima (lexicographic max) — a weakness no
    # registry entry knows; the registry proposer could not have fixed this
    assert report.evaluation.split_scores[VISIBLE] == 3 / 5
    assert report.diagnosis is not None
    assert report.diagnosis.weakness_id == "visible-case-failures"
    assert report.proposal is not None
    assert "int" in report.proposal.source

    # promoted through the trusted paired policy on protected splits
    assert report.candidate_evaluation is not None
    assert report.candidate_evaluation.split_scores[VISIBLE] == 1.0
    assert report.candidate_evaluation.split_scores[HELD_OUT] == 1.0
    assert report.decision is not None and report.decision.accepted
    assert report.decision.policy == "paired-deterministic"
    assert report.generation_after != report.generation_before

    active = store.active_generation()
    assert active is not None and active.weakness_id == "visible-case-failures"


def test_registry_proposer_cannot_fix_the_non_planted_weakness(tmp_path: Path) -> None:
    """Control: the deterministic registry has no patch for max-integers."""
    store = Store(tmp_path / "artifacts")
    config = LoopConfig(diagnoser=EvidenceDiagnoser(), proposer=RegistryProposer())
    report = run_cycle(store, MAX_INTEGERS_TASK, config)
    assert report.diagnosis is not None
    assert report.proposal is None
    assert report.proposal_failure is not None
    assert report.generation_after == report.generation_before


# -- demonstration 3: full offline replay ----------------------------------------


def test_model_cycle_replays_offline_from_recorded_state(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts")
    report = run_cycle(store, MAX_INTEGERS_TASK, _model_config(demo_adapter()))
    assert report.decision is not None and report.decision.accepted

    # the journal carries the full model exchange with content-addressed artifacts
    events = EventLog(
        store.runs_dir / report.run_id / "events.jsonl", report.run_id
    ).read_all()
    model_calls = [e for e in events if e.type == "model_call"]
    assert len(model_calls) == 1
    payload = model_calls[0].payload
    assert payload["adapter"] == "fake"
    assert payload["model_id"] == "fake-deterministic-v1"
    assert isinstance(payload["latency_ms"], float)
    prompt = store.objects.get_text(str(payload["prompt_ref"]))
    completion = store.objects.get_text(str(payload["completion_ref"]))
    assert "max-integers" in prompt
    assert json.loads(completion)["changed_surfaces"] == ["strategy-code"]
    proposal_events = [e for e in events if e.type == "proposal"]
    assert len(proposal_events) == 1

    # replay re-executes baseline + candidate and reproduces the decision,
    # consulting no proposer and no model
    replay = replay_run(store, MAX_INTEGERS_TASK, report.run_id)
    assert replay.matches
    assert not replay.task_drift
    assert replay.candidate_replayed_score == 1.0
    assert replay.decision_matches is True


# -- demonstration 4: malformed / truncated / schema-invalid responses ------------


def test_malformed_model_response_is_rejected_without_crash(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts")
    adapter = FakeModelAdapter(responder=lambda request: "sorry, no JSON from me")
    report = run_cycle(store, MAX_INTEGERS_TASK, _model_config(adapter))

    assert report.proposal is None
    assert report.proposal_failure is not None
    assert report.proposal_failure.kind == FAILURE_PROPOSAL_MALFORMED
    assert report.generation_after == report.generation_before  # incumbent stays

    events = EventLog(
        store.runs_dir / report.run_id / "events.jsonl", report.run_id
    ).read_all()
    rejected = [e for e in events if e.type == "proposal_rejected"]
    assert len(rejected) == 1


def test_truncated_model_response_is_classified_distinctly(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts")
    config = _model_config(demo_adapter(), model_max_tokens=8)  # force truncation
    report = run_cycle(store, MAX_INTEGERS_TASK, config)
    assert report.proposal_failure is not None
    assert report.proposal_failure.kind == FAILURE_PROPOSAL_TRUNCATED
    assert report.generation_after == report.generation_before


def test_schema_invalid_model_response_is_classified_distinctly(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts")
    adapter = FakeModelAdapter(responder=lambda request: json.dumps({"summary": "hi"}))
    report = run_cycle(store, MAX_INTEGERS_TASK, _model_config(adapter))
    assert report.proposal_failure is not None
    assert report.proposal_failure.kind == FAILURE_PROPOSAL_SCHEMA_INVALID
    assert "missing fields" in report.proposal_failure.detail


def test_forbidden_source_is_screened_before_execution(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts")
    adapter = _scripted_source_adapter(
        "import os\n\ndef solve(input_text: str) -> int:\n    return 0\n"
    )
    report = run_cycle(store, MAX_INTEGERS_TASK, _model_config(adapter))
    assert report.proposal_failure is not None
    assert report.proposal_failure.kind == FAILURE_PROPOSAL_FORBIDDEN
    assert report.candidate is None  # never reached the sandbox
    assert report.generation_after == report.generation_before


# -- demonstration 5: syntactically valid but regressive candidate ----------------


def test_regressive_candidate_is_rejected_and_incumbent_stays(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts")
    adapter = _scripted_source_adapter("def solve(input_text: str) -> int:\n    return 0\n")
    report = run_cycle(store, MAX_INTEGERS_TASK, _model_config(adapter))

    assert report.proposal is not None  # schema-valid, screen-passing
    assert report.candidate_evaluation is not None
    assert report.decision is not None and not report.decision.accepted
    assert report.decision.regressed_case_ids  # it broke passing cases
    assert report.generation_after == report.generation_before

    # the rejected candidate is retained with its decision, for the record
    generations = store.generations()
    rejected = [
        g for g in generations.values()
        if g.decision is not None and not g.decision.accepted
    ]
    assert len(rejected) == 1


# -- demonstration 6: stale proposal after incumbent change ------------------------


class IncumbentChangingProposer:
    """Simulates a slow proposal: while 'thinking', the incumbent changes."""

    name = "stale-test"

    def __init__(self, store: Store, inner: Proposer) -> None:
        self._store = store
        self._inner = inner

    def propose(self, request: ProposalRequest) -> ProposalResult:
        result = self._inner.propose(request)
        usurper = self._store.add_generation(
            "def solve(input_text: str) -> int:\n    return -999\n",
            parent_id=request.ctx.parent_generation_id,
            origin="manual",
            surface="strategy-code",
            weakness_id=None,
            decision=None,
        )
        self._store.activate(usurper.generation_id, reason="promote", policy="manual")
        return result


def test_stale_proposal_is_rejected_after_incumbent_changes(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts")
    config = LoopConfig(
        proposer=IncumbentChangingProposer(store, RegistryProposer()),
    )
    report = run_cycle(store, SUM_INTEGERS_TASK, config)

    assert report.proposal is None
    assert report.proposal_failure is not None
    assert report.proposal_failure.kind == FAILURE_PROPOSAL_STALE
    assert report.candidate is None
    # no evolved generation was retained; only the usurper was added
    assert all(g.origin != "evolved" for g in store.generations().values())


# -- demonstration 7: proposal budget enforced by trusted code ---------------------


def test_model_call_budget_enforced_by_trusted_meter(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts")
    config = _model_config(demo_adapter(), budget=BudgetSpec(model_calls=0))
    report = run_cycle(store, MAX_INTEGERS_TASK, config)

    assert report.proposal is None
    assert report.proposal_failure is not None
    assert report.proposal_failure.kind == FAILURE_BUDGET_EXHAUSTED
    assert report.generation_after == report.generation_before

    events = EventLog(
        store.runs_dir / report.run_id / "events.jsonl", report.run_id
    ).read_all()
    assert any(e.type == "model_call_denied" for e in events)
    assert not any(e.type == "model_call" for e in events)  # never reached the model
