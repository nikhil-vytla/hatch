"""Pure protocol fold. Inputs expose reads only; no dispatch or candidate imports."""

from collections.abc import Iterable
from dataclasses import dataclass, replace
from typing import get_args

from ..codec import content_ref, decode, references
from ..contracts.annotations import Annotation
from ..contracts.commands import ApplyChange, Command, ExecuteEffect, RestoreBundle
from ..contracts.lifecycle import DispatchStage, EffectState, validate_transition
from ..contracts.primitives import (
    ArtifactRef, CommandId, EffectId, ExecutionStatus, InvocationId, RecordId, Resource, ResourceQuantity,
    ResultCursor, RevisionId,
)
from ..contracts.records import (
    ContinuationCommit, EffectAuthorization, EffectObservationSettlement, Measurement,
    OutcomeStatus, ProducerKind, Record, RecordClass, ReservationDisposition,
    RevisionActivation, RunBinding, UsageCompleteness, UsageKind,
)
from ..errors import VerificationError
from ..wire import Authority, Frame, JournalReader, ObjectReader, record_digest


@dataclass(frozen=True)
class EffectView:
    authorization: EffectAuthorization
    state: EffectState
    last_record_id: RecordId
    invocation_id: InvocationId
    result: ResultCursor | None = None
    response: ArtifactRef | None = None
    outcome: OutcomeStatus | None = None
    measured: tuple[ResourceQuantity, ...] = ()
    obligations: tuple[ResourceQuantity, ...] = ()
    overrun: tuple[ResourceQuantity, ...] = ()


@dataclass(frozen=True)
class VerifiedState:
    """Immutable output of replay/preflight; callers supply only verified prefixes."""

    records: tuple[Record, ...] = ()
    epoch: int = 0
    binding: RunBinding | None = None
    active_bundle: ArtifactRef | None = None
    active_revision: RevisionId | None = None
    revisions: tuple[tuple[RevisionId, ArtifactRef], ...] = ()
    effects: tuple[EffectView, ...] = ()
    private_state: bytes = b""
    environment: ArtifactRef | None = None
    pending_command: ArtifactRef | None = None
    pending_command_id: CommandId | None = None
    execution_status: ExecutionStatus = ExecutionStatus.CONTINUE
    consumed_results: frozenset[ResultCursor] = frozenset()
    measurements: tuple[Measurement, ...] = ()
    dispatch_stopped: bool = False

    @property
    def head(self) -> ArtifactRef | None:
        return self.records[-1].envelope.integrity_linkage.record_digest if self.records else None

    def effect(self, effect_id: EffectId) -> EffectView:
        for effect in self.effects:
            if effect.authorization.effect_id == effect_id:
                return effect
        raise VerificationError(f"unknown effect: {effect_id}")

    @property
    def measured(self) -> tuple[ResourceQuantity, ...]:
        return _sum_typed(effect.measured for effect in self.effects)

    @property
    def obligations(self) -> tuple[ResourceQuantity, ...]:
        return _sum_typed(effect.obligations for effect in self.effects)


def _sum_typed(groups: Iterable[tuple[ResourceQuantity, ...]]) -> tuple[ResourceQuantity, ...]:
    totals: dict[Resource, int] = {}
    for group in groups:
        for item in group:
            totals[item.resource] = totals.get(item.resource, 0) + item.quantity
    return _quantities(totals)


def _quantities(values: dict[Resource, int], *, include_zero: bool = False) -> tuple[ResourceQuantity, ...]:
    return tuple(ResourceQuantity(resource, quantity) for resource, quantity in sorted(values.items()) if quantity or include_zero)


def _amounts(values: tuple[ResourceQuantity, ...]) -> dict[Resource, int]:
    result = {value.resource: value.quantity for value in values}
    _require(len(result) == len(values), "duplicate resource component")
    return result


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise VerificationError(message)


def _transition(previous: EffectState, following: EffectState) -> None:
    try:
        validate_transition(previous, following)
    except ValueError as error:
        raise VerificationError(str(error)) from error


def _replace_effect(state: VerifiedState, effect: EffectView) -> VerifiedState:
    return replace(state, effects=tuple(effect if old.authorization.effect_id == effect.authorization.effect_id else old for old in state.effects))


