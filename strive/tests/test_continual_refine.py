"""`continual-refine@1` — the real continual model-led policy, end to end.

CI drives it with a DETERMINISTIC fake model through the exact production
adapter path (`ModelCatalog` -> `FakeModelAdapter`); no network. The fake reads
the rendered prompt — the pinned control prompt + the ACTIVE proposal template +
the policy context (real observations, prior rationale, changes, usage,
failures) — and returns a strict `RefinementProposal` under the issued durable
constraints. The seed prompt NEVER reveals the planted fix: the refiner learns
it from the negative-case failures it observed and must cite.

Proved: operate the weak harness (record negative failures) -> refine citing
them -> immediate apply -> operate again (behavior changed) -> review
keep/revert/revise/defer -> next cycle; restart is exact with no duplicate
model call; model-binding drift, forged linkage, budget reservations, edit-limit
violations, and an insecure production backend all fail closed; and EvaluateFork
stays an optional observation, never a gate.
"""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path
from typing import Callable

import pytest

from strive import codec
from strive.contracts import BudgetSpec, ModelRequest
from strive.kernel import KernelError, KernelServices, RunReport, run_policy
from strive.model import FakeModelAdapter, ModelCatalog
from strive.policies import continual_refine as cr
from strive.policy import RunView, conformance_violations, default_catalog
from strive.runtime import (
    OBSERVE_RESULT,
    REFINE_BINDING,
    REFINE_DISPATCH,
    REFINE_RESULT,
    AttemptRecord,
    ModelDispatch,
    ModelResult,
    RefinementProposal,
)
from strive.substrate import (
    ChangeApplied,
    ObservationRecorded,
    PolicyCommandCompleted,
    Substrate,
    new_run_id,
)
from strive.tasks import SUM_INTEGERS_TASK as TASK

# the planted-weakness seed: naive \d+ drops minus signs, so negatives fail
_WEAK_CODE = (
    "import re\n\n\ndef solve(input_text: str) -> int:\n"
    '    return sum(int(t) for t in re.findall(r"\\d+", input_text))\n'
)
# a BEHAVIORAL seed prompt that does NOT reveal the fix
_SEED_PROMPT = (
    "Improve solve(input_text) so it is correct on every observed case. React "
    "to the concrete failures reported in the refinement context.\n"
)
# the model's fix (handles negatives) and a further revision
_FIXED_CODE = (
    "import re\n\n\ndef solve(input_text: str) -> int:\n"
    '    return sum(int(t) for t in re.findall(r"-?\\d+", input_text))\n'
)
_REVISED_CODE = (
    "import re\n\n\ndef solve(input_text: str) -> int:\n"
    "    # revised\n"
    '    return sum(int(t) for t in re.findall(r"-?\\d+", input_text))\n'
)
_IMPROVED_PROMPT = _SEED_PROMPT + "Remember signed integers use a leading '-'.\n"


def _required_change_id(prompt: str) -> str:
    for line in prompt.splitlines():
        if line.startswith("required_change_id:"):
            return line.split(":", 1)[1].strip()
    raise AssertionError("no required_change_id in the rendered prompt")


def _cited_failures(prompt: str) -> list[str]:
    cited = []
    for line in prompt.splitlines():
        if "FAIL case " in line:
            cited.append(line.split("FAIL case ", 1)[1].split(":", 1)[0].strip())
    return sorted(set(cited))


def _proposal(change_id: str, *, code: str, prompt: str | None, cited: list[str],
              review_hint: str = "keep") -> str:
    edits = [{"surface_kind": "strategy-code", "surface_name": "solve", "content": code}]
    if prompt is not None:
        edits.append(
            {"surface_kind": "prompt", "surface_name": "proposal-template", "content": prompt}
        )
    return json.dumps({
        "change_id": change_id, "rationale": "handle signed integers (-?\\d+)",
        "cited_evidence": cited, "expected_outcomes": ["negatives sum correctly"],
        "uncertainty": 0.1, "review_hint": review_hint, "edits": edits,
    })


def _responder(*, review_verdict: str = "keep", fix: bool = True) -> Callable[[ModelRequest], str]:
    def responder(request: ModelRequest) -> str:
        prompt = request.prompt
        change_id = _required_change_id(prompt)
        if "review @1" in prompt:  # the pinned review control prompt
            if review_verdict == "revise":
                return _proposal(change_id, code=_REVISED_CODE, prompt=None, cited=[],
                                 review_hint="revise")
            return json.dumps({
                "change_id": change_id, "rationale": f"verdict {review_verdict}",
                "cited_evidence": [], "expected_outcomes": [], "uncertainty": 0.0,
                "review_hint": review_verdict, "edits": [],
            })
        # refine role: cite the observed failing cases and fix the code + prompt
        return _proposal(
            change_id, code=_FIXED_CODE if fix else _WEAK_CODE.replace("\\d+", "\\d+ "),
            prompt=_IMPROVED_PROMPT, cited=_cited_failures(prompt),
        )
    return responder


