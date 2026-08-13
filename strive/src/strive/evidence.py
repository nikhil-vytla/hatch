"""Stage-3C.2A: the versioned validation-evidence and selection envelopes.

The permanent home of the ADR-0003/0004/0005 evidence contracts, frozen by
this slice (they were provisional spikes in ``strive.stage3_contracts``,
which now re-exports them):

- `DatasetRevision` — append-friendly, fully reconstructable evaluation
  data: per-split CAS manifests, parent, reason, counts, fingerprint.
  Growing a split creates a NEW dataset revision and a re-evaluation
  requirement — never a task-drift acknowledgement.
- `EvaluationManifest` — everything a validation ran under: the
  run-resolved harness ref, task/dataset fingerprints, environment and
  scorer ids, tool versions, runtime, seeds, the validator list
  (name@version), budgets, and the objective spec. Manifests are owned by
  ValidationBundles, never by revisions: one revision is routinely
  evaluated under many manifests.
- `ValidatorResult` / `ValidationBundle` — what the evidence IS. Summary
  metrics stay flat; per-case outcomes, regressions, feedback, traces, and
  distributions live in CAS behind `artifact_ref`. Each bundle carries one
  ROLE (task / prompt / constraint): a composite gets separate task,
  prompt, and constraint bundles, and surfaces cannot borrow one
  another's evidence.
- `DecisionEvidence` / `SelectionDecision` — what was CONCLUDED,
  policy-neutral: policy_ref, objective_spec_ref, subject, incumbent,
  a closed disposition vocabulary (promote / reject / frontier_add /
  provisional_activate), typed evidence links, rationale, timestamp.
  EVERY disposition requires evidence.
- `ObjectiveSpec` — the minimal trusted objective/constraint declaration
  (ADR-0005). Not evolvable: it is the evaluator's voice.
- `TaskSpecVersion` + the `function-task@1` adapter — today's tasks
  described environment-generically; Environment/Trajectory protocols
  stay provisional in ``strive.stage3_contracts``.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass

from strive import codec
from strive.codec import register
from strive.contracts import BudgetSpec
from strive.revisions import ContractViolation, RevisionRef, validate_scope

# -- evidence roles ------------------------------------------------------------------------------

ROLE_TASK = "task"
ROLE_PROMPT = "prompt"
ROLE_CONSTRAINT = "constraint"
EVIDENCE_ROLES = (ROLE_TASK, ROLE_PROMPT, ROLE_CONSTRAINT)

# each changed surface kind demands its own validator role on a promoting
# decision — the structural form of "surfaces cannot borrow evidence"
REQUIRED_SURFACE_ROLE: dict[str, str] = {
    "strategy-code": ROLE_TASK,
    "prompt": ROLE_PROMPT,
    "policy-params": ROLE_CONSTRAINT,
}

# roles every promoting decision must carry regardless of surfaces
ALWAYS_REQUIRED_ROLES = (ROLE_TASK, ROLE_CONSTRAINT)

# the EXACT validator set each role prescribes for a promoting decision:
# a promote-authorizing bundle's manifest AND results must match this set
# one-to-one — no missing results, no extraneous results, no substitutes
ROLE_REQUIRED_VALIDATORS: dict[str, frozenset[str]] = {
    ROLE_TASK: frozenset({"task-suite@1", "paired-comparison@1"}),
    ROLE_PROMPT: frozenset({"prompt-comparison@1"}),
    ROLE_CONSTRAINT: frozenset({"source-screen@1", "budget-within-spec@1"}),
}

VALIDATOR_PASSED = "passed"
VALIDATOR_FAILED = "failed"
VALIDATOR_INCONCLUSIVE = "inconclusive"
VALIDATOR_STATUSES = (VALIDATOR_PASSED, VALIDATOR_FAILED, VALIDATOR_INCONCLUSIVE)


# -- dataset revisions ---------------------------------------------------------------------------


@register("dataset-revision", 1)
@dataclass(frozen=True)
class DatasetRevision:
    """Append-friendly, reconstructable evaluation data (ADR-0003)."""

    dataset_id: str
    revision: int
    parent_revision: int | None
    reason: str
    split_manifest_refs: dict[str, str]  # split -> CAS ref of the case list
    split_counts: dict[str, int]
    fingerprint: str


# -- evaluation manifests ------------------------------------------------------------------------


@register("evaluation-manifest", 3)
@dataclass(frozen=True)
class EvaluationManifest:
    """Everything a validation ran under (v3 adds sandbox provenance to v2's
    exact-identity-by-REF). `resolved_manifest_ref` must decode to the exact
    `ResolvedHarnessManifest` the evaluation executed under — never a
    revision's own scope manifest and never an ExecutionRecord;
    `execution_record_ref` carries the per-execution provenance separately.
    `task_spec_ref` / `dataset_revision_ref` decode to the exact
    `TaskSpecVersion` / `DatasetRevision`, and the pinned fingerprints must
    match what those refs decode to. `sandbox_provenance_ref` decodes to the
    `SandboxProvenance` naming the exact boundary (backend@version, runtime
    digest, enforced capabilities, mount/network policy, resource limits)
    that executed the candidate — "" for evidence that predates the sandbox
    boundary (historical/inferred; never promote-grade for untrusted code).
    All verified by the activation gate."""

    resolved_manifest_ref: str  # CAS ref of the ResolvedHarnessManifest
    execution_record_ref: str  # CAS ref of the ExecutionRecord ("" = none)
    sandbox_provenance_ref: str  # CAS ref of the SandboxProvenance ("" = none)
    objective_spec_ref: str
    task_spec_ref: str  # CAS ref of the exact TaskSpecVersion
    dataset_revision_ref: str  # CAS ref of the exact DatasetRevision
    task_fingerprint: str  # the TaskSpecVersion's SPEC fingerprint
    dataset_fingerprint: str
    environment: str  # adapter id@version, e.g. function-task@1
    scorer: str  # id@version
    tool_versions: dict[str, str]
    runtime: str
    seeds: tuple[int, ...]
    validators: tuple[str, ...]  # name@version, resolved exactly
    budget: BudgetSpec


# -- validator results / bundles -----------------------------------------------------------------


@register("validator-result", 1)
@dataclass(frozen=True)
class ValidatorResult:
    """One validator's verdict. `metrics` stays FLAT (means, counts, CIs);
    the full payload (per-case outcomes, regression ids, distributions,
    traces) lives in CAS behind `artifact_ref`. `subject_role` names what
    within the bundle this result assessed (baseline / candidate /
    comparison / constraint)."""

    validator: str  # name@version
    subject_role: str
    status: str  # passed | failed | inconclusive
    metrics: dict[str, float]
    detail: str
    artifact_ref: str | None = None


@register("validation-bundle", 1)
@dataclass(frozen=True)
class ValidationBundle:
    """What the evidence IS: one role's validated assessment of one exact
    subject revision under one pinned evaluation manifest."""

    role: str  # task | prompt | constraint
    evaluation_manifest_ref: str
    subject: RevisionRef
    results: tuple[ValidatorResult, ...]
    feedback: str
    at: str


# -- selection decisions -------------------------------------------------------------------------

DISPOSITION_PROMOTE = "promote"
DISPOSITION_REJECT = "reject"
DISPOSITION_FRONTIER_ADD = "frontier_add"
DISPOSITION_PROVISIONAL = "provisional_activate"
DISPOSITIONS = (
    DISPOSITION_PROMOTE,
    DISPOSITION_REJECT,
    DISPOSITION_FRONTIER_ADD,
    DISPOSITION_PROVISIONAL,
)
# dispositions that authorize serving the subject (evidence-gated activation)
ACTIVATING_DISPOSITIONS = (DISPOSITION_PROMOTE, DISPOSITION_PROVISIONAL)


@register("decision-evidence", 1)
@dataclass(frozen=True)
class DecisionEvidence:
    """One typed evidence link: which ROLE this bundle plays in the
    conclusion. The kernel checks the linked bundle declares the same role
    — evidence cannot be relabeled at decision time."""

    role: str
    bundle_ref: str  # CAS ref of the ValidationBundle


@register("selection-decision", 1)
@dataclass(frozen=True)
class SelectionDecision:
    """What was CONCLUDED, policy-neutral. Every disposition requires
    evidence; the policy's comparison method lives in the evidence
    artifacts, not in a kernel-visible kind field (ADR-0004)."""

    policy_ref: str  # name@version
    objective_spec_ref: str
    disposition: str
    subject: RevisionRef
    incumbent: RevisionRef | None
    evidence: tuple[DecisionEvidence, ...]
    rationale: str
    at: str


def validate_selection(decision: SelectionDecision) -> None:
    """Kernel-enforced, policy-independent invariants."""
    if decision.disposition not in DISPOSITIONS:
        raise ContractViolation(f"unknown disposition {decision.disposition!r}")
    if "@" not in decision.policy_ref:
        raise ContractViolation(
            f"policy_ref {decision.policy_ref!r} must be versioned (name@version)"
        )
    if not decision.objective_spec_ref:
        raise ContractViolation("a decision must pin its objective spec")
    if not decision.evidence:
        raise ContractViolation(
            f"disposition {decision.disposition!r} requires evidence bundles — "
            "a rejection without evidence is as unauditable as a promotion "
            "without it"
        )
    for item in decision.evidence:
        if item.role not in EVIDENCE_ROLES:
            raise ContractViolation(f"unknown evidence role {item.role!r}")
        if not item.bundle_ref:
            raise ContractViolation(f"evidence role {item.role!r} has no bundle ref")
    if decision.incumbent is not None and (
        decision.incumbent.revision_id == decision.subject.revision_id
    ):
        raise ContractViolation("a subject cannot be selected against itself")
    validate_scope(decision.subject.scope)


def validate_bundle(bundle: ValidationBundle) -> None:
    if bundle.role not in EVIDENCE_ROLES:
        raise ContractViolation(f"unknown bundle role {bundle.role!r}")
    if not bundle.evaluation_manifest_ref:
        raise ContractViolation("a bundle must pin its evaluation manifest")
    if not bundle.results:
        raise ContractViolation("a bundle must carry at least one validator result")
    for result in bundle.results:
        if result.status not in VALIDATOR_STATUSES:
            raise ContractViolation(
                f"unknown validator status {result.status!r} on {result.validator}"
            )
        if "@" not in result.validator:
            raise ContractViolation(
                f"validator {result.validator!r} must be versioned (name@version)"
            )
    validate_scope(bundle.subject.scope)


# -- objective specs (ADR-0005, minimal trusted slice) --------------------------------------------


@register("objective-term", 1)
@dataclass(frozen=True)
class ObjectiveTerm:
    metric: str
    direction: str  # "max" | "min"
    weight: float


@register("objective-constraint", 1)
@dataclass(frozen=True)
class ObjectiveConstraint:
    metric: str
    bound: float
    kind: str  # "hard" | "soft"


@register("objective-spec", 1)
@dataclass(frozen=True)
class ObjectiveSpec:
    """The versioned, trusted objective/constraint declaration. NOT
    evolvable in Stage 3: it is the evaluator's voice."""

    name: str
    version: int
    description: str
    objectives: tuple[ObjectiveTerm, ...]
    constraints: tuple[ObjectiveConstraint, ...]


