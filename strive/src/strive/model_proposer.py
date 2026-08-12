"""The model-backed proposer: evidence in, structured validated proposal out.

The prompt is built exclusively from the trusted ``ProposalRequest`` (visible
evidence, incumbent source, task signature, primitive catalog, sanitized
history, explicit budgets). The completion must be a JSON object matching the
structured proposal schema; anything else is classified into a distinct,
journal-ready failure kind:

- ``proposal-truncated``      — output hit the token cap before valid JSON
- ``proposal-malformed``      — not JSON at all
- ``proposal-schema-invalid`` — JSON but wrong shape/types/values
- ``budget-exhausted``        — the trusted meter denied the model call
- ``model-error``             — the adapter itself failed

The proposer never sees held-out/regression/adversarial contents, never
touches the store, and its output is only ever a *candidate*: the kernel
screens it (forbidden-source pre-filter, staleness) and the acceptance policy
gates it empirically.
"""

from __future__ import annotations

import json
from typing import Any

from strive.contracts import (
    FAILURE_BUDGET_EXHAUSTED,
    FAILURE_PROPOSAL_MALFORMED,
    FAILURE_PROPOSAL_SCHEMA_INVALID,
    FAILURE_PROPOSAL_TRUNCATED,
    FINISH_LENGTH,
    FINISH_UNKNOWN,
    FailureRecord,
    ModelRequest,
    ModelResponse,
    ProposalRecord,
    SurfaceUpdate,
)
from strive.propose import (
    STRATEGY_CODE_SURFACE,
    ProposalRequest,
    ProposalResult,
)

# The DEFAULT proposal template — the prompt/proposal-template surface's
# built-in value, used when no revision-activated template exists. Templates
# are evolvable artifacts: the active one is resolved from the native
# lifecycle's ScopeManifest and validated (`validate_prompt_template`) before
# use. Placeholders are filled by `build_prompt` from the trusted
# ProposalRequest (visible evidence only).
DEFAULT_PROPOSAL_TEMPLATE = """\
You are the proposal component of a gated self-evolution harness. Propose one
bounded improvement to the strategy below. Your proposal will be executed in a
sandbox and accepted only if it strictly improves evaluation with zero
regressions — optimize for correctness on the evidence, not cleverness.

## Task
id: {task_id}
description: {task_description}
required signature: {task_signature}
allowed imports (all others are rejected): {catalog}

## Incumbent strategy (generation {parent_generation_id})
```python
{parent_source}
```

## Diagnosis (from execution traces)
weakness: {weakness_id}
{diagnosis_description}

## Visible failing cases (the only evaluation data you get)
{failing_cases}

## Prior proposal history (aggregate outcomes)
{history}

## Budgets
max output tokens: {max_output_tokens}
model calls remaining after this one: {model_calls_remaining}
sandbox executions remaining for validation: {executions_remaining}

## Required output
Reply with ONLY a JSON object (no prose, no code fences) with exactly these keys:
- "parent_generation_id": string — echo "{parent_generation_id}"
- "summary": string — one sentence
- "rationale": string — why this change fixes the evidence
- "trace_evidence": array of case-id strings you are responding to
- "expected_outcome": string
- "source": string — the COMPLETE replacement strategy source implementing
  {task_signature}
- "changed_surfaces": array — ["strategy-code"], or
  ["prompt", "strategy-code"] when you also propose a template change
- "risks": array of strings
- "assumptions": array of strings
- "prompt_update": string or null — OPTIONAL complete replacement text for
  this very proposal template (bounded; visible evidence only)
"""

# every placeholder a template may use, with the request field that fills it;
# templates using anything else are rejected before use
TEMPLATE_PLACEHOLDERS: tuple[str, ...] = (
    "task_id", "task_description", "task_signature", "catalog",
    "parent_generation_id", "parent_source", "weakness_id",
    "diagnosis_description", "failing_cases", "failing_case_ids", "history",
    "max_output_tokens", "model_calls_remaining", "executions_remaining",
)

PROMPT_TEMPLATE_MAX_CHARS = 8000
PROMPT_PLACEHOLDER_MAX_USES = 4  # any single placeholder repeated more often
PROMPT_FIELD_MAX_TOTAL = 48  # total replacement fields in one template
RENDERED_PROMPT_MAX_CHARS = 24000  # enforced BEFORE any provider call

# the versioned prompt-template validator: descriptor `prompt@3` pins
# validation_policy `prompt-template@1` = this function; invoked at
# retention, activation, resolution, and replay (see strive.lifecycle)
PROMPT_TEMPLATE_VALIDATOR = "prompt-template@1"


