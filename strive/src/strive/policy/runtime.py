"""Continual refinement composed exclusively through public M3-M5 interfaces."""
from collections.abc import Callable, Mapping
from dataclasses import dataclass
import base64
import json
from typing import Protocol

from ..benchmarks.api import BenchmarkAdapter, EpisodeSnapshot
from ..benchmarks.bridge import OperationRequest
from ..benchmarks.episodes import EpisodeAssignment, EpisodeDriver
from ..benchmarks.payloads import loads as benchmark_loads
from ..codec import decode, encode
from ..contracts.annotations import Annotation
from ..contracts.bindings import ModelBinding
from ..contracts.commands import ApplyChange, Continue, ExecuteEffect, StepOutput, Suspend
from ..contracts.harness import GenerationInput
from ..contracts.feedback import EvidencePool
from ..contracts.lifecycle import EffectState
from ..contracts.primitives import ArtifactRef, EnvironmentId, ExecutionStatus, ModelRole, ResourceQuantity, ScopedArtifact
from ..contracts.records import ContinuationCommit, OutcomeStatus, RevisionActivation
from ..errors import VerificationError
from ..runtime.admission import ArtifactProvenance
from ..runtime.broker import EffectRequest
from ..runtime.supervisor import Supervisor
from .bundles import BundleManager
from .data import Origin, Proposal, dumps, loads
from .evidence import EvidenceSelector
from .refiner import SCHEMA
from .sandbox import BundleSandbox


class EpisodeProgram(Protocol):
    """Pinned workload translation, with candidate actions supplied as bytes."""
    def initialization(self, assignment: EpisodeAssignment) -> ArtifactRef: ...
    def operation(self, snapshot: EpisodeSnapshot, current: ArtifactRef, action: bytes) -> OperationRequest: ...


@dataclass(frozen=True)
class RefinerRoute:
    binding: str
    destination: str
    model: ModelBinding[ArtifactRef]
    limits: tuple[ResourceQuantity, ...]


