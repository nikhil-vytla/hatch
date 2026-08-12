"""The trusted validator registry: every validator is named, versioned,
role-bound, and resolved EXACTLY (name AND version) — an unknown name or an
unknown version of a known name both fail closed.

Validators here are converters from the kernel's existing trusted
mechanisms into `ValidatorResult` envelopes (ADR-0004): task evaluation
(`task-suite@1`, `paired-comparison@1`), the trusted prompt gate
(`prompt-comparison@1`), source screening (`source-screen@1`), and hard
constraints (`budget-within-spec@1`, `prompt-template@1`). Summary metrics
stay flat; the full payloads (per-case outcomes, regression ids, the
comparison evidence) are CAS artifacts behind `artifact_ref` — per-example
alignment and failure-as-data are preserved because the artifact IS the
existing `Evaluation` / `Decision` / `PromptComparisonEvidence` record.
"""

from __future__ import annotations

from dataclasses import dataclass

from strive import codec
from strive.contracts import BudgetSpec, BudgetUsage, Decision, Evaluation
from strive.evidence import (
    ROLE_CONSTRAINT,
    ROLE_PROMPT,
    ROLE_TASK,
    VALIDATOR_FAILED,
    VALIDATOR_INCONCLUSIVE,
    VALIDATOR_PASSED,
    ValidatorResult,
)


class ValidatorError(Exception):
    """A validator could not be resolved (unknown name or version)."""


@dataclass(frozen=True)
class ValidatorInfo:
    name: str
    version: int
    role: str
    description: str

    @property
    def ref(self) -> str:
        return f"{self.name}@{self.version}"


_REGISTRY: dict[str, ValidatorInfo] = {}


def _register(info: ValidatorInfo) -> ValidatorInfo:
    _REGISTRY[info.ref] = info
    return info


TASK_SUITE = _register(
    ValidatorInfo(
        "task-suite", 1, ROLE_TASK,
        "task-owned scoring of one subject over the pinned dataset splits; "
        "artifact = the full Evaluation (per-case outcomes, failure-as-data)",
    )
)
PAIRED_COMPARISON = _register(
    ValidatorInfo(
        "paired-comparison", 1, ROLE_TASK,
        "paired incumbent-vs-candidate verdict with regression accounting; "
        "artifact = the full Decision (regressed case ids, split scores)",
    )
)
PROMPT_COMPARISON = _register(
    ValidatorInfo(
        "prompt-comparison", 1, ROLE_PROMPT,
        "trusted candidate-vs-incumbent template comparison under matched "
        "conditions; artifact = the full PromptComparisonEvidence",
    )
)
SOURCE_SCREEN = _register(
    ValidatorInfo(
        "source-screen", 1, ROLE_CONSTRAINT,
        "kernel pre-filter over proposed source (catalog imports, size, "
        "hidden-split leakage)",
    )
)
BUDGET_WITHIN_SPEC = _register(
    ValidatorInfo(
        "budget-within-spec", 1, ROLE_CONSTRAINT,
        "trusted meter usage against the cycle's BudgetSpec ceilings",
    )
)
PROMPT_TEMPLATE_STATIC = _register(
    ValidatorInfo(
        "prompt-template", 1, ROLE_CONSTRAINT,
        "static template validation (exact placeholders, bounds, output "
        "contract) — the prompt@3 descriptor's pinned policy",
    )
)


def get_validator(ref: str) -> ValidatorInfo:
    """Resolve a validator by name AND version; fail closed on either."""
    info = _REGISTRY.get(ref)
    if info is not None:
        return info
    name, _, _ = ref.partition("@")
    known_versions = sorted(
        r for r in _REGISTRY if r.partition("@")[0] == name
    )
    if known_versions:
        raise ValidatorError(
            f"unknown validator version {ref!r}; this build knows "
            f"{', '.join(known_versions)} — refusing to guess"
        )
    raise ValidatorError(
        f"unknown validator {ref!r}; known: {sorted(_REGISTRY)}"
    )


def registry() -> dict[str, ValidatorInfo]:
    return dict(_REGISTRY)


# -- converters ----------------------------------------------------------------------------------


def task_suite_result(
    store: object, evaluation: Evaluation, *, subject_role: str
) -> ValidatorResult:
    """Task evaluation → envelope. Failure-as-data: a failed execution is a
    FAILED result whose artifact still carries every floor-scored case."""
    objects = getattr(store, "objects")
    artifact_ref = objects.put_text(codec.dumps(evaluation))
    metrics: dict[str, float] = {"overall_score": evaluation.overall_score}
    for split, score in sorted(evaluation.split_scores.items()):
        metrics[f"split_{split}"] = score
    metrics["cases"] = float(len(evaluation.case_evaluations))
    metrics["failing_cases"] = float(
        sum(1 for ce in evaluation.case_evaluations if not ce.passed)
    )
    status = VALIDATOR_FAILED if evaluation.failure is not None else VALIDATOR_PASSED
    return ValidatorResult(
        validator=TASK_SUITE.ref,
        subject_role=subject_role,
        status=status,
        metrics=metrics,
        detail=evaluation.feedback,
        artifact_ref=artifact_ref,
    )


