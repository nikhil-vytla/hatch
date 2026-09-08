"""One primary case per §2 guarantee and per Milestone 1 contract deliverable.

Schema tests freeze the protocol shapes. Guarantee 5 now exercises storage and
pure replay in a fresh interpreter. The other four runtime probes remain strict
expected failures until their named milestones install enforcement.
"""

from dataclasses import FrozenInstanceError, dataclass, fields, replace
from decimal import Decimal
import inspect
from pathlib import Path
from typing import Protocol, assert_never, get_args

import pytest

from strive.vnext.contracts.annotations import Annotation, MAX_ANNOTATION_BYTES
from strive.vnext.contracts.commands import (
    ApplyChange, Command, Continue, EvaluateFork, ExecuteEffect, Finish,
    RestoreBundle, Step, StepOutput, Suspend,
)
from strive.vnext.contracts.feedback import EvidencePool, FEEDBACK_ACCESS_MATRIX, FeedbackContract
from strive.vnext.contracts.harness import HarnessAdapter
from strive.vnext.contracts.lifecycle import (
    DispatchStage, EffectState, FINISHED_EXECUTION_RECOVERY_ACTION, HARNESS_RECOVERY_ACTIONS, HarnessInterruption,
    LEGAL_TRANSITIONS, RECOVERY_ACTIONS, RecoveryAction, validate_transition,
)
from strive.vnext.contracts.manifest import (
    ManifestError, load_authored_manifest, load_resolved_configuration,
)
from strive.vnext.contracts.primitives import (
    EffectId, ObservedModelIdentity, RequestedModelIdentity, Resource,
    ResourceQuantity, WireModelIdentity,
)
from strive.vnext.contracts.records import (
    AuthorityRecord, ContinuationCommit, EffectAuthorization, EffectObservationSettlement,
    Envelope, Measurement, RECORD_OWNERS, RecordClass, RecordOwner, RevisionActivation,
    RunBinding, UsageKind, UsageObservation, UsageProvenance,
)
from strive.vnext.contracts.study import (
    BenchmarkOperation, EpisodeOutcome, REFERENCE_STUDY_PLAN, SIMULATOR_SCENARIOS,
)

from .fixtures import AUTHORED_TOML, REF, RESOLVED_TOML, authorization


def test_integrity_1_candidate_commands_cannot_assign_outer_authority() -> None:
    """Candidate step output cannot assign reservations, epochs, or trusted settings."""
    authority_fields = {
        "effect_id", "invocation_id", "execution_epoch", "reservation", "producer_identity",
        "limits", "capabilities", "feedback_contract", "scorer", "recovery_contract",
        "consumed_result_cursor", "executing_bundle",
    }
    for command_type in get_args(Command.__value__):
        assert not authority_fields & {field.name for field in fields(command_type)}
    assert {field.name for field in fields(StepOutput)} == {"command", "proposed_private_state", "annotations"}
    with pytest.raises(TypeError):
        # Deliberately exercise a hostile dynamic caller, outside the typed API.
        ExecuteEffect(**{"operation": "model.generate", "binding": "actor", "request": REF, "reservation": REF})  # type: ignore[arg-type]


def test_integrity_2_annotation_claims_cannot_become_authoritative_facts() -> None:
    claim = Annotation("unregistered.claim", b'{"metric_value": 100, "reservation": 0, "producer": "broker"}')
    assert claim.payload.endswith(b'"broker"}')  # Unknown bounded schemas remain readable.
    assert {field.name for field in fields(Annotation)} == {"namespace", "payload"}
    assert not isinstance(claim, get_args(AuthorityRecord.__value__))
    assert Measurement.owner is RecordOwner.TRUSTED_SCORER
    assert EffectObservationSettlement.owner is RecordOwner.BROKER_AND_TRUSTED_ADAPTERS
    assert RecordClass.ANNOTATION not in RECORD_OWNERS
    with pytest.raises(TypeError):
        Annotation(**{"namespace": "candidate.claim", "payload": b"{}", "reservation_disposition": "release"})  # type: ignore[arg-type]