def _catalog(responder: Callable[[ModelRequest], str] | None = None) -> ModelCatalog:
    return ModelCatalog({"refine": FakeModelAdapter(responder=responder or _responder())})


def _config(**overrides: object) -> cr.ContinualRefineConfig:
    base = cr.load_config(cr.DEFAULT_CONFIG_PATH)
    return dataclasses.replace(base, **overrides)  # type: ignore[arg-type]


def _drive(
    root: Path, run_id: str, *, config: cr.ContinualRefineConfig | None = None,
    models: ModelCatalog | None = None, budget: BudgetSpec | None = None,
    max_commands: int = 128,
) -> RunReport:
    # tests opt IN to the fault-only backend explicitly (test-only escape hatch);
    # production continual-refine@1 requires a secure backend
    services = KernelServices.open(
        root, TASK, run_id, seed=7,
        sandbox_backend="process-fault-only@1", trusted=True,
        allow_insecure_execution=True,
        budget=budget or BudgetSpec(model_calls=8, executions=512),
        models=models or _catalog(), model_role="refine",
    )
    objects = services.substrate.objects
    cfg = config or _config()
    seed_state = cr.seed_state(objects, code=_WEAK_CODE, prompt=_SEED_PROMPT)
    return run_policy(
        services, default_catalog(), "continual-refine@1", cfg,
        prompt_refs=cr.prompt_refs(objects), seed_state=seed_state,
        run_metadata={"model": "fake"}, max_commands=max_commands,
    )


# -- journal inspection helpers -------------------------------------------------------------------


def _view(root: Path, run_id: str) -> RunView:
    sub = Substrate.discover(root, run_id)
    return RunView.of(0, sub.verify(), sub.objects.reader())


def _bodies(root: Path, run_id: str) -> list[object]:
    return list(Substrate.discover(root, run_id).verify().bodies)


def _count_kind(root: Path, run_id: str, kind: str) -> int:
    return sum(
        1 for b in _bodies(root, run_id)
        if isinstance(b, ObservationRecorded) and b.observation_kind == kind
    )


def _terminal(root: Path, run_id: str, cid: str) -> str | None:
    for b in _bodies(root, run_id):
        if isinstance(b, PolicyCommandCompleted) and b.command_id == cid:
            return b.outcome
    return None


def _active_code(root: Path, run_id: str) -> str:
    v = _view(root, run_id)
    ref = v.state.content_ref("strategy-code", "solve")
    assert ref is not None
    return v.read_text(ref)


def _observations(root: Path, run_id: str) -> list[AttemptRecord]:
    v = _view(root, run_id)
    out = []
    for b in v.bodies:
        if isinstance(b, ObservationRecorded) and b.observation_kind == OBSERVE_RESULT:
            out.append(codec.loads(v.read_text(b.observation_ref), AttemptRecord))
    return out


def _refine_proposals(root: Path, run_id: str) -> list[RefinementProposal]:
    v = _view(root, run_id)
    out = []
    for b in v.bodies:
        if isinstance(b, ObservationRecorded) and b.observation_kind == REFINE_RESULT:
            res = codec.loads(v.read_text(b.observation_ref), ModelResult)
            if res.proposal_ref is not None:
                out.append(codec.loads(v.read_text(res.proposal_ref), RefinementProposal))
    return out


# -- descriptor + happy path ----------------------------------------------------------------------


def test_descriptor_conforms() -> None:
    assert conformance_violations(cr.DESCRIPTOR) == []
    assert cr.DESCRIPTOR.requires_secure_execution is True


def test_operate_refine_apply_operate_keep(tmp_path: Path) -> None:
    run = new_run_id()
    report = _drive(tmp_path, run)
    obs = _observations(tmp_path, run)
    assert len(obs) >= 2  # operated before AND after the change
    pre, post = obs[0], obs[-1]
    assert pre.overall < post.overall  # behavior measurably changed for the better
    assert "-?" in _active_code(tmp_path, run)  # the fix is live
    # the refiner cited concrete observed failures (learned, not seeded)
    proposals = _refine_proposals(tmp_path, run)
    assert proposals and proposals[0].cited_evidence
    assert "-?" not in _SEED_PROMPT  # the seed never revealed the fix
    # kept: a ConfirmChange sealed the applied change
    assert _terminal(tmp_path, run, f"{run}:confirm:0") == "ok"
    assert report.stopped_reason.startswith("done")


