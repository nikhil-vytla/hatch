"""Serial live telecom pilot, composed around the unchanged M3 authority log.

Only this trusted runner projects actor observations. A model proposes a local
telecom action as data; every mutation and generation is a separate M3 effect.
"""
from collections.abc import Callable
from contextlib import ExitStack
from functools import partial
import fcntl
import json
from pathlib import Path
import subprocess
from typing import Self

from ..benchmarks.api import BenchmarkAdapter, CapturedGeneration, EpisodeSnapshot, ToolInvocation, UserTurnPlan
from ..benchmarks.bridge import BenchmarkEffectAdapter, OperationRequest, OperationValidator
from ..benchmarks.episodes import EpisodeAssignment, EpisodeDriver
from ..benchmarks.payloads import dumps, loads
from ..codec import decode, encode, references
from ..contracts.annotations import Annotation
from ..contracts.bindings import ModelResolution
from ..contracts.commands import Continue, ExecuteEffect, Finish, StepOutput, Suspend
from ..contracts.harness import GenerationInput
from ..contracts.lifecycle import EffectState, RecoveryCapability
from ..contracts.manifest import ResolvedModel, ResolvedOperation, load_authored_manifest
from ..contracts.primitives import (AccessScope, ArtifactRef, EnvironmentId, EpisodeId, ExecutionStatus, LineageId,
                                   ModelRole, Resource, RunId, ScopedArtifact, SeedSupport)
from ..contracts.records import BoundHarness, CausalIdentity, DeclaredLineage, Measurement, OutcomeStatus, ProducerKind, RunBinding
from ..errors import VerificationError
from ..harness.bridge import HarnessEffectAdapter
from ..harness.gateway import ModelGateway
from ..harness.native_opencode import NativeOpenCodeBridge, TelecomOpenCodeAdapter, profile
from ..harness.openai_live import CONTROLS, MODEL, OpenAIContract, OpenAIEgress, OpenAITransport, canonical, load_contract
from ..harness.profiles import LaunchProfile
from ..harness.provider import Upstream, json_object
from ..harness.user_model import DirectUserModelAdapter, request_from_user_plan
from ..runtime.admission import AdmissionRule, ArtifactProvenance, ScopedAdmission, ValidatedArguments
from ..runtime.broker import CapabilityBroker, EffectAdapter, EffectRequest
from ..runtime.ledger import amounts
from ..runtime.supervisor import Supervisor
from ..store import ArtifactStore
from ..store.cas import CAS
from .data import integer, json_bytes, local_id, mapping, sequence, string, write_json
from .resolve import Resolver, resolved, runtime_identity
from .runner import manifest_for, run_directory

AdapterFactory = Callable[[CAS, int, bool], BenchmarkAdapter]
View = Callable[[str, bytes | None, bytes], tuple[bytes, bytes]]
ProviderFactory = Callable[[OpenAIContract, CAS, Path], Upstream]


class CampaignGenerationValidator:
    def __init__(self, objects: CAS) -> None:
        self.objects = objects
        self.identity = objects.publish(Path(__file__).read_bytes())

    def validate(self, data: bytes) -> ValidatedArguments:
        generation = decode(data)
        if not isinstance(generation, GenerationInput) or generation.role not in {ModelRole.ACTOR, ModelRole.USER}:
            raise VerificationError("campaign actor/user generation required")
        first = generation.authorized_context[0].reference
        context = json_object(self.objects.read(first))
        return ValidatedArguments(ArtifactRef(string(context["environment"])), tuple(i.reference for i in generation.authorized_context))


