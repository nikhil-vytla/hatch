"""Trusted generic episode scheduling and Measurement production.

Pending tool batches/cursors live in adapter snapshots. Each operation is one
supervisor command; resume settles it before the driver selects another action.
"""
from collections.abc import Mapping
from dataclasses import dataclass

from ..codec import decode, encode, references
from ..contracts.commands import Continue, ExecuteEffect, StepOutput
from ..contracts.lifecycle import EffectState
from ..contracts.harness import GenerationInput
from ..contracts.primitives import ArtifactRef, EpisodeId, ExecutionStatus, TrajectoryId, ModelRole
from ..contracts.records import CausalIdentity, EffectObservationSettlement, Measurement, ProducerKind
from ..errors import VerificationError
from ..runtime.admission import ArtifactProvenance
from ..runtime.broker import EffectRequest
from ..runtime.supervisor import Supervisor
from .api import BenchmarkAdapter, CapturedGeneration, EpisodeSnapshot, OperationReceipt, RewardResult, ScoringInput, TaskSpec, ToolInvocation, UserTurnPlan
from .bridge import OperationRequest
from .payloads import dumps, loads


@dataclass(frozen=True)
class EpisodeAssignment:
    episode: EpisodeId
    task: TaskSpec
    grouping: ArtifactRef
    planned: tuple[str, ...]


