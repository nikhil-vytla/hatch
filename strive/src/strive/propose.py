"""The pluggable proposal pipeline: protocol, request/result types, registry
reference implementation, and the trusted source pre-filter screen.

Proposers receive a kernel-built ``ProposalRequest`` containing only trusted,
explicitly visible inputs: the incumbent source, the task signature and
primitive catalog, the visible-split evaluation, the diagnosis, sanitized
accepted/rejected proposal history (aggregate scores only — never case
contents), explicit budgets, and (for model-backed proposers) a metered
journaling model handle. Held-out, regression, and adversarial case contents
are mechanically absent.

A proposer returns a ``ProposalResult``: either a validated structured
``ProposalRecord`` or a distinct, journal-ready ``FailureRecord``
(abstained / truncated / malformed / schema-invalid / budget-exhausted /
model-error). Staleness and the forbidden-source screen are enforced by the
kernel, not trusted to proposers.
"""

from __future__ import annotations

import ast
from dataclasses import dataclass
from typing import Protocol

from strive.contracts import (
    FAILURE_PROPOSAL_ABSTAINED,
    FAILURE_PROPOSAL_FORBIDDEN,
    FAILURE_PROPOSAL_SCHEMA_INVALID,
    Diagnosis,
    FailureRecord,
    ProposalRecord,
)
from strive.diagnose import NEGATIVE_INTEGERS_DROPPED, VisibleContext
from strive.model import CompletingAdapter

STRATEGY_CODE_SURFACE = "strategy-code"


@dataclass(frozen=True)
class ProposalHistoryItem:
    """Sanitized past-decision summary fed back to proposers.

    Deliberately contains aggregate scores and policy identity only — never
    case ids or inputs, which may name hidden splits.
    """

    generation_id: str
    weakness_id: str | None
    description: str
    accepted: bool
    outcome: str  # e.g. "accepted by paired-deterministic@1: 0.600 -> 1.000"


@dataclass(frozen=True)
class ProposalRequest:
    ctx: VisibleContext
    diagnosis: Diagnosis
    task_description: str
    task_signature: str
    primitive_catalog: tuple[str, ...]
    history: tuple[ProposalHistoryItem, ...]
    max_output_tokens: int
    model_calls_remaining: int
    executions_remaining: int
    model: CompletingAdapter | None = None
    # the ACTIVE prompt/proposal-template surface, resolved by the kernel
    # from the native lifecycle's manifest ("" -> the built-in default) and
    # journaled per model request alongside the active revision
    prompt_template: str = ""
    prompt_ref: str = ""


@dataclass(frozen=True)
class ProposalResult:
    proposal: ProposalRecord | None = None
    failure: FailureRecord | None = None

    @staticmethod
    def abstain(detail: str) -> "ProposalResult":
        return ProposalResult(
            failure=FailureRecord(kind=FAILURE_PROPOSAL_ABSTAINED, detail=detail)
        )


class Proposer(Protocol):
    """A proposal source. Implementations must be side-effect free with
    respect to the store: the kernel retains, validates, and promotes."""

    name: str

    def propose(self, request: ProposalRequest) -> ProposalResult: ...


# -- trusted pre-filter screen (kernel-side; a filter, never the gate) ----------

_FORBIDDEN_NAMES = frozenset(
    {"eval", "exec", "compile", "open", "input", "__import__", "globals", "locals",
     "breakpoint", "exit", "quit"}
)


def screen_source(source: str, primitive_catalog: tuple[str, ...]) -> FailureRecord | None:
    """Static screen: imports limited to the task's primitive catalog and no
    obviously forbidden builtins. This is a cheap pre-filter (D1): passing it
    proves nothing — empirical validation in the sandbox remains the gate."""
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        return FailureRecord(
            kind=FAILURE_PROPOSAL_FORBIDDEN,
            detail=f"candidate source does not parse: {exc}",
        )
    allowed = set(primitive_catalog)
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = alias.name.split(".")[0]
                if root not in allowed:
                    return FailureRecord(
                        kind=FAILURE_PROPOSAL_FORBIDDEN,
                        detail=f"import of {alias.name!r} outside catalog {sorted(allowed)}",
                    )
        elif isinstance(node, ast.ImportFrom):
            root = (node.module or "").split(".")[0]
            if root not in allowed:
                return FailureRecord(
                    kind=FAILURE_PROPOSAL_FORBIDDEN,
                    detail=f"import from {node.module!r} outside catalog {sorted(allowed)}",
                )
        elif isinstance(node, ast.Name) and node.id in _FORBIDDEN_NAMES:
            return FailureRecord(
                kind=FAILURE_PROPOSAL_FORBIDDEN,
                detail=f"use of forbidden builtin {node.id!r}",
            )
    return None


def screen_prompt_update(
    prompt_update: str, hidden_case_texts: tuple[str, ...]
) -> FailureRecord | None:
    """Trusted screen for a proposed prompt-template change: it must validate
    as a template (bounded, known placeholders, output contract) and must not
    embed non-visible evaluation content — the kernel knows the hidden case
    inputs and ids; proposers never do."""
    from strive.model_proposer import validate_prompt_template

    reason = validate_prompt_template(prompt_update)
    if reason is not None:
        return FailureRecord(
            kind=FAILURE_PROPOSAL_SCHEMA_INVALID,
            detail=f"prompt_update rejected: {reason}",
        )
    for hidden in hidden_case_texts:
        if hidden and hidden in prompt_update:
            return FailureRecord(
                kind=FAILURE_PROPOSAL_FORBIDDEN,
                detail=(
                    "prompt_update embeds non-visible evaluation content; "
                    "hidden splits must stay out of evolvable prompts"
                ),
            )
    return None


# -- reference implementation: the deterministic registry proposer ---------------


@dataclass(frozen=True)
class Patch:
    target: str
    replacement: str
    description: str


PATCH_REGISTRY: dict[str, Patch] = {
    NEGATIVE_INTEGERS_DROPPED: Patch(
        target='r"\\d+"',
        replacement='r"-?\\d+"',
        description="Widen the integer regex to capture an optional leading minus sign.",
    ),
}


class RegistryProposer:
    """v0 semantics, kept as the deterministic reference implementation:
    one known weakness ↦ one textual patch that must match exactly once."""

    name = "registry"

    def propose(self, request: ProposalRequest) -> ProposalResult:
        patch = PATCH_REGISTRY.get(request.diagnosis.weakness_id)
        if patch is None:
            return ProposalResult.abstain(
                f"no registry patch for weakness {request.diagnosis.weakness_id!r}"
            )
        if request.ctx.parent_source.count(patch.target) != 1:
            return ProposalResult.abstain(
                f"patch target occurs {request.ctx.parent_source.count(patch.target)} "
                "times in parent source (need exactly 1)"
            )
        return ProposalResult(
            proposal=ProposalRecord(
                parent_generation_id=request.ctx.parent_generation_id,
                surface=STRATEGY_CODE_SURFACE,
                summary=patch.description,
                rationale=(
                    "Registry patch mapped from diagnosed weakness "
                    f"{request.diagnosis.weakness_id!r}."
                ),
                trace_evidence=request.diagnosis.evidence_case_ids,
                expected_outcome="Failing visible cases involving the weakness pass.",
                source=request.ctx.parent_source.replace(
                    patch.target, patch.replacement, 1
                ),
                changed_surfaces=(STRATEGY_CODE_SURFACE,),
                risks=("patch is textual; semantics verified only by validation",),
                assumptions=("parent source contains the target exactly once",),
            )
        )