class Campaign:
    def __init__(self, directory: Path, run_id: str, manifest: Path, adapter_factory: AdapterFactory,
                 view: View, task_ids: tuple[str, ...], schemas: dict[str, bytes], launch: LaunchProfile,
                 *, providers: ProviderFactory = OpenAITransport, native: bool = True, resume: bool = False) -> None:
        self.directory, self.run_id, self.view = directory, run_id, view
        self.resources = ExitStack()
        try:
            if providers is OpenAITransport:
                egress = OpenAIEgress()
                self.resources.callback(egress.close)
                providers = partial(OpenAITransport, egress=egress)
            directory.mkdir(parents=True, exist_ok=True)
            lease = self.resources.enter_context((directory / "campaign.lease").open("a+b"))
            fcntl.flock(lease.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.store = ArtifactStore(directory / "artifacts")
            self.objects = self.store.objects
            objects = self.objects
            source = manifest.read_text()
            authored = load_authored_manifest(source)
            if (authored.policy.entrypoint != "campaign:step" or authored.run.editable or authored.feedback.contract.value != "A"
                    or authored.seeds.model_request is not None):
                raise VerificationError("live pilot requires fixed actor, contract A and no unsupported model seed")
            actor_binding = next(m.binding for m in authored.models if m.name == "actor")
            user_binding = next(m.binding for m in authored.models if m.name == "user")
            if {m.name for m in authored.models} != {"actor", "user", "refiner"} or any(
                    m.binding.provider != "openai" or m.binding.model != MODEL for m in authored.models):
                raise VerificationError("pilot model bindings must all be OpenAI gpt-5.6-luna")
            self.contracts: dict[str, OpenAIContract] = {"actor": load_contract(objects, manifest.parent / authored.budget.price_schedule,
                input_tokens=actor_binding.max_input_tokens, output_tokens=actor_binding.max_output_tokens, wall_seconds=launch.deadline_seconds)}
            for task in task_ids:
                self.contracts["user-" + task] = load_contract(objects, manifest.parent / authored.budget.price_schedule,
                    input_tokens=user_binding.max_input_tokens, output_tokens=user_binding.max_output_tokens,
                    wall_seconds=launch.deadline_seconds, user=True, schemas=schemas[task])
            self.gateways: dict[str, ModelGateway] = {}
            for name, contract in self.contracts.items():
                if resume and not (directory / "gateway" / name / "spool.sqlite").is_file():
                    raise VerificationError("missing retained gateway spool; cannot resume")
                provider = providers(contract, objects, directory / "transport" / name)
                if isinstance(provider, OpenAITransport):
                    self.resources.callback(provider.close)
                gateway = ModelGateway(directory / "gateway" / name, objects, contract, provider)
                self.resources.callback(gateway.close)
                self.gateways[name] = gateway
            actor = TelecomOpenCodeAdapter(objects, launch, self.contracts["actor"])
            bridge_type = NativeOpenCodeBridge if native else HarnessEffectAdapter
            self.actor = bridge_type(actor, self.gateways["actor"], directory / "scratch")
            self.adapters: dict[str, EffectAdapter] = {"actor": self.actor}
            for name, contract in self.contracts.items():
                if name != "actor":
                    self.adapters[name] = DirectUserModelAdapter(self.gateways[name], contract)
            if resume:
                self.reader = self.store.reader(RunId(run_id))
                retained = manifest_for(self.reader)
                self.writer = self.store.writer(RunId(run_id))
                self.resources.callback(self.writer.close)
                epoch = self.writer.epoch
            else:
                epoch = 1
            self.adapter = adapter_factory(objects, epoch, not resume)
            descriptor = self.adapter.describe()
            development = next(s for s in self.adapter.declare_splits() if s.name == "development")
            if not task_ids or not set(task_ids) <= set(development.task_ids):
                raise VerificationError("pilot tasks must come from the qualified adaptive development split")
            task_map = {t.task_id: t for t in self.adapter.enumerate_tasks()}
            # Coverage names tasks once; repeated proof episodes retain their
            # own episode identities in the stream and measurements.
            coverage = tuple(dict.fromkeys(task_ids))
            self.assignments = tuple(EpisodeAssignment(EpisodeId(f"episode-{i}"), task_map[t], development.grouping_definition, coverage)
                                     for i, t in enumerate(task_ids))
            runtime = runtime_identity(objects)
            gateway_identity = objects.publish(encode(tuple((name, gateway.identity) for name, gateway in self.gateways.items())))
            options = objects.publish(b"{}")
            actor_tree = objects.publish(encode((("actor/protocol.txt", objects.publish(PROMPT.encode())),)))
            executable, _, sandbox = launch.references(objects)
            builtins = {"builtin:runtime": runtime, "builtin:verifier": objects.publish(Path(__file__).parents[1].joinpath("verify/engine.py").read_bytes()),
                "builtin:tau2": descriptor.implementation, "builtin:scorer": descriptor.scorer, "builtin:actor": actor_tree,
                "builtin:gateway": gateway_identity, "builtin:policy": objects.publish(Path(__file__).read_bytes()),
                "builtin:capabilities": objects.publish(b"telecom campaign scoped operations/1"), "builtin:initial": options,
                "builtin:options": options, "builtin:workload": descriptor.workload, "builtin:stream": objects.publish(canonical(list(task_ids))),
                "builtin:corpus": development.grouping_definition, "builtin:audit-plan": objects.publish(b"pilot has no audit release"),
                "builtin:comparison-plan": objects.publish(b"fixed-actor pilot cost measurement; not leaderboard comparable"),
                "builtin:opencode-adapter": actor.identity, "builtin:opencode-executable": executable,
                "builtin:opencode-launch": launch.retained(objects), "builtin:opencode-sandbox": sandbox}
            self.config = Resolver(objects, manifest.parent, builtins).configuration(authored, allow_harness=True)
            if any(contract.evidence != self.config.budget.price_schedule for contract in self.contracts.values()):
                raise VerificationError("provider bound differs from the manifest price schedule")
            if any(objects.read(m.binding.request_options) != b"{}" for m in self.config.models):
                raise VerificationError("pilot request options must be empty; live controls are pinned in provider contract")
            if next(m.binding for m in self.config.models if m.name == "refiner") != next(m.binding for m in self.config.models if m.name == "actor"):
                raise VerificationError("inactive refiner binding must match the actor")
            expected_pins = {"runtime": "runtime", "verifier": "verifier", "adapters": "tau2", "scorer": "scorer",
                             "initial_bundle": "actor", "model_gateway": "gateway"}
            if any(getattr(self.config.pins, field) != builtins["builtin:" + name] for field, name in expected_pins.items()):
                raise VerificationError("manifest pins differ from actual campaign implementations")
            if (self.config.workload.task_stream != builtins["builtin:stream"]
                    or self.config.workload.implementation != descriptor.workload
                    or self.config.workload.dev_corpus != development.grouping_definition
                    or self.config.policy.package != builtins["builtin:policy"]):
                raise VerificationError("manifest workload/policy differs from actual pilot")
            if len(self.config.harnesses) != 1 or self.config.harnesses[0].name != "opencode":
                raise VerificationError("exactly one OpenCode harness required")
            harness = self.config.harnesses[0].binding
            if (harness.backend != "opencode" or harness.version != launch.version or harness.deadline_seconds != launch.deadline_seconds
                    or harness.adapter != actor.identity or harness.launch_profile != launch.retained(objects)
                    or harness.executable != executable or harness.sandbox_profile != sandbox
                    or actor_binding.harness != "opencode" or user_binding.harness is not None):
                raise VerificationError("manifest differs from actual harness closure")
            self.scope = AccessScope(RunId(run_id), LineageId("development"), self.config.run.capabilities)
            self.provenance = ArtifactProvenance(directory / "grants", objects, self.scope.grant)
            self.resources.callback(self.provenance.close)
            names = frozenset(op.name for op in descriptor.operations)
            self.routes = {name: ("telecom", "local://telecom") for name in names}
            self.adapters["telecom"] = BenchmarkEffectAdapter(self.adapter, objects, "local://telecom", allowed_operations=names)
            op_validator, gen_validator = OperationValidator(objects), CampaignGenerationValidator(objects)
            rules = tuple(AdmissionRule("telecom", "benchmark." + name, "local://telecom", self.scope, self.adapter.identity,
                op_validator.identity, 1000000, 128, (), True) for name in sorted(names)) + tuple(
                AdmissionRule(name, "model.generate", contract.endpoint, self.scope, self.adapters[name].identity,
                    gen_validator.identity, 1000000, 128, contract.reservation(self.gateways[name].bound).components, True)
                for name, contract in self.contracts.items())
            self.broker = CapabilityBroker(objects, (), self.adapters,
                ScopedAdmission(objects, self.provenance, rules, (op_validator, gen_validator)))
            if not resume:
                model_resolutions = tuple(ResolvedModel(m.name, ModelResolution(self.contracts["actor"].endpoint, "env:OPENAI_API_KEY",
                    "responses-text/1", self.config.budget.price_schedule,
                    objects.publish(encode(tuple(g.bound for name, g in self.gateways.items() if name.startswith("user-"))))
                    if m.name == "user" else self.gateways["actor"].bound, objects.publish(canonical(CONTROLS)),
                    SeedSupport.UNSUPPORTED if m.binding.harness else None, SeedSupport.UNSUPPORTED,
                    actor.native_identifier() if m.binding.harness else None)) for m in self.config.models)
                operations = tuple(ResolvedOperation("benchmark." + op.name, op.recovery.capabilities) for op in descriptor.operations) + (
                    ResolvedOperation("model.generate", frozenset({RecoveryCapability.SUSPEND, RecoveryCapability.OPERATION_LOOKUP})),)
                self.manifest = resolved(objects, source, self.config, actor_tree, model_resolutions, operations, sandbox,
                    (descriptor.closure, executable, *[g.bound for g in self.gateways.values()]), tuple(objects.publish(s) for s in schemas.values()))
                self.reader = self.store.create_run(RunId(run_id), self.scope, {kind: {
                    ProducerKind.TRUSTED_SCORER: descriptor.scorer, ProducerKind.BROKER: gateway_identity,
                    ProducerKind.TRUSTED_ADAPTER: self.adapter.identity}.get(kind, runtime) for kind in ProducerKind})
                self.writer = self.store.writer(RunId(run_id))
                self.resources.callback(self.writer.close)
                binding = RunBinding(objects.publish(encode(self.manifest)), runtime, self.config.pins.verifier, self.adapter.identity,
                    descriptor.scorer, self.config.workload.initial_snapshot, actor_tree, self.config.models, self.config.budget,
                    self.broker.policy_reference, (), self.config.feedback, self.config.comparison, self.config.run.mode,
                    DeclaredLineage(self.scope.lineage_id, None, None, self.scope.grant),
                    (BoundHarness("opencode", harness, objects.publish(encode(actor.describe())), executable,
                        launch.retained(objects), sandbox, harness.level),), gateway_identity)
                self.writer.port(ProducerKind.RUN_SETUP).append(binding, causal=CausalIdentity(None, None, None, None), epoch=self.writer.epoch)
                write_json(directory / "resolved-manifest.json", self.manifest)
            else:
                self.manifest = retained
                if self.config != retained.configuration or self.reader.verify().binding is None:
                    raise VerificationError("resume configuration/implementation differs from retained run; budget cannot reset")
            self.supervisor = Supervisor(self.writer, self.broker)
            self.supervisor.recover()
        except BaseException:
            self.resources.close()
            raise

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *args: object) -> None:
        self.resources.close()

    def progress(self) -> dict[str, object]:
        raw = self.supervisor.state.private_state
        return json_object(raw) if raw else {"episode": 0, "stage": "ready"}

    def checkpoint(self, progress: dict[str, object]) -> None:
        self.supervisor.accept(StepOutput(Continue(), canonical(progress)), expected_head=self.supervisor.state.head)

    def stopped(self) -> bool:
        return self.supervisor.state.dispatch_stopped or any(
            isinstance(r.payload, Annotation) and r.payload.namespace == "campaign.budget_stop" for r in self.supervisor.state.records)

    def issue(self, command: ExecuteEffect, progress: dict[str, object]) -> bool:
        if self.stopped():
            return False
        try:
            self.supervisor.accept(StepOutput(command, canonical(progress)), expected_head=self.supervisor.state.head)
        except VerificationError as error:
            if str(error) != "reservation exceeds run budget":
                raise
            state = self.supervisor.state
            evidence = canonical({"command": self.objects.publish(encode(command)).digest, "measured": json.loads(json_bytes(state.measured)),
                "outstanding": json.loads(json_bytes(state.obligations)), "reason": str(error)})
            self.supervisor.accept(StepOutput(Suspend(str(error)), state.private_state,
                (Annotation("campaign.budget_stop", evidence),)), expected_head=state.head)
            return False
        try:
            self.supervisor.drive()
        except Exception:
            self.supervisor.recover()
            raise
        return not self.stopped()

    def operation(self, assignment: EpisodeAssignment, name: str, values: tuple[object, ...], progress: dict[str, object]) -> bool:
        state = self.supervisor.state
        assert state.environment is not None
        before = None if name == "initialize" else loads(self.objects.read(state.environment), EpisodeSnapshot)
        operation = OperationRequest(assignment.episode, EnvironmentId("telecom-" + assignment.episode), state.environment, before, name, values)
        source = self.objects.publish(dumps((assignment.episode, assignment.task)))
        arguments = self.provenance.publish(operation.to_bytes(), self.scope, source, state.environment)
        for ref in references(values):
            self.provenance.publish(self.objects.read(ref), self.scope, source, state.environment, purpose="operand")
        request = EffectRequest("local://telecom", arguments, self.scope)
        return self.issue(ExecuteEffect("benchmark." + name, "telecom", self.objects.publish(request.to_bytes())),
                          {**progress, "stage": "operation", "operation": name})

    def generation(self, name: str, context: dict[str, object], progress: dict[str, object], plan: UserTurnPlan | None = None) -> bool:
        state = self.supervisor.state
        assert state.environment is not None
        source = self.objects.publish(canonical(context))
        view = self.provenance.publish(canonical({"environment": state.environment.digest, **context}), self.scope,
                                       source, state.environment, purpose="view")
        inputs = [view]
        role = ModelRole.USER if plan else ModelRole.ACTOR
        binding = next(m.binding for m in self.config.models if m.name == ("user" if plan else "actor"))
        settings = binding.request_options
        if plan:
            self.provenance.publish(self.objects.read(plan.generation_input), self.scope, source, state.environment, purpose="view")
            inputs.append(plan.generation_input)
            settings = self.objects.publish(request_from_user_plan(self.objects.read(plan.generation_input), self.contracts[name]))
            progress = {**progress, "plan": self.objects.publish(dumps(plan)).digest}
        generation = GenerationInput(role, tuple(ScopedArtifact(ref, self.scope) for ref in inputs), binding, settings,
            self.objects.publish(b"structured-user-response/1" if plan else self.actor.adapter.output_schema), ())
        arguments = self.provenance.publish(encode(generation), self.scope, source, state.environment)
        request = EffectRequest(self.contracts[name].endpoint, arguments, self.scope, tuple(inputs))
        return self.issue(ExecuteEffect("model.generate", name, self.objects.publish(request.to_bytes())),
                          {**progress, "stage": "user" if plan else "actor"})

    def drive(self, *, episodes: int | None = None, transitions: int | None = None) -> dict[str, object]:
        completed_at_start = integer(self.progress()["episode"])
        steps = 0
        if self.stopped() or self.supervisor.state.execution_status is ExecutionStatus.FINISHED:
            return self.report()
        # An operator pause is resumable. An unresolved or budget-stopped run is
        # never resumed by manufacturing a fresh budget or repeating inference.
        if self.supervisor.state.execution_status is ExecutionStatus.SUSPENDED:
            if any(e.state not in {EffectState.SETTLED, EffectState.CONSUMED} for e in self.supervisor.state.effects):
                return self.report()
            self.checkpoint(self.progress())
        while not self.stopped():
            progress = self.progress()
            index, stage = integer(progress["episode"]), string(progress["stage"])
            if index == len(self.assignments):
                self.supervisor.accept(StepOutput(Finish("pilot task stream completed"), canonical(progress)), expected_head=self.supervisor.state.head)
                break
            if episodes is not None and index - completed_at_start >= episodes or transitions is not None and steps >= transitions:
                self.supervisor.accept(StepOutput(Suspend("operator pause"), canonical(progress)), expected_head=self.supervisor.state.head)
                break
            assignment = self.assignments[index]
            driver = EpisodeDriver(self.supervisor, self.adapter, assignment, self.routes, self.provenance)
            if stage in {"actor", "user", "operation"}:
                effect = self.supervisor.state.effects[-1]
                if effect.state not in {EffectState.SETTLED, EffectState.CONSUMED} or effect.response is None:
                    break
                if effect.outcome is not OutcomeStatus.RETURNED or (stage != "operation" and effect.obligations):
                    self.supervisor.accept(StepOutput(Suspend("generation incomplete; retain usage and stop"), canonical(progress)),
                                           expected_head=self.supervisor.state.head)
                    break
                if stage == "operation":
                    if progress["operation"] == "terminate":
                        if not any(m.episode_identity == assignment.episode for m in self.supervisor.state.measurements):
                            reward = driver.score()
                            if reward.status != "scored":
                                raise VerificationError("deterministic scoring unresolved")
                        self.checkpoint({"episode": index + 1, "stage": "ready"})
                    else:
                        self.checkpoint({"episode": index, "stage": "ready"})
                elif stage == "actor":
                    values: tuple[object, ...]
                    proposal = json_object(self.objects.read(effect.response))
                    if "message" in proposal:
                        name, values = "deliver_message", (self.objects.publish(canonical({"role": "assistant", "content": proposal["message"]})),)
                    elif "tool" in proposal:
                        name, values = "agent_tool", (ToolInvocation("actor-" + str(len(self.supervisor.state.effects)),
                            string(proposal["tool"]), self.objects.publish(canonical(mapping(proposal["arguments"])))),)
                    else:
                        name, values = "terminate", (self.objects.publish(canonical("agent_stop")),)
                    if not self.operation(assignment, name, values, progress):
                        break
                else:
                    plan = loads(self.objects.read(ArtifactRef(string(progress["plan"]))), UserTurnPlan)
                    assert effect.result is not None
                    if plan.generation_input not in effect.authorization.input_references:
                        raise VerificationError("user capture lacks authorized plan")
                    capture = CapturedGeneration(effect.result, plan.generation_input, effect.response)
                    if not self.operation(assignment, "user_turn", (plan, capture), progress):
                        break
            elif stage == "ready":
                receipts = driver.receipts()
                if not receipts:
                    initial = self.objects.publish(canonical({"model": MODEL, "model_settings": {}, "seed": self.config.seeds.workload + index}))
                    if not self.operation(assignment, "initialize", (assignment.task, initial), progress):
                        break
                else:
                    snapshot = receipts[-1][1].after
                    data = json_object(self.objects.read(snapshot.state))
                    if data.get("termination"):
                        if not self.operation(assignment, "terminate", (self.objects.publish(canonical(data["termination"])),), progress):
                            break
                    elif data.get("pending_batch"):
                        batch = sequence(data["pending_batch"])
                        call = mapping(batch[integer(data.get("delivery_cursor", 0))])
                        if not self.operation(assignment, "user_tool", (ToolInvocation(string(call["id"]), string(call["name"]),
                                self.objects.publish(canonical(call["arguments"]))),), progress):
                            break
                    elif data.get("pending_message") is not None:
                        next_plan = self.adapter.plan_user_turn(snapshot, self.objects.publish(b"{}"))
                        if next_plan is None:
                            raise VerificationError("telecom user plan missing")
                        if not self.generation("user-" + assignment.task.task_id, {"purpose": "bounded user simulation"}, progress, next_plan):
                            break
                    elif integer(data.get("steps", 0)) >= 100:
                        if not self.operation(assignment, "terminate", (self.objects.publish(canonical("max_steps")),), progress):
                            break
                    else:
                        _, view = self.view("actor_view", self.objects.read(snapshot.state), b"{}")
                        if not self.generation("actor", {"protocol": PROMPT, "telecom": json_object(view)}, progress):
                            break
            else:
                raise VerificationError("unknown campaign continuation")
            steps += 1
        return self.report()

    def report(self) -> dict[str, object]:
        state = self.reader.verify()
        measured, held = amounts(state.measured), amounts(state.obligations)
        episodes = [r.payload for r in state.records if isinstance(r.payload, Measurement)]
        costs: dict[str, int] = {}
        for effect in state.effects:
            if effect.authorization.operation != "model.generate":
                continue
            request = EffectRequest.read(self.objects.read(effect.authorization.exact_request_reference))
            generation = decode(self.objects.read(request.arguments))
            assert isinstance(generation, GenerationInput)
            context = json_object(self.objects.read(generation.authorized_context[0].reference))
            snapshot = loads(self.objects.read(ArtifactRef(string(context["environment"]))), EpisodeSnapshot)
            costs[snapshot.episode] = costs.get(snapshot.episode, 0) + amounts(effect.measured).get(Resource.USD_NANODOLLARS, 0)
        result: dict[str, object] = {"run": self.run_id, "status": state.execution_status.value,
            "budget_stopped": self.stopped(), "cap_usd": self.config.budget.usd.nanodollars / 1e9,
            "settled_usd": measured.get(Resource.USD_NANODOLLARS, 0) / 1e9,
            "outstanding_usd": held.get(Resource.USD_NANODOLLARS, 0) / 1e9,
            "model_calls": measured.get(Resource.MODEL_CALLS, 0), "progress": self.progress(),
            "completed_episodes": len(episodes), "verified_head": state.head.digest if state.head else None,
            "episodes": [{"episode": a.episode, "task": a.task.task_id, "settled_usd": costs.get(a.episode, 0) / 1e9,
                "completed": any(m.episode_identity == a.episode for m in episodes)}
                for a in self.assignments if a.episode in costs]}
        write_json(self.directory / "campaign-result.json", result, replace=True)
        return result