class EpisodeDriver:
    def __init__(self, supervisor: Supervisor, adapter: BenchmarkAdapter, assignment: EpisodeAssignment,
                 routes: Mapping[str, tuple[str, str]], provenance: ArtifactProvenance | None = None) -> None:
        self.supervisor, self.adapter, self.assignment = supervisor, adapter, assignment
        self.routes, self.provenance = dict(routes), provenance
        if assignment.task not in adapter.enumerate_tasks() or assignment.task.task_id not in assignment.planned:
            raise VerificationError("episode assignment not in trusted workload")
        self.objects = supervisor.writer.objects
        self.assignment_ref = self.objects.publish(dumps(("episode-assignment/1", assignment.episode, assignment.task,
                                                         assignment.grouping, assignment.planned)))

    def perform(self, operation: OperationRequest) -> None:
        state = self.supervisor.writer.reader.verify()
        if (state.execution_status is not ExecutionStatus.CONTINUE or state.pending_command is not None
                or operation.current != state.environment or operation.episode != self.assignment.episode):
            raise VerificationError("episode is not ready for a new operation")
        if operation.operation == "initialize" and operation.values[0] != self.assignment.task:
            raise VerificationError("initialization task differs from assignment")
        if operation.operation == "user_turn":
            plan, capture = operation.values
            assert isinstance(plan, UserTurnPlan) and isinstance(capture, CapturedGeneration)
            effect = state.effect(capture.result_cursor.effect_id)
            envelope = decode(self.objects.read(effect.authorization.generation_envelope)) if effect.authorization.generation_envelope else ()
            if (effect.result != capture.result_cursor or effect.response != capture.response
                    or effect.authorization.operation != "model.generate" or capture.request != plan.generation_input
                    or capture.request not in effect.authorization.input_references
                    or not isinstance(envelope, tuple) or not any(isinstance(v, GenerationInput) and v.role is ModelRole.USER for v in envelope)):
                raise VerificationError("user turn lacks authenticated user-model capture")
        binding, destination = self.routes[operation.operation]
        scope = self.supervisor.writer.reader.authority.scope
        arguments = self.objects.publish(operation.to_bytes())
        if self.provenance is not None:
            assert state.environment is not None
            self.provenance.publish(operation.to_bytes(), scope, self.assignment_ref, state.environment)
            for reference in references(operation.values):
                self.provenance.publish(self.objects.read(reference), scope, self.assignment_ref, state.environment, purpose="operand")
        request = self.objects.publish(EffectRequest(destination, arguments, scope).to_bytes())
        command = ExecuteEffect("benchmark." + operation.operation, binding, request)
        self.supervisor.accept(StepOutput(command, state.private_state), expected_head=state.head)
        self.supervisor.drive()

    def consume(self) -> None:
        state = self.supervisor.state
        self.supervisor.accept(StepOutput(Continue(), state.private_state), expected_head=state.head)

    def drain_user_tools(self) -> None:
        """Resume the captured batch from authenticated operation receipts.

        The accepted command and resulting snapshot are the durable cursor. A
        crash after mutation is reconciled before another tool is selected.
        """
        self.supervisor.recover()
        if self.supervisor.state.execution_status is not ExecutionStatus.CONTINUE:
            return
        if any(e.state is EffectState.SETTLED for e in self.supervisor.state.effects):
            self.consume()
        receipts = self.receipts()
        positions = [i for i, (_, receipt) in enumerate(receipts)
                     if OperationRequest.read(self.objects.read(receipt.arguments)).operation == "user_turn"]
        if not positions:
            return
        position = positions[-1]
        batch = loads(self.objects.read(receipts[position][1].output), tuple)
        if len(batch) != 3 or batch[0] != "user-turn/1" or not isinstance(batch[2], tuple) or not all(isinstance(c, ToolInvocation) for c in batch[2]):
            raise VerificationError("invalid captured user batch")
        completed = [OperationRequest.read(self.objects.read(receipt.arguments)) for _, receipt in receipts[position + 1:]]
        if any(op.operation != "user_tool" or op.values != (batch[2][i],) for i, op in enumerate(completed)):
            raise VerificationError("user batch cursor differs from captured calls")
        for call in batch[2][len(completed):]:
            current = self.supervisor.state.environment
            assert current is not None
            before = loads(self.objects.read(current), EpisodeSnapshot)
            self.perform(OperationRequest(before.episode, before.environment, current, before, "user_tool", (call,)))
            self.consume()

    def receipts(self) -> tuple[tuple[ArtifactRef, OperationReceipt], ...]:
        state = self.supervisor.writer.reader.verify()
        result: list[tuple[ArtifactRef, OperationReceipt]] = []
        for effect in state.effects:
            if effect.authorization.adapter != self.adapter.identity or not effect.authorization.operation.startswith("benchmark."):
                continue
            if effect.state not in {EffectState.SETTLED, EffectState.CONSUMED}:
                raise VerificationError("episode has an unresolved operation")
            observed = next((record.payload for record in state.records if isinstance(record.payload, EffectObservationSettlement)
                             and record.payload.effect_id == effect.authorization.effect_id and record.payload.receipt_references), None)
            if observed is None:
                raise VerificationError("missing authenticated operation receipt")
            receipt_ref = observed.receipt_references[0]
            receipt = loads(self.objects.read(receipt_ref), OperationReceipt)
            if receipt.after.episode != self.assignment.episode:
                continue
            if (receipt.exact_request != effect.authorization.exact_request_reference
                    or receipt.effect_id != effect.authorization.effect_id or receipt.output != effect.response
                    or receipt.original_epoch != effect.authorization.execution_epoch):
                raise VerificationError("receipt differs from verified effect history")
            result.append((receipt_ref, receipt))
        return tuple(result)

    def score(self) -> RewardResult:
        state = self.supervisor.writer.reader.verify()
        receipts = self.receipts()
        if not receipts or state.environment is None:
            raise VerificationError("no completed episode")
        final = loads(self.objects.read(state.environment), EpisodeSnapshot)
        if final != receipts[-1][1].after:
            raise VerificationError("scoring requires the actual committed final state")
        operations = [OperationRequest.read(self.objects.read(r.arguments)) for _, r in receipts]
        if operations[0].operation != "initialize" or operations[0].values[0] != self.assignment.task:
            raise VerificationError("scoring task differs from authenticated initialization")
        if operations[-1].operation != "terminate":
            raise VerificationError("episode has no authenticated termination")
        termination = operations[-1].values[0]
        assert isinstance(termination, ArtifactRef)
        interaction = self.objects.publish(dumps(tuple(r for _, r in receipts)))
        inputs = ScoringInput(self.assignment.task, final, interaction, tuple(ref for ref, _ in receipts), termination)
        reward = self.adapter.scorer.score(inputs)
        if reward.exact_reward_definition != self.assignment.task.reward_definition:
            raise VerificationError("scorer changed the reward definition")
        if reward.status != "scored":
            if reward.metrics:
                raise VerificationError("unresolved/invalid reward cannot fabricate a score")
            return reward
        descriptor = self.adapter.describe()
        if self.adapter.scorer.identity != descriptor.scorer or state.binding is None or state.binding.scorer != descriptor.scorer:
            raise VerificationError("scorer identity differs from run binding")
        for metric in reward.metrics:
            measurement = Measurement(self.supervisor.writer.reader.authority.scope.run_id, self.assignment_ref,
                tuple(revision for revision, _ in state.revisions), descriptor.workload, descriptor.scorer,
                inputs.operation_receipts, (*tuple(r.after.state for _, r in receipts), interaction, *reward.evidence), self.assignment.planned,
                (self.assignment.task.task_id,), (self.assignment.task.task_id,), (), metric.identity, metric.value,
                descriptor.upstream_revision, self.assignment.grouping, self.assignment.episode,
                TrajectoryId(interaction.digest), receipts[0][0], reward.exact_reward_definition)
            self.supervisor.writer.port(ProducerKind.TRUSTED_SCORER).append(measurement,
                causal=CausalIdentity(state.records[-1].envelope.record_id, None, None, None), epoch=self.supervisor.writer.epoch)
            state = self.supervisor.writer.reader.verify()
        self.supervisor.state = state
        return reward