def test_integrity_3_upstream_authorization_requires_exact_request_and_execution_identity() -> None:
    original = authorization()
    with pytest.raises(ValueError, match="actual provider request"):
        replace(original, actual_provider_request_reference=None)
    with pytest.raises(ValueError, match="binding and generation envelope"):
        replace(original, dispatch_stage=DispatchStage.HARNESS_LAUNCH, harness_binding_reference=None)
    second = replace(original, effect_id=EffectId("effect-2"))
    assert original.exact_request_reference == second.exact_request_reference
    assert original.effect_id != second.effect_id  # Content identity never deduplicates executions.
    assert {field.name for field in fields(ContinuationCommit)} == {
        "private_state", "executing_bundle", "consumed_result_cursor", "pending_command_reference",
        "environment_reference", "execution_status",
    }


def test_integrity_4_ambiguous_execution_cannot_be_consumed_or_erased() -> None:
    assert RECOVERY_ACTIONS[EffectState.AUTHORIZED_RESERVED] is RecoveryAction.RECONCILE_OR_SUSPEND
    assert RECOVERY_ACTIONS[EffectState.UNCERTAIN] is RecoveryAction.RECONCILE_OR_SUSPEND
    with pytest.raises(ValueError, match="illegal effect transition"):
        validate_transition(EffectState.UNCERTAIN, EffectState.CONSUMED)
    with pytest.raises(ValueError, match="obligation"):
        UsageObservation(UsageKind.UNKNOWN, None, UsageProvenance.GATEWAY, REF, None)
    unknown = UsageObservation(UsageKind.UNKNOWN, None, UsageProvenance.GATEWAY, REF,
                               ResourceQuantity(Resource.INPUT_TOKENS, 100))
    assert unknown.quantity is None
    assert unknown.remaining_obligation == ResourceQuantity(Resource.INPUT_TOKENS, 100)
    assert "reservation" not in {field.name for field in fields(RestoreBundle)}


def test_integrity_5_closed_protocol_refuses_skipped_and_repeated_consumption() -> None:
    for previous, following in (
        (EffectState.ACCEPTED, EffectState.DISPATCHED),
        (EffectState.DISPATCHED, EffectState.CONSUMED),
        (EffectState.UNCERTAIN, EffectState.SETTLED),
        (EffectState.CONSUMED, EffectState.CONSUMED),
        (EffectState.CONSUMED, EffectState.DISPATCHED),
    ):
        with pytest.raises(ValueError, match="illegal effect transition"):
            validate_transition(previous, following)
    assert set(LEGAL_TRANSITIONS) == set(EffectState) == set(RECOVERY_ACTIONS)
    assert LEGAL_TRANSITIONS[EffectState.CONSUMED] == frozenset()


def test_exit_authority_schema_freezes_all_groups_and_owners() -> None:
    record_types: set[type[AuthorityRecord]] = {RunBinding, EffectAuthorization, EffectObservationSettlement,
                    Measurement, RevisionActivation, ContinuationCommit}
    assert set(get_args(AuthorityRecord.__value__)) == record_types
    assert {record.record_class for record in record_types} == set(RecordClass) - {RecordClass.ANNOTATION}
    assert Envelope.owner is RecordOwner.SUPERVISOR
    assert set(RECORD_OWNERS) == set(RecordClass) - {RecordClass.ANNOTATION}
    assert all(record.owner == RECORD_OWNERS[record.record_class] for record in record_types)
    assert {"harness_bindings", "gateway_identity"} <= {field.name for field in fields(RunBinding)}
    assert {"benchmark_upstream_revision", "split_grouping_identity", "episode_identity", "trajectory_identity",
            "reset_boundary", "exact_reward_definition"} <= {field.name for field in fields(Measurement)}
    with pytest.raises(FrozenInstanceError):
        setattr(authorization(), "execution_epoch", 99)


