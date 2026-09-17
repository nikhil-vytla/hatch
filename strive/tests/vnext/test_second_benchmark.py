from dataclasses import replace
import hashlib
import json
from pathlib import Path

import pytest

from strive.benchmarks.api import BenchmarkAdapter, EpisodeSnapshot, ToolInvocation
from strive.benchmarks.bridge import BenchmarkEffectAdapter, OperationRequest, OperationValidator
from strive.benchmarks.episodes import EpisodeAssignment, EpisodeDriver
from strive.benchmarks.json_data import canonical
from strive.benchmarks.payloads import loads
from strive.benchmarks.store import OperationStore
from strive.contracts.manifest import load_resolved_configuration
from strive.contracts.primitives import AccessScope, EnvironmentId, EpisodeId, LineageId, RunId
from strive.contracts.records import CausalIdentity, DeclaredLineage, ProducerKind, RunBinding
from strive.errors import VerificationError
from strive.runtime.admission import AdmissionRule, ArtifactProvenance, ScopedAdmission
from strive.runtime.broker import CapabilityBroker
from strive.runtime.supervisor import Supervisor
from strive.store import ArtifactStore
from strive_benchmark_counter import CounterAdapter
from .fixtures import AUTHORED_TOML
from .fresh_probe import fresh_replay
from .test_runtime import Crash

ROOT = Path(__file__).resolve().parents[2]


def test_second_benchmark_zero_core_diff_discovery_operations_scoring_recovery(tmp_path: Path) -> None:
    freeze = json.loads((ROOT / "tests/vnext/baselines/second-benchmark-core-freeze.json").read_text())
    assert all(hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == digest for name, digest in freeze.items())
    store = ArtifactStore(tmp_path / "artifacts")
    objects = store.objects
    pin = objects.publish(b"integer-target fixture infrastructure")
    scope = AccessScope(RunId("run-1"), LineageId("development"), pin)
    operation_store = OperationStore(tmp_path / "operations", objects, scope.run_id, pin, 1, create=True)
    adapter = CounterAdapter(operation_store, objects)
    protocol: BenchmarkAdapter = adapter
    assert len(protocol.enumerate_tasks()) == 2 and len(protocol.declare_splits()) == 2
    assert not protocol.describe().has_user_simulator
    reader = store.create_run(scope.run_id, scope, {kind: adapter.scorer.identity if kind is ProducerKind.TRUSTED_SCORER else pin for kind in ProducerKind})
    writer = store.writer(scope.run_id)
    provenance = ArtifactProvenance(tmp_path / "grants", objects, pin)
    validator = OperationValidator(objects)
    names = frozenset(spec.name for spec in adapter.describe().operations)
    bridge = BenchmarkEffectAdapter(adapter, objects, "local://integer-target", allowed_operations=names)
    admission = ScopedAdmission(objects, provenance, tuple(AdmissionRule("counter", "benchmark." + name, "local://integer-target", scope,
        pin, validator.identity, 1000000, 32, ()) for name in names), (validator,))
    broker = CapabilityBroker(objects, (), {"counter": bridge}, admission)
    config = load_resolved_configuration(AUTHORED_TOML.replace("./artifact", pin.digest))
    binding = RunBinding(pin, pin, pin, pin, adapter.scorer.identity, pin, pin, config.models, config.budget, broker.policy_reference,
        config.run.editable, config.feedback, config.comparison, config.run.mode, DeclaredLineage(scope.lineage_id, None, None, pin), (), pin)
    writer.port(ProducerKind.RUN_SETUP).append(binding, causal=CausalIdentity(None, None, None, None), epoch=writer.epoch)
    supervisor = Supervisor(writer, broker)
    task = adapter.enumerate_tasks()[0]
    assignment = EpisodeAssignment(EpisodeId("integer-target"), task, adapter.grouping, (task.task_id,))
    driver = EpisodeDriver(supervisor, adapter, assignment, {name: ("counter", "local://integer-target") for name in names}, provenance)
    try:
        driver.perform(OperationRequest(assignment.episode, EnvironmentId("counter"), pin, None, "initialize", (task, objects.publish(b"{}"))))
        driver.consume()
        initial = operation_store.head(assignment.episode)
        assert initial is not None and protocol.plan_user_turn(initial, pin) is None
        current = supervisor.state.environment
        assert current is not None
        call = ToolInvocation("move", "add", objects.publish(canonical({"delta": 7})))
        def crash(point: str) -> None:
            if point == "after-commit":
                raise Crash()
        operation_store.fault = crash
        with pytest.raises(Crash):
            driver.perform(OperationRequest(assignment.episode, EnvironmentId("counter"), current, initial, "agent_tool", (call,)))
        writer.close(); operation_store.close()
        writer = store.writer(scope.run_id)
        operation_store = OperationStore(tmp_path / "operations", objects, scope.run_id, pin, writer.epoch)
        adapter.store = operation_store; adapter.scorer.store = operation_store
        supervisor = Supervisor(writer, broker)
        driver = EpisodeDriver(supervisor, adapter, assignment, driver.routes, provenance)
        supervisor.recover(); driver.consume()
        current = supervisor.state.environment
        assert current is not None
        after = loads(objects.read(current), EpisodeSnapshot)
        assert after.version == 1
        with pytest.raises(VerificationError, match="rewind"):
            adapter.open_committed_snapshot(initial)
        driver.perform(OperationRequest(assignment.episode, EnvironmentId("counter"), current, after, "terminate", (objects.publish(canonical("done")),)))
        driver.consume()
        assert driver.score().metrics[0].value == 1
        fresh_replay(tmp_path / "artifacts", corrupt=False, benchmark=True)
        assert len(reader.verify().consumed_results) == 3
        assert all(hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == digest for name, digest in freeze.items())
    finally:
        writer.close(); operation_store.close(); provenance.close()
