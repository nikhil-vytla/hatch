"""Stage-3C.1: the prompt-surface composite evolution experiment.

Coverage: the operational prompt surface (manifest resolution, per-request
journaling, restart, rollback), exact composite candidates through the live
loop, the matched-arm causal experiment, trusted-evaluation refusals
(malformed prompt edits, forbidden content, hidden-content embedding),
composite crash injection, and preservation of every earlier suite's
behavior (asserted by the full test run).
"""

from pathlib import Path

import pytest

from strive import codec, lifecycle
from strive.contracts import (
    FAILURE_PROPOSAL_FORBIDDEN,
    FAILURE_PROPOSAL_SCHEMA_INVALID,
    Event,
)
from strive.events import EventLog
from strive.experiment import (
    CANDIDATE_TEMPLATE,
    INCUMBENT_TEMPLATE,
    run_prompt_experiment,
)
from strive.fakemodel import (
    SIGNED_SUM_FIX,
    prompt_sensitive_adapter,
)
from strive.loop import CycleReport, LoopConfig, resolve_active_prompt, run_cycle
from strive.model_proposer import (
    DEFAULT_PROPOSAL_TEMPLATE,
    ModelProposer,
    validate_prompt_template,
)
from strive.propose import screen_prompt_update
from strive.revisions import HarnessRevision, ScopeManifest
from strive.store import Store
from strive.contracts import VISIBLE
from strive.tasks import SUM_INTEGERS_TASK

TASK = SUM_INTEGERS_TASK


def _events(store: Store, run_id: str) -> "list[Event]":
    return list(EventLog(store.runs_dir / run_id / "events.jsonl", run_id).read_all())


# -- the operational prompt surface --------------------------------------------------------------


def test_default_template_validates_and_resolves(tmp_path: Path) -> None:
    assert validate_prompt_template(DEFAULT_PROPOSAL_TEMPLATE) is None
    assert validate_prompt_template(INCUMBENT_TEMPLATE) is None
    assert validate_prompt_template(CANDIDATE_TEMPLATE) is None
    store = Store(tmp_path / "artifacts", TASK.task_id)
    run_cycle(store, TASK)
    text, ref, revision, source = resolve_active_prompt(store)
    assert source == "default"  # no revision binds a prompt yet
    assert text == DEFAULT_PROPOSAL_TEMPLATE
    assert store.objects.get_text(ref) == text  # journaled by stable CAS ref
    assert revision is not None


def test_prompt_ref_and_active_revision_journaled_per_model_request(
    tmp_path: Path,
) -> None:
    from strive.contracts import BudgetSpec
    from strive.diagnose import EvidenceDiagnoser

    store = Store(tmp_path / "artifacts", TASK.task_id)
    config = LoopConfig(
        proposer=ModelProposer(),
        diagnoser=EvidenceDiagnoser(),
        model_adapter=prompt_sensitive_adapter(),
        budget=BudgetSpec(model_calls=4),
    )
    report = run_cycle(store, TASK, config)
    events = _events(store, report.run_id)
    resolved = [e for e in events if e.type == "prompt_resolved"]
    assert len(resolved) == 1
    payload = resolved[0].payload
    assert isinstance(payload["prompt_ref"], str) and payload["prompt_ref"]
    assert payload["prompt_source"] in ("default", "revision")
    assert payload["active_revision"] is not None
    # the model_call's journaled prompt bytes ARE the consumed artifact
    calls = [e for e in events if e.type == "model_call"]
    assert calls
    prompt_text = store.objects.get_text(str(calls[0].payload["prompt_ref"]))
    assert "sum-integers" in prompt_text


def test_invalid_templates_are_rejected(tmp_path: Path) -> None:
    assert validate_prompt_template("") is not None
    assert validate_prompt_template("x" * 9000) is not None
    assert validate_prompt_template("hello {unknown_placeholder}") is not None
    assert (
        validate_prompt_template("no parent placeholder, JSON contract only")
        is not None
    )


