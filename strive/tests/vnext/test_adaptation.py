from collections.abc import Iterator
from dataclasses import replace
import hashlib
import json
from pathlib import Path

import pytest

from strive.codec import decode, encode
from strive.contracts.commands import ApplyChange, Continue, ExecuteEffect, StepOutput
from strive.contracts.feedback import FeedbackContract
from strive.contracts.lifecycle import EffectState
from strive.contracts.primitives import AccessScope, ArtifactRef, LineageId, Resource, RevisionId, ScopedArtifact
from strive.contracts.records import RevisionActivation
from strive.errors import VerificationError
from strive.policy import Dependency, Edit, EvidenceSelector, Origin, Proposal
from strive.policy.data import FileVersion, dumps
from strive.runtime.ledger import amounts
from strive.runtime.sandbox import SandboxFailure
from strive.runtime.supervisor import Boundary
from strive.contracts.primitives import ExecutionStatus

from .adaptation_fixtures import ACTOR, AdaptationFixture, CounterProgram
from .fresh_probe import fresh_replay
from .test_runtime import Crash


@pytest.fixture
def adaptation(tmp_path: Path) -> Iterator[AdaptationFixture]:
    fixture = AdaptationFixture(tmp_path)
    try:
        yield fixture
    finally:
        fixture.close()


def test_prompt_only_edit_changes_behavior(adaptation: AdaptationFixture) -> None:
    assert adaptation.step()["delta"] == 1
    adaptation.policy.activate(adaptation.proposal(Edit("prompts/delta.txt", b"7")))
    assert adaptation.step()["delta"] == 7


def test_code_only_edit_changes_behavior(adaptation: AdaptationFixture) -> None:
    assert adaptation.step()["delta"] == 1
    adaptation.policy.activate(adaptation.proposal(Edit("actor/step.js", ACTOR.replace(b"prompt+memory", b"prompt+memory+6"))))
    assert adaptation.step()["delta"] == 7


def test_memory_write_persists_and_is_readable_next_episode(adaptation: AdaptationFixture) -> None:
    adaptation.initialize()
    adaptation.policy.activate(adaptation.proposal(Edit("memory/delta.txt", b"6"), Edit("skills/arbitrary-notes.md", b"Use add once.")))
    bundle_ref = adaptation.supervisor.state.active_bundle
    assert bundle_ref is not None
    bundle = adaptation.bundles.load(bundle_ref)
    memory_ref = dict(bundle.files)["memory/delta.txt"]
    memory = adaptation.bundles.file(memory_ref)
    assert memory.previous is not None and memory.origins and memory.scope == adaptation.scope
    adaptation.restart()
    adaptation.policy.run(adaptation.adapter, adaptation.assignments(), adaptation.routes, CounterProgram(adaptation))
    assert [m.metric_value for m in adaptation.supervisor.state.measurements] == [1, 1]
    assert adaptation.objects.read(adaptation.bundles.file(memory_ref).content) == b"6"
    assert adaptation.objects.read(adaptation.bundles.file(memory.previous).content) == b"0"


@pytest.mark.parametrize("boundary", [Boundary.ACCEPTED, Boundary.ACTIVATED])
def test_composite_activation_crash_is_atomic(adaptation: AdaptationFixture, boundary: Boundary) -> None:
    old = adaptation.supervisor.state.active_bundle
    proposal = adaptation.proposal(Edit("actor/step.js", ACTOR.replace(b"prompt+memory", b"prompt+memory+2")),
        Edit("prompts/delta.txt", b"3"), Edit("memory/delta.txt", b"2"))
    command = adaptation.bundles.build(proposal, adaptation.supervisor.state)
    def crash(point: Boundary) -> None:
        if point is boundary:
            raise Crash()
    adaptation.supervisor.fault = crash
    with pytest.raises(Crash):
        adaptation.supervisor.accept(StepOutput(command, b"unchanged"), expected_head=adaptation.supervisor.state.head)
        adaptation.supervisor.drive()
    at_crash = adaptation.reader.verify()
    assert at_crash.active_bundle in {old, command.next_bundle}
    if boundary is Boundary.ACCEPTED:
        assert at_crash.active_bundle == old
    adaptation.restart()
    assert adaptation.supervisor.state.active_bundle == command.next_bundle
    assert adaptation.step()["delta"] == 7
    assert len(adaptation.supervisor.state.revisions) == 2


