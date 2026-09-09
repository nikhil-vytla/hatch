"""strive.run/1 structures and a pure TOML text loader, with no resolution I/O.

Unknown core keys fail at every table. Inline policy parameters are the one
extension point: the pinned policy must validate them. The default validator
accepts only the amended continual-policy parameters.
"""

from dataclasses import dataclass
from decimal import Decimal
from enum import StrEnum
import tomllib
from typing import Callable, Literal

from .bindings import HarnessBinding, ModelBinding, ModelResolution
from .feedback import FeedbackContract
from .lifecycle import RecoveryCapability
from .primitives import ArtifactRef, IntegrationLevel, TrustMode, Usd


class ManifestError(ValueError):
    pass


class ComparisonStrictness(StrEnum):
    MATCHED = "matched"
    DESCRIPTIVE = "descriptive"


class CostPhase(StrEnum):
    ACTING = "acting"
    REFINEMENT = "refinement"
    USER_SIMULATION = "user_simulation"
    DEV_EVALUATION = "dev_evaluation"
    VALIDATION = "validation"
    AUDIT = "audit"
    RETRIES = "retries"
    ADAPTER_ACCEPTANCE = "adapter_acceptance"
    RECONCILIATION = "reconciliation"


class RecoveryStrategy(StrEnum):
    RECONCILE = "reconcile"
    SUSPEND_IF_AMBIGUOUS = "suspend_if_ambiguous"
    RECOMPUTE_DETERMINISTIC = "recompute_deterministic"
    DEDUPLICATED_RETRY = "deduplicated_retry"


@dataclass(frozen=True, slots=True)
class RunTable[Ref]:
    mode: TrustMode
    editable: tuple[str, ...]
    capabilities: Ref


@dataclass(frozen=True, slots=True)
class PinsTable[Ref]:
    runtime: Ref
    verifier: Ref
    adapters: Ref
    scorer: Ref
    initial_bundle: Ref
    model_gateway: Ref


type PolicyValue = str | bool | int | Decimal | tuple[PolicyValue, ...] | PolicyObject


@dataclass(frozen=True, slots=True)
class PolicyParameter:
    name: str
    value: PolicyValue


@dataclass(frozen=True, slots=True)
class PolicyObject:
    parameters: tuple[PolicyParameter, ...]


type PolicyValidator = Callable[[PolicyObject], None]


@dataclass(frozen=True, slots=True)
class PolicyTable[Ref]:
    package: Ref
    entrypoint: str
    parameters: PolicyObject


@dataclass(frozen=True, slots=True)
class WorkloadTable[Ref]:
    implementation: Ref
    initial_snapshot: Ref
    task_stream: Ref
    dev_corpus: Ref
    validation_corpus: Ref | None


@dataclass(frozen=True, slots=True)
class FeedbackTable[Ref]:
    contract: FeedbackContract
    operational_failures_visible: bool
    audit_plan: Ref
    audit_release: Literal["after-campaign-freeze"]


@dataclass(frozen=True, slots=True)
class ComparisonTable[Ref]:
    strictness: ComparisonStrictness
    plan: Ref
    allowed_differences: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class NamedModel[Ref]:
    name: str
    binding: ModelBinding[Ref]


@dataclass(frozen=True, slots=True)
class NamedHarness[Ref]:
    name: str
    binding: HarnessBinding[Ref]


@dataclass(frozen=True, slots=True)
class SeedsTable:
    workload: int
    policy: int
    model_request: int | None


@dataclass(frozen=True, slots=True)
class BudgetTable[Ref]:
    usd: Usd
    tokens: int
    model_calls: int
    wall_seconds: int
    price_schedule: Ref
    includes: frozenset[CostPhase]


@dataclass(frozen=True, slots=True)
class RecoveryTable:
    strategy: RecoveryStrategy
    require_operation_lookup: bool = False
    native_session_resume: Literal[False] = False
    automatic_redispatch: Literal[False] = False
    unknown_usage: Literal["retain_reservation"] = "retain_reservation"


@dataclass(frozen=True, slots=True)
class OperationRecovery:
    operation: str
    settings: RecoveryTable


class TelemetryProfile(StrEnum):
    LANGFUSE = "langfuse"


