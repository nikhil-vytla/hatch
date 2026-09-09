"""Closed RPC dispatch in the separately installed adapter environment."""
import os
from pathlib import Path
import sys

from strive.vnext.benchmarks.api import (CapturedGeneration, EpisodeSnapshot, OperationContext, TaskSpec, ToolInvocation, UserTurnPlan, ScoringInput)
from strive.vnext.benchmarks.json_data import canonical, items, obj, parse, string
from strive.vnext.benchmarks.payloads import dumps, loads
from strive.vnext.benchmarks.store import OperationStore
from strive.vnext.codec import decode
from strive.vnext.contracts.primitives import ArtifactRef, EffectId, EpisodeId, RunId
from strive.vnext.errors import VerificationError
from strive.vnext.store.cas import CAS
from .adapter import Tau2Adapter, implementation_identity
from .process import IsolatedTau2
from .qualification import Qualification


def assemble(configuration: tuple[object, ...], *, create: bool) -> Tau2Adapter:
    # Configuration is retained by trusted composition, never obtained from a
    # candidate operation. The current lease epoch is supplied on each restart.
    match configuration:
        case (str() as cas_path, str() as database_path, str() as run, int() as epoch,
              ArtifactRef() as closure, ArtifactRef() as data_index, ArtifactRef() as report):
            objects = CAS(Path(cas_path))
        case _:
            raise VerificationError("invalid remote adapter configuration")
    value = decode(objects.read(report))
    if not isinstance(value, tuple) or len(value) != 12 or value[0] != "qualified-telecom/1":
        raise VerificationError("remote adapter requires full inventory qualification")
    implementation, inventory, splits = value[1:4]
    if not all(isinstance(ref, ArtifactRef) for ref in (implementation, inventory, splits)):
        raise VerificationError("invalid qualification references")
    assert isinstance(implementation, ArtifactRef) and isinstance(inventory, ArtifactRef) and isinstance(splits, ArtifactRef)
    groups, development, validation, audit = value[5:9]
    if (not isinstance(groups, tuple) or not all(isinstance(group, tuple) and all(isinstance(t, str) for t in group) for group in groups)
            or not all(isinstance(ids, tuple) and all(isinstance(t, str) for t in ids) for ids in (development, validation, audit))):
        raise VerificationError("invalid qualified memberships")
    assert isinstance(development, tuple) and isinstance(validation, tuple) and isinstance(audit, tuple)
    qualification = Qualification(inventory, splits, implementation, report, groups, development, validation, audit)
    backend = IsolatedTau2(Path(sys.executable), Path(os.environ["TAU2_DATA_DIR"]), objects, closure, data_index)
    identity = implementation_identity(objects, backend, qualification, closure)
    operations = OperationStore(Path(database_path), objects, RunId(run), identity, epoch, create=create)
    source = parse(objects.read(inventory))
    if isinstance(source, dict):
        source = source.get("tasks")
    selected = set(development + validation + audit)
    tasks = tuple(TaskSpec(string(obj(task)["id"]), next(group[0] for group in groups if obj(task)["id"] in group),
        objects.publish(canonical(task)), objects.publish(canonical(obj(task)["evaluation_criteria"])))
        for task in items(source) if obj(task)["id"] in selected)
    return Tau2Adapter(objects, backend, tasks, qualification, closure, operations)


def dispatch(adapter: Tau2Adapter, operation: str, args: tuple[object, ...]) -> object:
    match operation, args:
        case "bootstrap" | "describe", ():
            return adapter.describe()
        case "enumerate_tasks", ():
            return adapter.enumerate_tasks()
        case "declare_splits", ():
            return adapter.declare_splits()
        case "initialize", (OperationContext() as context, TaskSpec() as task, ArtifactRef() as initial):
            return adapter.initialize(context, task, initial)
        case "agent_tool", (OperationContext() as context, ToolInvocation() as call):
            return adapter.agent_tool(context, call)
        case "user_tool", (OperationContext() as context, ToolInvocation() as call):
            return adapter.user_tool(context, call)
        case "plan_user_turn", (EpisodeSnapshot() as snapshot, ArtifactRef() as message):
            return adapter.plan_user_turn(snapshot, message)
        case "user_turn", (OperationContext() as context, UserTurnPlan() as plan, CapturedGeneration() as generation):
            return adapter.user_turn(context, plan, generation)
        case "deliver_message", (OperationContext() as context, ArtifactRef() as message):
            return adapter.deliver_message(context, message)
        case "terminate", (OperationContext() as context, ArtifactRef() as termination):
            return adapter.terminate(context, termination)
        case "snapshot", (OperationContext() as context,):
            return adapter.snapshot(context)
        case "lookup_operation", (str() as episode, str() as effect, ArtifactRef() as request):
            return adapter.lookup_operation(EpisodeId(episode), EffectId(effect), request)
        case "open_committed_snapshot", (EpisodeSnapshot() as snapshot,):
            adapter.open_committed_snapshot(snapshot)
            return None
        case "score", (ScoringInput() as inputs,):
            return adapter.scorer.score(inputs)
        case _:
            raise VerificationError("unknown RPC method or malformed arguments")


def main() -> None:
    request = loads(sys.stdin.buffer.read(32 * 1024 * 1024), tuple)
    if len(request) != 3 or not isinstance(request[0], tuple) or not isinstance(request[1], str) or not isinstance(request[2], tuple):
        raise VerificationError("invalid adapter RPC envelope")
    configuration, operation, args = request
    adapter = assemble(configuration, create=operation == "bootstrap")
    try:
        sys.stdout.buffer.write(dumps(dispatch(adapter, operation, args)))
    finally:
        adapter.store.close()


if __name__ == "__main__":
    main()
