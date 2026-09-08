"""Serial execution, durable acceptance, settlement and crash recovery."""

from collections.abc import Callable
from dataclasses import replace
from enum import StrEnum
import json
import math
import threading
import time

from ..codec import decode, encode
from ..contracts.annotations import Annotation
from ..contracts.commands import ApplyChange, AuthorizedView, Continue, EvaluateFork, ExecuteEffect, Finish, RecordedResult, RestoreBundle, StepOutput, Suspend
from ..contracts.lifecycle import DispatchStage, EffectState, RecoveryCapability, RecoveryContract
from ..contracts.primitives import ArtifactRef, CommandId, EffectId, ExecutionStatus, InvocationId, ResultCursor, ScopedArtifact, EnvironmentId, Reservation, Resource, ResourceQuantity
from ..contracts.records import (
    CausalIdentity, ContinuationCommit, EffectAuthorization, EffectObservationSettlement,
    OutcomeStatus, ProducerKind, RecordPayload, ReservationDisposition,
    RevisionActivation, UsageCompleteness, UsageProvenance,
)
from ..errors import VerificationError
from ..store import RunWriter
from ..verify.engine import EffectView
from .broker import CapabilityBroker, DispatchContext, EffectAdapter, Receipt
from .ledger import BudgetLedger
from .sandbox import CandidateSandbox


class Boundary(StrEnum):
    ACCEPTED = "accepted"
    AUTHORIZED = "authorized"
    DISPATCH = "dispatch"
    EXTERNAL_RETURN = "external_return"
    RETURN_RECORDED = "return_recorded"
    SETTLED = "settled"
    CONTINUATION = "continuation"
    UPSTREAM_AUTHORIZED = "upstream_authorized"
    ACTIVATED = "activated"


def _no_fault(boundary: Boundary) -> None:
    pass