def test_prompt_update_screen_blocks_hidden_content_and_bad_templates() -> None:
    hidden = tuple(
        value
        for case in TASK.cases
        if case.split != VISIBLE
        for value in (case.input_text, case.case_id)
    )
    # malformed template -> schema-invalid
    failure = screen_prompt_update("{not_a_placeholder}", hidden)
    assert failure is not None and failure.kind == FAILURE_PROPOSAL_SCHEMA_INVALID
    # embedding a hidden case input -> forbidden
    hidden_input = next(c.input_text for c in TASK.cases if c.split != VISIBLE)
    sneaky = CANDIDATE_TEMPLATE + f"\nremember: {hidden_input}\n"
    failure = screen_prompt_update(sneaky, hidden)
    assert failure is not None and failure.kind == FAILURE_PROPOSAL_FORBIDDEN
    # the genuine candidate template passes
    assert screen_prompt_update(CANDIDATE_TEMPLATE, hidden) is None


# -- the matched-arm experiment -------------------------------------------------------------------


def test_prompt_experiment_offline(tmp_path: Path) -> None:
    report = run_prompt_experiment(tmp_path / "exp")
    a, b, c, d, e = (report.arms[k] for k in "ABCDE")

    # A: the incumbent prompt causes a measurable, structured failure — the
    # proposal is valid but the unsigned fix is rejected by the gate
    assert a.proposal_valid and a.accepted is False
    assert a.prompt_contained_input_excerpts is False
    # ... and the incumbent stayed active in arm A's store
    store_a = Store(tmp_path / "exp" / "arm-a", TASK.task_id)
    active_a = store_a.active_generation()
    assert active_a is not None and active_a.generation_id == "gen-0000"
    # the rejected composite (unsigned code + proposed prompt update) is
    # retained with its evidence
    st_a = lifecycle.state(store_a)
    assert a.revision_id in st_a.retained
    assert not st_a.selections[str(a.revision_id)][-1].accepted

    # B: identical adapter/baseline/budgets; only the prompt differs; the
    # proposer sees the excerpts and the gate accepts
    assert b.proposal_valid and b.accepted is True
    assert b.prompt_contained_input_excerpts is True
    assert b.model_calls == a.model_calls  # matched budgets

    # C/D: ablations — prompt alone cannot move execution scores; code can
    assert c.accepted is False and d.accepted is True

    # E: the composite passed the gate and was activated as ONE revision
    assert e.accepted is True
    assert report.composite_gate_passed
    assert report.causal_prompt_effect
    assert report.prompt_consumed
    assert report.restart_serves_candidate_prompt
    assert report.rollback_restores_incumbent
    assert report.offline  # pipeline wiring, not model capability
    assert report.passed


def test_experiment_arm_b_composite_identity_and_evidence(tmp_path: Path) -> None:
    """Arm B's accepted candidate went through the full 3B.3 lifecycle:
    evaluated id == retained id == activated id, evidence linked."""
    report = run_prompt_experiment(tmp_path / "exp")
    b = report.arms["B"]
    store = Store(tmp_path / "exp" / "arm-b", TASK.task_id)
    st = lifecycle.state(store)
    assert b.revision_id is not None
    assert st.active_revision_id == b.revision_id
    assert st.selections[b.revision_id][-1].accepted
    assert lifecycle.compat_parity(store).ok


# -- exact composite candidates through the live loop ----------------------------------------------


def _prompt_cycle(store: Store) -> "CycleReport":
    from strive.contracts import BudgetSpec
    from strive.diagnose import EvidenceDiagnoser

    config = LoopConfig(
        proposer=ModelProposer(),
        diagnoser=EvidenceDiagnoser(),
        model_adapter=prompt_sensitive_adapter(),
        budget=BudgetSpec(model_calls=4),
    )
    return run_cycle(store, TASK, config)


def test_live_loop_builds_composite_candidate_with_prompt_update(
    tmp_path: Path,
) -> None:
    """Under the DEFAULT template (which surfaces excerpts), the adapter fixes
    the code; under the sparse incumbent it also proposes a prompt update —
    the overlay then carries BOTH deltas as one immutable revision."""
    from strive.experiment import _activate_prompt_only

    store = Store(tmp_path / "artifacts", TASK.task_id)
    _activate_prompt_only(store, INCUMBENT_TEMPLATE, "live")
    report = _prompt_cycle(store)
    assert report.proposal is not None
    assert report.proposal.prompt_update is not None  # composite proposal
    events = _events(store, report.run_id)
    overlay_ref = str(
        next(e for e in events if e.type == "candidate_overlay").payload["revision_ref"]
    )
    overlay: HarnessRevision = codec.loads(
        store.objects.get_text(overlay_ref), HarnessRevision
    )
    kinds = sorted((d.kind, d.name) for d in overlay.deltas)
    assert kinds == [("prompt", "proposal-template"), ("strategy-code", "solve")]
    manifest: ScopeManifest = codec.loads(
        store.objects.get_text(overlay.scope_manifest_ref), ScopeManifest
    )
    manifest_prompt = next(
        b.binding.content_ref for b in manifest.bindings if b.kind == "prompt"
    )
    assert manifest_prompt is not None
    assert store.objects.get_text(manifest_prompt) == report.proposal.prompt_update
    # rejected (unsigned code) -> retained with evidence, incumbent active
    assert report.decision is not None and not report.decision.accepted
    st = lifecycle.state(store)
    assert overlay.ref.revision_id in st.retained
    assert not st.selections[overlay.ref.revision_id][-1].accepted


