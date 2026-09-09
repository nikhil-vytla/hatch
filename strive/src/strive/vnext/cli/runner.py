"""The serial composition root: manifests -> existing broker/policy/benchmark."""
from collections.abc import Callable
from contextlib import ExitStack
from dataclasses import replace
from pathlib import Path
import random
import fcntl
from typing import Self

from ..benchmarks.bridge import BenchmarkEffectAdapter, OperationValidator
from ..benchmarks.payloads import dumps as benchmark_dumps
from ..benchmarks.episodes import EpisodeAssignment
from ..benchmarks.store import OperationStore
from ..codec import encode
from ..contracts.annotations import Annotation
from ..contracts.bindings import ModelBinding, ModelResolution
from ..contracts.commands import Finish, StepOutput, Suspend
from ..contracts.lifecycle import RecoveryCapability
from ..contracts.manifest import ResolvedManifest, ResolvedModel, ResolvedOperation, load_authored_manifest
from ..contracts.primitives import AccessScope, ArtifactRef, EpisodeId, ExecutionStatus, LineageId, RunId, SeedSupport
from ..contracts.records import CausalIdentity, DeclaredLineage, ProducerKind, RunBinding
from ..errors import VerificationError
from ..harness.gateway import ModelGateway
from ..harness.provider import ProviderContract, Upstream
from ..policy import BundleManager, BundleSandbox, ContinualRefine, EvidenceSelector, GatewayRefiner, GenerationValidator, RefinerRoute
from ..runtime.admission import AdmissionRule, ArtifactProvenance, ScopedAdmission
from ..runtime.broker import CapabilityBroker
from ..runtime.sandbox import DenoSandbox, SandboxLimits
from ..runtime.supervisor import Supervisor
from ..store import ArtifactStore, RunReader
from ..store.cas import atomic_file, durable_directory, fsync_directory
from ..verify import VerifiedState
from .data import integer, json_bytes, local_id, mapping, read_json, sequence, string, write_json
from .fixture import CounterProgram, FixtureProvider, initial_tree, policy_tree
from .resolve import Resolver, load_manifest, resolved, runtime_identity, tree


def run_directory(root: Path, run_id: str) -> Path:
    return root / "runs" / local_id(run_id)


def reader(root: Path, run_id: str) -> RunReader:
    return RunReader(run_directory(root, run_id) / "artifacts", RunId(run_id))


def manifest_for(read: RunReader) -> ResolvedManifest:
    state = read.verify()
    if state.binding is None:
        raise VerificationError("run setup has not committed")
    return load_manifest(read.objects, state.binding.resolved_manifest)


def ensure_mutable(directory: Path) -> None:
    if (directory / "FROZEN").exists():
        raise VerificationError("campaign frozen; development cannot resume or import audit feedback")