def paired_comparison_result(store: object, decision: Decision) -> ValidatorResult:
    """The paired verdict → envelope; the full Decision (regressed case ids,
    both score maps) is the CAS artifact."""
    objects = getattr(store, "objects")
    artifact_ref = objects.put_text(codec.dumps(decision))
    metrics = {
        "accepted": 1.0 if decision.accepted else 0.0,
        "baseline_score": decision.baseline_score,
        "candidate_score": decision.candidate_score,
        "regressions": float(len(decision.regressed_case_ids)),
    }
    return ValidatorResult(
        validator=PAIRED_COMPARISON.ref,
        subject_role="comparison",
        status=VALIDATOR_PASSED if decision.accepted else VALIDATOR_FAILED,
        metrics=metrics,
        detail=decision.reason,
        artifact_ref=artifact_ref,
    )


def prompt_comparison_result(
    evidence_ref: str, *, improved: bool, detail: str,
    candidate_gate: bool | None = None, incumbent_gate: bool | None = None,
) -> ValidatorResult:
    metrics = {"improved": 1.0 if improved else 0.0}
    if candidate_gate is not None:
        metrics["candidate_gate_accepted"] = 1.0 if candidate_gate else 0.0
    if incumbent_gate is not None:
        metrics["incumbent_gate_accepted"] = 1.0 if incumbent_gate else 0.0
    return ValidatorResult(
        validator=PROMPT_COMPARISON.ref,
        subject_role="comparison",
        status=VALIDATOR_PASSED if improved else VALIDATOR_FAILED,
        metrics=metrics,
        detail=detail,
        artifact_ref=evidence_ref,
    )


def source_screen_result(rejection_kind: str | None, detail: str) -> ValidatorResult:
    return ValidatorResult(
        validator=SOURCE_SCREEN.ref,
        subject_role="constraint",
        status=VALIDATOR_PASSED if rejection_kind is None else VALIDATOR_FAILED,
        metrics={"rejected": 0.0 if rejection_kind is None else 1.0},
        detail=detail,
    )


def budget_result(usage: BudgetUsage | None, spec: BudgetSpec) -> ValidatorResult:
    """Hard budget constraint over EVERY metered dimension — wall time,
    executions, model calls, tokens, output bytes, cost, and recursion
    depth — with the meter's exact limit semantics (strive.budget):
    ``-1`` = accounting only (never a violation); ``0`` = nothing allowed
    (any usage violates); otherwise recorded usage must not EXCEED the
    limit (the meter's pre-request gates keep counted dimensions at or
    under their ceilings, and post-call token/cost overruns reject the
    overrunning completion — so usage above a limit is evidence of an
    unmetered or overrunning assessment). Unknown usage is INCONCLUSIVE —
    and an inconclusive hard constraint blocks activation (fail closed)."""
    if usage is None:
        return ValidatorResult(
            validator=BUDGET_WITHIN_SPEC.ref,
            subject_role="constraint",
            status=VALIDATOR_INCONCLUSIVE,
            metrics={},
            detail="no metered usage recorded for this assessment",
        )
    dimensions: tuple[tuple[str, float, float], ...] = (
        ("wall_time_s", usage.wall_time_s, spec.wall_time_s),
        ("executions", float(usage.executions), float(spec.executions)),
        ("model_calls", float(usage.model_calls), float(spec.model_calls)),
        ("tokens", float(usage.tokens), float(spec.tokens)),
        ("output_bytes", float(usage.output_bytes), float(spec.output_bytes)),
        ("cost", usage.cost, spec.cost),
        (
            "recursion_depth",
            float(usage.recursion_depth),
            float(spec.max_recursion_depth),
        ),
    )

    def violated(used: float, limit: float) -> bool:
        if limit == -1:  # UNLIMITED: accounting only
            return False
        if limit == 0:  # nothing allowed
            return used > 0
        return used > limit

    violations = [name for name, used, limit in dimensions if violated(used, limit)]
    metrics: dict[str, float] = {}
    for name, used, limit in dimensions:
        metrics[name] = used
        metrics[f"{name}_limit"] = limit
    return ValidatorResult(
        validator=BUDGET_WITHIN_SPEC.ref,
        subject_role="constraint",
        status=VALIDATOR_PASSED if not violations else VALIDATOR_FAILED,
        metrics=metrics,
        detail=(
            "usage within every budget dimension"
            if not violations
            else "budget exceeded on: " + ", ".join(violations)
        ),
    )


__all__ = [
    "BUDGET_WITHIN_SPEC",
    "PAIRED_COMPARISON",
    "PROMPT_COMPARISON",
    "PROMPT_TEMPLATE_STATIC",
    "SOURCE_SCREEN",
    "TASK_SUITE",
    "ValidatorError",
    "ValidatorInfo",
    "budget_result",
    "get_validator",
    "paired_comparison_result",
    "prompt_comparison_result",
    "registry",
    "source_screen_result",
    "task_suite_result",
]
