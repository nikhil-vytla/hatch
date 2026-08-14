"""Stage-3C.1 (corrected): the prompt-surface composite evolution experiment.

Coverage: the operational, stale-safe prompt surface (pinned default in
lifecycle state, structured failures, staleness after slow model calls);
the hardened Formatter-based template validator and rendered-budget limits;
generic surface updates; the trusted prompt gate (harmful prompts riding on
good code are demoted to code-only siblings); the two-stage self-produced
composite with one identity through propose → evaluate → retain → select →
activate → restart → replay → rollback; rollback to the pinned historical
default; reproducible runs (manifest + reuse refusal); and the proposal@1
no-migration proof.
"""

import json
from pathlib import Path

import pytest

from strive import codec, lifecycle
from strive.contracts import (
    FAILURE_BUDGET_EXHAUSTED,
    FAILURE_PROPOSAL_FORBIDDEN,
    FAILURE_PROPOSAL_SCHEMA_INVALID,
    FAILURE_PROPOSAL_STALE,
    BudgetSpec,
    Event,
    SurfaceUpdate,
    VISIBLE,
)
from strive.events import EventLog
from strive.experiment import (
    CANDIDATE_TEMPLATE,
    INCUMBENT_TEMPLATE,
    run_prompt_experiment,
)
from strive.fakemodel import SIGNED_SUM_FIX, prompt_sensitive_adapter
from strive.loop import LoopConfig, resolve_active_prompt, run_cycle
from strive.model import FakeModelAdapter
from strive.model_proposer import (
    DEFAULT_PROPOSAL_TEMPLATE,
    ModelProposer,
    validate_prompt_template,
)
from strive.propose import screen_surface_update
from strive.store import Store
from strive.tasks import SUM_INTEGERS_TASK

TASK = SUM_INTEGERS_TASK


def _events(store: Store, run_id: str) -> "list[Event]":
    return list(EventLog(store.runs_dir / run_id / "events.jsonl", run_id).read_all())


def _prompt_config(adapter: "object" = None) -> LoopConfig:
    from strive.diagnose import EvidenceDiagnoser

    return LoopConfig(
        proposer=ModelProposer(),
        diagnoser=EvidenceDiagnoser(),
        model_adapter=adapter or prompt_sensitive_adapter(),  # type: ignore[arg-type]
        budget=BudgetSpec(model_calls=6, executions=24),
    )


# -- the operational, stale-safe prompt surface ---------------------------------------------------


def test_default_template_is_pinned_into_lifecycle_state(tmp_path: Path) -> None:
    """After seeding, the default template lives IN lifecycle state (a
    retained revision + CAS artifact): resolution reads history, not the
    current build's default string; fallback would only ever apply to
    explicitly unmigrated pre-prompt history."""
    store = Store(tmp_path / "artifacts", TASK.task_id)
    run_cycle(store, TASK)
    st = lifecycle.state(store)
    assert "rev-prompt-default" in st.retained
    text, ref, _revision, source = resolve_active_prompt(store)
    assert source == "revision"  # manifest-bound, not a fallback
    assert text == DEFAULT_PROPOSAL_TEMPLATE
    assert store.objects.get_text(ref) == text


def test_rollback_serves_the_pinned_historical_default(tmp_path: Path) -> None:
    """Rolling back must restore the HISTORICAL pinned template from CAS,
    even when the current build's default string has changed."""
    import strive.model_proposer as mp

    store = Store(tmp_path / "artifacts", TASK.task_id)
    report = run_cycle(store, TASK)  # pins the default, evolves gen-0001
    assert report.decision is not None and report.decision.accepted
    pinned_text = resolve_active_prompt(store)[0]

    original = mp.DEFAULT_PROPOSAL_TEMPLATE
    mp.DEFAULT_PROPOSAL_TEMPLATE = original + "\n# a NEWER build's default\n"
    try:
        lifecycle.rollback(store)  # active candidate -> its parent (the pin)
        text, _ref, _rev, source = resolve_active_prompt(store)
        assert source == "revision"
        assert text == pinned_text  # the historical artifact, from CAS
        assert "NEWER build" not in text
    finally:
        mp.DEFAULT_PROPOSAL_TEMPLATE = original