DEFAULT_OBJECTIVE = ObjectiveSpec(
    name="task-score",
    version=1,
    description=(
        "maximize overall task score under trusted split discipline; hard "
        "constraint: zero regressions on previously passing cases"
    ),
    objectives=(ObjectiveTerm(metric="overall_score", direction="max", weight=1.0),),
    constraints=(ObjectiveConstraint(metric="regressions", bound=0.0, kind="hard"),),
)


def objective_spec_ref(store: object) -> str:
    """CAS-store the default objective spec and return its ref."""
    objects = getattr(store, "objects")
    ref: str = objects.put_text(codec.dumps(DEFAULT_OBJECTIVE))
    return ref


# -- the function-task adapter (ADR-0003) ---------------------------------------------------------


@register("function-task-config", 1)
@dataclass(frozen=True)
class FunctionTaskConfig:
    """The adapter-specific config blob: the function signature and the
    primitive catalog live HERE, not in the environment-generic spec."""

    signature: str
    primitive_catalog: tuple[str, ...]


@register("task-spec", 1)
@dataclass(frozen=True)
class TaskSpecVersion:
    """Immutable, environment-generic task identity. The kernel never sees
    a function signature."""

    task_id: str
    version: int
    description: str
    environment: str  # adapter id@version
    action_schema: str
    observation_schema: str
    scorer: str  # id@version
    config_ref: str  # CAS ref of the adapter-specific config
    fingerprint: str