def test_pre_change_observation_records_negative_failures(tmp_path: Path) -> None:
    run = new_run_id()
    _drive(tmp_path, run)
    v = _view(tmp_path, run)
    first = _observations(tmp_path, run)[0]
    from strive.contracts import Evaluation

    ev = codec.loads(v.read_text(first.evaluation_ref), Evaluation)
    failing = {ce.case_id for ce in ev.case_evaluations if not ce.passed}
    assert "negative-all" in failing  # the planted weakness, observed durably


# -- optional fork = observation, not a gate ------------------------------------------------------


def test_fork_is_optional_observation_not_a_gate(tmp_path: Path) -> None:
    from strive.runtime import FORK_SUMMARY

    run = new_run_id()
    _drive(tmp_path, run, config=_config(use_fork=True))
    assert _count_kind(tmp_path, run, FORK_SUMMARY) == 1  # the observation happened
    assert "-?" in _active_code(tmp_path, run)  # applied immediately regardless


# -- two cycles + cadence -------------------------------------------------------------------------


def _cycle_of(prompt: str) -> int:
    for line in prompt.splitlines():
        if line.startswith("cycle:"):
            return int(line.split(":", 1)[1].strip())
    return 0


def test_two_cycles_cadence(tmp_path: Path) -> None:
    # each cycle makes a DISTINCT change (cycle 0 fixes, cycle 1 revises) so both
    # cycles do real work
    def responder(request: ModelRequest) -> str:
        change_id = _required_change_id(request.prompt)
        code = _FIXED_CODE if _cycle_of(request.prompt) == 0 else _REVISED_CODE
        return _proposal(change_id, code=code, prompt=None,
                         cited=_cited_failures(request.prompt))

    run = new_run_id()
    _drive(tmp_path, run, config=_config(trigger_mode="cadence", max_cycles=2),
           models=_catalog(responder))
    # two refine cycles ran (each journals one model result)
    assert _count_kind(tmp_path, run, REFINE_RESULT) == 2
    assert _terminal(tmp_path, run, f"{run}:confirm:1") == "ok"
    assert "# revised" in _active_code(tmp_path, run)


# -- all four review verdicts (model review) ------------------------------------------------------


def test_model_review_keep(tmp_path: Path) -> None:
    run = new_run_id()
    _drive(tmp_path, run, config=_config(review_mode="model"),
           models=_catalog(_responder(review_verdict="keep")))
    assert "-?" in _active_code(tmp_path, run)
    assert _terminal(tmp_path, run, f"{run}:confirm:0") == "ok"


def test_model_review_revert_rolls_back(tmp_path: Path) -> None:
    run = new_run_id()
    _drive(tmp_path, run, config=_config(review_mode="model"),
           models=_catalog(_responder(review_verdict="revert")))
    assert _active_code(tmp_path, run) == _WEAK_CODE  # exact rollback to seed
    assert _terminal(tmp_path, run, f"{run}:revert:0") == "ok"


def test_model_review_revise_applies_new_change_with_lineage(tmp_path: Path) -> None:
    run = new_run_id()
    _drive(tmp_path, run, config=_config(review_mode="model"),
           models=_catalog(_responder(review_verdict="revise")))
    assert "# revised" in _active_code(tmp_path, run)  # the revised change is live
    # lineage: the revise change's proposal cites the superseded change id
    applied = [b for b in _bodies(tmp_path, run) if isinstance(b, ChangeApplied)]
    assert any(b.change_id == f"{run}:revise-change:0" for b in applied)
    assert _terminal(tmp_path, run, f"{run}:confirm-revise:0") == "ok"


def test_model_review_defer_gathers_more_then_resolves(tmp_path: Path) -> None:
    # defer once, then keep — defer must NOT terminate; it observes again + re-reviews
    verdicts = iter(["defer", "keep"])

    def responder(request: ModelRequest) -> str:
        prompt = request.prompt
        change_id = _required_change_id(prompt)
        if "review @1" in prompt:
            v = next(verdicts)
            return json.dumps({
                "change_id": change_id, "rationale": v, "cited_evidence": [],
                "expected_outcomes": [], "uncertainty": 0.0, "review_hint": v, "edits": [],
            })
        return _proposal(change_id, code=_FIXED_CODE, prompt=_IMPROVED_PROMPT,
                         cited=_cited_failures(prompt))

    run = new_run_id()
    _drive(tmp_path, run, config=_config(review_mode="model"), models=_catalog(responder))
    # two review model calls happened (defer round 0, then keep round 1)
    assert _terminal(tmp_path, run, f"{run}:review:0:0") == "ok"
    assert _terminal(tmp_path, run, f"{run}:review:0:1") == "ok"
    assert _terminal(tmp_path, run, f"{run}:confirm:0") == "ok"
    assert "-?" in _active_code(tmp_path, run)