def test_restore_preserves_environment_and_accounting(adaptation: AdaptationFixture) -> None:
    adaptation.policy.run(adaptation.adapter, adaptation.assignments(1), adaptation.routes, CounterProgram(adaptation))
    adaptation.policy.activate(adaptation.proposal(Edit("prompts/delta.txt", b"7")))
    before = adaptation.reader.verify()
    adaptation.supervisor.restore(adaptation.initial)
    after = adaptation.reader.verify()
    assert after.environment == before.environment
    assert after.effects == before.effects
    assert after.measured == before.measured and after.obligations == before.obligations
    assert after.consumed_results == before.consumed_results
    assert after.private_state == before.private_state
    assert after.active_bundle == adaptation.initial


@pytest.mark.parametrize("case,match", [("scope", "out-of-editable-scope"), ("revision", "expected-revision"),
    ("dependency", "missing-dependency"), ("capability", "capabilities"), ("structure", "structure"), ("path", "path")])
def test_invalid_proposal_rejected_without_activation(adaptation: AdaptationFixture, case: str, match: str) -> None:
    proposal = adaptation.proposal(Edit("prompts/delta.txt", b"7"))
    if case == "scope":
        proposal = replace(proposal, edits=(Edit("verifier/engine.py", b"unsafe"),))
    elif case == "revision":
        proposal = replace(proposal, expected_revision=RevisionId("wrong"))
    elif case == "dependency":
        proposal = replace(proposal, dependencies=(Dependency("missing", adaptation.pin),))
    elif case == "capability":
        proposal = replace(proposal, capabilities=("network.arbitrary",))
    elif case == "structure":
        proposal = replace(proposal, edits=(Edit("actor/step.js", None),))
    else:
        proposal = replace(proposal, edits=(Edit("memory/../protected.txt", b"unsafe"),))
    before = adaptation.reader.verify()
    with pytest.raises(VerificationError, match=match):
        adaptation.policy.activate(proposal)
    assert adaptation.reader.verify() == before


def test_controller_edit_rejected_out_of_scope(adaptation: AdaptationFixture) -> None:
    proposal = replace(adaptation.proposal(Edit("controller/step.js", b"function step(){}")), controller_state=b"new")
    with pytest.raises(VerificationError, match="out-of-editable-scope"):
        adaptation.policy.activate(proposal)
    assert adaptation.reader.verify().active_bundle == adaptation.initial


@pytest.mark.parametrize("boundary", [Boundary.ACCEPTED, Boundary.ACTIVATED])
def test_bounded_controller_handover_is_atomic(tmp_path: Path, boundary: Boundary) -> None:
    fixture = AdaptationFixture(tmp_path, controller_editable=True)
    try:
        fixture.initialize()
        before = fixture.reader.verify()
        source = b'''function step(view,state,result,handles) {
            if(atob(state.bytes)!=="explicit new state") throw Error("wrong handover");
            return {type:"StepOutput", fields:{command:{type:"Continue",fields:{}},
            proposed_private_state:{bytes:btoa('{"delta":7}')},annotations:{tuple:[]}}};
        }'''
        proposal = replace(fixture.proposal(Edit("controller/step.js", source)), controller_state=b"explicit new state")
        def crash(point: Boundary) -> None:
            if point is boundary:
                raise Crash()
        fixture.supervisor.fault = crash
        with pytest.raises(Crash):
            fixture.policy.activate(proposal)
        at_crash = fixture.reader.verify()
        assert (at_crash.active_bundle == before.active_bundle) == (at_crash.private_state == before.private_state)
        fixture.restart()
        after = fixture.reader.verify()
        assert after.private_state == b"explicit new state"
        assert after.effects == before.effects and after.consumed_results == before.consumed_results
        assert after.environment == before.environment and after.measured == before.measured
        assert fixture.step()["delta"] == 7
    finally:
        fixture.close()


@pytest.mark.parametrize("source", [b'function step(){throw Error("broken")}', b'function step(){while(true){}}',
    b'function step(){return {not:"a step"}}'])
def test_broken_controller_suspends_operator_restores_without_execution(tmp_path: Path, source: bytes) -> None:
    fixture = AdaptationFixture(tmp_path, controller_editable=True)
    try:
        fixture.policy.activate(replace(fixture.proposal(Edit("controller/step.js", source)), controller_state=b"bad private state"))
        with pytest.raises(SandboxFailure):
            fixture.step()
        before = fixture.reader.verify()
        assert before.execution_status is ExecutionStatus.SUSPENDED
        fixture.supervisor.restore(fixture.initial)
        after = fixture.reader.verify()
        assert after.active_bundle == fixture.initial and after.execution_status is ExecutionStatus.SUSPENDED
        assert after.effects == before.effects and after.measured == before.measured
        assert after.environment == before.environment and after.private_state == before.private_state
        assert after.consumed_results == before.consumed_results
        fixture.restart()
        assert fixture.reader.verify().active_bundle == fixture.initial
    finally:
        fixture.close()