def test_malformed_prompt_update_is_structured_failure(tmp_path: Path) -> None:
    """A proposal whose prompt_update fails the template validator is a
    distinct journaled failure; the incumbent stays active."""
    import json as json_module

    from strive.model import FakeModelAdapter

    def bad_prompt_responder(request: "object") -> str:
        import re

        parent = re.search(r"generation (gen-\d{4})", request.prompt)  # type: ignore[attr-defined]
        evidence = re.findall(r"^- ([\w-]+): ", request.prompt, re.MULTILINE)  # type: ignore[attr-defined]
        return json_module.dumps(
            {
                "parent_generation_id": parent.group(1) if parent else "gen-0000",
                "summary": "s", "rationale": "r",
                "trace_evidence": evidence, "expected_outcome": "o",
                "source": SIGNED_SUM_FIX,
                "changed_surfaces": ["prompt", "strategy-code"],
                "risks": [], "assumptions": [],
                "prompt_update": "{totally_unknown_placeholder}",
            }
        )

    store = Store(tmp_path / "artifacts", TASK.task_id)
    from strive.diagnose import EvidenceDiagnoser

    from strive.contracts import BudgetSpec

    config = LoopConfig(
        proposer=ModelProposer(),
        diagnoser=EvidenceDiagnoser(),
        model_adapter=FakeModelAdapter(responder=bad_prompt_responder),
        budget=BudgetSpec(model_calls=4),
    )
    report = run_cycle(store, TASK, config)
    assert report.proposal is None
    assert report.proposal_failure is not None
    assert report.proposal_failure.kind == FAILURE_PROPOSAL_SCHEMA_INVALID
    assert "prompt_update rejected" in report.proposal_failure.detail
    active = store.active_generation()
    assert active is not None and active.generation_id == "gen-0000"


def test_composite_crash_injection_resumes(tmp_path: Path) -> None:
    """The 3B.3 recoverable activation op covers composite candidates: after
    evaluation+selection+generation activation, a crash before the lifecycle
    activation resumes to the SAME composite revision."""
    from strive.events import now_iso
    from strive.experiment import _activate_prompt_only, _evaluate_composite_arm

    result, store, revision_id, decision_ref = _evaluate_composite_arm(
        tmp_path / "exp", "arm-crash", "crash-injection composite",
        {
            ("prompt", "proposal-template"): CANDIDATE_TEMPLATE,
            ("strategy-code", "solve"): SIGNED_SUM_FIX,
        },
    )
    assert result.accepted
    st = lifecycle.state(store)
    generation_id = st.links[revision_id]
    intent = lifecycle.ActivationIntent(
        op_id="op-crash-composite",
        revision_id=revision_id,
        baseline_revision_id=st.active_revision_id,
        generation_id=generation_id,
        reason="promote",
        policy_ref="paired-deterministic@1",
        decision_ref=decision_ref,
        at=now_iso(),
    )
    lifecycle.lifecycle(store).journal.append_batch([intent])
    store.activate(generation_id, reason="promote", policy="manual@0")
    # ... crash here, before the lifecycle activation

    outcomes = lifecycle.reconcile(store)
    assert outcomes == ("completed",)
    st = lifecycle.state(store)
    assert st.active_revision_id == revision_id  # the SAME composite revision
    resolved = lifecycle.materialize_active(store)
    assert resolved is not None
    surfaces = {(b.kind, b.name) for b in resolved.effective}
    assert ("prompt", "proposal-template") in surfaces  # both surfaces intact
    assert lifecycle.compat_parity(store).ok