class Supervisor:
    """One owner of a RunWriter. Public methods reject concurrent/reentrant use.

    Returned candidate bytes are data. The trusted caller supplies expected_head,
    never an identity extracted from candidate output. Every authority append
    uses M2 ProducerPort.append, which runs preflight before its durable commit.
    """

    def __init__(self, writer: RunWriter, broker: CapabilityBroker,
                 fault: Callable[[Boundary], None] = _no_fault,
                 compatible_bundle: Callable[[ArtifactRef], bool] | None = None,
                 sandbox: CandidateSandbox | None = None) -> None:
        self.writer, self.broker, self.fault = writer, broker, fault
        self._lock = threading.Lock()
        self._compatible_bundle = compatible_bundle
        self._sandbox = sandbox
        self.state = writer.reader.verify()
        if self.state.binding is None or self.state.binding.capabilities != broker.policy_reference:
            raise VerificationError("runtime requires the bound capability policy")

    def _enter(self) -> None:
        if not self._lock.acquire(blocking=False):
            raise VerificationError("supervisor already executing")
        try:
            self.writer._check_lease(self.writer.epoch)
            self.state = self.writer.reader.verify()
        except BaseException:
            self._lock.release()
            raise

    def _append(self, payload: RecordPayload, kind: ProducerKind, causal: CausalIdentity) -> None:
        self.writer.port(kind).append(payload, causal=causal, epoch=self.writer.epoch)
        self.state = self.writer.reader.verify()

    def _cause(self, command: CommandId | None = None, effect: EffectView | None = None) -> CausalIdentity:
        if effect is not None:
            return CausalIdentity(effect.last_record_id, effect.invocation_id,
                                  effect.authorization.command_id, effect.authorization.effect_id)
        parent = self.state.records[-1].envelope.record_id
        return CausalIdentity(parent, InvocationId(f"{parent}:step"), command, None)

    def _cursor(self) -> ResultCursor | None:
        results = [effect.result for effect in self.state.effects if effect.state is EffectState.SETTLED]
        if len(results) > 1:
            raise VerificationError("multiple outstanding results")
        return results[0] if results else None

    def step(self, sandbox: CandidateSandbox, artifacts: tuple[ScopedArtifact, ...] = ()) -> None:
        """Retain the next sandbox invocation and reserve time before launch.

        The prior result is consumed into a pending runtime.step command holding
        its exact input cursor/bytes. The sandbox result is then consumed with
        the candidate's private state and command. This uses M2's serial protocol
        without an unaccounted computation between externally charged effects.
        """
        self._enter()
        try:
            if (self.state.pending_command is not None or self.state.execution_status is not ExecutionStatus.CONTINUE
                    or self.state.dispatch_stopped or any(e.state not in {EffectState.SETTLED, EffectState.CONSUMED}
                                                         for e in self.state.effects)):
                raise VerificationError("candidate step requires an available continuation")
            scope = self.writer.reader.authority.scope
            permitted = set().union(*(c.inputs for c in self.broker.capabilities))
            if any(item.access_scope != scope or item.reference not in permitted for item in artifacts):
                raise VerificationError("candidate input not permitted")
            assert self.state.active_bundle is not None and self.state.active_revision is not None
            assert self.state.environment is not None
            view = AuthorizedView(artifacts, self.state.active_revision, EnvironmentId(self.state.environment.digest),
                                  self.state.execution_status)
            cursor = self._cursor()
            result = None
            if cursor is not None:
                response = self.state.effect(cursor.effect_id).response
                if response is not None:
                    result = RecordedResult(cursor, ScopedArtifact(response, scope))
            profile = self.writer.objects.publish(sandbox.profile().to_bytes())
            if any(e.authorization.operation == "runtime.step" and e.authorization.reservation.bound_method != profile
                   for e in self.state.effects):
                raise VerificationError("candidate confinement profile changed within run")
            reservation = Reservation((ResourceQuantity(Resource.WALL_MILLISECONDS, sandbox.wall_limit_milliseconds),), profile)
            BudgetLedger.admit(self.state, reservation)
            request = self.writer.objects.publish(encode((view, self.state.private_state, result, profile, reservation)))
            command = ExecuteEffect("runtime.step", "@supervisor", request)
            command_ref = self.writer.objects.publish(encode(command))
            command_id = CommandId(f"{self.state.records[-1].envelope.record_id}:step")
            self._append(ContinuationCommit(self.state.private_state, self.state.active_bundle, cursor, command_ref,
                                            self.state.environment, ExecutionStatus.CONTINUE),
                         ProducerKind.SUPERVISOR, self._cause(command_id))
            self.fault(Boundary.ACCEPTED)
            self._sandbox = sandbox
            self._drive()
        finally:
            self._lock.release()

    def _drive_step(self, command: ExecuteEffect) -> None:
        value = decode(self.writer.objects.read(command.request))
        if not isinstance(value, tuple) or len(value) != 5:
            raise VerificationError("invalid retained sandbox request")
        view, private_state, result, profile, reservation = value
        if (not isinstance(view, AuthorizedView) or not isinstance(private_state, bytes)
                or result is not None and not isinstance(result, RecordedResult)
                or not isinstance(profile, ArtifactRef) or not isinstance(reservation, Reservation)):
            raise VerificationError("invalid retained sandbox inputs")
        sandbox = self._sandbox
        if sandbox is None:
            raise VerificationError("resume requires the pinned candidate sandbox")
        profile_bytes = sandbox.profile().to_bytes()
        if self.writer.objects.read(profile) != profile_bytes or reservation.components != (
                ResourceQuantity(Resource.WALL_MILLISECONDS, sandbox.wall_limit_milliseconds),):
            raise VerificationError("sandbox profile or bound changed on resume")
        BudgetLedger.admit(self.state, reservation)
        assert self.state.pending_command_id is not None and self.state.active_bundle is not None
        assert self.state.binding is not None
        effect_id = EffectId(f"{self.state.pending_command_id}:effect")
        authorization = EffectAuthorization(self.state.pending_command_id, effect_id, command.request,
            self.state.active_bundle, self.state.binding.trusted_runtime, command.operation, view.environment,
            self.writer.reader.authority.scope, reservation,
            RecoveryContract(frozenset({RecoveryCapability.SUSPEND}), False, False), self.writer.epoch,
            DispatchStage.OPERATION, None, None, tuple(item.reference for item in view.artifacts), None)
        self._append(authorization, ProducerKind.SUPERVISOR, replace(self._cause(self.state.pending_command_id), effect_id=effect_id))
        self.fault(Boundary.AUTHORIZED)
        effect = self.state.effect(effect_id)
        self._append(self._observation(effect, EffectState.DISPATCHED, OutcomeStatus.DISPATCHED), ProducerKind.BROKER,
                     self._cause(effect=effect))
        self.fault(Boundary.DISPATCH)
        references = {item.reference for item in view.artifacts}
        if result is not None:
            references.add(result.output.reference)
        started = time.monotonic()
        failure: Exception | None = None
        try:
            output = sandbox.run(self.writer.objects.read(self.state.active_bundle), view, private_state,
                                 result, {ref: self.writer.objects.read(ref) for ref in references})
        except Exception as error:
            failure = error
            output = StepOutput(Suspend("candidate step failed"), private_state)
        elapsed = math.ceil((time.monotonic() - started) * 1000)
        self.fault(Boundary.EXTERNAL_RETURN)
        receipt = Receipt(effect_id, self.writer.epoch, encode(output), encode(("supervisor monotonic wall", elapsed)),
                          (ResourceQuantity(Resource.WALL_MILLISECONDS, elapsed),), provenance=UsageProvenance.TRUSTED_ADAPTER,
                          outcome=OutcomeStatus.FAILED if failure else OutcomeStatus.RETURNED)
        self._record_return(self.state.effect(effect_id), receipt)
        self._settle(self.state.effect(effect_id))
        self._consume_step(self.state.effect(effect_id))
        if failure is not None:
            raise failure

    def _consume_step(self, effect: EffectView) -> None:
        assert effect.response is not None
        output = decode(self.writer.objects.read(effect.response))
        if not isinstance(output, StepOutput):
            raise VerificationError("sandbox response is not StepOutput")
        if self.state.dispatch_stopped:
            output = StepOutput(Suspend("candidate time overrun"), self.state.private_state)
        try:
            self._accept(output, self.state.head)
        except VerificationError:
            # A malformed command is a bounded controller failure. Preserve the
            # already recorded candidate output; consume it into suspension.
            self._accept(StepOutput(Suspend("candidate command rejected"), self.state.private_state), self.state.head)
            raise

    def accept(self, output: StepOutput, *, expected_head: ArtifactRef | None) -> None:
        self._enter()
        try:
            self._accept(output, expected_head)
        finally:
            self._lock.release()

    def _accept(self, output: StepOutput, expected_head: ArtifactRef | None) -> None:
        # Canonical decoding checks runtime types, not just dataclass annotations.
        if not isinstance(decode(encode(output)), StepOutput):
            raise VerificationError("invalid step output")
        if expected_head != self.state.head or self.state.pending_command is not None:
            raise VerificationError("stale step or pending command")
        if self.state.execution_status is ExecutionStatus.FINISHED:
            raise VerificationError("execution already finished")
        if any(e.state not in {EffectState.SETTLED, EffectState.CONSUMED} for e in self.state.effects):
            raise VerificationError("step cannot interpret an unresolved effect")
        command = output.command
        if isinstance(command, ExecuteEffect) and (command.binding == "@supervisor" or command.operation == "runtime.step"):
            raise VerificationError("candidate cannot request supervisor operations")
        if isinstance(command, EvaluateFork):
            raise VerificationError("fork evaluation requires the stateful operation milestone")
        if isinstance(command, ExecuteEffect):
            self.broker.prepare(self.state, command)  # Admission validation, no authority or dispatch.
        if isinstance(command, (ApplyChange, RestoreBundle)):
            bundle = command.next_bundle if isinstance(command, ApplyChange) else command.prior_bundle
            if command.expected_active_revision != self.state.active_revision:
                raise VerificationError("stale bundle revision")
            self.writer.objects.read(bundle)
            if self._compatible_bundle is None or not self._compatible_bundle(bundle):
                raise VerificationError("bundle has not passed trusted compatibility validation")
            if isinstance(command, RestoreBundle) and bundle not in {b for _, b in self.state.revisions}:
                raise VerificationError("restoration requires a previously active bundle")
        status = ExecutionStatus.FINISHED if isinstance(command, Finish) else (
            ExecutionStatus.SUSPENDED if isinstance(command, Suspend) else ExecutionStatus.CONTINUE)
        if self.state.dispatch_stopped and status is ExecutionStatus.CONTINUE:
            raise VerificationError("overrun stops dispatch and continuation")
        pending = None if isinstance(command, (Continue, Suspend, Finish)) else self.writer.objects.publish(encode(command))
        retained = self.writer.objects.publish(encode(output))
        command_id = CommandId(f"{self.state.records[-1].envelope.record_id}:next")
        # The complete StepOutput remains inspectable. Recovery authority is only
        # the atomic continuation, not this diagnostic reference.
        annotation = Annotation("runtime.step_output", json.dumps({"reference": retained.digest}).encode())
        self._append(annotation, ProducerKind.SUPERVISOR, self._cause(command_id))
        for item in output.annotations:
            self._append(item, ProducerKind.CANDIDATE, self._cause(command_id))
        assert self.state.active_bundle is not None and self.state.environment is not None
        self._append(ContinuationCommit(output.proposed_private_state, self.state.active_bundle,
                                        self._cursor(), pending, self.state.environment, status),
                     ProducerKind.SUPERVISOR, self._cause(command_id))
        self.fault(Boundary.CONTINUATION)
        self.fault(Boundary.ACCEPTED)

    def drive(self) -> None:
        """Act on one durable pending command using its pinned adapter."""
        self._enter()
        try:
            self._drive()
        finally:
            self._lock.release()

    def _drive(self) -> None:
        if self.state.pending_command is None:
            return
        command = decode(self.writer.objects.read(self.state.pending_command))
        if isinstance(command, ExecuteEffect) and command.operation == "runtime.step" and command.binding == "@supervisor":
            self._drive_step(command)
            return
        if isinstance(command, (ApplyChange, RestoreBundle)):
            bundle = command.next_bundle if isinstance(command, ApplyChange) else command.prior_bundle
            if self._compatible_bundle is None or not self._compatible_bundle(bundle):
                raise VerificationError("compatible bundle unavailable")
            assert self.state.active_bundle is not None
            self._append(RevisionActivation(self.state.active_bundle, bundle, command.expected_active_revision,
                                            self.state.pending_command, command.controller_state),
                         ProducerKind.SUPERVISOR, self._cause(self.state.pending_command_id))
            self.fault(Boundary.ACTIVATED)
            return
        if not isinstance(command, ExecuteEffect):
            raise VerificationError("unsupported pending command")
        adapter, request, plan = self.broker.prepare(self.state, command)
        assert self.state.pending_command_id is not None and self.state.active_bundle is not None
        command_id = self.state.pending_command_id
        effect_id = EffectId(f"{command_id}:effect")
        cause = self._cause(command_id)
        authorization = EffectAuthorization(
            command_id, effect_id, command.request, self.state.active_bundle, adapter.identity,
            command.operation, plan.environment, request.scope, plan.reservation, plan.recovery,
            self.writer.epoch, plan.stage, plan.harness_binding, plan.generation, request.inputs, plan.actual_request)
        self._append(authorization, ProducerKind.BROKER, replace(cause, effect_id=effect_id))
        self.fault(Boundary.AUTHORIZED)
        effect = self.state.effect(effect_id)
        self._append(self._observation(effect, EffectState.DISPATCHED, OutcomeStatus.DISPATCHED),
                     ProducerKind.BROKER, self._cause(effect=effect))
        self.fault(Boundary.DISPATCH)
        context = DispatchContext(authorization, lambda data: self._upstream(effect_id, data))
        try:
            receipt = adapter.invoke(context, request)
        except Exception:
            # Invocation failures, including malformed/stale returns, prove no
            # nonexecution. Fault injection uses BaseException to model death.
            self._uncertain(self.state.effect(effect_id))
            raise
        self.fault(Boundary.EXTERNAL_RETURN)
        try:
            self._record_return(self.state.effect(effect_id), receipt)
        except VerificationError:
            self._uncertain(self.state.effect(effect_id))
            raise
        self._settle(self.state.effect(effect_id))

    def _adapter_for(self, effect: EffectView) -> EffectAdapter:
        # Recover the binding name from the accepted canonical command. Code
        # identity alone cannot distinguish two instances with different routes.
        for record in self.state.records:
            if (isinstance(record.payload, ContinuationCommit)
                    and record.envelope.causal_identity.command_id == effect.authorization.command_id
                    and record.payload.pending_command_reference is not None):
                command = decode(self.writer.objects.read(record.payload.pending_command_reference))
                if isinstance(command, ExecuteEffect):
                    return self.broker.adapter_for(effect.authorization, command.binding)
        raise VerificationError("effect has no accepted adapter binding")

    def _upstream(self, effect_id: EffectId, data: bytes) -> None:
        effect = self.state.effect(effect_id)
        self._adapter_for(effect).validate_upstream(effect.authorization, data)
        reference = self.writer.objects.publish(data)
        self._append(replace(effect.authorization, dispatch_stage=DispatchStage.UPSTREAM_FORWARD,
                             actual_provider_request_reference=reference), ProducerKind.BROKER, self._cause(effect=effect))
        self.fault(Boundary.UPSTREAM_AUTHORIZED)

    def _reconciliation(self, effect: EffectView, reason: str) -> tuple[ArtifactRef, ...]:
        return (self.writer.objects.publish(encode((effect.authorization.effect_id, effect.authorization.execution_epoch,
                                                   self.writer.epoch, reason))),)

    def _observation(self, effect: EffectView, state: EffectState, outcome: OutcomeStatus) -> EffectObservationSettlement:
        return EffectObservationSettlement(
            effect.authorization.effect_id, self.writer.epoch, state, effect.authorization.dispatch_stage,
            outcome, None, (), None, (), UsageCompleteness.MISSING if effect.obligations else UsageCompleteness.NOT_APPLICABLE,
            ReservationDisposition.RETAIN, (), None, (), None, None, None, None, None, None, ())

    def _record_return(self, effect: EffectView, receipt: Receipt, *, reconciled: bool = False) -> None:
        if receipt.effect_id != effect.authorization.effect_id or receipt.epoch != self.writer.epoch:
            raise VerificationError("stale result identity or epoch")
        if receipt.outcome not in {OutcomeStatus.RETURNED, OutcomeStatus.FAILED}:
            raise VerificationError("receipt does not establish an outcome")
        evidence = self.writer.objects.publish(receipt.evidence)
        output = self.writer.objects.publish(receipt.output)
        accounting = BudgetLedger.settlement(effect, receipt.measured, evidence, receipt.provenance, receipt.remaining)
        payload = replace(self._observation(effect, EffectState.RETURNED, receipt.outcome),
                          response_reference=output, receipt_references=(evidence,),
                          observed_environment_version=receipt.environment,
                          usage=accounting.usage, usage_completeness=accounting.completeness,
                          reconciliation_references=self._reconciliation(effect, "adapter outcome lookup") if reconciled else ())
        self._append(payload, ProducerKind.TRUSTED_ADAPTER, self._cause(effect=effect))
        self.fault(Boundary.RETURN_RECORDED)

    def _settle(self, effect: EffectView) -> None:
        recorded = next(r.payload for r in reversed(self.state.records)
                        if isinstance(r.payload, EffectObservationSettlement) and r.payload.effect_id == effect.authorization.effect_id)
        assert isinstance(recorded, EffectObservationSettlement)
        bounds = {q.resource: q.quantity for q in effect.authorization.reservation.components}
        overrun = tuple(ResourceQuantity(u.quantity.resource, u.quantity.quantity - bounds[u.quantity.resource])
                        for u in recorded.usage if u.quantity is not None and u.quantity.quantity > bounds[u.quantity.resource])
        complete = recorded.usage_completeness in {UsageCompleteness.COMPLETE, UsageCompleteness.NOT_APPLICABLE}
        payload = replace(recorded, state=EffectState.SETTLED, execution_epoch=self.writer.epoch,
                          reservation_disposition=ReservationDisposition.RELEASE if complete else ReservationDisposition.REPLACE_KNOWN_COMPONENTS,
                          overrun=overrun, reconciliation_references=self._reconciliation(effect, "settle retained return"))
        self._append(payload, ProducerKind.BROKER, self._cause(effect=effect))
        self.fault(Boundary.SETTLED)
        if self.state.dispatch_stopped:
            self._suspend()

    def _suspend(self) -> None:
        if self.state.execution_status in {ExecutionStatus.SUSPENDED, ExecutionStatus.FINISHED}:
            return
        if self.state.pending_command is not None:
            # A late overrun must retain an already accepted command. M2 cannot
            # discard it in a suspension; dispatch_stopped is the durable fence.
            return
        assert self.state.active_bundle is not None and self.state.environment is not None
        self._append(ContinuationCommit(self.state.private_state, self.state.active_bundle, None, None,
                                        self.state.environment, ExecutionStatus.SUSPENDED),
                     ProducerKind.SUPERVISOR, self._cause())

    def _uncertain(self, effect: EffectView) -> None:
        if effect.state is not EffectState.UNCERTAIN:
            self._append(replace(self._observation(effect, EffectState.UNCERTAIN, OutcomeStatus.UNCERTAIN),
                                 reconciliation_references=self._reconciliation(effect, "outcome indeterminate")),
                         ProducerKind.BROKER, self._cause(effect=effect))
        self._suspend()

    def recover(self) -> None:
        """Restore bookkeeping; never infer nonexecution from a missing marker."""
        self._enter()
        try:
            if self.state.execution_status is ExecutionStatus.FINISHED:
                return
            for effect in self.state.effects:
                if effect.state is EffectState.CONSUMED:
                    continue
                if effect.state is EffectState.SETTLED:
                    if effect.authorization.operation == "runtime.step":
                        self._consume_step(effect)
                    continue
                if effect.state is EffectState.RETURNED:
                    self._settle(effect)
                    if effect.authorization.operation == "runtime.step":
                        self._consume_step(self.state.effect(effect.authorization.effect_id))
                    continue
                recovery = effect.authorization.recovery_contract
                supported = recovery.capabilities - {RecoveryCapability.SUSPEND}
                # Paid retry requires billing as well as business deduplication.
                if supported == {RecoveryCapability.DEDUPLICATED_RETRY} and not (
                        recovery.billing_deduplication and recovery.business_operation_deduplication):
                    supported = frozenset()
                receipt = None
                if supported:
                    try:
                        receipt = self._adapter_for(effect).reconcile(effect.authorization, self.writer.epoch)
                    except Exception:
                        receipt = None
                if receipt is None:
                    self._uncertain(effect)
                else:
                    try:
                        self._record_return(effect, receipt, reconciled=True)
                    except VerificationError:
                        self._uncertain(effect)
                        raise
                    self._settle(self.state.effect(effect.authorization.effect_id))
            if self.state.dispatch_stopped:
                self._suspend()
            if self.state.execution_status is ExecutionStatus.CONTINUE and not self.state.dispatch_stopped:
                self._drive()
        finally:
            self._lock.release()

    def late_receipt(self, effect_id: EffectId, receipt: Receipt) -> None:
        self._enter()
        try:
            effect = self.state.effect(effect_id)
            if receipt.effect_id != effect_id or receipt.epoch != self.writer.epoch:
                raise VerificationError("stale result identity or epoch")
            if effect.state not in {EffectState.SETTLED, EffectState.CONSUMED}:
                raise VerificationError("late accounting requires a recorded result")
            if (self.writer.objects.publish(receipt.output) != effect.response or receipt.outcome != effect.outcome
                    or receipt.environment not in {None, self.state.environment}):
                raise VerificationError("late receipt cannot change a result or environment")
            evidence = self.writer.objects.publish(receipt.evidence)
            accounting = BudgetLedger.settlement(effect, receipt.measured, evidence, receipt.provenance, receipt.remaining)
            payload = replace(self._observation(effect, effect.state, receipt.outcome), response_reference=effect.response,
                              receipt_references=(evidence,), usage=accounting.usage, usage_completeness=accounting.completeness,
                              reservation_disposition=accounting.disposition, overrun=accounting.overrun,
                              reconciliation_references=self._reconciliation(effect, "late trusted receipt"))
            self._append(payload, ProducerKind.TRUSTED_ADAPTER, self._cause(effect=effect))
            if self.state.dispatch_stopped:
                self._suspend()
        finally:
            self._lock.release()

    def restore(self, bundle: ArtifactRef, *, controller_state: ArtifactRef | None = None) -> None:
        """Operator-only entry point. No broken candidate code is executed."""
        self._enter()
        try:
            assert self.state.active_revision is not None
            self._accept(StepOutput(RestoreBundle(bundle, self.state.active_revision, controller_state),
                                    self.state.private_state), self.state.head)
            self._drive()
        finally:
            self._lock.release()