@dataclass(frozen=True, slots=True)
class TelemetryTable:
    semconv: Literal["1.41.0"]
    profile: TelemetryProfile
    content_export: Literal["authorized-development"]
    sampling: Literal["all"]


@dataclass(frozen=True, slots=True)
class RunManifest[Ref]:
    schema: Literal["strive.run/1"]
    run: RunTable[Ref]
    pins: PinsTable[Ref]
    policy: PolicyTable[Ref]
    workload: WorkloadTable[Ref]
    feedback: FeedbackTable[Ref]
    comparison: ComparisonTable[Ref]
    models: tuple[NamedModel[Ref], ...]
    harnesses: tuple[NamedHarness[Ref], ...]
    seeds: SeedsTable
    budget: BudgetTable[Ref]
    recovery: tuple[OperationRecovery, ...]
    telemetry: TelemetryTable

    def __post_init__(self) -> None:
        if self.schema != "strive.run/1":
            raise ManifestError("schema: expected strive.run/1")
        if self.feedback.contract is FeedbackContract.C:
            raise ManifestError("feedback.contract: C is not implemented in release 1")
        for names, path in (([m.name for m in self.models], "models"),
                            ([h.name for h in self.harnesses], "harnesses"),
                            ([r.operation for r in self.recovery], "recovery")):
            if len(names) != len(set(names)):
                raise ManifestError(f"{path}: duplicate binding")
        models = {model.name for model in self.models}
        if not {"actor", "refiner"} <= models:
            raise ManifestError("models: actor and refiner bindings are required")
        harnesses = {harness.name for harness in self.harnesses}
        for model in self.models:
            if model.binding.harness is not None and model.binding.harness not in harnesses:
                raise ManifestError(f"models.{model.name}.harness: unknown harness binding")
        if self.feedback.contract is FeedbackContract.B and self.workload.validation_corpus is None:
            raise ManifestError("workload.validation_corpus: required for contract B")
        required = {CostPhase.ACTING, CostPhase.REFINEMENT, CostPhase.RETRIES}
        if "user" in models:
            required.add(CostPhase.USER_SIMULATION)
        if self.feedback.contract is FeedbackContract.B:
            required.add(CostPhase.VALIDATION)
        for parameter in self.policy.parameters.parameters:
            if parameter.name == "optional_dev_forks" and parameter.value is True:
                required.add(CostPhase.DEV_EVALUATION)
        validate_cost_phases(self.budget.includes, frozenset(required))


type AuthoredManifest = RunManifest[str]


@dataclass(frozen=True, slots=True)
class ResolvedModel:
    name: str
    resolution: ModelResolution


@dataclass(frozen=True, slots=True)
class ResolvedOperation:
    operation: str
    recovery_capabilities: frozenset[RecoveryCapability]


@dataclass(frozen=True, slots=True)
class ResolvedClosure:
    runtime_and_platform: ArtifactRef
    dependency_artifacts: tuple[ArtifactRef, ...]
    controller_package: ArtifactRef
    controller_initial_state: ArtifactRef
    complete_initial_bundle: ArtifactRef
    actor_artifacts: tuple[ArtifactRef, ...]
    imported_memory: tuple[ArtifactRef, ...]
    tool_schemas: tuple[ArtifactRef, ...]
    timeout_and_retry_settings: ArtifactRef
    workload_and_scorer_definitions: ArtifactRef
    model_resolutions: tuple[ResolvedModel, ...]
    operation_descriptors: tuple[ResolvedOperation, ...]
    enabled_cost_phases: frozenset[CostPhase]


