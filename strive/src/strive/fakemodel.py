"""Scripted proposal fixtures for the deterministic fake adapter.

What this is, stated precisely: a SCRIPTED PROPOSAL FIXTURE. The repair below
was written by the harness authors and is emitted by a canned responder when
the prompt matches the demo task. It was NOT derived from the execution
evidence by any model, and demos/tests built on it demonstrate *pipeline*
correctness only — prompt construction, strict schema validation,
forbidden-source screening, sandboxed validation, gated promotion,
journaling, replay. They demonstrate nothing about model reasoning or
capability. Real-model runs are opt-in via environment variables (see
``strive.model.adapter_from_env``) and carry their own safety
acknowledgement requirement in the CLI.
"""

from __future__ import annotations

import json
import re

from strive.contracts import ModelRequest
from strive.model import FakeModelAdapter

SCRIPTED_MAX_INTEGERS_FIX = '''\
"""Strategy for max-integers: numeric maximum over signed integer tokens."""

import re


def solve(input_text: str) -> int:
    tokens = re.findall(r"-?\\d+", input_text)
    if not tokens:
        return 0
    return max(int(token) for token in tokens)
'''

_PARENT_RE = re.compile(r"generation (gen-\d{4})")
_EVIDENCE_RE = re.compile(r"^- ([\w-]+): input=", re.MULTILINE)


def scripted_proposal_responder(request: ModelRequest) -> str:
    """Canned stand-in for a real model on the max-integers demo task.

    It extracts the parent generation id and the cited failing case ids from
    the prompt (so prompt evolution doesn't break the fixture) and returns the
    author-written repair above wrapped in the proposal schema. Any other
    prompt gets a refusal the schema validator will reject.
    """
    parent_match = _PARENT_RE.search(request.prompt)
    if parent_match is None or "max-integers" not in request.prompt:
        return "This scripted fixture only covers the max-integers demo task."
    evidence = _EVIDENCE_RE.findall(request.prompt)
    proposal = {
        "parent_generation_id": parent_match.group(1),
        "summary": "Compare integer values, not token strings, when taking the maximum.",
        "rationale": (
            "[scripted fixture — authored repair, not model-derived] Convert "
            "tokens to int before max() so comparison is numeric rather than "
            "lexicographic."
        ),
        "trace_evidence": evidence,
        "expected_outcome": (
            "Multi-digit maxima are selected correctly; single-value, empty, and "
            "negative inputs keep their current behavior."
        ),
        "source": SCRIPTED_MAX_INTEGERS_FIX,
        "changed_surfaces": ["strategy-code"],
        "risks": ["none identified beyond normal regression risk"],
        "assumptions": ["token pattern -?\\d+ already captures all integers"],
    }
    return json.dumps(proposal)


def scripted_fixture_adapter() -> FakeModelAdapter:
    """The fake adapter used by tests and by `strive run --proposer model`
    when no real provider is configured through the environment."""
    return FakeModelAdapter(responder=scripted_proposal_responder)


# -- the prompt-sensitive deterministic adapter (Stage 3C.1 experiment) -------------------
#
# What this is, stated precisely: a deterministic instruction follower whose
# output is a FUNCTION OF THE PROMPT CONTENT — the causal wiring the
# experiment measures. Both strategy variants below are author-written
# fixtures; the adapter merely selects between them based on what evidence
# the active prompt template actually surfaced. This proves that the prompt
# artifact is consumed and changes proposer behavior; it demonstrates nothing
# about real-model prompt-following or reasoning.

SIGNED_SUM_FIX = '''\
"""Strategy: sum signed integer tokens."""

import re


def solve(input_text: str) -> int:
    return sum(int(token) for token in re.findall(r"-?\\d+", input_text))
'''

UNSIGNED_SUM_ATTEMPT = '''\
"""Strategy: sum integer tokens (unsigned extraction)."""

import re


def solve(input_text: str) -> int:
    return sum(int(token) for token in re.findall(r"\\d+", input_text))
'''

_NEGATIVE_INPUT_RE = re.compile(r"input=[^\n]*-\d")


def prompt_sensitive_responder(request: ModelRequest) -> str:
    """Deterministic prompt-dependent behavior for the sum-integers task.

    - If the prompt surfaces failing-case INPUT EXCERPTS (an `input=` line
      containing a negative literal), the responder "notices" the signs and
      proposes the signed extraction fix.
    - If the prompt withholds the excerpts (ids + feedback only), it proposes
      a plausible but unsigned extraction that cannot fix the weakness.
    - If the prompt lacks a template-provided excerpt section entirely, it
      additionally proposes a prompt_update asking future prompts to include
      the failing inputs — a bounded, generic template change that contains
      neither hidden cases nor any strategy code.
    """
    parent_match = _PARENT_RE.search(request.prompt)
    if parent_match is None or "sum-integers" not in request.prompt:
        return "This responder only covers the sum-integers experiment task."
    evidence = _EVIDENCE_RE.findall(request.prompt) or re.findall(
        r"^- ([\w-]+): feedback=", request.prompt, re.MULTILINE
    )
    saw_inputs = _NEGATIVE_INPUT_RE.search(request.prompt) is not None
    proposal: dict[str, object] = {
        "parent_generation_id": parent_match.group(1),
        "summary": (
            "Extract signed integer tokens before summing."
            if saw_inputs
            else "Restructure integer extraction before summing."
        ),
        "rationale": (
            "[deterministic fixture] The failing inputs shown in the prompt "
            "contain minus signs immediately before digits; extraction must "
            "keep them."
            if saw_inputs
            else "[deterministic fixture] The failing feedback suggests the "
            "extraction misses some tokens; reformulate it."
        ),
        "trace_evidence": evidence,
        "expected_outcome": (
            "Signed integers are summed correctly."
            if saw_inputs
            else "Extraction is more robust."
        ),
        "source": SIGNED_SUM_FIX if saw_inputs else UNSIGNED_SUM_ATTEMPT,
        "changed_surfaces": ["strategy-code"],
        "risks": ["regression risk on unusual formats"],
        "assumptions": ["integer tokens are whitespace/punctuation delimited"],
    }
    if "input=" not in request.prompt:
        # the prompt withheld the excerpts: propose the bounded template
        # change that would surface them for FUTURE proposals
        from strive.experiment import CANDIDATE_TEMPLATE

        proposal["prompt_update"] = CANDIDATE_TEMPLATE
        proposal["changed_surfaces"] = ["prompt", "strategy-code"]
    return json.dumps(proposal)


def prompt_sensitive_adapter() -> FakeModelAdapter:
    return FakeModelAdapter(responder=prompt_sensitive_responder)