class ContinualRefine:
    def __init__(self, supervisor: Supervisor, bundles: BundleManager, sandbox: BundleSandbox,
                 evidence: EvidenceSelector, provenance: ArtifactProvenance, refiner: RefinerRoute,
                 *, interval: int = 1, max_episode_steps: int = 32,
                 development_check: Callable[[Proposal], bool] | None = None) -> None:
        if min(interval, max_episode_steps) < 1:
            raise ValueError("positive policy bounds required")
        self.supervisor, self.bundles, self.sandbox = supervisor, bundles, sandbox
        self.evidence, self.provenance, self.refiner = evidence, provenance, refiner
        self.interval, self.max_episode_steps, self.development_check = interval, max_episode_steps, development_check
        self.objects = supervisor.writer.objects
        state = supervisor.writer.reader.verify()
        assert state.binding is not None
        if frozenset(state.binding.editable_scope) != bundles.editable:
            raise VerificationError("policy editable scope differs from run binding")
        if not any(model.name == "refiner" and model.binding == refiner.model for model in state.binding.model_bindings):
            raise VerificationError("refiner model differs from run binding")
        bundles.state = supervisor.writer.reader.verify

    def _accept(self, command: ApplyChange | Continue | Suspend | ExecuteEffect,
                annotations: tuple[Annotation, ...] = ()) -> None:
        state = self.supervisor.state
        self.supervisor.accept(StepOutput(command, state.private_state, annotations), expected_head=state.head)

    def activate(self, proposal: Proposal, origins: tuple[Origin, ...] = ()) -> ArtifactRef:
        command = self.bundles.build(proposal, self.supervisor.writer.reader.verify(), origins)
        self._accept(command)
        self.supervisor.drive()
        return command.next_bundle

    def _done(self, effect_id: str) -> bool:
        state = self.supervisor.state
        # A diagnostic choice only counts for scheduling when its associated
        # continuation committed. It never authorizes a revision or an effect.
        markers = set()
        for record in state.records:
            if not isinstance(record.payload, Annotation) or record.payload.namespace != "policy.decision":
                continue
            payload = json.loads(record.payload.payload)
            if isinstance(payload, dict) and payload.get("effect") == effect_id:
                markers.add(record.envelope.causal_identity.command_id)
        return any(isinstance(r.payload, ContinuationCommit) and r.envelope.causal_identity.command_id in markers
                   for r in state.records)

    def refine(self, checkpoint: str) -> str:
        self.supervisor.recover()
        state = self.supervisor.state
        if state.execution_status is not ExecutionStatus.CONTINUE:
            return "suspended"
        scope = self.supervisor.writer.reader.authority.scope
        found = None
        for effect in state.effects:
            if effect.authorization.operation != "model.generate":
                continue
            request = EffectRequest.read(self.objects.read(effect.authorization.exact_request_reference))
            generation = decode(self.objects.read(request.arguments))
            if not isinstance(generation, GenerationInput) or generation.role is not ModelRole.REFINER:
                continue
            context = json.loads(self.objects.read(generation.authorized_context[0].reference))
            if context.get("checkpoint") == checkpoint:
                found = effect
        if found is None:
            if any(e.state is not EffectState.CONSUMED for e in state.effects):
                raise VerificationError("refinement requires consumed operation results")
            view = self.evidence.select(state)
            assert state.environment is not None and state.active_bundle is not None and state.active_revision is not None
            bundle = self.bundles.load(state.active_bundle)
            files: dict[str, dict[str, str]] = {}
            for path, ref in bundle.files:
                content = self.objects.read(self.bundles.file(ref).content)
                try:
                    files[path] = {"text": content.decode("utf-8")}
                except UnicodeDecodeError:
                    files[path] = {"base64": base64.b64encode(content).decode("ascii")}
            # Text context is a projection of authorized inputs and current
            # bundle files. No scorer receipt, hidden snapshot or audit byte.
            context_data = json.dumps({"schema": SCHEMA.decode(), "checkpoint": checkpoint,
                "environment": state.environment.digest, "revision": state.active_revision,
                "active_bundle": state.active_bundle.digest,
                "prior_bundles": list(dict.fromkeys(bundle.digest for _, bundle in state.revisions[:-1])),
                "files": files, "evidence_origins": dumps(view.origins).decode(), "proposal_format": dumps(Proposal(state.active_revision, "keep")).decode(),
                "instructions": "Return canonical strive.policy/1 Proposal: keep, revise, restore or gather-more-evidence. Comparison is optional."},
                sort_keys=True).encode()
            context_ref = self.provenance.publish(context_data, scope, state.active_bundle, state.environment, purpose="view")
            generation = GenerationInput(ModelRole.REFINER, (ScopedArtifact(context_ref, scope), *view.artifacts),
                self.refiner.model, self.refiner.model.request_options, self.objects.publish(SCHEMA), self.refiner.limits)
            arguments = self.provenance.publish(encode(generation), scope, context_ref, state.environment)
            request_ref = self.objects.publish(EffectRequest(self.refiner.destination, arguments, scope,
                tuple(i.reference for i in generation.authorized_context)).to_bytes())
            self._accept(ExecuteEffect("model.generate", self.refiner.binding, request_ref))
            self.supervisor.drive()
            found = self.supervisor.state.effects[-1]
        if self._done(found.authorization.effect_id):
            return "already-decided"
        if found.state is EffectState.SETTLED:
            self._accept(Continue())
        if found.response is None or found.outcome is not OutcomeStatus.RETURNED:
            self._accept(Suspend("refiner generation failed"))
            return "suspended"
        proposal = loads(self.objects.read(found.response), Proposal)
        state = self.supervisor.state
        # Recovery after activation but before the caller returned uses the
        # committed revision, never repeats generation or activation.
        if any(isinstance(r.payload, RevisionActivation) and r.payload.expected_active_revision == proposal.expected_revision
               for r in state.records):
            return "already-activated"
        if proposal.expected_revision != state.active_revision:
            raise VerificationError("wrong expected-revision")
        marker = (Annotation("policy.decision", json.dumps({"effect": found.authorization.effect_id,
            "decision": proposal.decision, "rationale": proposal.rationale,
            "comparison": "optional; fork enactment unsupported"}).encode()),)
        if proposal.decision in {"keep", "gather-more-evidence"}:
            if proposal.edits or proposal.controller_state is not None or proposal.restore is not None or proposal.dependencies is not None or proposal.capabilities is not None:
                raise VerificationError("non-revision decision contains edits")
            self._accept(Continue(), marker)
        elif proposal.decision == "restore":
            if (proposal.restore is None or proposal.edits or proposal.controller_state is not None
                    or proposal.dependencies is not None or proposal.capabilities is not None):
                raise VerificationError("restore requires a prior compatible bundle")
            self.supervisor.restore(proposal.restore)
            self._accept(Continue(), marker)
        elif proposal.decision == "revise":
            if proposal.compare and self.development_check is not None and not self.development_check(proposal):
                self._accept(Continue(), marker)
                return "gather-more-evidence"
            # Reconstruct exactly the generation's evidence, even after restart.
            request = EffectRequest.read(self.objects.read(found.authorization.exact_request_reference))
            retained = decode(self.objects.read(request.arguments))
            assert isinstance(retained, GenerationInput)
            context = json.loads(self.objects.read(retained.authorized_context[0].reference))
            retained_origins = loads(context["evidence_origins"].encode(), tuple)
            if not all(isinstance(o, Origin) for o in retained_origins):
                raise VerificationError("invalid retained evidence origins")
            origins = tuple(o for o in retained_origins if isinstance(o, Origin))
            if tuple(o.reference for o in origins) != tuple(i.reference for i in retained.authorized_context[1:]):
                raise VerificationError("retained provenance differs from generation inputs")
            # Keep source provenance already embedded in all active files, too.
            assert state.active_bundle is not None
            inherited = tuple(o for _, ref in self.bundles.load(state.active_bundle).files for o in self.bundles.file(ref).origins)
            origins = tuple(dict.fromkeys((*origins, *inherited, Origin(found.response, scope, "development"))))
            command = self.bundles.build(proposal, state, origins)
            self._accept(command, marker)
            self.supervisor.drive()
        else:
            raise VerificationError("unknown policy decision")
        return proposal.decision

    def run(self, adapter: BenchmarkAdapter, assignments: tuple[EpisodeAssignment, ...],
            routes: Mapping[str, tuple[str, str]], program: EpisodeProgram) -> None:
        self.supervisor.recover()
        for assignment in assignments:
            pools = {split.name for split in adapter.declare_splits() if assignment.task.task_id in split.task_ids}
            if len(pools) != 1:
                raise VerificationError("episode requires one declared evidence pool")
            self.evidence.episode_pools[assignment.episode] = EvidencePool(pools.pop())
        for index, assignment in enumerate(assignments):
            if self.supervisor.state.execution_status is not ExecutionStatus.CONTINUE:
                return
            driver = EpisodeDriver(self.supervisor, adapter, assignment, routes, self.provenance)
            measured = any(m.episode_identity == assignment.episode for m in self.supervisor.state.measurements)
            if not measured:
                receipts = driver.receipts()
                if not receipts:
                    current = self.supervisor.state.environment
                    assert current is not None
                    driver.perform(OperationRequest(assignment.episode, EnvironmentId(assignment.episode), current, None,
                        "initialize", (assignment.task, program.initialization(assignment))))
                    driver.consume()
                elif any(e.state is EffectState.SETTLED for e in self.supervisor.state.effects):
                    driver.consume()
                while True:
                    receipts = driver.receipts()
                    last = OperationRequest.read(self.objects.read(receipts[-1][1].arguments))
                    if last.operation == "terminate":
                        break
                    if len(receipts) > self.max_episode_steps:
                        self._accept(Suspend("policy episode step limit"))
                        return
                    state = self.supervisor.state
                    # A committed actor result after the last operation is the
                    # next action, including on restart before command acceptance.
                    operations = [i for i, e in enumerate(state.effects) if e.authorization.operation.startswith("benchmark.")]
                    steps = [i for i, e in enumerate(state.effects) if e.authorization.operation == "runtime.step"]
                    if not steps or not operations or steps[-1] < operations[-1]:
                        self.supervisor.step(self.sandbox, self.evidence.select(state).artifacts)
                    if self.supervisor.state.execution_status is not ExecutionStatus.CONTINUE:
                        return
                    if self.supervisor.state.pending_command is not None:
                        raise VerificationError("episode action controller must return Continue with action bytes")
                    current = self.supervisor.state.environment
                    assert current is not None
                    snapshot = benchmark_loads(self.objects.read(current), EpisodeSnapshot)
                    driver.perform(program.operation(snapshot, current, self.supervisor.state.private_state))
                    driver.consume()
                driver.score()
            if (index + 1) % self.interval == 0 and index + 1 < len(assignments):
                self.refine("episode:" + str(assignment.episode))
