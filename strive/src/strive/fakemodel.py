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