FUNCTION_TASK_ENVIRONMENT = "function-task@1"
FUNCTION_TASK_SCORER = "exact-int@1"


def _spec_body(task: object) -> dict[str, object]:
    """The spec fields, with the config ref computed PURELY (the CAS address
    the config blob would have) so spec identity needs no store access."""
    from strive.cas import hash_text

    config = FunctionTaskConfig(
        signature=str(getattr(task, "signature")),
        primitive_catalog=tuple(getattr(task, "primitive_catalog")),
    )
    return {
        "task_id": getattr(task, "task_id"),
        "version": getattr(task, "version"),
        "description": getattr(task, "description"),
        "environment": FUNCTION_TASK_ENVIRONMENT,
        "action_schema": "submit-int@1",
        "observation_schema": "input-text@1",
        "scorer": FUNCTION_TASK_SCORER,
        "config_ref": hash_text(codec.dumps(config)),
    }


def task_spec_fingerprint(task: object) -> str:
    """SPEC identity only — deliberately excludes the cases, which belong to
    the dataset revision: growing data never trips spec drift. Pure (no
    store access), so the live mutation guard can call it."""
    canonical = json.dumps(_spec_body(task), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def task_spec_version(store: object, task: object) -> TaskSpecVersion:
    """Adapt a current `strive.tasks.Task` as `function-task@1`, publishing
    the config blob to CAS so the spec's config_ref resolves."""
    objects = getattr(store, "objects")
    config = FunctionTaskConfig(
        signature=str(getattr(task, "signature")),
        primitive_catalog=tuple(getattr(task, "primitive_catalog")),
    )
    config_ref = objects.put_text(codec.dumps(config))
    body = _spec_body(task)
    assert body["config_ref"] == config_ref  # pure address == published address
    return TaskSpecVersion(
        fingerprint=task_spec_fingerprint(task),
        **body,  # type: ignore[arg-type]
    )


def store_task_spec(store: object, task: object) -> tuple[TaskSpecVersion, str]:
    """CAS-store the exact TaskSpecVersion; returns (spec, ref)."""
    spec = task_spec_version(store, task)
    objects = getattr(store, "objects")
    return spec, objects.put_text(codec.dumps(spec))


__all__ = [
    "ACTIVATING_DISPOSITIONS",
    "ALWAYS_REQUIRED_ROLES",
    "DEFAULT_OBJECTIVE",
    "DISPOSITIONS",
    "DISPOSITION_FRONTIER_ADD",
    "DISPOSITION_PROMOTE",
    "DISPOSITION_PROVISIONAL",
    "DISPOSITION_REJECT",
    "DatasetRevision",
    "DecisionEvidence",
    "EVIDENCE_ROLES",
    "EvaluationManifest",
    "FUNCTION_TASK_ENVIRONMENT",
    "FUNCTION_TASK_SCORER",
    "FunctionTaskConfig",
    "ObjectiveConstraint",
    "ObjectiveSpec",
    "ObjectiveTerm",
    "REQUIRED_SURFACE_ROLE",
    "ROLE_REQUIRED_VALIDATORS",
    "ROLE_CONSTRAINT",
    "ROLE_PROMPT",
    "ROLE_TASK",
    "SelectionDecision",
    "TaskSpecVersion",
    "VALIDATOR_FAILED",
    "VALIDATOR_INCONCLUSIVE",
    "VALIDATOR_PASSED",
    "VALIDATOR_STATUSES",
    "ValidationBundle",
    "ValidatorResult",
    "objective_spec_ref",
    "store_task_spec",
    "task_spec_fingerprint",
    "task_spec_version",
    "validate_bundle",
    "validate_selection",
]