def _command_name(command: Command) -> str:
    if isinstance(command, ExecuteEffect):
        return "ExecuteEffect"
    if isinstance(command, ApplyChange):
        return "ApplyChange"
    if isinstance(command, RestoreBundle):
        return "RestoreBundle"
    if isinstance(command, EvaluateFork):
        return "EvaluateFork"
    if isinstance(command, Continue):
        return "Continue"
    if isinstance(command, Suspend):
        return "Suspend"
    if isinstance(command, Finish):
        return "Finish"
    assert_never(command)  # mypy rejects adding a command without extending this case.


def test_exit_step_interface_has_one_exhaustive_seven_command_union() -> None:
    assert set(get_args(Command.__value__)) == {ExecuteEffect, ApplyChange, RestoreBundle, EvaluateFork, Continue, Suspend, Finish}
    assert list(inspect.signature(Step.__call__).parameters) == ["self", "authorized_view", "private_state", "recorded_result"]
    assert _command_name(Finish("budget exhausted")) == "Finish"
    assert "success" not in {field.name for field in fields(Finish)}


def test_exit_effect_lifecycle_and_recovery_cover_every_dispatch_stage() -> None:
    path = (EffectState.ACCEPTED, EffectState.AUTHORIZED_RESERVED, EffectState.DISPATCHED,
            EffectState.RETURNED, EffectState.SETTLED, EffectState.CONSUMED)
    for previous, following in zip(path, path[1:]):
        validate_transition(previous, following)
    validate_transition(EffectState.DISPATCHED, EffectState.UNCERTAIN)
    validate_transition(EffectState.UNCERTAIN, EffectState.RETURNED)
    assert set(HARNESS_RECOVERY_ACTIONS) == set(HarnessInterruption)
    assert HARNESS_RECOVERY_ACTIONS[HarnessInterruption.COMPLETE_RETURN_CAPTURED] is RecoveryAction.COMPLETE_RECORDED_BOOKKEEPING
    assert HARNESS_RECOVERY_ACTIONS[HarnessInterruption.LATE_RESPONSE_OR_RECEIPT] is RecoveryAction.APPEND_LATE_RECONCILIATION
    assert HARNESS_RECOVERY_ACTIONS[HarnessInterruption.LAUNCH_AUTHORIZED_NO_UPSTREAM_AUTHORIZATION] is RecoveryAction.PROVE_NO_UPSTREAM_REVOKE_TERMINATE_NEW_EPOCH
    assert FINISHED_EXECUTION_RECOVERY_ACTION is RecoveryAction.APPEND_LATE_RECONCILIATION


def test_exit_harness_adapter_freezes_four_methods_and_three_model_identities() -> None:
    assert {name for name, value in vars(HarnessAdapter).items() if callable(value) and not name.startswith("_")} == {
        "describe", "prepare", "invoke", "reconcile",
    }
    assert list(inspect.signature(HarnessAdapter.prepare).parameters) == ["self", "binding", "generation_input", "execution_context"]
    assert list(inspect.signature(HarnessAdapter.invoke).parameters) == ["self", "prepared_generation", "supervisor_services"]
    assert list(inspect.signature(HarnessAdapter.reconcile).parameters) == ["self", "prepared_generation", "durable_evidence"]
    requested = RequestedModelIdentity("openai", "alias", "openai/alias")
    wire = WireModelIdentity("https://provider.invalid/v1", "alias")
    observed = ObservedModelIdentity("actual-model", "revision-1", "response.model", REF)
    assert len({type(requested), type(wire), type(observed)}) == 3
    assert observed.original_field == "response.model" and observed.provenance == REF