def test_concurrent_prompt_activation_during_model_call_is_stale(
    tmp_path: Path,
) -> None:
    """The request pins the prompt ref and lifecycle head; a prompt change
    DURING the slow model call rejects the proposal as stale even though the
    active generation id never changed."""
    from strive.experiment import _activate_prompt_only
    from strive.fakemodel import prompt_sensitive_responder

    store = Store(tmp_path / "artifacts", TASK.task_id)
    run_cycle(store, TASK)  # seed + pin + first candidate
    lifecycle.rollback(store)  # weak incumbent so the next cycle proposes
    fired = {"done": False}

    def hostile_responder(request: "object") -> str:
        if not fired["done"]:
            fired["done"] = True
            # a concurrent operator installs a different prompt mid-call
            _activate_prompt_only(store, INCUMBENT_TEMPLATE, "concurrent")
        return prompt_sensitive_responder(request)  # type: ignore[arg-type]

    report = run_cycle(
        store, TASK, _prompt_config(FakeModelAdapter(responder=hostile_responder))
    )
    assert report.proposal is None
    assert report.proposal_failure is not None
    assert report.proposal_failure.kind == FAILURE_PROPOSAL_STALE
    assert (
        "prompt changed" in report.proposal_failure.detail
        or "lifecycle head" in report.proposal_failure.detail
    )
    # the incumbent stayed active
    active = store.active_generation()
    assert active is not None and active.generation_id == "gen-0000"


def test_corrupt_active_prompt_is_a_structured_failure(tmp_path: Path) -> None:
    from strive.store import StoreError

    store = Store(tmp_path / "artifacts", TASK.task_id)
    run_cycle(store, TASK)
    _text, ref, _rev, source = resolve_active_prompt(store)
    assert source == "revision"
    (store.objects.root / ref[:2] / ref).write_text("corrupted")
    with pytest.raises(StoreError, match="active prompt artifact unavailable"):
        resolve_active_prompt(store)


# -- the hardened template validator ---------------------------------------------------------------


def test_formatter_validator_rejects_malformed_fields() -> None:
    assert validate_prompt_template("") is not None
    assert validate_prompt_template("x" * 9000) is not None
    base = "propose JSON for {parent_generation_id} "
    assert validate_prompt_template(base + "{unknown}") is not None
    assert validate_prompt_template(base + "{task_id.__class__}") is not None
    assert validate_prompt_template(base + "{task_id[0]}") is not None
    assert validate_prompt_template(base + "{task_id!r}") is not None
    assert validate_prompt_template(base + "{task_id:>100}") is not None
    assert validate_prompt_template(base + "{}") is not None
    assert validate_prompt_template(base + "{task_id} " * 6) is not None
    assert validate_prompt_template("no parent placeholder, JSON only") is not None
    assert (
        validate_prompt_template("has {parent_generation_id} but no output contract")
        is not None
    )
    # the shipped templates pass
    assert validate_prompt_template(DEFAULT_PROPOSAL_TEMPLATE) is None
    assert validate_prompt_template(INCUMBENT_TEMPLATE) is None
    assert validate_prompt_template(CANDIDATE_TEMPLATE) is None