@dataclass(frozen=True, slots=True)
class ResolvedManifest:
    """Retained identities only. This type does not resolve paths or hash bytes."""

    configuration: RunManifest[ArtifactRef]
    configuration_digest: ArtifactRef
    authored_manifest: ArtifactRef
    closure: ResolvedClosure

    def __post_init__(self) -> None:
        validate_cost_phases(self.configuration.budget.includes, self.closure.enabled_cost_phases)
        models = {model.name: model.binding for model in self.configuration.models}
        resolutions = {item.name: item.resolution for item in self.closure.model_resolutions}
        if len(resolutions) != len(self.closure.model_resolutions) or models.keys() != resolutions.keys():
            raise ManifestError("resolved model settings must cover every model exactly once")
        for name, resolution in resolutions.items():
            if not resolution.provider_endpoint or not resolution.account_binding or not resolution.protocol:
                raise ManifestError(f"models.{name}: endpoint, account binding, and protocol must resolve")
            if resolution.price_schedule != self.configuration.budget.price_schedule:
                raise ManifestError(f"models.{name}: conflicting price schedules")
            if (models[name].harness is None) != (resolution.harness_seed_support is None):
                raise ManifestError(f"models.{name}: record harness seed support separately")
        descriptors = {item.operation: item.recovery_capabilities for item in self.closure.operation_descriptors}
        if len(descriptors) != len(self.closure.operation_descriptors):
            raise ManifestError("duplicate resolved operation descriptor")
        for recovery in self.configuration.recovery:
            if recovery.operation not in descriptors:
                raise ManifestError(f"recovery.{recovery.operation}: no pinned adapter descriptor")
            needed: set[RecoveryCapability] = set()
            if recovery.settings.require_operation_lookup or recovery.settings.strategy is RecoveryStrategy.RECONCILE:
                needed.add(RecoveryCapability.OPERATION_LOOKUP)
            if recovery.settings.strategy is RecoveryStrategy.RECOMPUTE_DETERMINISTIC:
                needed.add(RecoveryCapability.RECOMPUTE_DETERMINISTIC)
            if recovery.settings.strategy is RecoveryStrategy.DEDUPLICATED_RETRY:
                needed.add(RecoveryCapability.DEDUPLICATED_RETRY)
            if recovery.settings.strategy is RecoveryStrategy.SUSPEND_IF_AMBIGUOUS:
                needed.add(RecoveryCapability.SUSPEND)
            if not needed <= descriptors[recovery.operation]:
                raise ManifestError(f"recovery.{recovery.operation}: unsupported adapter recovery capability")


def validate_cost_phases(includes: frozenset[CostPhase], enabled: frozenset[CostPhase]) -> None:
    missing = enabled - includes
    if missing:
        raise ManifestError(f"budget.includes: missing enabled phases {', '.join(sorted(missing))}")


def _mapping(value: object, path: str) -> dict[str, object]:
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise ManifestError(f"{path}: expected a table")
    return {str(key): item for key, item in value.items()}


class _Table:
    def __init__(self, value: object, path: str, required: str, optional: str = "") -> None:
        self.path = path
        self.values = _mapping(value, path)
        unknown = self.values.keys() - set(required.split()) - set(optional.split())
        if unknown:
            raise ManifestError(f"{path}: unknown core keys {', '.join(sorted(unknown))}")
        missing = set(required.split()) - self.values.keys()
        if missing:
            raise ManifestError(f"{path}: missing required keys {', '.join(sorted(missing))}")

    def string(self, key: str) -> str:
        value = self.values[key]
        if not isinstance(value, str) or not value:
            raise ManifestError(f"{self.path}.{key}: expected nonempty string")
        return value

    def strings(self, key: str) -> tuple[str, ...]:
        value = self.values[key]
        if not isinstance(value, list) or any(not isinstance(item, str) or not item for item in value):
            raise ManifestError(f"{self.path}.{key}: expected array of nonempty strings")
        return tuple(str(item) for item in value)

    def integer(self, key: str, minimum: int = 0) -> int:
        value = self.values[key]
        if type(value) is not int or value < minimum:
            raise ManifestError(f"{self.path}.{key}: expected integer >= {minimum}")
        return value

    def boolean(self, key: str) -> bool:
        value = self.values[key]
        if not isinstance(value, bool):
            raise ManifestError(f"{self.path}.{key}: expected boolean")
        return value

    def literal(self, key: str, expected: str | int | bool) -> None:
        value = self.values[key]
        if type(value) is not type(expected) or value != expected:
            raise ManifestError(f"{self.path}.{key}: expected {expected!r}")


def _policy_value(value: object, path: str) -> PolicyValue:
    if isinstance(value, (str, bool, int, Decimal)):
        if isinstance(value, Decimal) and not value.is_finite():
            raise ManifestError(f"{path}: nonfinite policy number")
        return value
    if isinstance(value, list):
        return tuple(_policy_value(item, path) for item in value)
    if isinstance(value, dict):
        return PolicyObject(tuple(PolicyParameter(key, _policy_value(item, f"{path}.{key}"))
                                  for key, item in _mapping(value, path).items()))
    raise ManifestError(f"{path}: unsupported policy value")