def validate_prompt_template(text: str) -> str | None:
    """`prompt-template@1`: parse with string.Formatter and allow EXACT
    placeholder names only — no attribute/index traversal, no conversions,
    no format specs, bounded repetition and size — plus the required output
    fields. Returns a rejection reason, or None when valid."""
    import string

    if not text.strip():
        return "prompt template is empty"
    if len(text) > PROMPT_TEMPLATE_MAX_CHARS:
        return (
            f"prompt template is {len(text)} chars; the bound is "
            f"{PROMPT_TEMPLATE_MAX_CHARS}"
        )
    allowed = set(TEMPLATE_PLACEHOLDERS)
    uses: dict[str, int] = {}
    total = 0
    try:
        parsed = list(string.Formatter().parse(text))
    except ValueError as exc:
        return f"prompt template does not parse: {exc}"
    for _literal, field_name, format_spec, conversion in parsed:
        if field_name is None:
            continue
        total += 1
        if total > PROMPT_FIELD_MAX_TOTAL:
            return (
                f"prompt template has more than {PROMPT_FIELD_MAX_TOTAL} "
                "replacement fields"
            )
        if conversion is not None:
            return f"conversion {'!' + conversion!r} is not allowed in templates"
        if format_spec:
            return f"format spec {format_spec!r} is not allowed in templates"
        if field_name == "":
            return "positional replacement fields are not allowed"
        if "." in field_name or "[" in field_name:
            return (
                f"field {field_name!r} uses attribute/index traversal, which "
                "is not allowed"
            )
        if field_name not in allowed:
            return (
                f"unknown placeholder {field_name!r}; allowed: "
                f"{sorted(allowed)}"
            )
        uses[field_name] = uses.get(field_name, 0) + 1
        if uses[field_name] > PROMPT_PLACEHOLDER_MAX_USES:
            return (
                f"placeholder {field_name!r} repeats more than "
                f"{PROMPT_PLACEHOLDER_MAX_USES} times"
            )
    if "{parent_generation_id}" not in text:
        return "prompt template must include {parent_generation_id}"
    if "JSON" not in text:
        return "prompt template must state the JSON output contract"
    return None

_REQUIRED_FIELDS: dict[str, type] = {
    "parent_generation_id": str,
    "summary": str,
    "rationale": str,
    "trace_evidence": list,
    "expected_outcome": str,
    "source": str,
    "changed_surfaces": list,
    "risks": list,
    "assumptions": list,
}


def build_prompt(request: ProposalRequest) -> str:
    """Fill the ACTIVE template (revision-resolved or default) from the
    trusted request. The template chooses which placeholders to include —
    e.g. {failing_cases} carries full input excerpts while
    {failing_case_ids} carries ids + feedback only — but every value is
    visible-split data regardless."""
    failing = [
        ce for ce in request.ctx.evaluation.case_evaluations if not ce.passed
    ]
    failing_lines = "\n".join(
        f"- {ce.case_id}: input={request.ctx.case(ce.case_id).input_text!r} "
        f"expected={ce.expected} got={ce.output} feedback={ce.feedback!r}"
        for ce in failing
    ) or "(none)"
    failing_id_lines = "\n".join(
        f"- {ce.case_id}: feedback={ce.feedback!r}" for ce in failing
    ) or "(none)"
    history_lines = "\n".join(
        f"- {item.generation_id} [{item.weakness_id or 'n/a'}]: "
        f"{item.description} -> {item.outcome}"
        for item in request.history
    ) or "(no prior proposals)"
    template = request.prompt_template or DEFAULT_PROPOSAL_TEMPLATE
    return template.format(
        task_id=request.ctx.task_id,
        task_description=request.task_description,
        task_signature=request.task_signature,
        catalog=", ".join(request.primitive_catalog) or "(none)",
        parent_generation_id=request.ctx.parent_generation_id,
        parent_source=request.ctx.parent_source,
        weakness_id=request.diagnosis.weakness_id,
        diagnosis_description=request.diagnosis.description,
        failing_cases=failing_lines,
        failing_case_ids=failing_id_lines,
        history=history_lines,
        max_output_tokens=request.max_output_tokens,
        model_calls_remaining=request.model_calls_remaining,
        executions_remaining=request.executions_remaining,
    )


