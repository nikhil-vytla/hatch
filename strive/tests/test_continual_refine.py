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


# -- helpers for journal inspection ---------------------------------------------------------------


def _bodies(root: Path, run_id: str) -> list[object]:
    return list(Substrate.discover(root, run_id).verify().bodies)


def _count_kind(root: Path, run_id: str, observation_kind: str) -> int:
    return sum(
        1 for b in _bodies(root, run_id)
        if isinstance(b, ObservationRecorded) and b.observation_kind == observation_kind
    )


def _terminal_outcome(root: Path, run_id: str, cid: str) -> str | None:
    from strive.substrate import PolicyCommandCompleted

    for b in _bodies(root, run_id):
        if isinstance(b, PolicyCommandCompleted) and b.command_id == cid:
            return b.outcome
    return None


# -- optional EvaluateFork run (comparative observation, not a gate) ------------------------------


def test_fork_run_observes_then_applies_and_keeps(tmp_path: Path) -> None:
    run = new_run_id()
    report = _drive(tmp_path, run, config=_config(use_fork=True))
    # a fork summary was recorded (the optional comparative observation)
    from strive.runtime import FORK_SUMMARY

    assert _count_kind(tmp_path, run, FORK_SUMMARY) == 1
    # the change was still applied immediately and kept (the fix improved)
    assert "-?" in _active_code(tmp_path, run)
    assert report.stopped_reason.startswith("review verdict: keep")


# -- review reverts and rollback restores the EXACT prior state -----------------------------------


def test_review_revert_restores_exact_prior_state(tmp_path: Path) -> None:
    # a cosmetic (non-improving) change under a fork: apply immediately, the
    # fork shows no improvement, auto-review reverts, state returns to seed
    run = new_run_id()
    _drive(tmp_path, run, prompt=_NEUTRAL_PROMPT, config=_config(use_fork=True))
    assert _active_code(tmp_path, run) == _WEAK_CODE  # EXACT rollback to seed
    c = 0
    assert _terminal_outcome(tmp_path, run, f"{run}:apply:{c}") == "ok"
    assert _terminal_outcome(tmp_path, run, f"{run}:revert:{c}") == "ok"


# -- restart resumes exactly with NO duplicate model call / spend / effect ------------------------


def test_restart_resumes_without_duplicate_model_call(tmp_path: Path) -> None:
    run = new_run_id()
    # stop after the first command (the refinement)
    first = _drive(tmp_path, run, max_commands=1)
    assert first.usage.model_calls == 1
    assert _count_kind(tmp_path, run, REFINE_RESULT) == 1
    # resume to completion — the completed refinement is NOT re-called
    second = _drive(tmp_path, run)
    assert second.resumed is True
    assert second.usage.model_calls == 1  # still one — no duplicate spend
    assert _count_kind(tmp_path, run, REFINE_RESULT) == 1  # no duplicate effect
    assert "-?" in _active_code(tmp_path, run)


# -- adversarial: malformed / failing model, exhausted budget, indeterminate ----------------------


def test_malformed_model_output_is_failure_as_data(tmp_path: Path) -> None:
    run = new_run_id()
    models = ModelCatalog({"refine": FakeModelAdapter(responder=lambda r: "not json at all")})
    report = _drive(tmp_path, run, models=models)
    assert _terminal_outcome(tmp_path, run, f"{run}:refine:0") == "failed"
    assert _active_code(tmp_path, run) == _WEAK_CODE  # state untouched
    assert report.usage.model_calls == 1  # the call happened and stays charged
    assert _count_kind(tmp_path, run, REFINE_RESULT) == 1  # a durable failure result


def test_model_adapter_error_is_failure_as_data(tmp_path: Path) -> None:
    def _boom(_r: ModelRequest) -> str:
        raise ValueError("provider exploded")

    run = new_run_id()
    report = _drive(tmp_path, run, models=ModelCatalog({"refine": FakeModelAdapter(responder=_boom)}))
    assert _terminal_outcome(tmp_path, run, f"{run}:refine:0") == "failed"
    assert _active_code(tmp_path, run) == _WEAK_CODE
    assert report.usage.model_calls == 1


def test_exhausted_model_budget_fails_with_no_effect(tmp_path: Path) -> None:
    run = new_run_id()
    report = _drive(tmp_path, run, budget=BudgetSpec(model_calls=0, executions=64))
    assert _terminal_outcome(tmp_path, run, f"{run}:refine:0") == "failed"
    assert report.usage.model_calls == 0  # a pre-call denial charges nothing
    assert _count_kind(tmp_path, run, REFINE_DISPATCH) == 0  # no dispatch effect
    assert _count_kind(tmp_path, run, REFINE_RESULT) == 0
    assert _active_code(tmp_path, run) == _WEAK_CODE