def _check_budget(state: VerifiedState, proposed: tuple[ResourceQuantity, ...] = ()) -> None:
    assert state.binding is not None
    limits = state.binding.limits
    totals = _amounts(_sum_typed((state.measured, state.obligations, proposed)))
    tokens = sum(totals.get(resource, 0) for resource in (Resource.TOKENS, Resource.INPUT_TOKENS, Resource.OUTPUT_TOKENS))
    _require(totals.get(Resource.USD_NANODOLLARS, 0) <= limits.usd.nanodollars
             and tokens <= limits.tokens and totals.get(Resource.MODEL_CALLS, 0) <= limits.model_calls
             and totals.get(Resource.WALL_MILLISECONDS, 0) <= limits.wall_seconds * 1000,
             "reservation exceeds run budget")


def _binding(state: VerifiedState, payload: RunBinding, frame: Frame, authority: Authority) -> VerifiedState:
    _require(not state.records and state.binding is None, "RunBinding must be first and unique")
    _require(payload.declared_lineage.lineage_id == authority.scope.lineage_id, "binding lineage mismatch")
    _require(payload.declared_lineage.authorized_import_scope == authority.scope.grant, "binding scope mismatch")
    pins = {ProducerKind.RUN_SETUP: payload.trusted_runtime, ProducerKind.SUPERVISOR: payload.trusted_runtime,
            ProducerKind.BROKER: payload.gateway_identity, ProducerKind.TRUSTED_ADAPTER: payload.adapters,
            ProducerKind.TRUSTED_SCORER: payload.scorer}
    for kind, identity in authority.producers.items():
        if kind in pins:
            _require(identity.implementation == pins[kind], "producer implementation is not bound")
    _require(all(type(value) is int and value >= 0 for value in (
        payload.limits.tokens, payload.limits.model_calls, payload.limits.wall_seconds)), "invalid budget limits")
    revision = RevisionId(frame.envelope.record_id)
    return replace(state, binding=payload, active_bundle=payload.initial_bundle, active_revision=revision,
                   revisions=((revision, payload.initial_bundle),), environment=payload.initial_environment)


def _authorize(state: VerifiedState, payload: EffectAuthorization, frame: Frame, objects: ObjectReader) -> VerifiedState:
    envelope, causal = frame.envelope, frame.envelope.causal_identity
    _require(state.execution_status is ExecutionStatus.CONTINUE and not state.dispatch_stopped, "dispatch is stopped")
    _require(payload.execution_epoch == frame.epoch, "stale authorization epoch")
    _require(payload.executing_bundle == state.active_bundle, "authorization bundle is not active")
    _require(payload.permitted_scope == envelope.access_scope, "authorization scope mismatch")
    _require(causal.effect_id == payload.effect_id and causal.command_id == payload.command_id
             and causal.invocation_id is not None, "authorization causation mismatch")
    existing = next((effect for effect in state.effects if effect.authorization.effect_id == payload.effect_id), None)
    if existing is not None:
        prior = existing.authorization
        _require(prior.dispatch_stage is DispatchStage.HARNESS_LAUNCH and payload.dispatch_stage is DispatchStage.UPSTREAM_FORWARD
                 and existing.state in {EffectState.AUTHORIZED_RESERVED, EffectState.DISPATCHED}
                 and prior.execution_epoch == payload.execution_epoch,
                 "duplicate effect authorization or illegal dispatch stage")
        _require(replace(payload, dispatch_stage=prior.dispatch_stage,
                         actual_provider_request_reference=prior.actual_provider_request_reference) == prior,
                 "stage authorization changed execution identity or reservation")
        _require(causal.parent_record == existing.last_record_id and causal.invocation_id == existing.invocation_id,
                 "stage authorization causation mismatch")
        return _replace_effect(state, replace(existing, authorization=payload, last_record_id=envelope.record_id))
    _require(all(effect.state is EffectState.CONSUMED for effect in state.effects), "serial execution has an outstanding effect/result")
    _require(all(effect.authorization.command_id != payload.command_id for effect in state.effects), "command already authorized")
    amounts = _amounts(payload.reservation.components)
    _require(not (Resource.TOKENS in amounts and ({Resource.INPUT_TOKENS, Resource.OUTPUT_TOKENS} & amounts.keys())),
             "overlapping token reservations")
    if state.pending_command is not None:
        command = decode(objects.read(state.pending_command))
        _require(isinstance(command, ExecuteEffect) and command.operation == payload.operation
                 and command.request == payload.exact_request_reference
                 and state.pending_command_id == payload.command_id, "authorization differs from pending command")
        _require(any(record.envelope.record_id == causal.parent_record and isinstance(record.payload, ContinuationCommit)
                        and record.payload.pending_command_reference == state.pending_command for record in state.records),
                 "authorization has no accepting continuation")
    _check_budget(state, payload.reservation.components)
    _transition(EffectState.ACCEPTED, EffectState.AUTHORIZED_RESERVED)
    assert causal.invocation_id is not None
    effect = EffectView(payload, EffectState.AUTHORIZED_RESERVED, envelope.record_id, causal.invocation_id,
                        obligations=payload.reservation.components)
    return replace(state, effects=state.effects + (effect,), pending_command=None, pending_command_id=None)