def test_handover_rejects_pending_command_and_unconsumed_result(tmp_path: Path) -> None:
    fixture = AdaptationFixture(tmp_path, controller_editable=True)
    try:
        proposal = replace(fixture.proposal(Edit("controller/step.js", b"function step(){}")), controller_state=b"new")
        command = fixture.bundles.build(fixture.proposal(Edit("prompts/delta.txt", b"2")), fixture.supervisor.state)
        fixture.supervisor.accept(StepOutput(command, b""), expected_head=fixture.supervisor.state.head)
        with pytest.raises(VerificationError, match="boundary"):
            fixture.bundles.build(proposal, fixture.supervisor.state)
        fixture.supervisor.drive()
        driver = fixture.initialize()
        current = fixture.supervisor.state.environment
        assert current is not None
        from strive.benchmarks.payloads import loads as load_benchmark
        from strive.benchmarks.api import EpisodeSnapshot
        from strive.benchmarks.bridge import OperationRequest
        snapshot = load_benchmark(fixture.objects.read(current), EpisodeSnapshot)
        driver.perform(OperationRequest(snapshot.episode, snapshot.environment, current, snapshot, "snapshot", ()))
        proposal = replace(proposal, expected_revision=fixture.supervisor.state.active_revision or RevisionId("missing"))
        with pytest.raises(VerificationError, match="boundary"):
            fixture.bundles.build(proposal, fixture.supervisor.state)
    finally:
        fixture.close()


def test_continual_refine_counter_replay_and_fresh_interpreter_purity(adaptation: AdaptationFixture) -> None:
    adaptation.upstream.decide = lambda context: Proposal(RevisionId(str(context["revision"])), "revise",
        (Edit("prompts/delta.txt", b"7"),), rationale="confirmed improvement is just a claim", compare=True)
    adaptation.policy.run(adaptation.adapter, adaptation.assignments(), adaptation.routes, CounterProgram(adaptation))
    state = adaptation.reader.verify()
    assert [m.metric_value for m in state.measurements] == [0, 1]
    assert adaptation.upstream.calls == 1
    assert len(state.revisions) == 2 and not state.pending_command
    assert all(e.state is EffectState.CONSUMED for e in state.effects)
    assert amounts(state.measured)[Resource.MODEL_CALLS] == 1
    assert amounts(state.measured).get(Resource.USD_NANODOLLARS, 0) == 0
    assert any(e.authorization.operation == "runtime.step" for e in state.effects)
    assert any(e.authorization.operation == "model.generate" for e in state.effects)
    assert not adaptation.adapter.describe().supports_forks
    fresh_replay(adaptation.root / "artifacts", corrupt=False, benchmark=True)
    adaptation.restart()
    adaptation.policy.run(adaptation.adapter, adaptation.assignments(), adaptation.routes, CounterProgram(adaptation))
    assert adaptation.reader.verify().effects == state.effects and adaptation.upstream.calls == 1


@pytest.mark.parametrize("decision", ["keep", "gather-more-evidence", "restore"])
def test_refiner_policy_decisions(adaptation: AdaptationFixture, decision: str) -> None:
    adaptation.policy.activate(adaptation.proposal(Edit("prompts/delta.txt", b"4")))
    current = adaptation.supervisor.state.active_bundle
    def decide(context: dict[str, object]) -> Proposal:
        prior = context["prior_bundles"]
        assert isinstance(prior, list) and prior
        return Proposal(RevisionId(str(context["revision"])), decision,
            restore=ArtifactRef(str(prior[0])) if decision == "restore" else None)
    adaptation.upstream.decide = decide
    assert adaptation.policy.refine("decision") == decision
    assert adaptation.supervisor.state.active_bundle == (adaptation.initial if decision == "restore" else current)
    adaptation.restart()
    adaptation.policy.refine("decision")
    assert adaptation.upstream.calls == 1


@pytest.mark.parametrize("contract,expected", [(FeedbackContract.A, {"development"}), (FeedbackContract.B, {"development", "validation"})])
def test_evidence_intersects_feedback_and_grants_before_read(tmp_path: Path, contract: FeedbackContract, expected: set[str]) -> None:
    fixture = AdaptationFixture(tmp_path, contract=contract)
    try:
        origins = []
        for pool in ("development", "validation", "audit", "private_veto"):
            ref = fixture.provenance.publish(pool.encode(), fixture.scope, fixture.pin, fixture.pin, purpose="view")
            origins.append(Origin(ref, fixture.scope, pool))
        ungranted = fixture.objects.publish(b"ungranted")
        origins.append(Origin(ungranted, fixture.scope, "development"))
        selected = EvidenceSelector(fixture.broker, tuple(origins)).select(fixture.reader.verify())
        assert {o.pool for o in selected.origins} == expected
        assert set(selected.contents) == {p.encode() for p in expected}
    finally:
        fixture.close()


