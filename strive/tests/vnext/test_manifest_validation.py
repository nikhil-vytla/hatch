"""Adversarial schema and retained-closure checks, without resolving artifacts."""

from dataclasses import replace
from decimal import Decimal, localcontext

import pytest

from strive.vnext.contracts.bindings import ModelResolution
from strive.vnext.contracts.lifecycle import RecoveryCapability
from strive.vnext.contracts.manifest import (
    CostPhase, ManifestError, PolicyObject, ResolvedClosure, ResolvedManifest,
    ResolvedModel, ResolvedOperation, load_authored_manifest, load_resolved_configuration,
)
from strive.vnext.contracts.primitives import ArtifactRef, SeedSupport, Usd

from .fixtures import AUTHORED_TOML, REF, RESOLVED_TOML


def _resolved() -> ResolvedManifest:
    configuration = load_resolved_configuration(RESOLVED_TOML)
    models = tuple(ResolvedModel(model.name, ModelResolution(
        provider_endpoint="https://provider.invalid/v1", account_binding="external-account-handle",
        protocol="openai", price_schedule=REF, bound_method=REF, effective_request_options=REF,
        harness_seed_support=SeedSupport.UNSUPPORTED if model.binding.harness else None,
        provider_seed_support=SeedSupport.UNSUPPORTED,
        harness_native_identifier="openai/gpt-5.6-luna" if model.binding.harness else None,
    )) for model in configuration.models)
    return ResolvedManifest(configuration, REF, REF, ResolvedClosure(
        runtime_and_platform=REF, dependency_artifacts=(REF,), controller_package=REF,
        controller_initial_state=REF, complete_initial_bundle=REF, actor_artifacts=(REF,),
        imported_memory=(), tool_schemas=(REF,), timeout_and_retry_settings=REF,
        workload_and_scorer_definitions=REF, model_resolutions=models,
        operation_descriptors=(
            ResolvedOperation("model.generate", frozenset({RecoveryCapability.SUSPEND})),
            ResolvedOperation("benchmark.tool", frozenset({RecoveryCapability.OPERATION_LOOKUP})),
        ),
        enabled_cost_phases=frozenset({CostPhase.ACTING, CostPhase.REFINEMENT, CostPhase.USER_SIMULATION}),
    ))


def test_resolved_manifest_requires_recovery_supported_by_pinned_adapter() -> None:
    manifest = _resolved()
    unsupported = replace(manifest.closure, operation_descriptors=(
        manifest.closure.operation_descriptors[0], ResolvedOperation("benchmark.tool", frozenset()),
    ))
    with pytest.raises(ManifestError, match="unsupported adapter recovery capability"):
        replace(manifest, closure=unsupported)


def test_resolved_manifest_keeps_harness_and_provider_seed_support_separate() -> None:
    manifest = _resolved()
    actor = manifest.closure.model_resolutions[0]
    assert actor.resolution.harness_seed_support is SeedSupport.UNSUPPORTED
    assert actor.resolution.provider_seed_support is SeedSupport.UNSUPPORTED
    assert manifest.configuration.seeds.model_request == 17  # Requested seed is not a support claim.
    invalid = replace(actor, resolution=replace(actor.resolution, harness_seed_support=None))
    with pytest.raises(ManifestError, match="harness seed support"):
        replace(manifest, closure=replace(manifest.closure, model_resolutions=(invalid,) + manifest.closure.model_resolutions[1:]))


def test_resolved_manifest_rejects_missing_or_conflicting_model_resolution() -> None:
    manifest = _resolved()
    with pytest.raises(ManifestError, match="cover every model exactly once"):
        replace(manifest, closure=replace(manifest.closure, model_resolutions=()))
    actor = manifest.closure.model_resolutions[0]
    invalid = replace(actor, resolution=replace(actor.resolution, price_schedule=ArtifactRef("sha256:" + "b" * 64)))
    with pytest.raises(ManifestError, match="conflicting price schedules"):
        replace(manifest, closure=replace(manifest.closure, model_resolutions=(invalid,) + manifest.closure.model_resolutions[1:]))


def test_resolved_manifest_charges_enabled_phases_outside_policy_defaults() -> None:
    manifest = _resolved()
    closure = replace(manifest.closure, enabled_cost_phases=manifest.closure.enabled_cost_phases | {CostPhase.RECONCILIATION})
    with pytest.raises(ManifestError, match="reconciliation"):
        replace(manifest, closure=closure)


