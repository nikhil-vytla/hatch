"""The policy-neutral, pinned operation package (Area 1).

An operation is how a continual policy learns: it runs the ACTIVE harness and
reports how it behaved. That feedback MUST be policy-visible only — hidden
evaluator data (held-out / adversarial / audit cases, selection-only answers)
can never reach the Refiner, or an outage or a leaked answer would "teach" a
change dishonestly.

This module replaces the thin `operation_cases(Task)` driver with a versioned,
injected `OperationCatalog` of `OperationDescriptor`s. A descriptor:

- receives ONLY a `PolicyVisibleOperationContext` (visible cases + seed +
  task/environment fingerprints), NEVER the full `Task`;
- deterministically produces an immutable, CAS-backed `OperationPlan` pinning
  descriptor/config identity, an opaque manifest, the environment regime, the
  projection schema, the resource envelope, and the attempt-validity rule;
- interprets the kernel's protected per-case evidence into a separate
  POLICY-VISIBLE `OperationProjection` (the only thing policy/review reads).

The kernel alone owns the `CandidateExecutor`, sandbox checks, budgets,
dispatch/result journaling, CAS writes, and state integrity. The descriptor
never executes code or touches the budget.

The shipping `task-suite@1` descriptor operates the task's VISIBLE split,
relabelled with OPAQUE ids (`op-0`, `op-1`, …) into an explicit ``operation``
split, so neither the hidden splits nor a diagnostic case name ever reaches the
Refiner. Catalogs are injected, so a deployment can supply a different operation
surface without touching the kernel; there is no import-time registration.
"""

from __future__ import annotations

import hashlib
import inspect
from typing import Protocol, Sequence

from strive.contracts import Evaluation, ExecutionReport, TaskCase
from strive.runtime import (
    OP_BEHAVIORAL,
    OperationBinding,
    OperationPlan,
    OperationProjection,
    PolicyVisibleOperationContext,
    ProjectedOutcome,
)

OPERATION_SPLIT = "operation"


def descriptor_source_digest(descriptor: object) -> str:
    """The ACTUAL digest of a descriptor's implementation source + its strict
    config identity. Edits to the descriptor's source change this even without a
    version-label bump, so drift is detected on resume (the plan_ref changes)."""
    try:
        source = inspect.getsource(type(descriptor))
    except (OSError, TypeError):  # pragma: no cover — source must be available
        source = type(descriptor).__qualname__
    config = getattr(descriptor, "config_digest", "")
    return hashlib.sha256(f"{source}\x00{config}".encode("utf-8")).hexdigest()[:32]


class OperationDescriptor(Protocol):
    """A versioned, immutable operation implementation. Its identity fields are
    pinned into every plan (and thus into the `ObserveCurrentState` intent), so a
    changed implementation/config is detected on resume."""

    name: str                     # ref@version, e.g. "task-suite@1"
    impl_version: str             # implementation digest
    config_digest: str            # strict config identity
    plan_schema_version: str
    projection_schema_version: str
    required_capabilities: tuple[str, ...]
    required_surfaces: tuple[str, ...]
    validity: str                 # "all-required" | "partial-allowed"
    indivisible: bool

    def create_plan(self, context: PolicyVisibleOperationContext) -> OperationPlan:
        """Deterministically build the immutable plan from the POLICY-VISIBLE
        context (never the full task)."""
        ...

    def project(
        self,
        plan: OperationPlan,
        *,
        command_id: str,
        state_ref: str,
        report: ExecutionReport,
        evaluation: Evaluation,
        origin: str,
    ) -> OperationProjection:
        """Interpret the kernel's protected per-case evidence into the separate
        POLICY-VISIBLE projection."""
        ...


VALIDITY_ALL_REQUIRED = "all-required"
VALIDITY_PARTIAL_ALLOWED = "partial-allowed"