def _strip_fences(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("```"):
        first_newline = stripped.find("\n")
        if first_newline != -1 and stripped.endswith("```"):
            return stripped[first_newline + 1 : -3].strip()
    return stripped


def parse_completion(
    response: ModelResponse, request: ProposalRequest
) -> ProposalRecord | FailureRecord:
    """Classify and validate a completion strictly. Never raises."""
    text = _strip_fences(response.text)
    try:
        parsed: Any = json.loads(text)
    except json.JSONDecodeError as exc:
        truncated = response.finish_reason == FINISH_LENGTH or (
            response.finish_reason == FINISH_UNKNOWN
            and response.output_tokens >= request.max_output_tokens
        )
        if truncated:
            return FailureRecord(
                kind=FAILURE_PROPOSAL_TRUNCATED,
                detail=(
                    f"completion stopped for length (finish_reason="
                    f"{response.finish_reason!r}) before parseable JSON ({exc})"
                ),
            )
        return FailureRecord(
            kind=FAILURE_PROPOSAL_MALFORMED,
            detail=f"completion is not JSON: {exc}",
        )

    def invalid(reason: str) -> FailureRecord:
        return FailureRecord(kind=FAILURE_PROPOSAL_SCHEMA_INVALID, detail=reason)

    if not isinstance(parsed, dict):
        return invalid(f"proposal is {type(parsed).__name__}, expected object")
    missing = _REQUIRED_FIELDS.keys() - parsed.keys()
    if missing:
        return invalid(f"missing fields {sorted(missing)}")
    extra = parsed.keys() - _REQUIRED_FIELDS.keys() - {"prompt_update"}
    if extra:
        return invalid(f"unexpected fields {sorted(extra)}")
    prompt_update = parsed.get("prompt_update")
    if prompt_update is not None and not isinstance(prompt_update, str):
        return invalid(
            f"field 'prompt_update' is {type(prompt_update).__name__}, "
            "expected string or null"
        )
    for field_name, expected_type in _REQUIRED_FIELDS.items():
        if not isinstance(parsed[field_name], expected_type):
            return invalid(
                f"field {field_name!r} is {type(parsed[field_name]).__name__}, "
                f"expected {expected_type.__name__}"
            )
    for list_field in ("trace_evidence", "changed_surfaces", "risks", "assumptions"):
        if not all(isinstance(item, str) for item in parsed[list_field]):
            return invalid(f"field {list_field!r} must contain only strings")
    if not parsed["source"].strip():
        return invalid("field 'source' is empty")
    expected_surfaces = (
        ["prompt", STRATEGY_CODE_SURFACE]
        if prompt_update is not None
        else [STRATEGY_CODE_SURFACE]
    )
    if parsed["changed_surfaces"] != expected_surfaces:
        return invalid(
            f"changed_surfaces {parsed['changed_surfaces']!r} != "
            f"{expected_surfaces!r} (must agree with prompt_update presence)"
        )
    if parsed["parent_generation_id"] != request.ctx.parent_generation_id:
        return invalid(
            f"proposal names parent {parsed['parent_generation_id']!r} but was "
            f"asked about {request.ctx.parent_generation_id!r}"
        )
    visible_failing = {
        ce.case_id for ce in request.ctx.evaluation.case_evaluations if not ce.passed
    }
    if visible_failing and not parsed["trace_evidence"]:
        return invalid(
            "trace_evidence is empty although visible cases are failing; a "
            "proposal must cite the evidence it responds to"
        )
    uncited = [c for c in parsed["trace_evidence"] if c not in visible_failing]
    if uncited:
        return invalid(
            f"trace_evidence cites case ids outside the visible failing set: "
            f"{uncited}"
        )
    from strive.revisions import current_descriptor

    surface_updates: tuple[SurfaceUpdate, ...] = ()
    if prompt_update is not None:
        surface_updates = (
            SurfaceUpdate(
                descriptor_ref=current_descriptor("prompt").descriptor_ref,
                name="proposal-template",
                content=prompt_update,
            ),
        )
    return ProposalRecord(
        parent_generation_id=parsed["parent_generation_id"],
        surface=STRATEGY_CODE_SURFACE,
        summary=parsed["summary"],
        rationale=parsed["rationale"],
        trace_evidence=tuple(parsed["trace_evidence"]),
        expected_outcome=parsed["expected_outcome"],
        source=parsed["source"],
        changed_surfaces=tuple(parsed["changed_surfaces"]),
        risks=tuple(parsed["risks"]),
        assumptions=tuple(parsed["assumptions"]),
        surface_updates=surface_updates,
    )


def rendered_prompt_overflow(prompt: str) -> FailureRecord | None:
    """Enforce the rendered-prompt bound BEFORE any provider call: the
    template can be valid while its rendered form (with real evidence
    substituted) explodes past what the budget or provider tolerates."""
    if len(prompt) > RENDERED_PROMPT_MAX_CHARS:
        return FailureRecord(
            kind=FAILURE_BUDGET_EXHAUSTED,
            detail=(
                f"rendered prompt is {len(prompt)} chars; the bound is "
                f"{RENDERED_PROMPT_MAX_CHARS} — refusing the provider call"
            ),
        )
    return None


class ModelProposer:
    """Model-backed proposer over the provider-neutral adapter interface.

    Its prompt is built from visible evidence only; what the model does with
    that evidence is the model's business — in offline tests and demos a
    scripted proposal fixture stands in, which exercises this pipeline but
    demonstrates nothing about model reasoning."""

    name = "model"

    def propose(self, request: ProposalRequest) -> ProposalResult:
        if request.model is None:
            return ProposalResult.abstain("no model handle provided to ModelProposer")
        prompt = build_prompt(request)
        overflow = rendered_prompt_overflow(prompt)
        if overflow is not None:
            return ProposalResult(failure=overflow)
        outcome = request.model.complete(
            ModelRequest(prompt=prompt, max_tokens=request.max_output_tokens)
        )
        if isinstance(outcome, FailureRecord):
            return ProposalResult(failure=outcome)
        parsed = parse_completion(outcome, request)
        if isinstance(parsed, FailureRecord):
            return ProposalResult(failure=parsed)
        return ProposalResult(proposal=parsed)