def validate_continual_parameters(parameters: PolicyObject) -> None:
    for parameter in parameters.parameters:
        if parameter.name == "refine_every_episodes":
            if type(parameter.value) is not int or parameter.value <= 0:
                raise ManifestError("policy.refine_every_episodes: expected positive integer")
        elif parameter.name == "optional_dev_forks":
            if not isinstance(parameter.value, bool):
                raise ManifestError("policy.optional_dev_forks: expected boolean")
        else:
            raise ManifestError(f"policy: unknown policy parameter {parameter.name}")


def _parse_model[Ref](value: object, path: str, ref: Callable[[str], Ref]) -> ModelBinding[Ref]:
    table = _Table(value, path, "provider model request_options max_input_tokens max_output_tokens fallback", "harness")
    table.literal("fallback", "forbid")
    return ModelBinding(table.string("provider"), table.string("model"), ref(table.string("request_options")),
                        table.integer("max_input_tokens", 1), table.integer("max_output_tokens", 1), "forbid",
                        table.string("harness") if "harness" in table.values else None)


def _parse_harness[Ref](value: object, path: str, ref: Callable[[str], Ref]) -> HarnessBinding[Ref]:
    table = _Table(value, path, "interface backend adapter executable version level launch_profile sandbox_profile "
                   "model_transport native_tools session_policy max_provider_requests deadline_seconds")
    for key, expected in (("interface", "strive.harness/1"), ("level", "model"),
                          ("model_transport", "broker_gateway"), ("native_tools", "none"), ("session_policy", "fresh")):
        table.literal(key, expected)
    table.literal("max_provider_requests", 1)
    return HarnessBinding("strive.harness/1", table.string("backend"), ref(table.string("adapter")),
                          ref(table.string("executable")), table.string("version"), IntegrationLevel.MODEL,
                          ref(table.string("launch_profile")), ref(table.string("sandbox_profile")),
                          "broker_gateway", "none", "fresh", 1, table.integer("deadline_seconds", 1))


def _parse_recovery(value: object, operation: str) -> OperationRecovery:
    model = operation == "model.generate"
    extra = "native_session_resume automatic_redispatch unknown_usage"
    table = _Table(value, f"recovery.{operation}", f"strategy {extra}" if model else "strategy",
                   "require_operation_lookup" if model else f"require_operation_lookup {extra}")
    for key in ("native_session_resume", "automatic_redispatch"):
        if key in table.values:
            table.literal(key, False)
    if "unknown_usage" in table.values:
        table.literal("unknown_usage", "retain_reservation")
    settings = RecoveryTable(RecoveryStrategy(table.string("strategy")),
                             table.boolean("require_operation_lookup") if "require_operation_lookup" in table.values else False)
    return OperationRecovery(operation, settings)