# -- restart is exact, with no duplicate model call -----------------------------------------------


def test_restart_at_every_boundary_is_exact(tmp_path: Path) -> None:
    run = new_run_id()
    for _ in range(20):
        report = _drive(tmp_path, run, max_commands=1)
        assert Substrate.discover(tmp_path, run).verify().ok
        if report.stopped_reason != "max-commands":
            break
    assert "-?" in _active_code(tmp_path, run)
    assert _count_kind(tmp_path, run, REFINE_RESULT) == 1  # never re-called
    assert _count_kind(tmp_path, run, REFINE_DISPATCH) == 1


# -- honest bounds: reservations, edit limit, cost fails closed -----------------------------------


def test_open_dispatch_reserves_input_and_output_tokens(tmp_path: Path) -> None:
    run = new_run_id()
    _drive(tmp_path, run)
    v = _view(tmp_path, run)
    disp = next(
        codec.loads(v.read_text(b.observation_ref), ModelDispatch)
        for b in v.bodies
        if isinstance(b, ObservationRecorded) and b.observation_kind == REFINE_DISPATCH
    )
    # the reservation spans BOTH the estimated input and the capped output
    assert disp.reserved_tokens > disp.max_tokens  # includes input estimate, not output alone


def test_edit_limit_violation_is_failure_as_data(tmp_path: Path) -> None:
    # a proposal with more edits than the limit is failure-as-data, not accepted
    def responder(request: ModelRequest) -> str:
        change_id = _required_change_id(request.prompt)
        return _proposal(change_id, code=_FIXED_CODE, prompt=_IMPROVED_PROMPT,
                         cited=["negative-all"])

    run = new_run_id()
    _drive(tmp_path, run, config=_config(edit_limit=1), models=_catalog(responder))
    assert _terminal(tmp_path, run, f"{run}:refine:0") == "failed"
    assert _active_code(tmp_path, run) == _WEAK_CODE  # untouched


def test_cost_budget_without_reporting_adapter_fails_closed(tmp_path: Path) -> None:
    # the fake reports cost (0.0), so make an adapter that cannot estimate/report
    class NoCostFake(FakeModelAdapter):
        reports_cost = False
        config_digest = "nocost-config"

        def estimate_cost(self, i: int, o: int) -> float | None:
            return None

    run = new_run_id()
    models = ModelCatalog({"refine": NoCostFake(responder=_responder())})
    _drive(tmp_path, run, models=models, budget=BudgetSpec(model_calls=8, executions=512, cost=1.0))
    assert _terminal(tmp_path, run, f"{run}:refine:0") == "failed"


# -- production rejects an insecure backend -------------------------------------------------------


def _failure_detail(root: Path, run_id: str, cid: str) -> str:
    from strive.substrate import OperationFailed

    for b in _bodies(root, run_id):
        if isinstance(b, OperationFailed) and b.command_id == cid:
            return b.detail
    return ""


def test_model_binding_drift_refused(tmp_path: Path) -> None:
    # crash AFTER the model binding is journaled but BEFORE the dispatch
    class CrashAfterBinding(FakeModelAdapter):
        config_digest = "model-A"

        def estimate_cost(self, i: int, o: int) -> float | None:
            raise KeyboardInterrupt("crash after binding, before dispatch")

    run = new_run_id()
    with pytest.raises(KeyboardInterrupt):
        _drive(tmp_path, run, models=ModelCatalog({"refine": CrashAfterBinding(responder=_responder())}))
    assert _count_kind(tmp_path, run, REFINE_BINDING) == 1  # bound to model-A
    assert _count_kind(tmp_path, run, REFINE_DISPATCH) == 0  # never dispatched

    # resume with a DIFFERENT model — refuse to switch after the binding
    class OtherModel(FakeModelAdapter):
        config_digest = "model-B"

    _drive(tmp_path, run, models=ModelCatalog({"refine": OtherModel(responder=_responder())}))
    assert _terminal(tmp_path, run, f"{run}:refine:0") == "failed"
    assert "switch models after issue" in _failure_detail(tmp_path, run, f"{run}:refine:0")