def test_rendered_prompt_overflow_refuses_before_provider_call(
    tmp_path: Path,
) -> None:
    from strive.budget import BudgetMeter
    from strive.contracts import Diagnosis
    from strive.model import MeteredJournalingAdapter
    from strive.promptgate import make_visible_context
    from strive.propose import ProposalRequest

    calls = {"count": 0}

    def counting_responder(request: "object") -> str:
        calls["count"] += 1
        return "never valid"

    store = Store(tmp_path / "artifacts", TASK.task_id)
    run_cycle(store, TASK)
    active = store.active_generation()
    assert active is not None
    huge_source = store.source_of(active) + "\n# pad\n" * 12000  # ~26k rendered
    from strive.sandboxes import CandidateExecutor, default_catalog

    trusted_executor = CandidateExecutor.from_catalog(
        default_catalog(), "process-fault-only@1", trusted=True
    )
    ctx, diagnosis = make_visible_context(
        TASK, active.generation_id, huge_source, trusted_executor
    )
    diagnosis = diagnosis or Diagnosis(
        weakness_id="visible-case-failures", description="d",
        evidence_case_ids=("positives-pair",),
    )
    meter = BudgetMeter(BudgetSpec(model_calls=2))
    events = EventLog(store.runs_dir / "overflow" / "events.jsonl", "overflow")
    handle = MeteredJournalingAdapter(
        FakeModelAdapter(responder=counting_responder), meter, events, store.objects
    )
    request = ProposalRequest(
        ctx=ctx, diagnosis=diagnosis, task_description=TASK.description,
        task_signature=TASK.signature, primitive_catalog=TASK.primitive_catalog,
        history=(), max_output_tokens=2048, model_calls_remaining=1,
        executions_remaining=4, model=handle,
        prompt_template=DEFAULT_PROPOSAL_TEMPLATE,
    )
    result = ModelProposer().propose(request)
    assert result.failure is not None
    assert result.failure.kind == FAILURE_BUDGET_EXHAUSTED
    assert "rendered prompt" in result.failure.detail
    assert calls["count"] == 0  # the provider was never called


def test_surface_update_screen_blocks_hidden_content_and_bad_templates() -> None:
    from strive.revisions import current_descriptor

    descriptor = current_descriptor("prompt").descriptor_ref
    hidden = tuple(
        value
        for case in TASK.cases
        if case.split != VISIBLE
        for value in (case.input_text, case.case_id)
    )
    bad = SurfaceUpdate(descriptor, "proposal-template", "{not_a_placeholder}")
    failure = screen_surface_update(bad, hidden)
    assert failure is not None and failure.kind == FAILURE_PROPOSAL_SCHEMA_INVALID
    hidden_input = next(c.input_text for c in TASK.cases if c.split != VISIBLE)
    sneaky = SurfaceUpdate(
        descriptor, "proposal-template", CANDIDATE_TEMPLATE + f"\n{hidden_input}\n"
    )
    failure = screen_surface_update(sneaky, hidden)
    assert failure is not None and failure.kind == FAILURE_PROPOSAL_FORBIDDEN
    unknown = SurfaceUpdate("prompt@99", "proposal-template", CANDIDATE_TEMPLATE)
    failure = screen_surface_update(unknown, hidden)
    assert failure is not None and failure.kind == FAILURE_PROPOSAL_SCHEMA_INVALID
    good = SurfaceUpdate(descriptor, "proposal-template", CANDIDATE_TEMPLATE)
    assert screen_surface_update(good, hidden) is None


def test_proposal_v1_records_are_never_decoded_and_refuse_loudly() -> None:
    """The item-6 proof: proposal@1 exists only inside run-event payloads
    (never codec-decoded from disk anywhere in strive — event payloads are
    plain dicts), so no migration path is required; decoding one anyway
    refuses with the strict unsupported-version error."""
    v1 = json.dumps(
        {
            "schema": "proposal@1", "parent_generation_id": "gen-0000",
            "surface": "strategy-code", "summary": "s", "rationale": "r",
            "trace_evidence": [], "expected_outcome": "o", "source": "x",
            "changed_surfaces": ["strategy-code"], "risks": [], "assumptions": [],
        }
    )
    with pytest.raises(codec.SchemaError, match="unsupported proposal version 1"):
        codec.loads(v1)