def test_dispatch_without_result_is_indeterminate_not_rerun(tmp_path: Path) -> None:
    # a BaseException (not Exception) mid-call leaves an OPEN dispatch: the
    # process dies after journaling the dispatch but before any result
    def _crash(_r: ModelRequest) -> str:
        raise KeyboardInterrupt("process died mid-call")

    run = new_run_id()
    crashing = ModelCatalog({"refine": FakeModelAdapter(responder=_crash)})
    with pytest.raises(KeyboardInterrupt):
        _drive(tmp_path, run, models=crashing)
    # an open dispatch, no result
    assert _count_kind(tmp_path, run, REFINE_DISPATCH) == 1
    assert _count_kind(tmp_path, run, REFINE_RESULT) == 0
    # resume with a HEALTHY model: the open dispatch is reconciled indeterminate,
    # never silently re-called
    report = _drive(tmp_path, run)
    assert _terminal_outcome(tmp_path, run, f"{run}:refine:0") == "indeterminate"
    assert _count_kind(tmp_path, run, REFINE_RESULT) == 0  # no silent re-dispatch
    assert report.usage.model_calls == 1  # the open dispatch's reservation
    assert _active_code(tmp_path, run) == _WEAK_CODE


def _review_responder(verdict: str) -> Callable[[ModelRequest], str]:
    def responder(request: ModelRequest) -> str:
        if "review @1" in request.prompt:  # the pinned review.md control prompt
            return json.dumps({
                "change_id": "review-0", "edits": [], "rationale": f"verdict {verdict}",
                "cited_evidence": [], "expected_outcomes": [], "uncertainty": 0.0,
                "review_hint": verdict,
            })
        return _proposal_json(code=_FIXED_CODE, prompt=_FIXED_PROMPT)
    return responder


def test_model_review_keep(tmp_path: Path) -> None:
    run = new_run_id()
    models = ModelCatalog({"refine": FakeModelAdapter(responder=_review_responder("keep"))})
    report = _drive(tmp_path, run, config=_config(review_mode="model"), models=models)
    assert report.usage.model_calls == 2  # refine + review
    assert "-?" in _active_code(tmp_path, run)  # kept
    assert report.stopped_reason.startswith("review verdict: keep")


def test_model_review_revert_rolls_back(tmp_path: Path) -> None:
    run = new_run_id()
    models = ModelCatalog({"refine": FakeModelAdapter(responder=_review_responder("revert"))})
    _drive(tmp_path, run, config=_config(review_mode="model"), models=models)
    assert _active_code(tmp_path, run) == _WEAK_CODE  # model-decided revert rolled back
    assert _terminal_outcome(tmp_path, run, f"{run}:revert:0") == "ok"


def test_unavailable_secure_backend_fails_closed(tmp_path: Path) -> None:
    from strive.sandboxes import SandboxError

    with pytest.raises(SandboxError):
        KernelServices.open(
            tmp_path, TASK, new_run_id(), seed=7,
            budget=BudgetSpec(model_calls=1),
            sandbox_backend="linux-landlock-seccomp@1", trusted=False,
            models=_catalog(),
        )


def test_resume_at_every_command_boundary_is_exact(tmp_path: Path) -> None:
    # drive one command at a time (a crash+resume after every boundary); the run
    # converges to the same fixed state with exactly one model call and stays
    # fully verifiable throughout
    run = new_run_id()
    for _ in range(12):
        report = _drive(tmp_path, run, config=_config(use_fork=True), max_commands=1)
        assert Substrate.discover(tmp_path, run).verify().ok
        if report.stopped_reason != "max-commands":
            break
    assert "-?" in _active_code(tmp_path, run)
    assert _count_kind(tmp_path, run, REFINE_RESULT) == 1  # never re-called
    assert _count_kind(tmp_path, run, REFINE_DISPATCH) == 1


def test_nonfinite_uncertainty_is_rejected(tmp_path: Path) -> None:
    # a proposal with NaN uncertainty is malformed — failure-as-data, not a
    # silently-coerced change
    bad = (
        '{"change_id":"c0","rationale":"x","cited_evidence":[],'
        '"expected_outcomes":[],"uncertainty":NaN,"review_hint":"keep",'
        '"edits":[{"surface_kind":"strategy-code","surface_name":"solve",'
        '"content":"def solve(input_text: str) -> int:\\n    return 0\\n"}]}'
    )
    run = new_run_id()
    models = ModelCatalog({"refine": FakeModelAdapter(responder=lambda r: bad)})
    _drive(tmp_path, run, models=models)
    assert _terminal_outcome(tmp_path, run, f"{run}:refine:0") == "failed"
    assert _active_code(tmp_path, run) == _WEAK_CODE