def test_memory_import_cannot_launder_provenance_or_scope(adaptation: AdaptationFixture) -> None:
    foreign = AccessScope(adaptation.scope.run_id, LineageId("protected"), adaptation.pin)
    version = adaptation.objects.publish(dumps(FileVersion(adaptation.pin, foreign, (Origin(adaptation.pin, foreign, "audit"),))))
    with pytest.raises(VerificationError, match="provenance"):
        adaptation.policy.activate(adaptation.proposal(Edit("memory/import.md", None, version)))
    before = adaptation.reader.verify()
    with pytest.raises(VerificationError, match="widen"):
        adaptation.policy.activate(adaptation.proposal(Edit("memory/summary.md", b"summary")), (Origin(adaptation.pin, foreign, "audit"),))
    assert adaptation.reader.verify() == before


def test_core_freeze_all_30_hashes_match() -> None:
    root = Path(__file__).resolve().parents[2]
    freeze = json.loads((root / "tests/vnext/baselines/second-benchmark-core-freeze.json").read_text())
    assert len(freeze) == 30
    assert all(hashlib.sha256((root / name).read_bytes()).hexdigest() == digest for name, digest in freeze.items())


@pytest.mark.xfail(strict=True, reason="EvaluateFork enactment is deferred: a future approved verifier+supervisor change must authorize and charge fork effects; ExecuteEffect is currently the only chargeable authorization.")
def test_evaluate_fork_enactment_deferred() -> None:
    pytest.fail("EvaluateFork remains declared unsupported; immediate activation requires no fork")


@pytest.mark.parametrize("boundary", [Boundary.EXTERNAL_RETURN, Boundary.RETURN_RECORDED, Boundary.SETTLED, Boundary.ACTIVATED])
def test_refiner_crash_recovery_never_repeats_generation(adaptation: AdaptationFixture, boundary: Boundary) -> None:
    adaptation.upstream.decide = lambda context: Proposal(RevisionId(str(context["revision"])), "revise", (Edit("memory/delta.txt", b"6"),))
    def crash(point: Boundary) -> None:
        if point is boundary:
            raise Crash()
    adaptation.supervisor.fault = crash
    with pytest.raises(Crash):
        adaptation.policy.refine("crash-checkpoint")
    adaptation.restart()
    adaptation.policy.refine("crash-checkpoint")
    assert adaptation.upstream.calls == 1
    assert len(adaptation.reader.verify().revisions) == 2
    assert adaptation.step()["delta"] == 7
    assert amounts(adaptation.reader.verify().measured)[Resource.MODEL_CALLS] == 1


def test_development_check_is_optional_and_can_gather_more_evidence(adaptation: AdaptationFixture) -> None:
    adaptation.upstream.decide = lambda context: Proposal(RevisionId(str(context["revision"])), "revise", (Edit("prompts/delta.txt", b"7"),), compare=True)
    seen: list[Proposal] = []
    def check(proposal: Proposal) -> bool:
        seen.append(proposal)
        return False
    adaptation.policy.development_check = check
    assert adaptation.policy.refine("development-check") == "gather-more-evidence"
    assert len(seen) == 1 and adaptation.supervisor.state.active_bundle == adaptation.initial
    adaptation.policy.development_check = None
    assert adaptation.policy.refine("immediate") == "revise"
    assert adaptation.step()["delta"] == 7


def test_validation_provenance_survives_summary_and_import(tmp_path: Path) -> None:
    fixture = AdaptationFixture(tmp_path, contract=FeedbackContract.B)
    try:
        reference = fixture.provenance.publish(b"validation observation", fixture.scope, fixture.pin, fixture.pin, purpose="view")
        fixture.selector.grants = (Origin(reference, fixture.scope, "validation"),)
        fixture.upstream.decide = lambda context: Proposal(RevisionId(str(context["revision"])), "revise", (Edit("memory/delta.txt", b"6"),))
        fixture.policy.refine("validation")
        active = fixture.supervisor.state.active_bundle
        assert active is not None
        memory_ref = dict(fixture.bundles.load(active).files)["memory/delta.txt"]
        assert Origin(reference, fixture.scope, "validation") in fixture.bundles.file(memory_ref).origins
        fixture.policy.activate(fixture.proposal(Edit("skills/freeform.txt", None, memory_ref)))
        active = fixture.supervisor.state.active_bundle
        assert active is not None
        imported = fixture.bundles.file(dict(fixture.bundles.load(active).files)["skills/freeform.txt"])
        assert Origin(reference, fixture.scope, "validation") in imported.origins
        assert imported.scope == fixture.scope and fixture.objects.read(imported.content) == b"6"
    finally:
        fixture.close()