# -- the trusted prompt gate: no piggybacking --------------------------------------------------------


def test_harmful_prompt_piggybacking_on_good_code_is_demoted(tmp_path: Path) -> None:
    """An adversarial proposal bundles GOOD code with a prompt delta that
    makes future proposals WORSE. The task gate accepts the code; the trusted
    prompt comparison shows no benefit; the composite is retained as
    rejected and the code-only sibling is activated instead."""
    import re as re_module

    def piggyback_responder(request: "object") -> str:
        prompt = request.prompt  # type: ignore[attr-defined]
        parent = re_module.search(r"generation (gen-\d{4})", prompt)
        evidence = re_module.findall(r"^- ([\w-]+): ", prompt, re_module.MULTILINE)
        return json.dumps(
            {
                "parent_generation_id": parent.group(1) if parent else "gen-0000",
                "summary": "good code, harmful prompt",
                "rationale": "r",
                "trace_evidence": evidence,
                "expected_outcome": "o",
                "source": SIGNED_SUM_FIX,
                "changed_surfaces": ["prompt", "strategy-code"],
                "risks": [],
                "assumptions": [],
                # the harmful delta: replace the (default, excerpt-bearing)
                # template with the SPARSE one — future proposals lose the
                # evidence they need
                "prompt_update": INCUMBENT_TEMPLATE,
            }
        )

    store = Store(tmp_path / "artifacts", TASK.task_id)
    report = run_cycle(
        store, TASK, _prompt_config(FakeModelAdapter(responder=piggyback_responder))
    )
    assert report.decision is not None and report.decision.accepted  # the CODE
    st = lifecycle.state(store)
    active = st.active_revision_id
    assert active is not None and active.endswith("-code")  # the SIBLING
    composite_id = active.removesuffix("-code")
    assert composite_id in st.retained  # retained as REJECTED evidence
    assert not st.selections[composite_id][-1].accepted
    evidence = st.surface_evidence[composite_id][-1]
    assert evidence.surface == "prompt" and not evidence.improved
    # the served prompt is unchanged (the harmful delta never activated)
    text, _ref, _rev, _src = resolve_active_prompt(store)
    assert text == DEFAULT_PROPOSAL_TEMPLATE
    assert lifecycle.compat_parity(store).ok
    events = _events(store, report.run_id)
    demoted = [e for e in events if e.type == "composite_demoted"]
    assert len(demoted) == 1
    assert demoted[0].payload["activated_revision_id"] == active


def test_beneficial_prompt_with_failing_code_is_retained_not_activated(
    tmp_path: Path,
) -> None:
    """Under the SPARSE incumbent, the fixture proposes (unsigned code +
    beneficial prompt). The code fails the task gate, so nothing activates —
    the composite is retained with prompt evidence showing improvement."""
    from strive.experiment import _activate_prompt_only

    store = Store(tmp_path / "artifacts", TASK.task_id)
    _activate_prompt_only(store, INCUMBENT_TEMPLATE, "live")
    report = run_cycle(store, TASK, _prompt_config())
    assert report.proposal is not None
    assert report.proposal.surface_updates  # composite proposal
    assert report.decision is not None and not report.decision.accepted
    st = lifecycle.state(store)
    composite_id = next(r for r in st.retained if r.startswith("rev-cand-"))
    assert not st.selections[composite_id][-1].accepted
    evidence = st.surface_evidence[composite_id][-1]
    assert evidence.improved  # the prompt WOULD help; the code didn't
    active = store.active_generation()
    assert active is not None and active.generation_id == "gen-0000"


# -- the matched-arm experiment + the two-stage self-produced composite -------------------------------