def test_exit_manifest_separates_authored_paths_from_resolved_content() -> None:
    authored = load_authored_manifest(AUTHORED_TOML)
    assert authored.policy.package == "./artifact"
    assert authored.budget.usd.nanodollars == 20_000_000_001
    assert authored.models[2].binding.harness is None  # Direct trusted provider path.
    with pytest.raises(ManifestError, match="artifact reference"):
        load_resolved_configuration(AUTHORED_TOML)
    resolved = load_resolved_configuration(RESOLVED_TOML)
    assert resolved.policy.package == REF
    assert resolved.pins.model_gateway == REF
    assert resolved.harnesses[0].binding.executable == REF


def test_exit_simulator_scenarios_cover_tau_agent_user_state_and_trusted_reward() -> None:
    scenarios = {item.name: item for item in SIMULATOR_SCENARIOS}
    assert {"crash_after_agent_mutation", "crash_after_user_mutation", "same_id_different_arguments",
            "snapshot_both_sides", "scorer_uses_committed_state", "episode_reset", "limit_preserves_coverage"} <= scenarios.keys()
    assert scenarios["crash_after_agent_mutation"].operation is BenchmarkOperation.AGENT_TOOL
    assert scenarios["crash_after_user_mutation"].operation is BenchmarkOperation.USER_TOOL
    assert all(item.given and item.interruption_or_attack and item.required_observation for item in SIMULATOR_SCENARIOS)
    assert len(EpisodeOutcome) == 5


def test_exit_feedback_matrix_freezes_a_b_and_defers_c() -> None:
    a, b, c = (FEEDBACK_ACCESS_MATRIX[contract] for contract in FeedbackContract)
    assert a.adaptation == a.selection == frozenset({EvidencePool.DEVELOPMENT, EvidencePool.OPERATIONAL_FAILURES})
    assert b.adaptation == b.selection == a.adaptation | {EvidencePool.VALIDATION}
    assert not c.implemented and not c.adaptation and not c.selection
    for access in (a, b, c):
        assert EvidencePool.AUDIT not in access.adaptation | access.selection
        assert EvidencePool.PRIVATE_VETO not in access.adaptation | access.selection
    with pytest.raises(ManifestError, match="not implemented"):
        load_authored_manifest(AUTHORED_TOML.replace('contract = "A"', 'contract = "C"'))


def test_exit_reference_study_freezes_split_exposures_selection_and_allocation_formula() -> None:
    plan = REFERENCE_STUDY_PLAN
    assert (plan.development_tasks, plan.validation_tasks, plan.audit_tasks) == (60, 14, 40)
    assert plan.development_tasks + plan.validation_tasks + plan.audit_tasks == 114
    assert plan.feedback_contract is FeedbackContract.A and not plan.forks_enabled
    assert plan.development_passes * plan.development_tasks == plan.development_episodes_per_trajectory == 180
    assert plan.refinement_after_episodes == tuple(range(20, 180, 20))
    assert len(plan.refinement_after_episodes) == plan.max_refiner_generations == 8
    development = plan.trajectory_pairs * len(plan.arms) * plan.development_episodes_per_trajectory
    audit = plan.trajectory_pairs * len(plan.arms) * plan.audit_tasks * plan.audit_repetitions_per_task
    assert (development, audit, development + audit) == (2880, 1280, 4160)
    assert development + audit + plan.pilot_episodes == 4184
    assert plan.trajectory_pairs * plan.max_refiner_generations + plan.pilot_refiner_generations == 68
    assert plan.selection == "final_valid_active_actor_from_every_trajectory"
    assert plan.independent_unit == "paired_trajectory"
    assert (plan.max_actor_generations_per_episode, plan.max_user_generations_per_episode,
            plan.max_benchmark_transitions_per_episode) == (100, 100, 400)
    assert (plan.max_input_tokens_per_episode, plan.max_output_tokens_per_episode) == (512_000, 32_768)
    assert (plan.actor_model, plan.refiner_model, plan.user_model) == ("gpt-5.6-luna",) * 3