def _settle(effect: EffectView, payload: EffectObservationSettlement) -> EffectView:
    bounds = _amounts(effect.authorization.reservation.components)
    measured, obligations = _amounts(effect.measured), _amounts(effect.obligations)
    seen: set[Resource] = set()
    for usage in payload.usage:
        quantity = usage.quantity
        remaining = usage.remaining_obligation
        resource = quantity.resource if quantity is not None else remaining.resource if remaining is not None else None
        _require(resource is not None and resource in bounds and resource not in seen, "unknown or duplicate usage component")
        assert resource is not None
        seen.add(resource)
        if remaining is not None:
            _require(remaining.resource is resource, "obligation resource mismatch")
        if usage.kind is UsageKind.MEASURED:
            assert quantity is not None
            _require(quantity.quantity >= measured.get(resource, 0), "measured usage cannot disappear")
            measured[resource] = quantity.quantity
            obligations[resource] = remaining.quantity if remaining is not None else 0
            _require(obligations[resource] <= max(0, bounds[resource] - measured[resource]), "obligation exceeds remaining bound")
        else:
            held = remaining.quantity if usage.kind is UsageKind.UNKNOWN and remaining is not None else quantity.quantity if quantity is not None else -1
            _require(held == obligations.get(resource, 0), "unknown usage cannot erase or expand its obligation")
            _require(usage.kind is not UsageKind.RESERVED or remaining is None, "reserved usage must not duplicate an obligation")
    if payload.usage_completeness is UsageCompleteness.COMPLETE:
        _require(all(resource in measured and not obligations.get(resource, 0) for resource in bounds), "complete usage omits reserved components")
    elif payload.usage_completeness is UsageCompleteness.NOT_APPLICABLE:
        _require(not bounds and not payload.usage, "reserved usage cannot be not_applicable")
    elif payload.usage_completeness is UsageCompleteness.MISSING:
        _require(not measured and any(obligations.values()), "missing usage must retain obligations")
    else:
        _require(any(obligations.values()), "partial usage requires an obligation")
    if payload.reservation_disposition is ReservationDisposition.RELEASE:
        _require(not any(obligations.values()) and payload.usage_completeness in {UsageCompleteness.COMPLETE, UsageCompleteness.NOT_APPLICABLE},
                 "release has unresolved obligations")
    elif payload.reservation_disposition is ReservationDisposition.RETAIN:
        _require(_quantities(measured, include_zero=True) == effect.measured and _quantities(obligations) == _quantities(_amounts(effect.obligations)),
                 "retain cannot book usage or change reservations")
    overruns = {resource: amount - bounds[resource] for resource, amount in measured.items() if amount > bounds[resource]}
    _require(_amounts(payload.overrun) == overruns, "overrun must report exact excess above reservation")
    return replace(effect, measured=_quantities(measured, include_zero=True), obligations=_quantities(obligations), overrun=_quantities(overruns))


