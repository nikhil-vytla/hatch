"""`continual-refine@1` — the real continual model-led policy, end to end.

CI drives it with a DETERMINISTIC fake model through the exact production
adapter path (`ModelCatalog` -> `FakeModelAdapter`); no network. The fixture is
NON-LEAKY: it derives its proposal from the VISIBLE observed feedback in the
rendered prompt (opaque case ids + expected/got), never from a hard-coded fix
or a diagnostic case name — and the seed prompt never reveals the fix.

Proves the exit claim: operation feedback is policy-visible only (hidden splits
never train the Refiner), operation/model effects are crash-honest, review
verdicts are truthful (pre/post auto review, real keep rationale, unresolved
exhausted defer, revise→observe→review), and model-authored changes are
observed before confirmation. Fault-only is fixture-only; a secure-backend run
is exercised when the backend is available.
"""

from __future__ import annotations

import dataclasses
import json
import re
from pathlib import Path
from typing import Callable

import pytest

from strive import codec
from strive.contracts import BudgetSpec, Evaluation, ModelRequest, ModelResponse
from strive.kernel import KernelError, KernelServices, RunReport, run_policy
from strive.model import FakeModelAdapter, ModelCatalog, ModelTransportError
from strive.operate import OPERATION_SPLIT
from strive.policies import continual_refine as cr
from strive.policy import RunView, conformance_violations, default_catalog
from strive.runtime import (
    OPERATION_DISPATCH,
    OPERATION_RESULT,
    REFINE_DISPATCH,
    REFINE_RESULT,
    AttemptRecord,
    ModelDispatch,
    ModelResult,
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
_FIXED_CODE = (
    "import re\n\n\ndef solve(input_text: str) -> int:\n"
    '    return sum(int(t) for t in re.findall(r"-?\\d+", input_text))\n'
)
_REVISED_CODE = (
    "import re\n\n\ndef solve(input_text: str) -> int:\n"
    "    # revised\n"
    '    return sum(int(t) for t in re.findall(r"-?\\d+", input_text))\n'
)
_COSMETIC_CODE = (
    "import re\n\n\ndef solve(input_text: str) -> int:\n"
    "    # tidy\n"
    '    return sum(int(t) for t in re.findall(r"\\d+", input_text))\n'
)
_IMPROVED_PROMPT = _SEED_PROMPT + "Signed integers may carry a leading minus.\n"

_FAIL_RE = re.compile(r"FAIL case (\S+?): expected (-?\d+), got (\S+)")


def _required_change_id(prompt: str) -> str:
    for line in prompt.splitlines():
        if line.startswith("required_change_id:"):
            return line.split(":", 1)[1].strip()
    raise AssertionError("no required_change_id in the rendered prompt")


def _observed_failures(prompt: str) -> list[tuple[str, int]]:
    """The (opaque case id, expected) pairs the refiner actually observed."""
    return [(cid, int(exp)) for cid, exp, _got in _FAIL_RE.findall(prompt)]


def _reviewing(prompt: str) -> str:
    """The change id a review prompt is reviewing (empty if not a review)."""
    for line in prompt.splitlines():
        if line.startswith("reviewing change:"):
            return line.split(":", 1)[1].strip()
    return ""


def _proposal(change_id: str, *, code: str, prompt: str | None, cited: list[str],
              review_hint: str = "keep") -> str:
    edits = [{"surface_kind": "strategy-code", "surface_name": "solve", "content": code}]
    if prompt is not None:
        edits.append(
            {"surface_kind": "prompt", "surface_name": "proposal-template", "content": prompt}
        )
    return json.dumps({
        "change_id": change_id, "rationale": "handle the observed failing cases",
        "cited_evidence": cited, "expected_outcomes": ["failing cases pass"],
        "uncertainty": 0.1, "review_hint": review_hint, "edits": edits,
    })


def _responder(*, review_verdict: str = "keep") -> Callable[[ModelRequest], str]:
    """A NON-LEAKY fixture: it inspects the observed (opaque id, expected) pairs
    and, seeing a failing case whose EXPECTED value is negative, infers the
    harness drops signs and proposes the signed-integer fix — deriving the fix
    from observed OUTPUT feedback, not from a case name or a hard-coded answer."""
    def responder(request: ModelRequest) -> str:
        prompt = request.prompt
        change_id = _required_change_id(prompt)
        if "review @1" in prompt:  # the pinned review control prompt
            if review_verdict == "revise" and "revise-change:" not in _reviewing(prompt):
                # revise the ORIGINAL change once; the review of the revised
                # change (below) then keeps it, so the revise-change is confirmed
                return _proposal(change_id, code=_REVISED_CODE, prompt=None, cited=[],
                                 review_hint="revise")
            if review_verdict == "revise":  # now reviewing the revised change
                return json.dumps({
                    "change_id": change_id, "rationale": "revised change is good",
                    "cited_evidence": [], "expected_outcomes": [], "uncertainty": 0.0,
                    "review_hint": "keep", "edits": [],
                })
            return json.dumps({
                "change_id": change_id, "rationale": f"verdict {review_verdict}",
                "cited_evidence": [], "expected_outcomes": [], "uncertainty": 0.0,
                "review_hint": review_verdict, "edits": [],
            })
        failures = _observed_failures(prompt)
        negative = [cid for cid, exp in failures if exp < 0]
        if negative:  # observed a negative expected the harness got wrong
            return _proposal(change_id, code=_FIXED_CODE, prompt=_IMPROVED_PROMPT, cited=negative)
        return _proposal(change_id, code=_COSMETIC_CODE, prompt=None,
                         cited=[cid for cid, _ in failures])
    return responder


def _catalog(responder: Callable[[ModelRequest], str] | None = None) -> ModelCatalog:
    return ModelCatalog({"refine": FakeModelAdapter(responder=responder or _responder())})


def _config(**overrides: object) -> cr.ContinualRefineConfig:
    base = cr.load_config(cr.DEFAULT_CONFIG_PATH)
    return dataclasses.replace(base, **overrides)  # type: ignore[arg-type]


def _services(
    root: Path, run_id: str, *, models: ModelCatalog | None = None,
    budget: BudgetSpec | None = None,
) -> KernelServices:
    # tests opt IN to fault-only explicitly (the fixture-only escape hatch);
    # production continual-refine@1 requires a secure backend
    return KernelServices.open(
        root, TASK, run_id, seed=7,
        sandbox_backend="process-fault-only@1", trusted=True,
        allow_insecure_execution=True,
        budget=budget or BudgetSpec(model_calls=8, executions=512),
        models=models or _catalog(),
    )


def _drive(
    root: Path, run_id: str, *, config: cr.ContinualRefineConfig | None = None,
    models: ModelCatalog | None = None, budget: BudgetSpec | None = None,
    services: KernelServices | None = None, max_commands: int = 128,
) -> RunReport:
    services = services or _services(root, run_id, models=models, budget=budget)
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


def _model_result(root: Path, run_id: str, cid: str) -> "ModelResult":
    from strive.runtime import ModelResult

    sub = Substrate.discover(root, run_id)
    view = sub.verify()
    for env, body in zip(view.envelopes, view.bodies, strict=True):
        if (
            env.caused_by == cid
            and isinstance(body, ObservationRecorded)
            and body.observation_kind == REFINE_RESULT
        ):
            return codec.loads(sub.objects.get_text(body.observation_ref), ModelResult)
    raise AssertionError(f"no REFINE_RESULT for {cid!r}")


def _active_code(root: Path, run_id: str) -> str:
    v = _view(root, run_id)
    ref = v.state.content_ref("strategy-code", "solve")
    assert ref is not None
    return v.read_text(ref)


def _operation_evaluations(root: Path, run_id: str) -> list[Evaluation]:
    v = _view(root, run_id)
    out = []
    for b in v.bodies:
        if isinstance(b, ObservationRecorded) and b.observation_kind == OPERATION_RESULT:
            rec = codec.loads(v.read_text(b.observation_ref), AttemptRecord)
            out.append(codec.loads(v.read_text(rec.evaluation_ref), Evaluation))
    return out


# -- descriptor + happy path (non-leaky) ----------------------------------------------------------


def test_descriptor_conforms() -> None:
    assert conformance_violations(cr.DESCRIPTOR) == []
    assert cr.DESCRIPTOR.requires_secure_execution is True


def test_operate_refine_apply_operate_keep(tmp_path: Path) -> None:
    run = new_run_id()
    report = _drive(tmp_path, run)
    evals = _operation_evaluations(tmp_path, run)
    assert len(evals) >= 2  # operated before AND after the change
    pre, post = evals[0].overall_score, evals[-1].overall_score
    assert post > pre  # behavior measurably improved
    assert "-?" in _active_code(tmp_path, run)  # the fix is live
    assert _terminal(tmp_path, run, f"{run}:confirm:0") == "ok"
    assert report.stopped_reason.startswith("done")


def test_operation_feedback_is_visible_only_with_opaque_ids(tmp_path: Path) -> None:
    run = new_run_id()
    _drive(tmp_path, run)
    visible_n = len(TASK.visible_cases())
    hidden_ids = {c.case_id for c in TASK.cases if c.split != "visible"}
    for ev in _operation_evaluations(tmp_path, run):
        ids = {ce.case_id for ce in ev.case_evaluations}
        assert ids == {f"op-{i}" for i in range(visible_n)}  # opaque, visible-only
        assert not (ids & hidden_ids)  # no held-out/adversarial/audit case id
        assert all(ce.split == OPERATION_SPLIT for ce in ev.case_evaluations)


def test_refiner_cites_observed_opaque_failures(tmp_path: Path) -> None:
    run = new_run_id()
    _drive(tmp_path, run)
    v = _view(tmp_path, run)
    proposal = None
    for b in v.bodies:
        if isinstance(b, ObservationRecorded) and b.observation_kind == REFINE_RESULT:
            res = codec.loads(v.read_text(b.observation_ref), ModelResult)
            if res.proposal_ref:
                from strive.runtime import RefinementProposal

                proposal = codec.loads(v.read_text(res.proposal_ref), RefinementProposal)
                break
    assert proposal is not None
    assert proposal.cited_evidence  # cited the observed failures
    assert all(c.startswith("op-") for c in proposal.cited_evidence)  # opaque only


# -- crash-honest operation -----------------------------------------------------------------------


def test_operation_is_dispatch_then_result(tmp_path: Path) -> None:
    run = new_run_id()
    _drive(tmp_path, run)
    # each operation journaled a dispatch AND a result (crash-honest)
    assert _count_kind(tmp_path, run, OPERATION_DISPATCH) >= 2
    assert _count_kind(tmp_path, run, OPERATION_RESULT) >= 2
    assert _count_kind(tmp_path, run, OPERATION_DISPATCH) == _count_kind(
        tmp_path, run, OPERATION_RESULT
    )


def test_restart_at_every_boundary_is_exact(tmp_path: Path) -> None:
    run = new_run_id()
    for _ in range(24):
        report = _drive(tmp_path, run, max_commands=1)
        assert Substrate.discover(tmp_path, run).verify().ok
        if report.stopped_reason != "max-commands":
            break
    assert "-?" in _active_code(tmp_path, run)
    assert _count_kind(tmp_path, run, REFINE_RESULT) == 1  # no duplicate model call


def test_operation_crash_before_result_is_indeterminate(tmp_path: Path) -> None:
    # a BaseException during the operation execution leaves an OPEN dispatch
    import strive.kernel as kmod

    run = new_run_id()
    services = _services(tmp_path, run)
    original = kmod._run_attempt

    def _crash(*a: object, **k: object) -> object:
        if k.get("gen_prefix") == "operation":
            raise KeyboardInterrupt("crash during operation execution")
        return original(*a, **k)  # type: ignore[arg-type]

    kmod._run_attempt = _crash  # type: ignore[assignment]
    try:
        with pytest.raises(KeyboardInterrupt):
            _drive(tmp_path, run, services=services)
    finally:
        kmod._run_attempt = original
    assert _count_kind(tmp_path, run, OPERATION_DISPATCH) == 1
    assert _count_kind(tmp_path, run, OPERATION_RESULT) == 0
    # resume healthily: the open dispatch reconciles to indeterminate, not re-run
    _drive(tmp_path, run)
    assert _terminal(tmp_path, run, f"{run}:warmup:0:0") == "indeterminate"


# -- Area 2: infrastructure failures cannot steer adaptation --------------------------------------


def test_infrastructure_outage_never_teaches_or_reverts(tmp_path: Path) -> None:
    # every operation suffers a genuine BACKEND fault (stamped infrastructure).
    # An infrastructure-only warm-up produces NO behavioral evidence, so the run
    # must end UNRESOLVED at warm-up WITHOUT invoking the Refiner, applying a
    # change, or reverting anything.
    from strive.contracts import (
        FAULT_INFRASTRUCTURE, FAILURE_CRASH, ExecutionReport, FailureRecord,
    )
    from strive.sandboxes import CandidateExecutor, ExecutionOutcome
    from strive.substrate import ChangeApplied, ChangeConfirmed, ChangeReverted
    from strive.runtime import OP_INFRASTRUCTURE, AttemptRecord as _AR, is_behavioral_operation

    class OutageExecutor(CandidateExecutor):
        def execute_suite(self, source, cases, *, generation_id, limits=None):  # type: ignore[no-untyped-def]
            return ExecutionOutcome(
                report=ExecutionReport(
                    ok=False, generation_id=generation_id, outcomes=(),
                    failure=FailureRecord(FAILURE_CRASH, "deno backend failed to launch"),
                    fault_origin=FAULT_INFRASTRUCTURE,
                ),
                provenance=self.provenance(limits),
                denials=(),
            )

    run = new_run_id()
    services = _services(tmp_path, run)
    services.executor = OutageExecutor(services.executor._backend, trusted=True)
    report = _drive(tmp_path, run, services=services)

    sub = Substrate.discover(tmp_path, run)
    view = sub.verify()
    op_recs = [
        codec.loads(sub.objects.get_text(b.observation_ref), _AR)
        for b in view.bodies
        if isinstance(b, ObservationRecorded) and b.observation_kind == OPERATION_RESULT
    ]
    # operations ran and are every one TRUSTED-stamped infrastructure
    assert op_recs and all(r.origin == OP_INFRASTRUCTURE for r in op_recs)
    assert not any(is_behavioral_operation(r) for r in op_recs)
    # an outage produced NO proposal, apply, confirm, or revert — and no model call
    assert _count_kind(tmp_path, run, REFINE_RESULT) == 0
    assert not any(isinstance(b, (ChangeApplied, ChangeConfirmed, ChangeReverted)) for b in view.bodies)
    assert "unresolved" in report.stopped_reason


def test_missing_post_evidence_defers_and_never_reverts(tmp_path: Path) -> None:
    # warm-up is BEHAVIORAL (a change is proposed + applied), but the review
    # window then suffers an outage: with a baseline but NO behavioral post
    # evidence, review must defer and finally leave the change UNRESOLVED —
    # never reverted for lack of evidence.
    from strive.contracts import FAULT_INFRASTRUCTURE, FAILURE_CRASH, ExecutionReport, FailureRecord
    from strive.sandboxes import CandidateExecutor, ExecutionOutcome
    from strive.substrate import ChangeApplied, ChangeReverted, ChangeConfirmed

    class OutageAfterApply(CandidateExecutor):
        applied = False  # flipped to True once a change is applied

        def execute_suite(self, source, cases, *, generation_id, limits=None):  # type: ignore[no-untyped-def]
            if self.applied:  # the review window: a genuine backend outage
                return ExecutionOutcome(
                    report=ExecutionReport(
                        ok=False, generation_id=generation_id, outcomes=(),
                        failure=FailureRecord(FAILURE_CRASH, "backend down post-apply"),
                        fault_origin=FAULT_INFRASTRUCTURE,
                    ),
                    provenance=self.provenance(limits), denials=(),
                )
            return super().execute_suite(source, cases, generation_id=generation_id, limits=limits)

    run = new_run_id()
    services = _services(tmp_path, run)
    outage = OutageAfterApply(services.executor._backend, trusted=True)
    services.executor = outage

    # flip to outage once the change is applied, so warm-up is behavioral but the
    # review window is an outage
    import strive.kernel as kmod
    original = kmod._perform

    def _perform(services_: KernelServices, view: object, command: object) -> object:
        result = original(services_, view, command)  # type: ignore[arg-type]
        if type(command).__name__ == "ApplyChange":
            outage.applied = True
        return result

    kmod._perform = _perform  # type: ignore[assignment]
    try:
        report = _drive(tmp_path, run, services=services)
    finally:
        kmod._perform = original

    sub = Substrate.discover(tmp_path, run)
    view = sub.verify()
    assert any(isinstance(b, ChangeApplied) for b in view.bodies)  # a change WAS applied
    # missing behavioral post evidence: unresolved, never reverted or confirmed
    assert not any(isinstance(b, (ChangeReverted, ChangeConfirmed)) for b in view.bodies)
    assert "unresolved" in report.stopped_reason


# -- truthful review ------------------------------------------------------------------------------


def test_auto_review_no_fork_reverts_a_non_improvement(tmp_path: Path) -> None:
    # a cosmetic change that does not improve behavior: auto review (no fork)
    # compares pre/post and REVERTS rather than blindly keeping
    def cosmetic(request: ModelRequest) -> str:
        change_id = _required_change_id(request.prompt)
        if "review @1" in request.prompt:
            return json.dumps({
                "change_id": change_id, "rationale": "n/a", "cited_evidence": [],
                "expected_outcomes": [], "uncertainty": 0.0, "review_hint": "keep",
                "edits": [],
            })
        return _proposal(change_id, code=_COSMETIC_CODE, prompt=None, cited=["op-0"])

    run = new_run_id()
    _drive(tmp_path, run, models=_catalog(cosmetic))  # review_mode defaults to auto
    assert _active_code(tmp_path, run) == _WEAK_CODE  # reverted to seed
    assert _terminal(tmp_path, run, f"{run}:revert:0") == "ok"


def test_keep_confirms_with_the_real_rationale(tmp_path: Path) -> None:
    run = new_run_id()
    _drive(tmp_path, run)
    from strive.substrate import ChangeConfirmed

    confirmed = [b for b in _bodies(tmp_path, run) if isinstance(b, ChangeConfirmed)]
    assert confirmed and confirmed[0].rationale == "handle the observed failing cases"
    assert "verdict" not in confirmed[0].rationale


def test_model_review_revert_rolls_back(tmp_path: Path) -> None:
    run = new_run_id()
    _drive(tmp_path, run, config=_config(review_mode="model"),
           models=_catalog(_responder(review_verdict="revert")))
    assert _active_code(tmp_path, run) == _WEAK_CODE
    assert _terminal(tmp_path, run, f"{run}:revert:0") == "ok"


def test_exhausted_defer_stays_unresolved(tmp_path: Path) -> None:
    def always_defer(request: ModelRequest) -> str:
        change_id = _required_change_id(request.prompt)
        if "review @1" in request.prompt:
            return json.dumps({
                "change_id": change_id, "rationale": "need more", "cited_evidence": [],
                "expected_outcomes": [], "uncertainty": 0.5, "review_hint": "defer",
                "edits": [],
            })
        neg = [cid for cid, exp in _observed_failures(request.prompt) if exp < 0]
        return _proposal(change_id, code=_FIXED_CODE, prompt=_IMPROVED_PROMPT, cited=neg)

    run = new_run_id()
    report = _drive(tmp_path, run, config=_config(review_mode="model"),
                    models=_catalog(always_defer))
    # the change was applied but, after exhausting defers, left UNCONFIRMED
    from strive.substrate import ChangeConfirmed

    assert not any(isinstance(b, ChangeConfirmed) for b in _bodies(tmp_path, run))
    assert "unresolved" in report.stopped_reason
    assert "-?" in _active_code(tmp_path, run)  # applied, not reverted


def test_revise_observes_and_reviews_before_confirm(tmp_path: Path) -> None:
    run = new_run_id()
    _drive(tmp_path, run, config=_config(review_mode="model"),
           models=_catalog(_responder(review_verdict="revise")))
    # the revise change was applied, then OBSERVED and REVIEWED before confirm
    applied = [b.change_id for b in _bodies(tmp_path, run) if isinstance(b, ChangeApplied)]
    assert f"{run}:revise-change:0" in applied
    # a review of the revised change (revised=1) ran before confirming it
    assert _terminal(tmp_path, run, f"{run}:review:0:1:0") == "ok"
    assert _terminal(tmp_path, run, f"{run}:confirm:0") == "ok"
    assert "# revised" in _active_code(tmp_path, run)


def test_second_revise_in_cycle_is_unresolved_never_kept(tmp_path: Path) -> None:
    # a model that revises on EVERY review (including the review of the already-
    # revised change): the one-revise-per-cycle bound must leave the change
    # UNRESOLVED, never silently confirm it.
    from strive.substrate import ChangeConfirmed

    def always_revise(request: ModelRequest) -> str:
        change_id = _required_change_id(request.prompt)
        if "review @1" in request.prompt:
            return _proposal(change_id, code=_REVISED_CODE, prompt=None, cited=[],
                             review_hint="revise")
        neg = [cid for cid, exp in _observed_failures(request.prompt) if exp < 0]
        return _proposal(change_id, code=_FIXED_CODE, prompt=_IMPROVED_PROMPT, cited=neg)

    run = new_run_id()
    report = _drive(tmp_path, run, config=_config(review_mode="model"),
                    models=_catalog(always_revise))
    # the first revise applied; the SECOND revise resolved to unresolved-stop
    applied = [b.change_id for b in _bodies(tmp_path, run) if isinstance(b, ChangeApplied)]
    assert f"{run}:revise-change:0" in applied
    assert not any(isinstance(b, ChangeConfirmed) for b in _bodies(tmp_path, run))
    assert "unresolved" in report.stopped_reason


# -- two cycles + active-prompt causality ---------------------------------------------------------


def test_two_cycles_exercise_the_evolved_prompt(tmp_path: Path) -> None:
    # cycle 0 evolves the proposal template; cycle 1's refine runs UNDER that
    # evolved template (the kernel renders from the active template)
    seen_prompts: list[str] = []

    def responder(request: ModelRequest) -> str:
        change_id = _required_change_id(request.prompt)
        if "review @1" in request.prompt:
            return json.dumps({
                "change_id": change_id, "rationale": "k", "cited_evidence": [],
                "expected_outcomes": [], "uncertainty": 0.0, "review_hint": "keep",
                "edits": [],
            })
        seen_prompts.append(request.prompt)
        cycle = 0 if len(seen_prompts) == 1 else 1
        code = _FIXED_CODE if cycle == 0 else _REVISED_CODE
        neg = [cid for cid, exp in _observed_failures(request.prompt) if exp < 0]
        return _proposal(change_id, code=code, prompt=_IMPROVED_PROMPT if cycle == 0 else None,
                         cited=neg or ["op-0"])

    run = new_run_id()
    # model review keeps both changes, so the cycle-0 prompt evolution survives
    # to be EXERCISED by cycle 1's refinement before anything about it is trusted
    _drive(tmp_path, run, config=_config(max_cycles=2, review_mode="model"),
           models=_catalog(responder))
    assert len(seen_prompts) == 2  # two refine cycles ran
    # cycle 0's seed prompt did NOT mention the fix; cycle 1's refine ran UNDER
    # the EVOLVED template from cycle 0 (the kernel renders the active template)
    assert "leading minus" not in seen_prompts[0]
    assert "leading minus" in seen_prompts[1]
    assert "# revised" in _active_code(tmp_path, run)


# -- optional fork = observation, not a gate ------------------------------------------------------


def test_fork_is_optional_observation_not_a_gate(tmp_path: Path) -> None:
    from strive.runtime import FORK_SUMMARY

    run = new_run_id()
    _drive(tmp_path, run, config=_config(use_fork=True))
    assert _count_kind(tmp_path, run, FORK_SUMMARY) == 1  # the observation happened
    assert "-?" in _active_code(tmp_path, run)  # applied immediately regardless


# -- model intent / recovery ----------------------------------------------------------------------


def test_wrong_model_resume_refuses_without_mutating(tmp_path: Path) -> None:
    # crash BEFORE the model dispatch (issue-before-binding window)
    class CrashBeforeDispatch(FakeModelAdapter):
        config_digest = "model-A"

        def estimate_cost(self, i: int, o: int) -> float | None:
            raise KeyboardInterrupt("crash before dispatch")

    run = new_run_id()
    a = _services(tmp_path, run, models=ModelCatalog({"refine": CrashBeforeDispatch()}))
    with pytest.raises(KeyboardInterrupt):
        _drive(tmp_path, run, services=a)
    assert _count_kind(tmp_path, run, REFINE_DISPATCH) == 0  # never dispatched

    # resume with a DIFFERENT model: the resolved model is pinned in the intent,
    # so the digest guard REFUSES resume (hard error) without mutating/failing
    class OtherModel(FakeModelAdapter):
        config_digest = "model-B"

    b = _services(tmp_path, run, models=ModelCatalog({"refine": OtherModel(responder=_responder())}))
    with pytest.raises(KernelError, match="different payload digest"):
        _drive(tmp_path, run, services=b)
    # the refine command has no terminal (not failed) — it stays resumable
    assert _terminal(tmp_path, run, f"{run}:refine:0") is None


def test_cost_budget_without_estimate_fails_closed(tmp_path: Path) -> None:
    class NoEstimate(FakeModelAdapter):
        config_digest = "nocost"

        def estimate_cost(self, i: int, o: int) -> float | None:
            return None

    run = new_run_id()
    _drive(
        tmp_path, run,
        models=ModelCatalog({"refine": NoEstimate(responder=_responder())}),
        budget=BudgetSpec(model_calls=8, executions=512, cost=1.0),
    )
    assert _terminal(tmp_path, run, f"{run}:refine:0") == "failed"


def test_unusable_finish_reason_is_failure_as_data(tmp_path: Path) -> None:
    from strive.contracts import FINISH_LENGTH

    class Truncating(FakeModelAdapter):
        config_digest = "trunc"

        def complete(self, request: ModelRequest) -> ModelResponse:
            return ModelResponse(
                text="{}", model_id=self.model_id, input_tokens=1, output_tokens=1,
                finish_reason=FINISH_LENGTH,  # truncated — unusable
            )

    run = new_run_id()
    _drive(tmp_path, run, models=ModelCatalog({"refine": Truncating()}))
    assert _terminal(tmp_path, run, f"{run}:refine:0") == "failed"
    assert _active_code(tmp_path, run) == _WEAK_CODE


def test_transport_error_is_indeterminate_unknown_spend(tmp_path: Path) -> None:
    class FlakyTransport(FakeModelAdapter):
        config_digest = "flaky"

        def complete(self, request: ModelRequest) -> ModelResponse:
            raise ModelTransportError("connection reset after send")

    run = new_run_id()
    _drive(tmp_path, run, models=ModelCatalog({"refine": FlakyTransport()}))
    # a possible-dispatch transport error → indeterminate (unknown spend), the
    # open dispatch's reservation retained
    assert _terminal(tmp_path, run, f"{run}:refine:0") == "indeterminate"
    assert _count_kind(tmp_path, run, REFINE_RESULT) == 0


def test_proven_no_call_error_is_failed_not_indeterminate(tmp_path: Path) -> None:
    from strive.model import ModelNoCallError

    class Refused(FakeModelAdapter):
        config_digest = "refused"

        def complete(self, request: ModelRequest) -> ModelResponse:
            raise ModelNoCallError("connection refused before any request left")

    run = new_run_id()
    _drive(tmp_path, run, models=ModelCatalog({"refine": Refused()}))
    # a PROVEN-no-call (no spend) is a clean FAILED result, not indeterminate —
    # the dispatch was journaled, then a result recorded carrying the failure
    assert _terminal(tmp_path, run, f"{run}:refine:0") == "failed"
    assert _count_kind(tmp_path, run, REFINE_DISPATCH) == 1
    assert _count_kind(tmp_path, run, REFINE_RESULT) == 1


def test_conservative_token_reservation_denies_before_dispatch(tmp_path: Path) -> None:
    # a token budget too small to cover the adapter's CONSERVATIVE input+output
    # reservation denies the call BEFORE any dispatch — nothing is spent.
    run = new_run_id()
    _drive(
        tmp_path, run, models=_catalog(),
        budget=BudgetSpec(model_calls=8, executions=512, tokens=5),
    )
    assert _terminal(tmp_path, run, f"{run}:refine:0") == "failed"
    assert _count_kind(tmp_path, run, REFINE_DISPATCH) == 0  # denied pre-dispatch


def test_viable_finite_token_budget_succeeds(tmp_path: Path) -> None:
    # a finite token budget with room for the input estimate PLUS output tokens
    # must succeed: input is estimated first, output capped to remaining-input,
    # so the reservation never spuriously exceeds a viable budget.
    run = new_run_id()
    _drive(
        tmp_path, run, models=_catalog(),
        budget=BudgetSpec(model_calls=8, executions=512, tokens=100_000),
    )
    assert _terminal(tmp_path, run, f"{run}:refine:0") == "ok"
    assert _count_kind(tmp_path, run, REFINE_RESULT) == 1
    assert "-?" in _active_code(tmp_path, run)  # a real proposal was applied


def test_underestimated_input_reservation_rejected_post_call(tmp_path: Path) -> None:
    # an adapter that UNDER-estimates its input tokens can slip past the
    # pre-dispatch reservation, but the post-call overrun check rejects the
    # completion as failure-as-data (a finite token budget is still enforced).
    class LiesLow(FakeModelAdapter):
        config_digest = "lies-low"

        def estimate_input_tokens(self, prompt: str) -> int:
            return 1  # dishonestly tiny

    run = new_run_id()
    _drive(
        tmp_path, run,
        models=ModelCatalog({"refine": LiesLow(responder=_responder())}),
        budget=BudgetSpec(model_calls=8, executions=512, tokens=40),
    )
    assert _terminal(tmp_path, run, f"{run}:refine:0") == "failed"
    assert _active_code(tmp_path, run) == _WEAK_CODE  # nothing applied


def test_untrusted_usage_charges_reservation_not_zero(tmp_path: Path) -> None:
    # an adapter that does NOT report trustworthy usage (and returns 0 counts)
    # must be charged the CONSERVATIVE reservation, never 0; raw provider values
    # are preserved for audit.
    class NoUsage(FakeModelAdapter):
        config_digest = "no-usage"
        reports_usage = False

        def complete(self, request: ModelRequest) -> ModelResponse:
            base = super().complete(request)
            return dataclasses.replace(base, input_tokens=0, output_tokens=0)

    run = new_run_id()
    _drive(tmp_path, run, models=ModelCatalog({"refine": NoUsage(responder=_responder())}))
    res = _model_result(tmp_path, run, f"{run}:refine:0")
    assert res.input_tokens + res.output_tokens > 0  # reservation charged, not 0
    assert res.provider_extras["usage_trusted"] == "False"
    assert res.provider_extras["reported_input_tokens"] == "0"


def test_requested_and_resolved_model_ids_recorded_separately(tmp_path: Path) -> None:
    # the requested model id (dispatch) and the provider-resolved model id
    # (result) are recorded separately, even when they differ.
    class Redirects(FakeModelAdapter):
        config_digest = "redirects"

        def complete(self, request: ModelRequest) -> ModelResponse:
            base = super().complete(request)
            return dataclasses.replace(base, model_id="provider-resolved-v2")

    run = new_run_id()
    _drive(tmp_path, run, models=ModelCatalog({"refine": Redirects(responder=_responder())}))
    res = _model_result(tmp_path, run, f"{run}:refine:0")
    assert res.model_id == "provider-resolved-v2"  # resolved
    assert res.provider_extras["requested_model_id"] == "fake-deterministic-v1"
    assert res.provider_extras["resolved_model_id"] == "provider-resolved-v2"


def test_command_model_role_drives_resolution_no_services_role(tmp_path: Path) -> None:
    # there is NO services-level model role: KernelServices exposes no model_role
    # field, and the command's own model_role (from config) drives adapter
    # resolution. A catalog keyed ONLY by the config's "refine" role suffices.
    assert not hasattr(KernelServices, "model_role")
    run = new_run_id()
    services = KernelServices.open(
        tmp_path, TASK, run, seed=7,
        sandbox_backend="process-fault-only@1", trusted=True,
        allow_insecure_execution=True,
        budget=BudgetSpec(model_calls=8, executions=512),
        models=ModelCatalog({"refine": FakeModelAdapter(responder=_responder())}),
    )
    _drive(tmp_path, run, services=services)
    assert _terminal(tmp_path, run, f"{run}:refine:0") == "ok"
    assert "-?" in _active_code(tmp_path, run)


# -- production rejects an insecure backend; secure backend runs when available -------------------


def test_production_rejects_insecure_backend(tmp_path: Path) -> None:
    services = KernelServices.open(
        tmp_path, TASK, new_run_id(), seed=7,
        sandbox_backend="process-fault-only@1", trusted=True,  # NO opt-in
        budget=BudgetSpec(model_calls=4, executions=64),
        models=_catalog(),
    )
    objects = services.substrate.objects
    with pytest.raises(KernelError, match="requires secure execution"):
        run_policy(
            services, default_catalog(), "continual-refine@1", _config(),
            prompt_refs=cr.prompt_refs(objects),
            seed_state=cr.seed_state(objects, code=_WEAK_CODE, prompt=_SEED_PROMPT),
            run_metadata={},
        )


def test_continual_refine_through_secure_backend(tmp_path: Path) -> None:
    from strive.sandboxes import SECURE_EXECUTION_CAPABILITIES, default_catalog as sbx

    deno = sbx().create("deno-pyodide@1")
    available, reason = deno.available()
    if not available:
        pytest.skip(f"deno-pyodide unavailable: {reason}")
    run = new_run_id()
    services = KernelServices.open(
        tmp_path, TASK, run, seed=7,
        sandbox_backend="deno-pyodide@1", trusted=False,
        required_capabilities=SECURE_EXECUTION_CAPABILITIES,
        budget=BudgetSpec(model_calls=8, executions=512),
        models=_catalog(),
    )
    _drive(tmp_path, run, services=services)
    assert "-?" in _active_code(tmp_path, run)


# -- decode enforces the durable constraints (failure-as-data) ------------------------------------

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
) -> object:
    return decode_proposal(
        text, validate=_validator, enabled_surfaces=_ENABLED,
        required_change_id=required, edit_limit=limit, edit_rule=rule,
    )


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


def test_decode_review_keep_forbids_edits() -> None:
    with pytest.raises(RefinementDecodeError, match="requires no edits"):
        _decode(_proposal("c0", code=_FIXED_CODE, prompt=None, cited=[], review_hint="keep"),
                rule="review")