def test_prompt_experiment_offline(tmp_path: Path) -> None:
    report = run_prompt_experiment(tmp_path / "exp")
    a, b, c, d, e = (report.arms[k] for k in "ABCDE")

    assert a.proposal_valid and a.accepted is False
    assert a.prompt_contained_input_excerpts is False
    assert b.proposal_valid and b.accepted is True
    assert b.prompt_contained_input_excerpts is True
    # matched CONFIGURATION (identical budgets/params); actual consumption
    # legitimately differs — arm A's composite proposal triggers the trusted
    # prompt-gate comparison (+2 calls), arm B's code-only proposal does not
    assert (a.budget_model_calls, a.budget_max_tokens) == (
        b.budget_model_calls, b.budget_max_tokens
    )
    assert c.accepted is False and d.accepted is True

    two = report.two_stage
    assert two is not None
    # D matches E on task score; E is accepted ONLY because its prompt earned
    # its own evidence under the trusted comparison
    assert d.candidate_overall == e.candidate_overall
    assert two.task_accepted and two.prompt_improved and two.composite_accepted
    # one identity through the whole lifecycle
    assert (
        two.proposed_revision_id
        == two.retained_revision_id
        == two.activated_revision_id
        == "rev-cand-two-stage"
    )
    assert two.restart_serves_p1 and two.replay_matches
    assert two.rollback_restores_incumbent
    assert report.causal_prompt_effect and report.prompt_consumed
    assert report.matched_configuration and report.offline
    assert report.passed

    # the manifest pins the run
    manifest = json.loads((tmp_path / "exp" / "manifest.json").read_text())
    assert manifest["task_fingerprint"] == TASK.fingerprint()
    assert manifest["arm_order"] == ["A", "B", "C", "D", "E"]
    assert set(manifest["lifecycle_heads"]) == {"A", "B", "C", "D", "E"}
    assert manifest["budget_model_calls"] == 6


def test_two_stage_composite_evidence_is_linked(tmp_path: Path) -> None:
    report = run_prompt_experiment(tmp_path / "exp")
    two = report.two_stage
    assert two is not None
    store = Store(tmp_path / "exp" / "arm-e", TASK.task_id)
    st = lifecycle.state(store)
    rid = two.proposed_revision_id
    assert st.selections[rid][-1].accepted
    assert st.selections[rid][-1].policy_ref == "prompt-comparison@1"
    evidence = st.surface_evidence[rid][-1]
    assert evidence.surface == "prompt" and evidence.improved
    from strive.promptgate import PromptComparisonEvidence

    comparison: PromptComparisonEvidence = codec.loads(
        store.objects.get_text(evidence.evidence_ref), PromptComparisonEvidence
    )
    assert comparison.candidate.gate_accepted
    assert not comparison.incumbent.gate_accepted
    assert comparison.improved


def test_experiment_rerun_in_same_directory_is_refused(tmp_path: Path) -> None:
    run_prompt_experiment(tmp_path / "exp")
    with pytest.raises(RuntimeError, match="reuse is refused"):
        run_prompt_experiment(tmp_path / "exp")
    report = run_prompt_experiment(tmp_path / "exp2")  # a fresh directory works
    assert report.passed


# -- structured failures leave the incumbent active ---------------------------------------------------


def test_malformed_prompt_update_is_structured_failure(tmp_path: Path) -> None:
    import re as re_module

    def bad_prompt_responder(request: "object") -> str:
        prompt = request.prompt  # type: ignore[attr-defined]
        parent = re_module.search(r"generation (gen-\d{4})", prompt)
        evidence = re_module.findall(r"^- ([\w-]+): ", prompt, re_module.MULTILINE)
        return json.dumps(
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
    report = run_cycle(
        store, TASK, _prompt_config(FakeModelAdapter(responder=bad_prompt_responder))
    )
    assert report.proposal is None
    assert report.proposal_failure is not None
    assert report.proposal_failure.kind == FAILURE_PROPOSAL_SCHEMA_INVALID
    assert "surface update" in report.proposal_failure.detail
    active = store.active_generation()
    assert active is not None and active.generation_id == "gen-0000"