def _observe(state: VerifiedState, payload: EffectObservationSettlement, frame: Frame) -> VerifiedState:
    effect = state.effect(payload.effect_id)
    causal = frame.envelope.causal_identity
    _require(payload.execution_epoch == frame.epoch, "stale observation epoch")
    _require(causal.effect_id == payload.effect_id and causal.command_id == effect.authorization.command_id
             and causal.invocation_id == effect.invocation_id and causal.parent_record == effect.last_record_id,
             "observation causation mismatch")
    _require(payload.dispatch_stage is effect.authorization.dispatch_stage, "unauthorized dispatch stage")
    if frame.epoch != effect.authorization.execution_epoch:
        _require(bool(payload.reconciliation_references or payload.gateway_reconciliation_references)
                 and payload.state is not EffectState.DISPATCHED, "new epoch requires explicit reconciliation")
    late = payload.state is effect.state and effect.state in {EffectState.SETTLED, EffectState.CONSUMED}
    if late:
        _require(bool(payload.reconciliation_references or payload.gateway_reconciliation_references), "late accounting requires reconciliation evidence")
        _require(payload.response_reference == effect.response and payload.outcome_status == effect.outcome, "late accounting cannot change a result")
        _require(payload.observed_environment_version in {None, state.environment}, "late accounting cannot rewind environment")
        updated = _settle(effect, payload)
        _require((updated.measured, updated.obligations) != (effect.measured, effect.obligations), "duplicate settlement")
    else:
        _require(state.execution_status is not ExecutionStatus.FINISHED, "finished execution only permits late accounting")
        _require(payload.state in {EffectState.DISPATCHED, EffectState.RETURNED, EffectState.UNCERTAIN, EffectState.SETTLED},
                 "observations cannot consume results or authorize effects")
        if payload.state is EffectState.SETTLED and effect.state is not EffectState.RETURNED:
            # The frozen record groups observation + settlement. A combined record
            # folds both legal edges; it does not add a shortcut to the lifecycle.
            _transition(effect.state, EffectState.RETURNED)
            _transition(EffectState.RETURNED, EffectState.SETTLED)
        else:
            _transition(effect.state, payload.state)
        expected_outcomes = {
            EffectState.DISPATCHED: {OutcomeStatus.DISPATCHED},
            EffectState.UNCERTAIN: {OutcomeStatus.UNCERTAIN},
            EffectState.RETURNED: {OutcomeStatus.RETURNED, OutcomeStatus.FAILED},
            EffectState.SETTLED: {OutcomeStatus.RETURNED, OutcomeStatus.FAILED},
        }
        _require(payload.outcome_status in expected_outcomes[payload.state], "outcome/state mismatch")
        if payload.state in {EffectState.RETURNED, EffectState.SETTLED}:
            _require(payload.outcome_status is OutcomeStatus.FAILED or payload.response_reference is not None,
                     "returned outcome requires response bytes")
            _require(effect.result is None or (payload.response_reference == effect.response and payload.outcome_status == effect.outcome),
                     "settlement changed recorded result")
            cursor = effect.result or ResultCursor(payload.effect_id, frame.envelope.record_id)
        else:
            _require(payload.response_reference is None, "nonreturn has a result")
            cursor = None
        updated = replace(effect, state=payload.state, result=cursor, response=payload.response_reference, outcome=payload.outcome_status)
        if payload.state is EffectState.SETTLED:
            updated = _settle(updated, payload)
        else:
            _require(payload.reservation_disposition is ReservationDisposition.RETAIN and not payload.overrun,
                     "unsettled effect must retain its reservation")
            # Preserve measurements as evidence until an explicit/combined settlement.
            _require(not payload.usage or payload.state is EffectState.RETURNED, "dispatch/uncertainty cannot book usage")
    updated = replace(updated, last_record_id=frame.envelope.record_id)
    result = _replace_effect(state, updated)
    if payload.observed_environment_version is not None:
        result = replace(result, environment=payload.observed_environment_version)
    return replace(result, dispatch_stopped=state.dispatch_stopped or bool(updated.overrun))