class TaskSuiteOperationDescriptor:
    """The shipping descriptor: operate the task's VISIBLE split, relabelled with
    opaque ids into the ``operation`` split. Attempt validity is `all-required`
    (every case must produce a behavioral outcome for the aggregate to be
    published), and the attempt is NOT indivisible (an infrastructure/unknown
    fault invalidates the aggregate but does not, by itself, floor the completed
    cases' evidence)."""

    name = "task-suite@1"
    impl_version = "task-suite-impl@1"
    config_digest = "task-suite-config@1"
    plan_schema_version = "operation-plan@1"
    projection_schema_version = "operation-projection@1"
    required_capabilities: tuple[str, ...] = ()
    required_surfaces: tuple[str, ...] = ("strategy-code/solve",)
    validity = VALIDITY_ALL_REQUIRED
    indivisible = False

    def binding(self) -> OperationBinding:
        return OperationBinding(
            descriptor_ref=self.name,
            source_digest=descriptor_source_digest(self),
            config_digest=self.config_digest,
            plan_schema_version=self.plan_schema_version,
            projection_schema_version=self.projection_schema_version,
            required_surfaces=self.required_surfaces,
            required_capabilities=self.required_capabilities,
            validity=self.validity,
            indivisible=self.indivisible,
        )

    def create_plan(self, context: PolicyVisibleOperationContext) -> OperationPlan:
        from strive.sandboxes import SandboxLimits

        manifest = tuple(
            TaskCase(
                case_id=f"op-{i}",
                input_text=case.input_text,
                expected=case.expected,  # a VISIBLE expected answer — not hidden
                split=OPERATION_SPLIT,
            )
            for i, case in enumerate(context.visible_cases)
        )
        cap = SandboxLimits()
        return OperationPlan(
            binding=self.binding(),
            seed=context.seed,
            task_fingerprint=context.task_fingerprint,
            regime=context.environment_fingerprint,
            manifest=manifest,
            reserved_executions=len(manifest),
            reserved_wall_s=round(len(manifest) * cap.wall_time_s, 6),
            reserved_output_bytes=len(manifest) * cap.output_bytes,
        )

    def project(
        self,
        plan: OperationPlan,
        *,
        command_id: str,
        state_ref: str,
        report: ExecutionReport,
        evaluation: Evaluation,
        origin: str,
    ) -> OperationProjection:
        # interpret the PROTECTED evidence into the policy-visible projection from
        # the REPORT's real per-case outcomes (not the pre-floored evaluation), so
        # completed cases keep their true result. A case "ran" iff it produced a
        # sandbox outcome; an un-run case (a boundary fault stopped the suite) is
        # marked, not floored.
        by_id = {o.case_id: o for o in report.outcomes}
        total = len(plan.manifest)
        completed = len(report.outcomes)
        behavioral = origin == OP_BEHAVIORAL
        incomplete = completed < total or not report.ok
        # INDIVISIBLE: the plan declares the attempt atomic, so a partial/faulted
        # attempt floors ALL cases (none are credited). Otherwise completed cases
        # keep their real outcomes.
        floored = plan.indivisible and (incomplete or not behavioral)

        outcomes: list[ProjectedOutcome] = []
        passes = 0
        for mc in plan.manifest:
            outcome = by_id.get(mc.case_id)
            got = outcome.output if outcome is not None else None
            if outcome is None:
                error_kind: str | None = "did-not-run"
                summary = "did not run"
            else:
                error_kind = _error_kind(outcome.error)
                summary = f"expected {mc.expected}, got {got}"
            passed = (
                outcome is not None and outcome.error is None
                and got == mc.expected and not floored
            )
            if passed:
                passes += 1
            outcomes.append(ProjectedOutcome(
                request_id=mc.case_id, passed=passed,
                score=1.0 if passed else 0.0, summary=summary, error_kind=error_kind,
            ))

        if plan.validity == VALIDITY_ALL_REQUIRED:
            valid = behavioral and completed == total and total > 0 and not floored
            denom = total  # every case must count
        else:  # partial-allowed: score only the cases that RAN
            valid = behavioral and completed > 0 and not floored
            denom = completed
        # NO normal aggregate for an invalid/incomplete attempt
        overall = (passes / denom) if (valid and denom > 0) else None
        return OperationProjection(
            command_id=command_id,
            plan_ref="",  # filled by the kernel (it owns the CAS ref)
            state_ref=state_ref,
            origin=origin,
            valid=valid,
            coverage_completed=completed,
            coverage_total=total,
            overall=overall,
            outcomes=tuple(outcomes),
        )


def _error_kind(error: str | None) -> str | None:
    """A SAFE, coarse error class from a per-case error string (the leading
    token before ':'), never the full protected text."""
    if error is None:
        return None
    head = error.strip().split(":", 1)[0].strip()
    return head[:40] or "error"


class OperationCatalog:
    """An immutable, injected set of operation descriptors, resolved by exact
    name@version, fail-closed (no import-time registration)."""

    def __init__(self, descriptors: Sequence[OperationDescriptor]) -> None:
        self._by_name: dict[str, OperationDescriptor] = {}
        for descriptor in descriptors:
            if descriptor.name in self._by_name:
                raise ValueError(f"duplicate operation descriptor {descriptor.name!r}")
            self._by_name[descriptor.name] = descriptor

    def names(self) -> tuple[str, ...]:
        return tuple(sorted(self._by_name))

    def descriptor(self, name: str) -> OperationDescriptor:
        descriptor = self._by_name.get(name)
        if descriptor is None:
            raise KeyError(
                f"unknown operation descriptor {name!r}; known: {list(self.names())} "
                "— refusing to substitute a different operation"
            )
        return descriptor


def policy_visible_operation_view(view: object) -> list[OperationProjection]:
    """The FILTERED policy-facing operation view: ONLY the policy-visible
    `OperationProjection`s, decoded in order. This is the mechanical boundary a
    policy/review consumes — the protected `AttemptRecord` behind an
    `operation-result` observation is deliberately absent. `view` is any read
    with `.bodies` (typed event bodies) and `.read_text(ref)` (a RunView)."""
    from strive import codec
    from strive.runtime import OPERATION_PROJECTION
    from strive.substrate import ObservationRecorded

    bodies = getattr(view, "bodies", ())
    read_text = view.read_text  # type: ignore[attr-defined]
    out: list[OperationProjection] = []
    for body in bodies:
        if isinstance(body, ObservationRecorded) and body.observation_kind == OPERATION_PROJECTION:
            out.append(codec.loads(read_text(body.observation_ref), OperationProjection))
    return out


def default_operation_catalog() -> OperationCatalog:
    return OperationCatalog([TaskSuiteOperationDescriptor()])


DEFAULT_OPERATION_DESCRIPTOR = "task-suite@1"


__all__ = [
    "DEFAULT_OPERATION_DESCRIPTOR",
    "OPERATION_SPLIT",
    "OperationCatalog",
    "OperationDescriptor",
    "TaskSuiteOperationDescriptor",
    "VALIDITY_ALL_REQUIRED",
    "VALIDITY_PARTIAL_ALLOWED",
    "default_operation_catalog",
    "descriptor_source_digest",
    "policy_visible_operation_view",
]