def test_production_rejects_insecure_backend(tmp_path: Path) -> None:
    # WITHOUT the test-only opt-in, continual-refine@1 refuses fault-only
    services = KernelServices.open(
        tmp_path, TASK, new_run_id(), seed=7,
        sandbox_backend="process-fault-only@1", trusted=True,
        budget=BudgetSpec(model_calls=4, executions=64),
        models=_catalog(), model_role="refine",
    )
    objects = services.substrate.objects
    with pytest.raises(KernelError, match="requires secure execution"):
        run_policy(
            services, default_catalog(), "continual-refine@1", _config(),
            prompt_refs=cr.prompt_refs(objects),
            seed_state=cr.seed_state(objects, code=_WEAK_CODE, prompt=_SEED_PROMPT),
            run_metadata={},
        )


# -- decode enforces the durable constraints (proposal-forgery rejections) -------------------------

from strive.refine import RefinementDecodeError, decode_proposal
from strive.surfaces import validate_prompt, validate_solve_code


def _validator(kind: str, name: str, content: str) -> None:
    if kind == "strategy-code":
        validate_solve_code(content)
    elif kind == "prompt":
        validate_prompt(content)
    else:
        from strive.surfaces import SurfaceValidationError

        raise SurfaceValidationError(f"unknown surface {(kind, name)}")


_ENABLED = frozenset({("strategy-code", "solve"), ("prompt", "proposal-template")})


def _decode(
    text: str, *, required: str = "c0", limit: int = 2, rule: str = "refine"
) -> tuple[RefinementProposal, dict[str, str]]:
    return decode_proposal(
        text, validate=_validator, enabled_surfaces=_ENABLED,
        required_change_id=required, edit_limit=limit, edit_rule=rule,
    )


def test_decode_valid_refine() -> None:
    proposal, blobs = _decode(_proposal("c0", code=_FIXED_CODE, prompt=None, cited=["x"]))
    assert proposal.change_id == "c0" and len(proposal.edits) == 1 and blobs


def test_decode_rejects_wrong_change_id() -> None:
    with pytest.raises(RefinementDecodeError, match="required cycle-scoped id"):
        _decode(_proposal("WRONG", code=_FIXED_CODE, prompt=None, cited=[]))


def test_decode_rejects_over_edit_limit() -> None:
    text = _proposal("c0", code=_FIXED_CODE, prompt=_IMPROVED_PROMPT, cited=[])
    with pytest.raises(RefinementDecodeError, match="over the edit_limit"):
        _decode(text, limit=1)


def test_decode_rejects_offlimits_surface() -> None:
    text = json.dumps({
        "change_id": "c0", "rationale": "x", "cited_evidence": [], "expected_outcomes": [],
        "uncertainty": 0.0, "review_hint": "keep",
        "edits": [{"surface_kind": "budget", "surface_name": "limits", "content": "1"}],
    })
    with pytest.raises(RefinementDecodeError, match="not enabled/pinned"):
        _decode(text)


def test_decode_rejects_nonfinite_uncertainty() -> None:
    text = (
        '{"change_id":"c0","rationale":"x","cited_evidence":[],"expected_outcomes":[],'
        '"uncertainty":NaN,"review_hint":"keep","edits":[{"surface_kind":"strategy-code",'
        '"surface_name":"solve","content":"def solve(input_text: str) -> int:\\n    return 0\\n"}]}'
    )
    with pytest.raises(RefinementDecodeError, match="NaN/Infinity"):
        _decode(text)


def test_decode_refine_requires_edits() -> None:
    text = json.dumps({
        "change_id": "c0", "rationale": "x", "cited_evidence": [], "expected_outcomes": [],
        "uncertainty": 0.0, "review_hint": "keep", "edits": [],
    })
    with pytest.raises(RefinementDecodeError, match="requires .*1 edit"):
        _decode(text, rule="refine")


def test_decode_review_keep_forbids_edits() -> None:
    with pytest.raises(RefinementDecodeError, match="requires no edits"):
        _decode(_proposal("c0", code=_FIXED_CODE, prompt=None, cited=[], review_hint="keep"),
                rule="review")


def test_decode_review_revise_requires_edits() -> None:
    text = json.dumps({
        "change_id": "c0", "rationale": "x", "cited_evidence": [], "expected_outcomes": [],
        "uncertainty": 0.0, "review_hint": "revise", "edits": [],
    })
    with pytest.raises(RefinementDecodeError, match="requires .*1 edit"):
        _decode(text, rule="review")