def _load[Ref](source: str, ref: Callable[[str], Ref], policy_validator: PolicyValidator) -> RunManifest[Ref]:
    try:
        data = tomllib.loads(source, parse_float=Decimal)
        root = _Table(data, "manifest", "schema run pins policy workload feedback comparison models seeds budget recovery telemetry", "harnesses")
        root.literal("schema", "strive.run/1")
        run = _Table(root.values["run"], "run", "mode editable capabilities")
        pins = _Table(root.values["pins"], "pins", "runtime verifier adapters scorer initial_bundle model_gateway")
        policy_data = _mapping(root.values["policy"], "policy")
        policy = _Table({key: item for key, item in policy_data.items() if key in {"package", "entrypoint"}},
                        "policy", "package entrypoint")
        parameters = PolicyObject(tuple(PolicyParameter(key, _policy_value(item, f"policy.{key}"))
                                         for key, item in policy_data.items() if key not in {"package", "entrypoint"}))
        policy_validator(parameters)
        workload = _Table(root.values["workload"], "workload", "implementation initial_snapshot task_stream dev_corpus", "validation_corpus")
        feedback = _Table(root.values["feedback"], "feedback", "contract operational_failures_visible audit_plan audit_release")
        feedback.literal("audit_release", "after-campaign-freeze")
        comparison = _Table(root.values["comparison"], "comparison", "strictness plan allowed_differences")
        models = tuple(NamedModel(name, _parse_model(value, f"models.{name}", ref))
                       for name, value in _mapping(root.values["models"], "models").items())
        harnesses = tuple(NamedHarness(name, _parse_harness(value, f"harnesses.{name}", ref))
                          for name, value in _mapping(root.values.get("harnesses", {}), "harnesses").items())
        seeds = _Table(root.values["seeds"], "seeds", "workload policy", "model_request")
        budget = _Table(root.values["budget"], "budget", "usd tokens model_calls wall_seconds price_schedule includes")
        dollars = budget.values["usd"]
        if type(dollars) is int:
            usd = Usd.from_decimal(Decimal(dollars))
        elif isinstance(dollars, Decimal):
            usd = Usd.from_decimal(dollars)
        else:
            raise ManifestError("budget.usd: expected finite nonnegative number")
        recovery = tuple(_parse_recovery(value, name) for name, value in _mapping(root.values["recovery"], "recovery").items())
        if "model.generate" not in {entry.operation for entry in recovery}:
            raise ManifestError("recovery: missing model.generate")
        telemetry = _Table(root.values["telemetry"], "telemetry", "semconv profile content_export sampling")
        telemetry.literal("semconv", "1.41.0")
        telemetry.literal("content_export", "authorized-development")
        telemetry.literal("sampling", "all")
        profile = telemetry.string("profile")
        if profile != TelemetryProfile.LANGFUSE:
            raise ManifestError(f"telemetry.profile: unsupported profile {profile!r}; release 1 supports only 'langfuse'; "
                                "LangSmith/Phoenix profiles are deferred")
        return RunManifest(
            schema="strive.run/1",
            run=RunTable(TrustMode(run.string("mode")), run.strings("editable"), ref(run.string("capabilities"))),
            pins=PinsTable(ref(pins.string("runtime")), ref(pins.string("verifier")), ref(pins.string("adapters")),
                           ref(pins.string("scorer")), ref(pins.string("initial_bundle")), ref(pins.string("model_gateway"))),
            policy=PolicyTable(ref(policy.string("package")), policy.string("entrypoint"), parameters),
            workload=WorkloadTable(ref(workload.string("implementation")), ref(workload.string("initial_snapshot")),
                                   ref(workload.string("task_stream")), ref(workload.string("dev_corpus")),
                                   ref(workload.string("validation_corpus")) if "validation_corpus" in workload.values else None),
            feedback=FeedbackTable(FeedbackContract(feedback.string("contract")), feedback.boolean("operational_failures_visible"),
                                   ref(feedback.string("audit_plan")), "after-campaign-freeze"),
            comparison=ComparisonTable(ComparisonStrictness(comparison.string("strictness")), ref(comparison.string("plan")),
                                       comparison.strings("allowed_differences")),
            models=models,
            harnesses=harnesses,
            seeds=SeedsTable(seeds.integer("workload"), seeds.integer("policy"),
                             seeds.integer("model_request") if "model_request" in seeds.values else None),
            budget=BudgetTable(usd, budget.integer("tokens"), budget.integer("model_calls"), budget.integer("wall_seconds"),
                               ref(budget.string("price_schedule")), frozenset(CostPhase(item) for item in budget.strings("includes"))),
            recovery=recovery,
            telemetry=TelemetryTable("1.41.0", TelemetryProfile(profile), "authorized-development", "all"),
        )
    except ManifestError:
        raise
    except ValueError as error:
        raise ManifestError(str(error)) from error


def load_authored_manifest(source: str, *, policy_validator: PolicyValidator = validate_continual_parameters) -> AuthoredManifest:
    """Parse supplied TOML text. Paths and placeholder references remain authored inputs."""
    return _load(source, str, policy_validator)


def load_resolved_configuration(source: str, *, policy_validator: PolicyValidator = validate_continual_parameters) -> RunManifest[ArtifactRef]:
    """Parse already resolved TOML; reject paths/placeholders. Does not resolve artifacts."""
    return _load(source, ArtifactRef, policy_validator)