def _activate(state: VerifiedState, payload: RevisionActivation, frame: Frame, objects: ObjectReader) -> VerifiedState:
    _require(state.execution_status is not ExecutionStatus.FINISHED, "cannot activate after finish")
    _require(payload.previous_bundle == state.active_bundle and payload.expected_active_revision == state.active_revision,
             "revision/bundle continuity mismatch")
    # The supervisor's operator entry point retains the RestoreBundle itself.
    # This single record changes only bundle identity, even with pending effects.
    if state.execution_status is ExecutionStatus.SUSPENDED:
        boundary = decode(objects.read(payload.activation_boundary))
        if isinstance(boundary, RestoreBundle):
            _require(boundary.prior_bundle == payload.next_bundle
                     and boundary.expected_active_revision == state.active_revision
                     and boundary.controller_state is None
                     and payload.coupled_controller_state_reference is None,
                     "suspended restoration cannot migrate state or change request")
            _require(payload.next_bundle in {bundle for _, bundle in state.revisions},
                     "restoration requires a previously active bundle")
            revision = RevisionId(frame.envelope.record_id)
            return replace(state, active_bundle=payload.next_bundle, active_revision=revision,
                           revisions=state.revisions + ((revision, payload.next_bundle),))
    _require(all(effect.state in {EffectState.SETTLED, EffectState.CONSUMED} for effect in state.effects),
             "activation requires a legal operation boundary")
    if state.pending_command is not None:
        command = decode(objects.read(state.pending_command))
        _require(isinstance(command, (ApplyChange, RestoreBundle)), "activation would lose a pending command")
        assert isinstance(command, (ApplyChange, RestoreBundle))
        next_bundle = command.next_bundle if isinstance(command, ApplyChange) else command.prior_bundle
        _require(next_bundle == payload.next_bundle and command.expected_active_revision == payload.expected_active_revision
                 and command.controller_state == payload.coupled_controller_state_reference
                 and frame.envelope.causal_identity.command_id == state.pending_command_id,
                 "activation differs from pending command")
        _require(any(record.envelope.record_id == frame.envelope.causal_identity.parent_record
                     and isinstance(record.payload, ContinuationCommit)
                     and record.payload.pending_command_reference == state.pending_command for record in state.records),
                 "activation has no accepting continuation")
    private_state = state.private_state
    if payload.coupled_controller_state_reference is not None:
        _require(all(effect.state is EffectState.CONSUMED for effect in state.effects), "controller replacement has an unconsumed result")
        private_state = objects.read(payload.coupled_controller_state_reference)
    revision = RevisionId(frame.envelope.record_id)
    return replace(state, active_bundle=payload.next_bundle, active_revision=revision,
                   revisions=state.revisions + ((revision, payload.next_bundle),), private_state=private_state,
                   pending_command=None, pending_command_id=None)


def _continue(state: VerifiedState, payload: ContinuationCommit, frame: Frame, objects: ObjectReader) -> VerifiedState:
    _require(state.execution_status is not ExecutionStatus.FINISHED, "execution already finished")
    _require(payload.executing_bundle == state.active_bundle, "continuation bundle is not active")
    _require(payload.environment_reference == state.environment, "continuation rewinds or invents environment")
    _require(frame.envelope.causal_identity.invocation_id is not None, "continuation requires invocation identity")
    _require(state.pending_command is None, "continuation would lose a pending command")
    cursor = payload.consumed_result_cursor
    if cursor is not None:
        _require(cursor not in state.consumed_results, "result already consumed")
        effect = state.effect(cursor.effect_id)
        _require(effect.result == cursor, "result cursor does not name the recorded return")
        _transition(effect.state, EffectState.CONSUMED)
        state = _replace_effect(state, replace(effect, state=EffectState.CONSUMED))
        state = replace(state, consumed_results=state.consumed_results | {cursor})
    unresolved = any(effect.state is not EffectState.CONSUMED for effect in state.effects)
    if unresolved or state.dispatch_stopped:
        _require(payload.execution_status in {ExecutionStatus.SUSPENDED, ExecutionStatus.FINISHED}
                 and payload.pending_command_reference is None, "unresolved execution requires suspension")
    if payload.execution_status is ExecutionStatus.FINISHED:
        _require(not unresolved and payload.pending_command_reference is None, "finish cannot discard pending work/result")
    if payload.execution_status is ExecutionStatus.CONTINUE:
        _check_budget(state)
    command_id = frame.envelope.causal_identity.command_id
    if payload.pending_command_reference is not None:
        _require(payload.execution_status is ExecutionStatus.CONTINUE and command_id is not None, "pending command requires a continuing invocation/command identity")
        command = decode(objects.read(payload.pending_command_reference))
        _require(isinstance(command, get_args(Command.__value__)), "pending artifact is not a canonical command")
        for reference in references(command):
            _read(objects, reference)
    return replace(state, private_state=payload.private_state, environment=payload.environment_reference,
                   pending_command=payload.pending_command_reference, pending_command_id=command_id if payload.pending_command_reference else None,
                   execution_status=payload.execution_status)