PROMPT = ('You are the telecom support agent. Follow the supplied policy and conversation. '
          'Return exactly one JSON object: {"message":"text to the customer"}, '
          '{"tool":"tool_name","arguments":{...}}, or {"stop":true}. '
          'Tool proposals are data for Strive to execute. Do not use native tools or markdown. '
          'Begin with a brief greeting when the conversation is empty.')


def live(root: Path, manifest: Path, run_id: str, *, resume: bool = False, episodes: int | None = None,
         prepare_only: bool = False, budget_proof: bool = False) -> dict[str, object]:
    from ..harness.openai_live import require_live_container
    require_live_container()
    with ExitStack() as resources:
        # Capture once before even the qualification jail, and share this
        # readied worker with every actor/user transport, including late ones.
        egress = None if prepare_only else OpenAIEgress()
        if egress is not None:
            resources.callback(egress.close)
        return _live(root, manifest, run_id, resume=resume, episodes=episodes,
                     prepare_only=prepare_only, budget_proof=budget_proof, egress=egress)


def _live(root: Path, manifest: Path, run_id: str, *, resume: bool, episodes: int | None,
          prepare_only: bool, budget_proof: bool, egress: OpenAIEgress | None) -> dict[str, object]:
    from ..runtime.linux_jail import require_capability
    require_capability()
    from strive_benchmark_tau2.client import Tau2Client
    from strive_benchmark_tau2.process import IsolatedTau2
    import os
    if episodes is not None and episodes < 1:
        raise VerificationError("episodes must be positive")
    if budget_proof and (load_authored_manifest(manifest.read_text()).budget.usd.nanodollars != 50_000_000
                         or episodes is not None or prepare_only):
        raise VerificationError("budget-stop-live requires exactly USD 0.05 and no episode/preparation override")
    repository = Path(__file__).resolve().parents[3]
    python = Path(os.environ.get("STRIVE_TAU2_PYTHON", str(repository / "adapters/tau2/.venv/bin/python")))
    data = Path(os.environ.get("TAU2_DATA_DIR", str(repository / "adapters/tau2/retained-data")))
    executable = Path(os.environ.get("STRIVE_OPENCODE", "/usr/local/bin/opencode"))
    directory = run_directory(root, local_id(run_id)).resolve()
    if not resume:
        directory.mkdir(parents=True, exist_ok=False)
        prepared = subprocess.run([str(python), "-I", "-B", "-m", "strive_benchmark_tau2.campaign_prepare",
            str(data), str(directory), str(repository), "5"], capture_output=True, timeout=1800,
            env={"TAU2_DATA_DIR": str(data), "PATH": "/usr/local/bin:/usr/bin:/bin"})
        if prepared.returncode:
            raise VerificationError("offline telecom preparation failed: " + prepared.stderr[-3000:].decode(errors="replace"))
    spec = json_object((directory / "telecom.json").read_bytes())
    objects = ArtifactStore(directory / "artifacts").objects
    closure, data_index, qualification, identity = (ArtifactRef(string(spec[k])) for k in ("closure", "data", "qualification", "identity"))
    backend = IsolatedTau2(python, directory / "data", objects, closure, data_index)
    def adapter_factory(cas: CAS, epoch: int, creating: bool) -> BenchmarkAdapter:
        config = (str(cas.directory), str(directory / "operations"), run_id, epoch, closure, data_index, qualification)
        return Tau2Client(python, directory / "data", config, identity, bootstrap=creating)
    tasks = tuple(string(t) for t in sequence(spec["tasks"]))
    if budget_proof:
        tasks = tasks * 200  # Repeat qualified dev episodes until USD admission refuses.
    schemas = {name: canonical(value) for name, value in mapping(spec["user_schemas"]).items()}
    def provider(contract: OpenAIContract, cas: CAS, path: Path) -> Upstream:
        return PreparationProvider() if prepare_only else OpenAITransport(contract, cas, path, egress=egress)
    with Campaign(directory, run_id, manifest, adapter_factory, backend.call, tasks, schemas, profile(executable),
                  providers=provider, resume=resume) as campaign:
        result = campaign.report() if prepare_only else campaign.drive(episodes=episodes)
        if budget_proof:
            from .budget_proof import prove
            result["budget_proof"] = prove(campaign, real=True)
        return result


class PreparationProvider:
    """Resolution needs no key and cannot dispatch, including during recovery."""
    def generate(self, request: bytes, operation_key: str) -> bytes:
        raise VerificationError("prepare-only mode cannot dispatch models")

    def lookup(self, operation_key: str) -> bytes | None:
        return None
