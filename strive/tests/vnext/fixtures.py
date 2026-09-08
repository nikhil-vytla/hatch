"""In-memory configuration and identities; no providers, files, or execution."""

from strive.vnext.contracts.lifecycle import DispatchStage, RecoveryCapability, RecoveryContract
from strive.vnext.contracts.primitives import (
    AccessScope, ArtifactRef, CommandId, EffectId, EnvironmentId, LineageId,
    Reservation, Resource, ResourceQuantity, RunId,
)
from strive.vnext.contracts.records import EffectAuthorization

REF = ArtifactRef("sha256:" + "a" * 64)
SCOPE = AccessScope(RunId("run-1"), LineageId("development"), REF)


def authorization() -> EffectAuthorization:
    return EffectAuthorization(
        command_id=CommandId("command-1"), effect_id=EffectId("effect-1"),
        exact_request_reference=REF, executing_bundle=REF, adapter=REF,
        operation="model.generate", target_environment=EnvironmentId("environment-1"),
        permitted_scope=SCOPE,
        reservation=Reservation((ResourceQuantity(Resource.INPUT_TOKENS, 16_384),), REF),
        recovery_contract=RecoveryContract(frozenset({RecoveryCapability.SUSPEND}), False, False),
        execution_epoch=1, dispatch_stage=DispatchStage.UPSTREAM_FORWARD,
        harness_binding_reference=REF, generation_envelope=REF,
        input_references=(REF,), actual_provider_request_reference=REF,
    )


AUTHORED_TOML = '''schema = "strive.run/1"

[run]
mode = "trusted"
editable = ["actor.code", "actor.prompts", "actor.memory"]
capabilities = "./artifact"

[pins]
runtime = "./artifact"
verifier = "./artifact"
adapters = "./artifact"
scorer = "./artifact"
initial_bundle = "./artifact"
model_gateway = "./artifact"

[policy]
package = "./artifact"
entrypoint = "policy:step"
refine_every_episodes = 20
optional_dev_forks = false

[workload]
implementation = "./artifact"
initial_snapshot = "./artifact"
task_stream = "./artifact"
dev_corpus = "./artifact"
validation_corpus = "./artifact"

[feedback]
contract = "A"
operational_failures_visible = true
audit_plan = "./artifact"
audit_release = "after-campaign-freeze"

[comparison]
strictness = "matched"
plan = "./artifact"
allowed_differences = ["policy.package", "run.editable"]

[models.actor]
provider = "openai"
model = "gpt-5.6-luna"
harness = "opencode"
request_options = "./artifact"
max_input_tokens = 16384
max_output_tokens = 2048
fallback = "forbid"

[models.refiner]
provider = "openai"
model = "gpt-5.6-luna"
harness = "opencode"
request_options = "./artifact"
max_input_tokens = 32768
max_output_tokens = 8192
fallback = "forbid"

[models.user]
provider = "openai"
model = "gpt-5.6-luna"
request_options = "./artifact"
max_input_tokens = 16384
max_output_tokens = 1024
fallback = "forbid"

[harnesses.opencode]
interface = "strive.harness/1"
backend = "opencode"
adapter = "./artifact"
executable = "./artifact"
version = "1.17.18"
level = "model"
launch_profile = "./artifact"
sandbox_profile = "./artifact"
model_transport = "broker_gateway"
native_tools = "none"
session_policy = "fresh"
max_provider_requests = 1
deadline_seconds = 180

[seeds]
workload = 17
policy = 17
model_request = 17

[budget]
usd = 20.000000001
tokens = 500000
model_calls = 300
wall_seconds = 3600
price_schedule = "./artifact"
includes = ["acting", "refinement", "user_simulation", "dev_evaluation", "validation", "audit", "retries", "adapter_acceptance"]

[recovery."model.generate"]
strategy = "suspend_if_ambiguous"
native_session_resume = false
automatic_redispatch = false
unknown_usage = "retain_reservation"

[recovery."benchmark.tool"]
strategy = "reconcile"
require_operation_lookup = true

[telemetry]
semconv = "1.41.0"
profile = "langfuse"
content_export = "authorized-development"
sampling = "all"
'''

RESOLVED_TOML = AUTHORED_TOML.replace("./artifact", REF.digest)
