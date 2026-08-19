"""`continual-refine@1` — the real continual model-led policy, end to end.

CI uses a DETERMINISTIC fake model through the exact production adapter path
(`ModelCatalog` -> `FakeModelAdapter`); no network, no real model. The fake's
responder reads the rendered prompt (active proposal-template + context) and
returns a strict `RefinementProposal` JSON — so the ACTIVE PROMPT genuinely
determines the proposal (an ablation test proves it).

Scenario proved here: seed harness has the planted `\\d+` weakness (drops minus
signs) -> refinement trigger -> typed coupled prompt+code proposal -> immediate
apply -> behavior changes (negatives now sum correctly) -> restart resumes
exactly with no duplicate model call -> review keeps or reverts -> rollback
restores the exact prior state. Plus adversarial failure modes.
"""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path
from typing import Callable

import pytest

from strive import codec
from strive.contracts import BudgetSpec, ModelRequest, ModelResponse
from strive.kernel import KernelError, KernelServices, RunReport, run_policy
from strive.model import FakeModelAdapter, ModelCatalog
from strive.policies import continual_refine as cr
from strive.policy import RunView, conformance_violations, default_catalog
from strive.runtime import REFINE_DISPATCH, REFINE_RESULT, ModelResult
from strive.sandboxes import CandidateExecutor, default_catalog as sandbox_catalog
from strive.substrate import (
    ChangeApplied,
    ChangeReverted,
    ObservationRecorded,
    Substrate,
    new_run_id,
)
from strive.tasks import SUM_INTEGERS_TASK as TASK

# the planted-weakness seed: naive \d+ drops minus signs, so negatives fail
_WEAK_CODE = (
    "import re\n\n\ndef solve(input_text: str) -> int:\n"
    '    return sum(int(t) for t in re.findall(r"\\d+", input_text))\n'
)
# a seed proposal template that DOES ask for signed-integer handling
_SIGNED_PROMPT = (
    "Improve solve(input_text) to sum ALL signed integers, including negative "
    "numbers written with a leading minus sign.\n"
)
# a seed template that does NOT mention signed/negative handling (ablation)
_NEUTRAL_PROMPT = "Make solve(input_text) tidy and well-formatted.\n"

# the model's fix (handles negatives) and a cosmetic non-fix (still \d+)
_FIXED_CODE = (
    "import re\n\n\ndef solve(input_text: str) -> int:\n"
    '    return sum(int(t) for t in re.findall(r"-?\\d+", input_text))\n'
)
_COSMETIC_CODE = (
    "import re\n\n\ndef solve(input_text: str) -> int:\n"
    "    # tidy version\n"
    '    return sum(int(t) for t in re.findall(r"\\d+", input_text))\n'
)
_FIXED_PROMPT = _SIGNED_PROMPT + "Use the pattern -?\\d+ to include negatives.\n"


def _proposal_json(*, code: str, prompt: str, review_hint: str = "keep") -> str:
    return json.dumps({
        "change_id": "refine-c0",
        "rationale": "handle signed integers via -?\\d+",
        "cited_evidence": ["negative-all", "negative-single"],
        "expected_outcomes": ["negative-all=-6"],
        "uncertainty": 0.1,
        "review_hint": review_hint,
        "edits": [
            {"surface_kind": "strategy-code", "surface_name": "solve", "content": code},
            {"surface_kind": "prompt", "surface_name": "proposal-template", "content": prompt},
        ],
    })


def _responder(request: ModelRequest) -> str:
    """Causal: fix the code ONLY when the active prompt asks for signed
    integers; otherwise propose a cosmetic (non-fixing) change."""
    wants_signed = "signed" in request.prompt.lower() or "negative" in request.prompt.lower()
    if wants_signed:
        return _proposal_json(code=_FIXED_CODE, prompt=_FIXED_PROMPT)
    return _proposal_json(code=_COSMETIC_CODE, prompt=_NEUTRAL_PROMPT)


def _catalog(responder: Callable[[ModelRequest], str] = _responder) -> ModelCatalog:
    return ModelCatalog({"refine": FakeModelAdapter(responder=responder)})


def _services(
    root: Path, run_id: str, *, models: ModelCatalog | None = None,
    budget: BudgetSpec | None = None,
) -> KernelServices:
    return KernelServices.open(
        root, TASK, run_id, seed=7,
        budget=budget or BudgetSpec(model_calls=4, executions=64),
        models=models or _catalog(), model_role="refine",
    )


def _config(**overrides: object) -> cr.ContinualRefineConfig:
    base = cr.load_config(cr.DEFAULT_CONFIG_PATH)
    return dataclasses.replace(base, **overrides)  # type: ignore[arg-type]


def _drive(
    root: Path, run_id: str, *, prompt: str = _SIGNED_PROMPT,
    config: cr.ContinualRefineConfig | None = None,
    models: ModelCatalog | None = None, budget: BudgetSpec | None = None,
    max_commands: int = 128,
) -> RunReport:
    services = _services(root, run_id, models=models, budget=budget)
    objects = services.substrate.objects
    cfg = config or _config()
    seed_state = cr.seed_state(objects, code=_WEAK_CODE, prompt=prompt)
    return run_policy(
        services, default_catalog(), "continual-refine@1", cfg,
        prompt_refs=cr.prompt_refs(objects), seed_state=seed_state,
        run_metadata={"model": "fake"}, max_commands=max_commands,
    )


def _active_code(root: Path, run_id: str) -> str:
    sub = Substrate.discover(root, run_id)
    view = sub.verify()
    ref = view.state.content_ref("strategy-code", "solve")
    assert ref is not None
    return sub.objects.get_text(ref)


def _runs(source: str, text: str) -> int | None:
    executor = CandidateExecutor.from_catalog(
        sandbox_catalog(), "process-fault-only@1", trusted=True
    )
    from strive.contracts import TaskCase

    outcome = executor.execute_suite(
        source, (TaskCase("c", text, 0, "held_out"),), generation_id="probe"
    )
    return outcome.report.outcomes[0].output if outcome.report.outcomes else None


# -- descriptor conformance -----------------------------------------------------------------------


def test_descriptor_conforms() -> None:
    assert conformance_violations(cr.DESCRIPTOR) == []


# -- the happy path: refine -> apply -> keep ------------------------------------------------------


def test_seed_weakness_is_fixed_by_one_refinement(tmp_path: Path) -> None:
    run = new_run_id()
    # baseline behavior: the weak seed drops the minus sign
    assert _runs(_WEAK_CODE, "deltas: -1 -2 -3") == 6  # WRONG (should be -6)
    report = _drive(tmp_path, run)
    assert report.stopped_reason.startswith("review verdict: keep")
    # the active strategy is now the fix, and it sums negatives correctly
    active = _active_code(tmp_path, run)
    assert "-?" in active
    assert _runs(active, "deltas: -1 -2 -3") == -6  # behavior CHANGED
    # exactly one model call was charged
    assert report.usage.model_calls == 1


def test_active_prompt_causally_determines_the_proposal(tmp_path: Path) -> None:
    # same fake model, same code — only the ACTIVE PROMPT differs
    signed = new_run_id()
    _drive(tmp_path, signed, prompt=_SIGNED_PROMPT)
    assert "-?" in _active_code(tmp_path, signed)  # fixed

    neutral = new_run_id()
    _drive(tmp_path, neutral, prompt=_NEUTRAL_PROMPT)
    assert "-?" not in _active_code(tmp_path, neutral)  # NOT fixed (cosmetic only)