def test_policy_parameters_require_the_pinned_validator_without_opening_core_tables() -> None:
    def custom_policy(parameters: PolicyObject) -> None:
        if len(parameters.parameters) != 1 or parameters.parameters[0].name != "learning_rate":
            raise ManifestError("custom policy requires learning_rate")
        if parameters.parameters[0].value != Decimal("0.125"):
            raise ManifestError("unexpected learning rate")

    source = AUTHORED_TOML.replace("refine_every_episodes = 20\noptional_dev_forks = false", "learning_rate = 0.125")
    with pytest.raises(ManifestError, match="unknown policy"):
        load_authored_manifest(source)
    assert load_authored_manifest(source, policy_validator=custom_policy).policy.parameters.parameters[0].value == Decimal("0.125")
    with pytest.raises(ManifestError, match="unknown core"):
        load_authored_manifest(source.replace("[run]", "[run]\nlearning_rate = 0.125"), policy_validator=custom_policy)


def test_a_can_omit_validation_while_b_requires_an_explicit_pool() -> None:
    source = AUTHORED_TOML.replace('validation_corpus = "./artifact"\n', "")
    assert load_authored_manifest(source).workload.validation_corpus is None
    with pytest.raises(ManifestError, match="validation_corpus"):
        load_authored_manifest(source.replace('contract = "A"', 'contract = "B"'))


def test_direct_provider_bindings_do_not_require_a_harness_table() -> None:
    before, rest = AUTHORED_TOML.split("[harnesses.opencode]", 1)
    _, after = rest.split("[seeds]", 1)
    source = (before + "[seeds]" + after).replace('harness = "opencode"\n', "")
    manifest = load_authored_manifest(source)
    assert not manifest.harnesses
    assert all(model.binding.harness is None for model in manifest.models)


def test_backend_names_are_registry_keys_not_a_closed_enum() -> None:
    manifest = load_authored_manifest(AUTHORED_TOML.replace("opencode", "independent_backend"))
    assert manifest.harnesses[0].binding.backend == "independent_backend"


def test_money_does_not_round_under_the_callers_decimal_context() -> None:
    with localcontext() as context:
        context.prec = 2
        assert Usd.from_decimal(Decimal("123.000000001")).nanodollars == 123_000_000_001


@pytest.mark.parametrize(("section", "key"), [
    ("run", "mode"), ("run", "editable"), ("run", "capabilities"),
    ("pins", "runtime"), ("pins", "verifier"), ("pins", "adapters"), ("pins", "scorer"),
    ("pins", "initial_bundle"), ("pins", "model_gateway"),
    ("policy", "package"), ("policy", "entrypoint"),
    ("workload", "implementation"), ("workload", "initial_snapshot"),
    ("workload", "task_stream"), ("workload", "dev_corpus"),
    ("feedback", "contract"), ("feedback", "operational_failures_visible"),
    ("feedback", "audit_plan"), ("feedback", "audit_release"),
    ("comparison", "strictness"), ("comparison", "plan"), ("comparison", "allowed_differences"),
    ("models.actor", "provider"), ("models.actor", "model"), ("models.actor", "request_options"),
    ("models.actor", "max_input_tokens"), ("models.actor", "max_output_tokens"), ("models.actor", "fallback"),
    ("harnesses.opencode", "interface"), ("harnesses.opencode", "backend"),
    ("harnesses.opencode", "adapter"), ("harnesses.opencode", "executable"), ("harnesses.opencode", "version"),
    ("harnesses.opencode", "level"), ("harnesses.opencode", "launch_profile"), ("harnesses.opencode", "sandbox_profile"),
    ("harnesses.opencode", "model_transport"), ("harnesses.opencode", "native_tools"),
    ("harnesses.opencode", "session_policy"), ("harnesses.opencode", "max_provider_requests"), ("harnesses.opencode", "deadline_seconds"),
    ("seeds", "workload"), ("seeds", "policy"), ("budget", "usd"), ("budget", "tokens"),
    ("budget", "model_calls"), ("budget", "wall_seconds"), ("budget", "price_schedule"), ("budget", "includes"),
    ('recovery."model.generate"', "strategy"), ('recovery."model.generate"', "native_session_resume"),
    ('recovery."model.generate"', "automatic_redispatch"), ('recovery."model.generate"', "unknown_usage"),
    ("telemetry", "semconv"), ("telemetry", "profile"), ("telemetry", "content_export"), ("telemetry", "sampling"),
])
def test_manifest_rejects_each_missing_required_key(section: str, key: str) -> None:
    before, table = AUTHORED_TOML.split(f"[{section}]\n", 1)
    lines = table.splitlines(keepends=True)
    index = next(index for index, line in enumerate(lines) if line.startswith(f"{key} ="))
    del lines[index]
    with pytest.raises(ManifestError, match="missing required keys"):
        load_authored_manifest(before + f"[{section}]\n" + "".join(lines))