@pytest.mark.parametrize("section", [
    "", "run", "pins", "policy", "workload", "feedback", "comparison", "models.actor", "models.refiner",
    "models.user", "harnesses.opencode", "seeds", "budget", 'recovery."model.generate"',
    'recovery."benchmark.tool"', "telemetry",
])
def test_manifest_rejects_unknown_keys_in_every_core_table(section: str) -> None:
    source = 'typo = "not an annotation"\n' + AUTHORED_TOML if not section else AUTHORED_TOML.replace(
        f"[{section}]", f'[{section}]\ntypo = "not an annotation"', 1)
    with pytest.raises(ManifestError, match="unknown"):
        load_authored_manifest(source)


@pytest.mark.parametrize(("old", "new", "message"), [
    ('model_gateway = "./artifact"\n', "", "missing required"),
    ('schema = "strive.run/1"', 'schema = "strive.run/2"', "schema"),
    ('max_input_tokens = 16384', "max_input_tokens = true", "integer"),
    ('max_output_tokens = 2048', "max_output_tokens = 0", "integer"),
    ('level = "model"', 'level = "executor"', "level"),
    ('native_tools = "none"', 'native_tools = "all"', "native_tools"),
    ('session_policy = "fresh"', 'session_policy = "resume"', "session_policy"),
    ('max_provider_requests = 1', 'max_provider_requests = 2', "max_provider_requests"),
    ('max_provider_requests = 1', 'max_provider_requests = true', "max_provider_requests"),
    ('model_transport = "broker_gateway"', 'model_transport = "direct"', "model_transport"),
    ('harness = "opencode"', 'harness = "missing"', "unknown harness"),
    ('fallback = "forbid"', 'fallback = "allow"', "fallback"),
    ('native_session_resume = false', 'native_session_resume = true', "native_session_resume"),
    ('automatic_redispatch = false', 'automatic_redispatch = true', "automatic_redispatch"),
    ('unknown_usage = "retain_reservation"', 'unknown_usage = "zero"', "unknown_usage"),
    ('usd = 20.000000001', 'usd = nan', "finite"),
    ('usd = 20.000000001', 'usd = -1', "nonnegative"),
    ('usd = 20.000000001', 'usd = 0.0000000001', "nanodollars"),
    ('"user_simulation", ', '', "missing enabled phases"),
    ('refine_every_episodes = 20', 'refine_every_orders = 20', "unknown policy"),
])
def test_manifest_refuses_unsafe_or_malformed_settings(old: str, new: str, message: str) -> None:
    with pytest.raises(ManifestError, match=message):
        load_authored_manifest(AUTHORED_TOML.replace(old, new))


def test_annotations_reject_unbounded_or_non_json_payloads() -> None:
    for payload in (b"x" * (MAX_ANNOTATION_BYTES + 1), b"NaN", b"Infinity", b"not json", b'"\xff"'):
        with pytest.raises(ValueError):
            Annotation("candidate.diagnostic", payload)


@dataclass(frozen=True)
class RuntimeEvidence:
    candidate_escape_denied: bool
    harness_escape_denied: bool
    protected_input_variation_changed_adaptive_requests: bool
    forged_measurement_rejected: bool
    request_retained_before_dispatch: bool
    result_consumptions: int
    mutation_count: int
    reservation_after_restore: Decimal
    reservation_before_restore: Decimal
    ambiguous_retry_dispatched: bool
    corrupt_authority_rejected: bool
    verifier_imported_candidate: bool


class RuntimeAcceptanceDriver(Protocol):
    def exercise(self, scenario: str) -> RuntimeEvidence: ...