def _measure(state: VerifiedState, payload: Measurement, authority: Authority) -> VerifiedState:
    assert state.binding is not None
    _require(payload.subject_run == authority.run_id and payload.scorer_version == state.binding.scorer, "measurement subject/scorer mismatch")
    _require(set(payload.revision_references) <= {revision for revision, _ in state.revisions}, "unknown measured revision")
    planned, admitted, completed = map(set, (payload.planned_coverage, payload.admitted_coverage, payload.completed_coverage))
    excluded = {item.subject for item in payload.exclusions}
    _require(len(planned) == len(payload.planned_coverage) and len(admitted) == len(payload.admitted_coverage)
             and len(completed) == len(payload.completed_coverage) and len(excluded) == len(payload.exclusions)
             and completed <= admitted <= planned and excluded <= planned and not excluded & completed,
             "inconsistent measurement coverage")
    return replace(state, measurements=state.measurements + (payload,))


def _read(objects: ObjectReader, reference: ArtifactRef) -> bytes:
    data = objects.read(reference)
    _require(content_ref(data) == reference, f"corrupted artifact {reference.digest}")
    return data


def preflight(state: VerifiedState, frame: Frame, objects: ObjectReader, authority: Authority) -> VerifiedState:
    """Check one transition against an already-verified immutable prefix.

    Returns a new state. Neither successful nor failed checks write anything.
    Epoch/path are authenticated transport fields, not a fork of Envelope.
    """
    # Validate in-memory callers to the same standard as disk input.
    _require(Frame.from_bytes(frame.to_bytes()) == frame, "invalid frame")
    authority.verify(frame)
    envelope = frame.envelope
    _require(envelope.sequence == len(state.records), "nonmonotonic sequence")
    _require(frame.epoch >= state.epoch, "stale execution epoch")
    _require(envelope.integrity_linkage.previous_record_digest == state.head, "broken hash chain")
    _require(envelope.integrity_linkage.record_digest == record_digest(envelope, frame.epoch, frame.append_path), "record digest mismatch")
    known = {record.envelope.record_id: record for record in state.records}
    _require(envelope.record_id not in known, "duplicate record identity")
    causal = envelope.causal_identity
    if not state.records:
        _require(causal.parent_record is None and causal.effect_id is None and causal.command_id is None and causal.invocation_id is None,
                 "initial binding has a cause")
    else:
        _require(causal.parent_record in known, "missing/future causal parent")
        _require(state.binding is not None, "run is unbound")
    payload = decode(_read(objects, envelope.payload_reference))
    _require(isinstance(payload, (RunBinding, EffectAuthorization, EffectObservationSettlement, Measurement, RevisionActivation, ContinuationCommit, Annotation)), "artifact is not a record payload")
    assert isinstance(payload, (RunBinding, EffectAuthorization, EffectObservationSettlement, Measurement, RevisionActivation, ContinuationCommit, Annotation))
    _require(state.binding is not None or isinstance(payload, RunBinding), "RunBinding must be first")
    expected_class = payload.record_class if not isinstance(payload, Annotation) else RecordClass.ANNOTATION
    _require(envelope.record_class is expected_class, "envelope record class does not match payload")
    record = Record(envelope, payload)
    for reference in references(payload) | {envelope.producer_identity.implementation, envelope.access_scope.grant}:
        _read(objects, reference)
    if isinstance(payload, RunBinding):
        result = _binding(state, payload, frame, authority)
    elif isinstance(payload, EffectAuthorization):
        result = _authorize(state, payload, frame, objects)
    elif isinstance(payload, EffectObservationSettlement):
        result = _observe(state, payload, frame)
    elif isinstance(payload, RevisionActivation):
        result = _activate(state, payload, frame, objects)
    elif isinstance(payload, ContinuationCommit):
        result = _continue(state, payload, frame, objects)
    elif isinstance(payload, Measurement):
        result = _measure(state, payload, authority)
    else:
        result = state  # Annotation payload bytes have no protocol meaning.
    return replace(result, records=state.records + (record,), epoch=frame.epoch)


def replay(journal: JournalReader, objects: ObjectReader, authority: Authority) -> VerifiedState:
    """Verify and reconstruct recorded history without any external execution."""
    state = VerifiedState()
    for frame in journal.frames():
        state = preflight(state, frame, objects, authority)
    return state


def verify(journal: JournalReader, objects: ObjectReader, authority: Authority) -> VerifiedState:
    return replay(journal, objects, authority)