@pytest.mark.parametrize("contract,expected", [(FeedbackContract.A, False), (FeedbackContract.B, True)])
def test_validation_operation_observation_does_not_become_development(tmp_path: Path, contract: FeedbackContract, expected: bool) -> None:
    from strive.benchmarks.bridge import OperationRequest
    from strive.benchmarks.episodes import EpisodeAssignment, EpisodeDriver
    from strive.contracts.feedback import EvidencePool
    from strive.contracts.primitives import EnvironmentId, EpisodeId
    fixture = AdaptationFixture(tmp_path, contract=contract)
    try:
        task = fixture.adapter.enumerate_tasks()[1]
        assignment = EpisodeAssignment(EpisodeId("validation"), task, fixture.adapter.grouping, (task.task_id,))
        driver = EpisodeDriver(fixture.supervisor, fixture.adapter, assignment, fixture.routes, fixture.provenance)
        driver.perform(OperationRequest(assignment.episode, EnvironmentId("validation"), fixture.pin, None,
            "initialize", (task, fixture.objects.publish(b"{}"))))
        driver.consume()
        fixture.selector.episode_pools[assignment.episode] = EvidencePool.VALIDATION
        selected = fixture.selector.select(fixture.reader.verify())
        assert bool(selected.origins) is expected
        assert all(o.pool == "validation" for o in selected.origins)
    finally:
        fixture.close()


def test_actor_action_is_not_rerun_after_committed_step_crash(adaptation: AdaptationFixture) -> None:
    adaptation.initialize()
    adaptation.step()
    before = len([e for e in adaptation.reader.verify().effects if e.authorization.operation == "runtime.step"])
    adaptation.restart()
    adaptation.policy.run(adaptation.adapter, adaptation.assignments(1), adaptation.routes, CounterProgram(adaptation))
    after = len([e for e in adaptation.reader.verify().effects if e.authorization.operation == "runtime.step"])
    assert after == before + 1  # Only the termination decision needs another step.
    assert len(adaptation.reader.verify().measurements) == 1


def test_stripping_handover_state_cannot_activate(tmp_path: Path) -> None:
    fixture = AdaptationFixture(tmp_path, controller_editable=True)
    try:
        command = fixture.bundles.build(replace(fixture.proposal(Edit("controller/step.js", b"function step(){throw Error('new')}")),
            controller_state=b"initial"), fixture.supervisor.state)
        fixture.supervisor.accept(StepOutput(replace(command, controller_state=None), b"old"), expected_head=fixture.supervisor.state.head)
        with pytest.raises(VerificationError, match="compatible"):
            fixture.supervisor.drive()
        assert fixture.reader.verify().active_bundle == fixture.initial
    finally:
        fixture.close()


def test_refiner_must_match_retained_model_binding(adaptation: AdaptationFixture) -> None:
    from strive.policy import ContinualRefine
    route = replace(adaptation.policy.refiner, model=replace(adaptation.model, model="unbound-model"))
    with pytest.raises(VerificationError, match="model differs from run binding"):
        ContinualRefine(adaptation.supervisor, adaptation.bundles, adaptation.sandbox, adaptation.selector, adaptation.provenance, route)
    assert adaptation.upstream.calls == 0 and not adaptation.reader.verify().effects


def test_binary_memory_is_retained_as_file_data_in_refiner_context(adaptation: AdaptationFixture) -> None:
    adaptation.policy.activate(adaptation.proposal(Edit("memory/blob.bin", b"\xff\x00")))
    assert adaptation.policy.refine("binary-memory") == "keep"
    files = adaptation.upstream.contexts[0]["files"]
    assert isinstance(files, dict) and files["memory/blob.bin"] == {"base64": "/wA="}


def test_open_annotation_payload_cannot_break_policy_decision_lookup(adaptation: AdaptationFixture) -> None:
    from strive.contracts.annotations import Annotation
    adaptation.supervisor.accept(StepOutput(Continue(), b"", (Annotation("policy.decision", b"[]"),)),
        expected_head=adaptation.supervisor.state.head)
    assert adaptation.policy.refine("opaque-annotation") == "keep"
    assert adaptation.policy.refine("opaque-annotation") == "already-decided"
    assert adaptation.upstream.calls == 1