class StorageRuntimeDriver:
    """Milestone 2 closes only replay/corruption; later scenarios remain explicit."""

    def __init__(self, root: Path) -> None:
        self.root = root

    def exercise(self, scenario: str) -> RuntimeEvidence:
        if scenario != "fresh_interpreter_replay_with_corrupt_reference_and_unknown_bounded_annotation":
            raise NotImplementedError("runtime scenario belongs to a later milestone")
        from .fresh_probe import fresh_replay
        from .storage_fixtures import complete_history

        reader = complete_history(self.root)
        fresh_replay(self.root, corrupt=False)
        effect = reader.verify().effects[0]
        assert effect.response is not None
        reader.objects.path(effect.response).write_bytes(b"corrupted authority response")
        fresh_replay(self.root, corrupt=True)
        return RuntimeEvidence(
            candidate_escape_denied=False, harness_escape_denied=False,
            protected_input_variation_changed_adaptive_requests=False,
            forged_measurement_rejected=False, request_retained_before_dispatch=False,
            result_consumptions=1, mutation_count=0,
            reservation_after_restore=Decimal(0), reservation_before_restore=Decimal(0),
            ambiguous_retry_dispatched=False, corrupt_authority_rejected=True,
            verifier_imported_candidate=False,
        )


@pytest.fixture
def future_runtime(tmp_path: Path) -> RuntimeAcceptanceDriver:
    return StorageRuntimeDriver(tmp_path / "runtime-vnext")


@pytest.mark.xfail(strict=True, raises=NotImplementedError,
                   reason="Milestone 3 Build effects, accounting, and confinement + Qualify replaceable harnesses: enforce process-tree isolation")
def test_runtime_integrity_1_confines_candidate_and_harness(future_runtime: RuntimeAcceptanceDriver) -> None:
    evidence = future_runtime.exercise("candidate_and_harness_attempt_credentials_network_storage_and_tool_access")
    assert evidence.candidate_escape_denied and evidence.harness_escape_denied


@pytest.mark.xfail(strict=True, raises=NotImplementedError,
                   reason="Complete stateful operation and Complete the research workflow: trusted scorer plus A/B noninterference")
def test_runtime_integrity_2_rejects_forged_facts_and_protected_feedback(future_runtime: RuntimeAcceptanceDriver) -> None:
    evidence = future_runtime.exercise("forge_success_and_vary_protected_evidence_with_fixed_permitted_inputs")
    assert evidence.forged_measurement_rejected
    assert not evidence.protected_input_variation_changed_adaptive_requests


@pytest.mark.xfail(strict=True, raises=NotImplementedError,
                   reason="Milestones 2/3 storage and effects + Qualify replaceable harnesses: crash at every dispatch/continuation boundary")
def test_runtime_integrity_3_retains_request_and_consumes_result_once(future_runtime: RuntimeAcceptanceDriver) -> None:
    evidence = future_runtime.exercise("crash_before_and_after_launch_forward_return_settlement_and_continuation")
    assert evidence.request_retained_before_dispatch
    assert evidence.result_consumptions == 1


@pytest.mark.xfail(strict=True, raises=NotImplementedError,
                   reason="Complete stateful operation and Enable adaptation: reconcile mutation, preserve uncertainty, restore only bundle")
def test_runtime_integrity_4_preserves_mutation_and_unresolved_obligation(future_runtime: RuntimeAcceptanceDriver) -> None:
    evidence = future_runtime.exercise("crash_after_mutation_then_restore_bundle_with_ambiguous_model_effect")
    assert evidence.mutation_count == 1
    assert evidence.reservation_after_restore == evidence.reservation_before_restore > 0
    assert not evidence.ambiguous_retry_dispatched


def test_runtime_integrity_5_replay_rejects_corruption_without_candidate_imports(future_runtime: RuntimeAcceptanceDriver) -> None:
    evidence = future_runtime.exercise("fresh_interpreter_replay_with_corrupt_reference_and_unknown_bounded_annotation")
    assert evidence.corrupt_authority_rejected
    assert not evidence.verifier_imported_candidate
