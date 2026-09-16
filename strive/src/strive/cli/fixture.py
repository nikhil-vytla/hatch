"""Pinned, zero-network counter program and recorded-response provider."""
import json
from pathlib import Path

from ..benchmarks.api import EpisodeSnapshot, ToolInvocation
from ..benchmarks.bridge import OperationRequest
from ..benchmarks.episodes import EpisodeAssignment
from ..codec import encode
from ..contracts.primitives import ArtifactRef, RevisionId
from ..errors import VerificationError
from ..harness.provider import json_object
from ..policy.data import Edit, Proposal, dumps
from ..store.cas import CAS
from .data import json_bytes

CONTROLLER = b"function step(view,state,result,handles,actor) { return actor(view,state,result,handles); }"
ACTOR = b'''function step(view,state,result,handles,files) {
 const delta = Number(atob(files["prompts/delta.txt"])) + Number(atob(files["memory/delta.txt"]));
 return {type:"StepOutput",fields:{command:{type:"Continue",fields:{}},
 proposed_private_state:{bytes:btoa(JSON.stringify({delta}))},annotations:{tuple:[]}}};
}'''


def initial_tree(objects: CAS) -> ArtifactRef:
    return objects.publish(encode(tuple((name, objects.publish(data)) for name, data in (
        ("actor/step.js", ACTOR), ("memory/delta.txt", b"0"), ("prompts/delta.txt", b"1")))))


def policy_tree(objects: CAS) -> ArtifactRef:
    return objects.publish(encode((("controller/step.js", objects.publish(CONTROLLER)),)))


class FixtureProvider:
    """One deterministic completion from permitted context, without I/O."""
    def generate(self, request: bytes, operation_key: str) -> bytes:
        raw = json_object(request)
        text = raw.get("input")
        if not isinstance(text, str):
            raise VerificationError("fixture expects retained text request")
        context, _ = json.JSONDecoder().raw_decode(text)
        if not isinstance(context, dict) or not isinstance(context.get("revision"), str):
            raise VerificationError("fixture requires a revision")
        proposal = Proposal(RevisionId(context["revision"]), "revise", (Edit("prompts/delta.txt", b"7"),),
                            rationale="Recorded counter fixture response; not a scientific claim.")
        return json_bytes({"model": "counter-refiner/1", "status": "completed", "output": [
            {"type": "message", "content": [{"type": "output_text", "text": dumps(proposal).decode()}]}],
            "usage": {"input_tokens": 1, "output_tokens": 1}})

    def lookup(self, operation_key: str) -> None:
        return None


class CounterProgram:
    def __init__(self, objects: CAS, seed: int) -> None:
        self.objects, self.seed = objects, seed

    def initialization(self, assignment: EpisodeAssignment) -> ArtifactRef:
        return self.objects.publish(b"{}")

    def operation(self, snapshot: EpisodeSnapshot, current: ArtifactRef, action: bytes) -> OperationRequest:
        if snapshot.version == 0:
            delta = json_object(action).get("delta")
            return OperationRequest(snapshot.episode, snapshot.environment, current, snapshot, "agent_tool",
                (ToolInvocation("move", "add", self.objects.publish(json_bytes({"delta": delta}))),))
        return OperationRequest(snapshot.episode, snapshot.environment, current, snapshot, "terminate",
                                (self.objects.publish(b'"done"'),))


def example(directory: Path) -> Path:
    """Create a reviewable fixture manifest with no provider credentials."""
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "counter.toml"
    path.write_text('''schema = "strive.run/1"
[run]
mode = "research"
editable = ["actor.code", "actor.prompts", "actor.memory"]
capabilities = "builtin:capabilities"
[pins]
runtime = "builtin:runtime"
verifier = "builtin:verifier"
adapters = "builtin:counter"
scorer = "builtin:scorer"
initial_bundle = "builtin:actor"
model_gateway = "builtin:gateway"
[policy]
package = "builtin:policy"
entrypoint = "policy:step"
refine_every_episodes = 1
optional_dev_forks = false
[workload]
implementation = "builtin:workload"
initial_snapshot = "builtin:initial"
task_stream = "builtin:stream"
dev_corpus = "builtin:corpus"
[feedback]
contract = "A"
operational_failures_visible = true
audit_plan = "builtin:audit-plan"
audit_release = "after-campaign-freeze"
[comparison]
strictness = "matched"
plan = "builtin:comparison-plan"
allowed_differences = ["run.editable"]
[models.actor]
provider = "fixture"
model = "counter-actor/1"
request_options = "builtin:options"
max_input_tokens = 100
max_output_tokens = 100
fallback = "forbid"
[models.refiner]
provider = "fixture"
model = "counter-refiner/1"
request_options = "builtin:options"
max_input_tokens = 100
max_output_tokens = 100
fallback = "forbid"
[seeds]
workload = 17
policy = 17
model_request = 17
[budget]
usd = 0
tokens = 10000
model_calls = 10
wall_seconds = 120
price_schedule = "builtin:prices"
includes = ["acting", "refinement", "retries", "audit"]
[recovery."benchmark.initialize"]
strategy = "reconcile"
require_operation_lookup = true
native_session_resume = false
automatic_redispatch = false
unknown_usage = "retain_reservation"
[recovery."model.generate"]
strategy = "suspend_if_ambiguous"
native_session_resume = false
automatic_redispatch = false
unknown_usage = "retain_reservation"
[telemetry]
semconv = "1.41.0"
profile = "langfuse"
content_export = "authorized-development"
sampling = "all"
''')
    return path
