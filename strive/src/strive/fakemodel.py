"""Deterministic reference responses for the fake model adapter.

Honesty note (see HANDOFF): a fake model demonstrates that the *pipeline* —
prompt construction, strict schema validation, forbidden-source screening,
sandboxed validation, gated promotion, journaling, replay — is correct. It
does not demonstrate model capability: the "reasoning" below is a fixture
standing in for what a real model would generate online. Real-model runs are
opt-in via environment variables (see ``strive.model.adapter_from_env``).
"""

from __future__ import annotations

import json
import re

from strive.contracts import ModelRequest
from strive.model import FakeModelAdapter

MAX_INTEGERS_FIXED_SOURCE = '''\
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


def demo_responder(request: ModelRequest) -> str:
    """Scripted stand-in for a real model on the demo tasks.

    Reads the parent generation id and cited failing cases out of the prompt
    (as a real model would) and answers with a structured proposal. Only the
    max-integers lexicographic-max weakness is recognized; anything else gets
    a deliberately honest refusal that the schema validator will reject.
    """
    parent_match = _PARENT_RE.search(request.prompt)
    if parent_match is None or "max-integers" not in request.prompt:
        return "I do not recognize this task, so I cannot propose a fix."
    evidence = _EVIDENCE_RE.findall(request.prompt)
    proposal = {
        "parent_generation_id": parent_match.group(1),
        "summary": "Compare integer values, not token strings, when taking the maximum.",
        "rationale": (
            "The failing cases return a smaller number whenever a shorter token "
            "beats a longer one (e.g. expecting 100 but getting 7): max() is "
            "running over strings, so comparison is lexicographic. Converting "
            "tokens to int before max() makes the comparison numeric."
        ),
        "trace_evidence": evidence,
        "expected_outcome": (
            "Multi-digit maxima are selected correctly; single-value, empty, and "
            "negative inputs keep their current behavior."
        ),
        "source": MAX_INTEGERS_FIXED_SOURCE,
        "changed_surfaces": ["strategy-code"],
        "risks": ["none identified beyond normal regression risk"],
        "assumptions": ["token pattern -?\\d+ already captures all integers"],
    }
    return json.dumps(proposal)


def demo_adapter() -> FakeModelAdapter:
    """The fake adapter used by tests and by `strive run --proposer model`
    when no real provider is configured through the environment."""
    return FakeModelAdapter(responder=demo_responder)