class Session:
    def __init__(self, directory: Path, run_id: str, *, source: str | None = None, base: Path | None = None,
                 lineage: str = "development", upstream: Upstream | None = None,
                 imported_actor: dict[str, bytes] | None = None, audit_target: int | None = None,
                 context: dict[str, str] | None = None) -> None:
        # All resources are private to this execution. No shared CAS, retrieval
        # DB, provider spool, environment, grant registry or budget object.
        try:
            from strive_benchmark_counter import CounterAdapter
        except ModuleNotFoundError as error:
            raise VerificationError("counter adapter unavailable; install adapters/counter or set PYTHONPATH=adapters/counter/src") from error

        self.directory, self.run_id = directory, run_id
        self.resources = ExitStack()
        try:
            lease = self.resources.enter_context((directory / "workflow.lease").open("a+b"))
            fcntl.flock(lease.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            ensure_mutable(directory)
            self.store = ArtifactStore(directory / "artifacts")
            self.objects = self.store.objects
            creating = source is not None
            retained: ResolvedManifest | None = None
            if not creating:
                self.reader = self.store.reader(RunId(run_id))
                retained = manifest_for(self.reader)
                config = retained.configuration
                lineage = self.reader.authority.scope.lineage_id
                for service in ("gateway/spool.sqlite", "operations/operations.sqlite", "bundles/bundles.sqlite", "grants/provenance.sqlite"):
                    if not (directory / service).is_file():
                        raise VerificationError("missing retained service state: " + service)
            self.runtime = runtime_identity(self.objects)
            counter_file = __import__(CounterAdapter.__module__, fromlist=["__file__"]).__file__
            assert counter_file is not None
            self.pin = self.objects.publish(Path(counter_file).read_bytes())
            self.backend = DenoSandbox(directory / "scratch", SandboxLimits(wall_seconds=1, cpu_seconds=1))
            sandbox_ref = self.objects.publish(self.backend.profile().to_bytes())
            executable_ref = self.backend.profile().executable
            if creating:
                self.objects.publish(self.backend.executable.read_bytes())
            else:
                assert retained is not None
                if executable_ref not in retained.closure.dependency_artifacts:
                    raise VerificationError("candidate executable differs from the retained closure")
                self.objects.read(executable_ref)
            for name in ("retrieval", "cache", "conversation"):
                durable_directory(directory / name)
            if creating:
                assert source is not None and base is not None
                authored = load_authored_manifest(source)
                model: ModelBinding[str] | ModelBinding[ArtifactRef]
                model = next(m.binding for m in authored.models if m.name == "refiner")
                price_ref = self.objects.publish(b'{"fixture":true,"input_nanodollars":0,"output_nanodollars":0}')
            else:
                assert retained is not None
                model = next(m.binding for m in retained.configuration.models if m.name == "refiner")
                price_ref = retained.configuration.budget.price_schedule
                if retained.configuration.pins.runtime != self.runtime:
                    raise VerificationError("pinned runtime differs; reproduce/resume requires retained implementation")
            contract = ProviderContract("fixture", "counter-refiner/1", "https://fixture.invalid/generate", "responses-text/1",
                "fixture-no-credentials", price_ref, model.max_input_tokens, model.max_output_tokens,
                1000000, 1000000, 0, 0, wall_milliseconds=3000)
            self.gateway = ModelGateway(directory / "gateway", self.objects, contract, upstream or FixtureProvider())
            self.resources.callback(self.gateway.close)
            if not creating:
                self.writer = self.store.writer(RunId(run_id))
                self.resources.callback(self.writer.close)
            self.operations = OperationStore(directory / "operations", self.objects, RunId(run_id), self.pin,
                1 if creating else self.writer.epoch, create=creating)
            self.resources.callback(self.operations.close)
            self.adapter = CounterAdapter(self.operations, self.objects)
            if creating and audit_target is not None:
                if lineage != "audit":
                    raise VerificationError("protected tasks require audit lineage")
                write_json(directory / "audit-input.json", {"target": audit_target})
            if lineage == "audit":
                target = integer(read_json((directory / "audit-input.json").read_bytes())["target"], -10)
                if target > 10:
                    raise VerificationError("audit target outside fixture bounds")
                self.adapter.tasks = tuple(replace(t, definition=self.objects.publish(json_bytes({"id": t.task_id, "target": target}))) for t in self.adapter.tasks)
                self.adapter.workload = self.objects.publish(benchmark_dumps(self.adapter.tasks))
                self.adapter.closure = self.objects.publish(encode(("integer-target-audit-closure/1", self.pin, self.adapter.workload)))
            if creating:
                builtins = {"builtin:runtime": self.runtime, "builtin:verifier": self.objects.publish(Path(__file__).parents[1].joinpath("verify/engine.py").read_bytes()),
                    "builtin:counter": self.pin, "builtin:scorer": self.adapter.scorer.identity,
                    "builtin:workload": self.adapter.workload, "builtin:actor": initial_tree(self.objects),
                    "builtin:policy": policy_tree(self.objects), "builtin:gateway": self.gateway.identity,
                    "builtin:capabilities": self.objects.publish(b"counter operations and bounded fixture refinement/1"),
                    "builtin:initial": self.objects.publish(b"{}"), "builtin:options": self.objects.publish(b"{}"),
                    "builtin:prices": price_ref,
                    "builtin:stream": self.objects.publish(json_bytes({"tasks": ["reach-seven", "reach-seven"]})),
                    "builtin:corpus": self.objects.publish(json_bytes({"tasks": ["reach-seven"], "update": "pinned"})),
                    "builtin:audit-plan": self.objects.publish(json_bytes({"selection": "final_valid_active_actor_from_every_trajectory", "release": "after-campaign-freeze"})),
                    "builtin:comparison-plan": self.objects.publish(json_bytes({"horizon": 2, "pairing": "workload_seed", "metric": "cumulative_successes", "exclusions": [], "stopping": "budget-or-horizon", "uncertainty": "paired-normal-95"}))}
                assert base is not None
                config = Resolver(self.objects, base, builtins).configuration(authored)
            expected = (self.pin, self.adapter.scorer.identity, self.gateway.identity, self.adapter.workload)
            if (config.pins.adapters, config.pins.scorer, config.pins.model_gateway, config.workload.implementation) != expected:
                raise VerificationError("implementation pins differ from installed fixture closure")
            if config.pins.runtime != self.runtime or config.pins.verifier != self.objects.publish(Path(__file__).parents[1].joinpath("verify/engine.py").read_bytes()):
                raise VerificationError("runtime/verifier pins differ")
            if {m.name for m in config.models} != {"actor", "refiner"} or any(
                m.binding.provider != "fixture" or m.binding.model != "counter-" + m.name + "/1"
                or m.binding.harness is not None or self.objects.read(m.binding.request_options) != b"{}" for m in config.models):
                raise VerificationError("only exact fixture models and empty request options are supported; conflicting scientific settings")
            if config.policy.entrypoint != "policy:step" or any(p.name == "optional_dev_forks" and p.value for p in config.policy.parameters.parameters):
                raise VerificationError("unsupported policy entrypoint or deferred EvaluateFork")
            if self.objects.read(config.budget.price_schedule) != b'{"fixture":true,"input_nanodollars":0,"output_nanodollars":0}' or self.objects.read(config.workload.initial_snapshot) != b"{}":
                raise VerificationError("fixture prices/initial snapshot differ from supported settings")
            if imported_actor is not None:
                actor_ref = self.objects.publish(encode(tuple((name, self.objects.publish(data)) for name, data in sorted(imported_actor.items()))))
                config = replace(config, pins=replace(config.pins, initial_bundle=actor_ref))
            self.config = config
            grant = config.run.capabilities
            self.scope = AccessScope(RunId(run_id), LineageId(lineage), grant)
            self.bundles = BundleManager(directory / "bundles", self.objects, self.scope, config.run.editable)
            self.resources.callback(self.bundles.close)
            if creating:
                files = tree(self.objects, config.pins.initial_bundle)
                if imported_actor is not None:
                    files = imported_actor
                    # The exact imported bytes enter only the audit's initial bundle.
                    if lineage != "audit" or config.run.editable:
                        raise VerificationError("frozen imports require immutable audit lineage")
                controller = tree(self.objects, config.policy.package)
                if any(not name.startswith("controller/") for name in controller) or any(name.startswith("controller/") for name in files):
                    raise VerificationError("actor and controller package trees must have separate component ownership")
                if files.keys() & controller.keys():
                    raise VerificationError("actor/policy duplicate bundle paths")
                initial = self.bundles.initial({**files, **controller}, config.pins.initial_bundle)
            else:
                assert retained is not None
                initial = retained.closure.complete_initial_bundle
            self.provenance = ArtifactProvenance(directory / "grants", self.objects, grant)
            self.resources.callback(self.provenance.close)
            self.refiner = GatewayRefiner(self.gateway)
            op_validator, gen_validator = OperationValidator(self.objects), GenerationValidator(self.objects)
            self.names = frozenset(spec.name for spec in self.adapter.describe().operations)
            bridge = BenchmarkEffectAdapter(self.adapter, self.objects, "local://counter", allowed_operations=self.names)
            rules = tuple(AdmissionRule("counter", "benchmark." + name, "local://counter", self.scope, self.pin,
                op_validator.identity, 1000000, 128, (), True) for name in sorted(self.names)) + (
                AdmissionRule("refiner", "model.generate", contract.endpoint, self.scope, self.refiner.identity,
                    gen_validator.identity, 1000000, 128, contract.reservation(self.gateway.bound).components, True),)
            self.broker = CapabilityBroker(self.objects, (), {"counter": bridge, "refiner": self.refiner},
                ScopedAdmission(self.objects, self.provenance, rules, (op_validator, gen_validator)))
            stream = read_json(self.objects.read(config.workload.task_stream))
            task_names = [string(v) for v in sequence(stream["tasks"])]
            if not task_names:
                raise VerificationError("empty task horizon")
            random.Random(config.seeds.workload).shuffle(task_names)
            task_map = {task.task_id: task for task in self.adapter.enumerate_tasks()}
            if any(t not in task_map for t in task_names):
                raise VerificationError("task stream contains unknown task")
            self.assignments = tuple(EpisodeAssignment(EpisodeId(f"episode-{i}"), task_map[name], self.adapter.grouping,
                (name,)) for i, name in enumerate(task_names))
            if creating:
                models = tuple(ResolvedModel(m.name, ModelResolution(contract.endpoint, contract.account, contract.protocol,
                    price_ref, self.gateway.bound, m.binding.request_options, None, SeedSupport.UNSUPPORTED, None)) for m in config.models)
                operations = tuple(ResolvedOperation("benchmark." + op.name, op.recovery.capabilities) for op in self.adapter.describe().operations)
                operations += (ResolvedOperation("model.generate", frozenset({RecoveryCapability.SUSPEND, RecoveryCapability.OPERATION_LOOKUP})),)
                assert source is not None
                self.manifest = resolved(self.objects, source, config, initial, models, operations, sandbox_ref,
                    (self.adapter.closure, self.gateway.bound, executable_ref),
                    tuple(ref for op in self.adapter.describe().operations for ref in (op.argument_schema, op.result_schema)))
                self.reader = self.store.create_run(RunId(run_id), self.scope,
                    {kind: {ProducerKind.TRUSTED_SCORER: config.pins.scorer, ProducerKind.BROKER: config.pins.model_gateway,
                        ProducerKind.TRUSTED_ADAPTER: config.pins.adapters}.get(kind, self.runtime) for kind in ProducerKind})
                self.writer = self.store.writer(RunId(run_id))
                self.resources.callback(self.writer.close)
                binding = RunBinding(self.objects.publish(encode(self.manifest)), config.pins.runtime, config.pins.verifier,
                    config.pins.adapters, config.pins.scorer, config.workload.initial_snapshot, initial, config.models,
                    config.budget, self.broker.policy_reference, config.run.editable, config.feedback, config.comparison,
                    config.run.mode, DeclaredLineage(self.scope.lineage_id, None, None, grant), (), config.pins.model_gateway)
                self.writer.port(ProducerKind.RUN_SETUP).append(binding, causal=CausalIdentity(None, None, None, None), epoch=self.writer.epoch)
                self.writer.port(ProducerKind.RUN_SETUP).append(Annotation("workflow.context", json_bytes(
                    context or {"campaign": run_id, "arm": "standalone"})),
                    causal=CausalIdentity(self.reader.verify().records[-1].envelope.record_id, None, None, None), epoch=self.writer.epoch)
                atomic_file(directory / "resolved.json", json_bytes(self.manifest))
            else:
                assert retained is not None
                self.manifest = retained
                if self.objects.read(retained.closure.timeout_and_retry_settings) != self.backend.profile().to_bytes():
                    raise VerificationError("sandbox changed on resume")
            self.bundles.state = self.reader.verify
            self.sandbox = BundleSandbox(self.bundles, self.backend)
            self.supervisor = Supervisor(self.writer, self.broker, compatible_bundle=self.bundles.compatible, sandbox=self.sandbox)
            interval = next(integer(p.value, 1) for p in config.policy.parameters.parameters if p.name == "refine_every_episodes")
            if not config.run.editable or lineage == "audit":
                interval = len(self.assignments) + 1
            self.selector = EvidenceSelector(self.broker)
            self.policy = ContinualRefine(self.supervisor, self.bundles, self.sandbox, self.selector, self.provenance,
                RefinerRoute("refiner", contract.endpoint, next(m.binding for m in config.models if m.name == "refiner"),
                    contract.reservation(self.gateway.bound).components), interval=interval)
        except BaseException:
            self.resources.close()
            raise

    def drive(self) -> VerifiedState:
        ensure_mutable(self.directory)
        try:
            self.policy.run(self.adapter, self.assignments, {name: ("counter", "local://counter") for name in self.names},
                            CounterProgram(self.objects, self.config.seeds.workload))
            state = self.supervisor.state
            if state.execution_status is ExecutionStatus.CONTINUE and len(state.measurements) == len(self.assignments):
                self.supervisor.accept(StepOutput(Finish("declared horizon complete"), state.private_state), expected_head=state.head)
        except VerificationError as error:
            state = self.supervisor.state
            self.writer.port(ProducerKind.OPERATOR).append(Annotation("workflow.failure", json_bytes({"reason": str(error)})),
                causal=CausalIdentity(state.records[-1].envelope.record_id, None, None, None), epoch=self.writer.epoch)
            self.supervisor.state = self.reader.verify()
            if state.pending_command is None and state.execution_status is ExecutionStatus.CONTINUE:
                try:
                    self.supervisor.accept(StepOutput(Suspend(str(error)), state.private_state), expected_head=self.supervisor.state.head)
                except VerificationError:
                    pass  # Ambiguous effects retain their existing recovery state.
        return self.reader.verify()

    def close(self) -> None:
        self.resources.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()


def run(root: Path, path: Path, run_id: str, *, display: Callable[[str], None] = print,
        dispatch: bool = True) -> VerifiedState:
    directory = run_directory(root, run_id)
    durable_directory(directory.parent)
    directory.mkdir(mode=0o700)  # Existing identity, even interrupted setup, is never reused.
    fsync_directory(directory.parent)
    with Session(directory, run_id, source=path.read_text(), base=path.parent) as session:
        display("Resolved configuration before dispatch:\n" + json_bytes(session.manifest).decode())
        return session.drive() if dispatch else session.reader.verify()


def resume(root: Path, run_id: str, *, overrides: dict[str, object] | None = None) -> VerifiedState:
    if overrides:
        raise VerificationError("scientific overrides on resume are forbidden; start a new run")
    with Session(run_directory(root, run_id), run_id) as session:
        return session.drive()
