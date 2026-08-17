"""Adversarial floor tests for the vNext substrate + kernel.

Each test attacks one guarantee the corrections added: exact run identity and
traversal safety, a closed body union, corrupt-but-present CAS, verify purity
(no read-side CAS writes), arbitrary/duplicate revert refusal, kernel command
re-derivation identity, budgets that survive restart without reset or
expansion, hyphenated task discovery via the binding index (never string
parsing), and trusted structural validation of surface content.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from strive import codec, kernel
from strive.cas import hash_text
from strive.contracts import BudgetSpec, BudgetUsage
from strive.events import now_iso
from strive.kernel import (
    IndeterminateEffect,
    KernelError,
    KernelServices,
    run_policy,
)
from strive.policies import manual_change as mc
from strive.policy import StopAdaptation, default_catalog
from strive.runtime import ENCODING, CommandPayload, ConfigBlob
from strive.substrate import (
    EMPTY_STATE,
    ChangeApplied,
    CompositeChange,
    EventEnvelope,
    PolicyCommandIssued,
    Substrate,
    SubstrateError,
    SurfaceDelta,
    canonical_state,
    new_run_id,
    validate_run_id,
)
from strive.surfaces import (
    SurfaceCatalog,
    SurfaceDescriptor,
    validate_prompt,
    validate_solve_code,
)
from strive.tasks import Task
from strive.tasks import SUM_INTEGERS_TASK as TASK

_BASELINE = (
    "import re\n\n\ndef solve(input_text: str) -> int:\n"
    '    return sum(int(t) for t in re.findall(r"\\d+", input_text))\n'
)


# -- shared helpers ---------------------------------------------------------------------------------


def _bound_sub(root: Path, run_id: str, *, task: str = "sum-integers") -> Substrate:
    """A minimally-bound substrate (no kernel), used to attack verify()."""
    sub = Substrate.open(root, task, run_id)
    code_ref = sub.objects.put_text("def solve(input_text: str) -> int:\n    return 0\n")
    prompt_ref = sub.objects.put_text("baseline proposal template")
    seed = canonical_state(
        {("strategy-code", "solve"): code_ref, ("prompt", "proposal-template"): prompt_ref}
    )
    sub.bind_policy(
        task_fingerprint="fp", policy_ref="p@1", policy_digest="pd",
        config_ref=sub.put(ConfigBlob(ENCODING, "{}")),
        prompt_refs={"refine": sub.objects.put_text("prompt-md")},
        seed=1, seed_state=seed,
        budget_ref=sub.put(BudgetSpec()),
        required_capabilities=(), run_metadata={},
    )
    return sub


def _issue(sub: Substrate, cid: str, kind: str, change: CompositeChange | None = None) -> None:
    issue = sub.verify().state_ref if kind == "EvaluateFork" else None
    ref = sub.put(CommandPayload(
        command_id=cid, kind=kind, encoding=ENCODING,
        change_ref=sub.put(change) if change is not None else None,
        target_change_id=change.change_id if change is not None else None,
        expected_state_ref=None, issue_state_ref=issue, prompt_role=None,
        context_ref=None, after_seconds=None, reason=None, json="{}",
    ))
    sub.issue_command(command_id=cid, command_kind=kind, command_ref=ref)


def _apply(sub: Substrate, cid: str, change: CompositeChange, blobs: dict[str, str]) -> None:
    _issue(sub, cid, "ApplyChange", change)
    sub.record_proposal(change=change, strategy_ref="t", caused_by=cid)
    sub.stage_change_closure(change, blobs)
    sub.apply(change=change, caused_by=cid)


def _drive(root: Path, run_id: str, *, executions: int = 128) -> object:
    services = KernelServices.open(
        root, TASK, run_id, seed=7, budget=BudgetSpec(executions=executions)
    )
    objects = services.substrate.objects
    return run_policy(
        services, default_catalog(), "manual-change@1",
        mc.load_config(mc.DEFAULT_CONFIG_PATH),
        prompt_refs=mc.prompt_refs(objects),
        seed_state=mc.seed_state(objects, code=_BASELINE, prompt="base proposal template"),
        run_metadata={},
    )


# -- exact run identity + traversal -----------------------------------------------------------------


@pytest.mark.parametrize("bad", ["../evil", "a/b", "..", "run/../x", "", "a" * 200, "\\x"])
def test_bad_run_ids_rejected(bad: str) -> None:
    with pytest.raises(SubstrateError):
        validate_run_id(bad)


def test_hyphenated_run_ids_and_tasks_are_allowed() -> None:
    validate_run_id("sum-integers-run-01")
    validate_run_id("run-abc.def_ghi-123")


def test_open_refuses_traversal_run_id(tmp_path: Path) -> None:
    with pytest.raises(SubstrateError):
        Substrate.open(tmp_path, "sum-integers", "../evil")


def test_hyphenated_task_discovered_from_binding_not_parsing(tmp_path: Path) -> None:
    run = new_run_id()  # opaque id encodes no task
    _bound_sub(tmp_path, run, task="multi-word-hyphenated-task")
    # discovery reads the binding index; it never string-parses the run id
    discovered = Substrate.discover(tmp_path, run)
    assert discovered.task_id == "multi-word-hyphenated-task"
    assert discovered.verify().ok


def test_task_spoofing_is_detected(tmp_path: Path) -> None:
    run = new_run_id()
    _bound_sub(tmp_path, run, task="sum-integers")
    # an attacker reopens the SAME run claiming a different task
    spoof = Substrate.open(tmp_path, "max-integers", run)
    view = spoof.verify()
    assert not view.ok
    assert any("task" in e for e in view.errors)


def test_binding_index_divergence_is_quarantined_not_stream_invalidating(
    tmp_path: Path,
) -> None:
    """The binding index is a DERIVED cache. A tampered/divergent index is
    quarantined and rebuilt from the authoritative PolicyBound — the valid
    event stream is NEVER invalidated."""
    run = new_run_id()
    sub = _bound_sub(tmp_path, run)
    assert sub.verify().ok  # a valid stream
    binding_path = tmp_path / "runs" / f"{run}.binding.json"
    binding_path.write_text(
        binding_path.read_text().replace("sum-integers", "max-integers")
    )
    quarantine = sub.ensure_binding()  # reconcile the derived index
    assert quarantine is not None and Path(quarantine).exists()
    # the stream stayed valid; the index now agrees with the authoritative event
    assert sub.verify().ok
    from strive.substrate import _read_binding

    rebuilt = _read_binding(tmp_path, run)
    assert rebuilt is not None and rebuilt.task_id == "sum-integers"


def test_binding_rebuilt_after_publication_crash(tmp_path: Path) -> None:
    """A crash between the PolicyBound event and the index write leaves a valid
    stream with NO index; discovery/ensure rebuilds it (never invalidates)."""
    run = new_run_id()
    sub = _bound_sub(tmp_path, run)
    (tmp_path / "runs" / f"{run}.binding.json").unlink()  # simulate the crash
    assert sub.verify().ok  # the stream is still valid without the index
    discovered = Substrate.discover(tmp_path, run)  # rebuilds the index
    assert discovered.task_id == "sum-integers"
    assert (tmp_path / "runs" / f"{run}.binding.json").exists()


# -- closed body union + corrupt CAS ----------------------------------------------------------------


def test_unknown_body_kind_is_refused(tmp_path: Path) -> None:
    run = new_run_id()
    sub = _bound_sub(tmp_path, run)
    view = sub.verify()
    # a registered dataclass that is NOT part of the substrate body union
    body = BudgetUsage(executions=1)
    env = EventEnvelope(
        event_id=f"{run}#{view.seq + 1}", run_id=run, task_id="sum-integers",
        seq=view.seq + 1, caused_by=None, body_kind=codec.schema_of(BudgetUsage),
        body_ref=sub.put(body), at=now_iso(),
    )
    sub.journal.append_batch([env], expected_head=view.head)
    after = sub.verify()
    assert not after.ok
    assert any("closed substrate body union" in e for e in after.errors)


def test_corrupt_but_present_cas_refuses_and_hides_state(tmp_path: Path) -> None:
    run = new_run_id()
    sub = _bound_sub(tmp_path, run)
    bound_env = sub.verify().envelopes[0]
    sub.objects._path(bound_env.body_ref).write_text("garbage-not-json")
    view = sub.verify()
    assert not view.ok
    # NEVER expose active state from an unverifiable stream
    assert view.state == EMPTY_STATE and view.state_ref is None


# -- verify purity ----------------------------------------------------------------------------------


def _object_files(root: Path) -> set[str]:
    objects = root / "objects"
    return {str(p.relative_to(objects)) for p in objects.rglob("*") if p.is_file()}


def test_verify_is_pure_no_readside_cas_writes(tmp_path: Path) -> None:
    run = new_run_id()
    sub = _bound_sub(tmp_path, run)
    # apply one change so verify's replay path runs
    seed = sub.verify().seed_state.as_map()
    code_after = hash_text("def solve(input_text: str) -> int:\n    return 5\n")
    prompt_after = hash_text("revised template")
    change = CompositeChange(
        change_id="c1",
        deltas=(
            SurfaceDelta("strategy-code", "solve", seed[("strategy-code", "solve")], code_after),
            SurfaceDelta("prompt", "proposal-template", seed[("prompt", "proposal-template")], prompt_after),
        ),
        summary="x",
    )
    _apply(sub, "cmd", change,
           {code_after: "def solve(input_text: str) -> int:\n    return 5\n",
            prompt_after: "revised template"})
    before = _object_files(tmp_path)
    for _ in range(5):
        assert sub.verify().ok
    assert _object_files(tmp_path) == before  # verify wrote nothing


# -- arbitrary / duplicate revert -------------------------------------------------------------------


def test_revert_of_never_applied_change_refused(tmp_path: Path) -> None:
    run = new_run_id()
    sub = _bound_sub(tmp_path, run)
    with pytest.raises(SubstrateError, match="no applied change"):
        sub.revert(change_id="ghost", caused_by="c")


def test_double_revert_refused(tmp_path: Path) -> None:
    run = new_run_id()
    sub = _bound_sub(tmp_path, run)
    seed = sub.verify().seed_state.as_map()
    code_after = hash_text("def solve(input_text: str) -> int:\n    return 7\n")
    change = CompositeChange(
        change_id="c1",
        deltas=(SurfaceDelta("strategy-code", "solve", seed[("strategy-code", "solve")], code_after),),
        summary="x",
    )
    _apply(sub, "a", change, {code_after: "def solve(input_text: str) -> int:\n    return 7\n"})
    _issue(sub, "r1", "RevertChange")
    sub.revert(change_id="c1", caused_by="r1")
    _issue(sub, "r2", "RevertChange")
    with pytest.raises(SubstrateError, match="already reverted"):
        sub.revert(change_id="c1", caused_by="r2")


# -- kernel command re-derivation identity ----------------------------------------------------------


def test_kernel_refuses_changed_rederived_command(tmp_path: Path) -> None:
    run = new_run_id()
    _bound_sub(tmp_path, run)  # a bound, verifiable run
    services = KernelServices.open(tmp_path, TASK, run, budget=BudgetSpec(executions=8))
    sub = services.substrate
    command = StopAdaptation(command_id=f"{run}:x", reason="r")
    # a VALID intent, but recorded under a DIFFERENT payload identity than the
    # command re-derives (a changed precondition/payload)
    bogus = sub.put(CommandPayload(
        command_id=command.command_id, kind="StopAdaptation", encoding=ENCODING,
        change_ref=None, target_change_id=None, expected_state_ref=None,
        issue_state_ref=None, prompt_role=None, context_ref=None,
        after_seconds=None, reason="DIFFERENT", json='{"reason":"DIFFERENT"}',
    ))
    sub.issue_command(command_id=command.command_id, command_kind="StopAdaptation",
                      command_ref=bogus)
    view = sub.verify()
    with pytest.raises(KernelError, match="different payload digest"):
        kernel._run_command(services, view, command)


# -- budgets survive restart ------------------------------------------------------------------------


def test_budget_not_reset_on_resume(tmp_path: Path) -> None:
    run = new_run_id()
    r1 = _drive(tmp_path, run)
    used = r1.usage.executions  # type: ignore[attr-defined]
    assert used > 0
    r2 = _drive(tmp_path, run)  # resume a completed run
    # cumulative spend is re-seeded from the durable per-fork usage, not reset
    assert r2.usage.executions >= used  # type: ignore[attr-defined]
    assert r2.resumed is True  # type: ignore[attr-defined]


def test_budget_cannot_be_expanded_on_resume(tmp_path: Path) -> None:
    run = new_run_id()
    _drive(tmp_path, run, executions=128)
    with pytest.raises(KernelError, match="budget"):
        _drive(tmp_path, run, executions=9999)


# -- trusted structural validation of surface content -----------------------------------------------


def test_bind_rejects_structurally_invalid_seed_code(tmp_path: Path) -> None:
    run = new_run_id()
    sub = Substrate.open(tmp_path, "sum-integers", run)
    code_ref = sub.objects.put_text("def solve(t):\n    return 0\n")  # wrong param name
    prompt_ref = sub.objects.put_text("p")
    seed = canonical_state(
        {("strategy-code", "solve"): code_ref, ("prompt", "proposal-template"): prompt_ref}
    )
    with pytest.raises(SubstrateError, match="seed binding.*invalid"):
        sub.bind_policy(
            task_fingerprint="fp", policy_ref="p@1", policy_digest="pd",
            config_ref=sub.put(ConfigBlob(ENCODING, "{}")),
            prompt_refs={"refine": sub.objects.put_text("md")},
            seed=1, seed_state=seed, budget_ref=sub.put(BudgetSpec()),
            required_capabilities=(), run_metadata={},
        )


def test_stage_closure_rejects_structurally_invalid_code(tmp_path: Path) -> None:
    run = new_run_id()
    sub = _bound_sub(tmp_path, run)
    seed = sub.verify().seed_state.as_map()
    bad = "def solve(t):\n    return 0\n"  # wrong param name
    bad_ref = hash_text(bad)
    change = CompositeChange(
        change_id="c1",
        deltas=(SurfaceDelta("strategy-code", "solve", seed[("strategy-code", "solve")], bad_ref),),
        summary="x",
    )
    with pytest.raises(SubstrateError, match="invalid"):
        sub.stage_change_closure(change, {bad_ref: bad})


# -- corrupt identity / result refs + closed-body forgery -------------------------------------------


def test_envelope_task_scope_forgery(tmp_path: Path) -> None:
    run = new_run_id()
    sub = _bound_sub(tmp_path, run, task="sum-integers")
    view = sub.verify()
    # a framing-valid envelope whose task_id is forged to a different task
    body = PolicyCommandIssued("k", "ConfirmChange", sub.objects.put_text("pl-k"))
    env = EventEnvelope(
        event_id=f"{run}#{view.seq + 1}", run_id=run, task_id="max-integers",
        seq=view.seq + 1, caused_by="k", body_kind=codec.schema_of(PolicyCommandIssued),
        body_ref=sub.put(body), at=now_iso(),
    )
    sub.journal.append_batch([env], expected_head=view.head)
    after = sub.verify()
    assert not after.ok
    assert any("task_id" in e or "scope forgery" in e for e in after.errors)


def test_corrupt_bound_config_ref_refused(tmp_path: Path) -> None:
    run = new_run_id()
    sub = _bound_sub(tmp_path, run)
    bound = sub._stream_policy_bound()
    assert bound is not None
    sub.objects._path(bound.config_ref).write_bytes(b"tampered")  # corrupt in place
    view = sub.verify()
    assert not view.ok
    assert any("config" in e for e in view.errors)
    assert view.state == EMPTY_STATE  # no state exposed


def test_corrupt_result_ref_refused(tmp_path: Path) -> None:
    run = new_run_id()
    _drive(tmp_path, run)
    sub = Substrate.discover(tmp_path, run)
    # corrupt one completed command's stored result object
    terminal = next(iter(sub.verify().completed.values()))
    assert terminal.result_ref is not None
    sub.objects._path(terminal.result_ref).write_bytes(b"tampered")
    view = sub.verify()
    assert not view.ok
    assert any("result ref" in e or "unreadable" in e or "corrupt" in e.lower()
               for e in view.errors)


def test_command_effect_kind_mismatch_refused(tmp_path: Path) -> None:
    run = new_run_id()
    sub = _bound_sub(tmp_path, run)
    # issue an EvaluateFork intent, then forge a ChangeApplied caused by it
    _issue(sub, "k", "EvaluateFork")
    view = sub.verify()
    seed = view.seed_state.as_map()
    code_after = hash_text("def solve(input_text: str) -> int:\n    return 4\n")
    change = CompositeChange(
        "c1", (SurfaceDelta("strategy-code", "solve", seed[("strategy-code", "solve")], code_after),), "x"
    )
    sub.objects.put_text("def solve(input_text: str) -> int:\n    return 4\n")
    after_state = sub.put_state(
        canonical_state({
            ("strategy-code", "solve"): code_after,
            ("prompt", "proposal-template"): seed[("prompt", "proposal-template")],
        })
    )
    body = ChangeApplied("c1", sub.put(change), view.state_ref or "", after_state)
    env = EventEnvelope(
        event_id=f"{run}#{view.seq + 1}", run_id=run, task_id="sum-integers",
        seq=view.seq + 1, caused_by="k", body_kind=codec.schema_of(ChangeApplied),
        body_ref=sub.put(body), at=now_iso(),
    )
    sub.journal.append_batch([env], expected_head=view.head)
    after = sub.verify()
    assert not after.ok
    assert any("incompatible command kind" in e for e in after.errors)


def test_duplicate_intent_refused_even_same_digest(tmp_path: Path) -> None:
    run = new_run_id()
    sub = _bound_sub(tmp_path, run)
    view = sub.verify()
    # forge a SECOND PolicyCommandIssued for the same id (bypass idempotent issue)
    for _ in range(2):
        v = sub.verify()
        body = PolicyCommandIssued("k", "ConfirmChange", sub.objects.put_text("pl-k"))
        env = EventEnvelope(
            event_id=f"{run}#{v.seq + 1}", run_id=run, task_id="sum-integers",
            seq=v.seq + 1, caused_by="k", body_kind=codec.schema_of(PolicyCommandIssued),
            body_ref=sub.put(body), at=v.head,
        )
        # append directly, ignoring the not-ok view after the first
        sub.journal.append_batch([env], expected_head=v.head)
    after = sub.verify()
    assert not after.ok
    assert any("duplicate intent" in e for e in after.errors)


# -- concurrency: the run lease ---------------------------------------------------------------------


def test_concurrent_runners_refused(tmp_path: Path) -> None:
    run = new_run_id()
    a = KernelServices.open(tmp_path, TASK, run)
    b = KernelServices.open(tmp_path, TASK, run)
    with a.substrate.run_lease():
        with pytest.raises(SubstrateError, match="lease|concurrent"):
            with b.substrate.run_lease():
                pass


# -- budgets / effects ------------------------------------------------------------------------------


def test_failed_fork_budget_persisted_across_restart(tmp_path: Path) -> None:
    """A fork that charges its base attempt then is DENIED on the candidate
    fails — but the partial spend is durably recorded and re-seeded on restart
    (no reset, no double-absorption)."""
    run = new_run_id()
    per_attempt = len(TASK.selection_cases())
    # exactly enough budget for ONE attempt: the candidate attempt is denied
    r1 = _drive(tmp_path, run, executions=per_attempt)
    assert r1.usage.executions == per_attempt  # type: ignore[attr-defined]
    sub = Substrate.discover(tmp_path, run)
    fork_terminal = next(iter(sub.verify().completed.values()))
    assert fork_terminal.outcome == "failed"
    # resume: cumulative spend reconstructed, not reset or doubled
    r2 = _drive(tmp_path, run, executions=per_attempt)
    assert r2.usage.executions == per_attempt  # type: ignore[attr-defined]


def test_indeterminate_effect_is_recorded_and_not_retried(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A dispatch with no recoverable durable result is recorded `indeterminate`
    and is NEVER silently re-dispatched on resume."""
    calls = {"n": 0}

    def boom(
        services: object, cid: str, label: str, state: object, state_ref: str
    ) -> object:
        calls["n"] += 1
        raise IndeterminateEffect("dispatched; result unknown")

    monkeypatch.setattr(kernel, "_run_attempt", boom)
    run = new_run_id()
    _drive(tmp_path, run)
    assert calls["n"] == 1  # dispatched once
    sub = Substrate.discover(tmp_path, run)
    fork_terminal = next(iter(sub.verify().completed.values()))
    assert fork_terminal.outcome == "indeterminate"
    # resume must NOT re-dispatch (reconstruct the recorded indeterminate result)
    _drive(tmp_path, run)
    assert calls["n"] == 1


def test_resume_reconstructs_identical_head(tmp_path: Path) -> None:
    run = new_run_id()
    r1 = _drive(tmp_path, run)
    r2 = _drive(tmp_path, run)  # fully-completed resume
    assert r2.resumed is True  # type: ignore[attr-defined]
    assert r1.head == r2.head  # type: ignore[attr-defined]


# -- surface extensibility / validator + task drift -------------------------------------------------


def _extended_catalog() -> SurfaceCatalog:
    return SurfaceCatalog((
        SurfaceDescriptor("strategy-code", "solve", "solve-code@1", validate_solve_code),
        SurfaceDescriptor("prompt", "proposal-template", "prompt-text@1", validate_prompt),
        SurfaceDescriptor("note", "misc", "note@1", validate_prompt),  # a NEW surface
    ))


def test_catalog_extension_does_not_invalidate_old_run(tmp_path: Path) -> None:
    run = new_run_id()
    _bound_sub(tmp_path, run)  # bound under the default (2-surface) catalog
    # reopening with an EXTENDED catalog (extra surface) keeps the run valid:
    # the pinned per-surface snapshots are resolved independently.
    reopened = Substrate.open(tmp_path, "sum-integers", run, catalog=_extended_catalog())
    assert reopened.verify().ok


def test_validator_implementation_drift_detected(tmp_path: Path) -> None:
    run = new_run_id()
    _bound_sub(tmp_path, run)

    def _drifted(source: str) -> None:  # same NAME, different implementation
        validate_solve_code(source)

    drift = SurfaceCatalog((
        SurfaceDescriptor("strategy-code", "solve", "solve-code@1", _drifted),
        SurfaceDescriptor("prompt", "proposal-template", "prompt-text@1", validate_prompt),
    ))
    reopened = Substrate.open(tmp_path, "sum-integers", run, catalog=drift)
    view = reopened.verify()
    assert not view.ok
    assert any("implementation changed" in e or "invalid" in e for e in view.errors)


def test_task_fingerprint_includes_scorer_semantics() -> None:
    class _DriftScorer(Task):
        def score_case(
            self, case: object, output: int | None, error: str | None
        ) -> tuple[float, bool, str]:
            return (0.0, False, "different scoring")

    drift = _DriftScorer(
        task_id=TASK.task_id, version=TASK.version, description=TASK.description,
        signature=TASK.signature, primitive_catalog=TASK.primitive_catalog,
        seed_source=TASK.seed_source, cases=TASK.cases,
    )
    # identical id/version/cases, DIFFERENT scorer => different fingerprint
    assert drift.fingerprint() != TASK.fingerprint()


def test_task_scorer_drift_rejected_on_resume(tmp_path: Path) -> None:
    class _DriftScorer(Task):
        def score_case(
            self, case: object, output: int | None, error: str | None
        ) -> tuple[float, bool, str]:
            return (0.0, False, "different scoring")

    run = new_run_id()
    _drive(tmp_path, run)  # bound with the real TASK
    drift = _DriftScorer(
        task_id=TASK.task_id, version=TASK.version, description=TASK.description,
        signature=TASK.signature, primitive_catalog=TASK.primitive_catalog,
        seed_source=TASK.seed_source, cases=TASK.cases,
    )
    services = KernelServices.open(tmp_path, drift, run, seed=7, budget=BudgetSpec(executions=128))
    objects = services.substrate.objects
    with pytest.raises(KernelError, match="fingerprint"):
        run_policy(
            services, default_catalog(), "manual-change@1",
            mc.load_config(mc.DEFAULT_CONFIG_PATH),
            prompt_refs=mc.prompt_refs(objects),
            seed_state=mc.seed_state(objects, code=_BASELINE, prompt="base proposal template"),
            run_metadata={},
        )


def test_preexisting_invalid_shared_content_rejected_by_stage(tmp_path: Path) -> None:
    """A structurally-invalid object already sitting in shared CAS is validated
    when a change references it — even though it is not re-staged."""
    run = new_run_id()
    sub = _bound_sub(tmp_path, run)
    invalid = "def solve(t):\n    return 0\n"  # wrong parameter name
    bad_ref = sub.objects.put_text(invalid)  # ALREADY present in shared CAS
    seed = sub.verify().seed_state.as_map()
    change = CompositeChange(
        "c1",
        (SurfaceDelta("strategy-code", "solve", seed[("strategy-code", "solve")], bad_ref),),
        "x",
    )
    with pytest.raises(SubstrateError, match="invalid"):
        sub.stage_change_closure(change, {})  # no blobs: content is already shared


# -- final semantic-atomicity pass: preflight, typed refs, durable attempts -------------------------


class _Boom(Exception):
    pass


def _journal_bytes(root: Path, run_id: str) -> bytes:
    path = root / "runs" / f"{run_id}.events.jsonl"
    return path.read_bytes() if path.exists() else b""


def test_preflight_refuses_and_leaves_stream_byte_for_byte_unchanged(tmp_path: Path) -> None:
    """An append whose POST-event view would be invalid is refused, and the
    journal is left byte-for-byte unchanged (confirm_change relies on the pure
    candidate-event preflight in _emit — it does not pre-check itself)."""
    run = new_run_id()
    sub = _bound_sub(tmp_path, run)
    before = _journal_bytes(tmp_path, run)
    with pytest.raises(SubstrateError, match="refusing to append"):
        sub.confirm_change(change_id="ghost", rationale="r", caused_by="ghost-cmd")
    assert _journal_bytes(tmp_path, run) == before  # not one byte appended


def test_malformed_seed_state_preflight_no_append(tmp_path: Path) -> None:
    """A bind whose seed content is structurally invalid is refused BEFORE any
    event is written."""
    run = new_run_id()
    sub = Substrate.open(tmp_path, "sum-integers", run)
    code_ref = sub.objects.put_text("def solve(t):\n    return 0\n")  # invalid
    prompt_ref = sub.objects.put_text("p")
    seed = canonical_state(
        {("strategy-code", "solve"): code_ref, ("prompt", "proposal-template"): prompt_ref}
    )
    before = _journal_bytes(tmp_path, run)
    with pytest.raises(SubstrateError):
        sub.bind_policy(
            task_fingerprint="fp", policy_ref="p@1", policy_digest="pd",
            config_ref=sub.put(ConfigBlob(ENCODING, "{}")),
            prompt_refs={"refine": sub.objects.put_text("md")},
            seed=1, seed_state=seed, budget_ref=sub.put(BudgetSpec()),
            required_capabilities=(), run_metadata={},
        )
    assert _journal_bytes(tmp_path, run) == before


def test_noncanonical_seed_bindings_refused(tmp_path: Path) -> None:
    run = new_run_id()
    sub = Substrate.open(tmp_path, "sum-integers", run)
    code_ref = sub.objects.put_text("def solve(input_text: str) -> int:\n    return 0\n")
    prompt_ref = sub.objects.put_text("p")
    from strive.substrate import HarnessState, SurfaceBinding

    # deliberately NON-canonical order (canonical is prompt < strategy-code)
    seed = HarnessState(bindings=(
        SurfaceBinding("strategy-code", "solve", code_ref),
        SurfaceBinding("prompt", "proposal-template", prompt_ref),
    ))
    with pytest.raises(SubstrateError):
        sub.bind_policy(
            task_fingerprint="fp", policy_ref="p@1", policy_digest="pd",
            config_ref=sub.put(ConfigBlob(ENCODING, "{}")),
            prompt_refs={"refine": sub.objects.put_text("md")},
            seed=1, seed_state=seed, budget_ref=sub.put(BudgetSpec()),
            required_capabilities=(), run_metadata={},
        )


def test_type_substituted_budget_ref_refused(tmp_path: Path) -> None:
    """A budget_ref that decodes as the WRONG type (a CompositeChange) is
    rejected — type substitution never slips through."""
    run = new_run_id()
    sub = Substrate.open(tmp_path, "sum-integers", run)
    code_ref = sub.objects.put_text("def solve(input_text: str) -> int:\n    return 0\n")
    prompt_ref = sub.objects.put_text("p")
    seed = canonical_state(
        {("strategy-code", "solve"): code_ref, ("prompt", "proposal-template"): prompt_ref}
    )
    wrong = sub.put(CompositeChange("x", (SurfaceDelta("prompt", "proposal-template", None, "aa" * 32),), "x"))
    with pytest.raises(SubstrateError, match="budget"):
        sub.bind_policy(
            task_fingerprint="fp", policy_ref="p@1", policy_digest="pd",
            config_ref=sub.put(ConfigBlob(ENCODING, "{}")),
            prompt_refs={"refine": sub.objects.put_text("md")},
            seed=1, seed_state=seed, budget_ref=wrong,  # a CompositeChange, not a BudgetSpec
            required_capabilities=(), run_metadata={},
        )


def test_type_substituted_command_payload_refused(tmp_path: Path) -> None:
    run = new_run_id()
    sub = _bound_sub(tmp_path, run)
    # a command_ref pointing at a BudgetSpec object (not a CommandPayload)
    wrong = sub.put(BudgetSpec())
    with pytest.raises(SubstrateError, match="refusing to append|does not decode"):
        sub.issue_command(command_id="k", command_kind="ConfirmChange", command_ref=wrong)
    assert sub.verify().ok  # stream stayed valid


def test_ghost_confirm_and_revise_refused(tmp_path: Path) -> None:
    run = new_run_id()
    sub = _bound_sub(tmp_path, run)
    _issue(sub, "k", "ConfirmChange")
    with pytest.raises(SubstrateError, match="refusing to append"):
        sub.confirm_change(change_id="never-proposed", rationale="r", caused_by="k")
    assert sub.verify().ok


def test_old_run_cannot_mutate_a_newly_added_surface(tmp_path: Path) -> None:
    """A run pins its surfaces at bind. Growing the live catalog keeps the run
    READABLE, but the run may not mutate the newly-added surface (that needs a
    rebind/new run)."""
    run = new_run_id()
    _bound_sub(tmp_path, run)  # pinned under the default 2-surface catalog
    grown = _extended_catalog()  # adds note/misc
    sub = Substrate.open(tmp_path, "sum-integers", run, catalog=grown)
    assert sub.verify().ok  # still readable under the grown catalog
    note = sub.objects.put_text("a note")
    change = CompositeChange("c1", (SurfaceDelta("note", "misc", None, note),), "x")
    _issue(sub, "k", "ApplyChange", change)
    with pytest.raises(SubstrateError, match="not pinned"):
        sub.stage_change_closure(change, {})


def test_same_services_reseed_does_not_double_count_budget(tmp_path: Path) -> None:
    """Driving the SAME KernelServices twice rebuilds a fresh meter from the
    durable ledger each time — never repeatedly absorbing into a reused meter."""
    run = new_run_id()
    services = KernelServices.open(
        tmp_path, TASK, run, seed=7, budget=BudgetSpec(executions=128)
    )

    def once() -> object:
        objects = services.substrate.objects
        return run_policy(
            services, default_catalog(), "manual-change@1",
            mc.load_config(mc.DEFAULT_CONFIG_PATH),
            prompt_refs=mc.prompt_refs(objects),
            seed_state=mc.seed_state(objects, code=_BASELINE, prompt="base proposal template"),
            run_metadata={},
        )

    r1 = once()
    r2 = once()  # resume on the SAME services object
    assert r2.usage.executions == r1.usage.executions  # type: ignore[attr-defined]


def test_open_dispatch_on_resume_is_indeterminate_not_rerun(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A crash AFTER an attempt's dispatch was journaled but BEFORE its result
    is an OPEN dispatch: on resume it becomes `indeterminate`, never an implicit
    re-run of the attempt."""
    calls = {"n": 0}
    real = kernel._run_attempt

    def flaky(services: object, cid: str, label: str, state: object, state_ref: str) -> object:
        calls["n"] += 1
        if calls["n"] == 1:
            raise _Boom("crash after dispatch, before result")
        return real(services, cid, label, state, state_ref)  # type: ignore[arg-type]

    monkeypatch.setattr(kernel, "_run_attempt", flaky)
    run = new_run_id()
    with pytest.raises(_Boom):
        _drive(tmp_path, run)
    monkeypatch.undo()
    _drive(tmp_path, run)  # resume
    # the open base dispatch short-circuited to indeterminate — never re-run
    assert calls["n"] == 1
    sub = Substrate.discover(tmp_path, run)
    terminal = next(iter(sub.verify().completed.values()))
    assert terminal.outcome == "indeterminate"


def test_applied_change_must_match_proposal_and_payload(tmp_path: Path) -> None:
    """A ChangeApplied whose change ref differs from BOTH its proposal and its
    issued command payload is refused (not matched by a mere kind string)."""
    from strive.substrate import apply_change

    run = new_run_id()
    sub = _bound_sub(tmp_path, run)
    seed = sub.verify().seed_state.as_map()
    code_after = hash_text("def solve(input_text: str) -> int:\n    return 5\n")
    delta = SurfaceDelta("strategy-code", "solve", seed[("strategy-code", "solve")], code_after)
    a = CompositeChange("c1", (delta,), "summary A")
    b = CompositeChange("c1", (delta,), "summary B")  # same deltas, DIFFERENT ref
    _issue(sub, "k", "ApplyChange", a)  # payload.change_ref = ref(a)
    sub.record_proposal(change=a, strategy_ref="t", caused_by="k")  # proposal = ref(a)
    sub.stage_change_closure(a, {code_after: "def solve(input_text: str) -> int:\n    return 5\n"})
    v = sub.verify()
    after = sub.put_state(apply_change(v.state, a, sub.catalog))
    forged = ChangeApplied("c1", sub.put(b), v.state_ref or "", after)  # change_ref = ref(b)
    env = EventEnvelope(
        event_id=f"{run}#{v.seq + 1}", run_id=run, task_id="sum-integers", seq=v.seq + 1,
        caused_by="k", body_kind=codec.schema_of(ChangeApplied),
        body_ref=sub.put(forged), at=now_iso(),
    )
    sub.journal.append_batch([env], expected_head=v.head)
    after_view = sub.verify()
    assert not after_view.ok
    assert any("does not match" in e for e in after_view.errors)


def test_duplicate_or_different_proposal_refused(tmp_path: Path) -> None:
    from strive.substrate import ChangeProposed

    run = new_run_id()
    sub = _bound_sub(tmp_path, run)
    seed = sub.verify().seed_state.as_map()
    code_after = hash_text("def solve(input_text: str) -> int:\n    return 6\n")
    a = CompositeChange("c1", (SurfaceDelta("strategy-code", "solve", seed[("strategy-code", "solve")], code_after),), "A")
    _issue(sub, "k", "EvaluateFork", a)
    sub.record_proposal(change=a, strategy_ref="t", caused_by="k")  # first proposal for c1
    b = CompositeChange("c1", (SurfaceDelta("strategy-code", "solve", seed[("strategy-code", "solve")], code_after),), "B")
    v = sub.verify()
    forged = ChangeProposed("c1", sub.put(b), "t")  # a SECOND proposal for c1
    env = EventEnvelope(
        event_id=f"{run}#{v.seq + 1}", run_id=run, task_id="sum-integers", seq=v.seq + 1,
        caused_by="k", body_kind=codec.schema_of(ChangeProposed),
        body_ref=sub.put(forged), at=now_iso(),
    )
    sub.journal.append_batch([env], expected_head=v.head)
    after = sub.verify()
    assert not after.ok
    assert any("more than one proposal" in e for e in after.errors)


def test_duplicate_seed_bindings_refused(tmp_path: Path) -> None:
    from strive.substrate import HarnessState, SurfaceBinding

    run = new_run_id()
    sub = Substrate.open(tmp_path, "sum-integers", run)
    code_ref = sub.objects.put_text("def solve(input_text: str) -> int:\n    return 0\n")
    seed = HarnessState(bindings=(
        SurfaceBinding("strategy-code", "solve", code_ref),
        SurfaceBinding("strategy-code", "solve", code_ref),  # DUPLICATE surface key
    ))
    before = _journal_bytes(tmp_path, run)
    with pytest.raises(SubstrateError):
        sub.bind_policy(
            task_fingerprint="fp", policy_ref="p@1", policy_digest="pd",
            config_ref=sub.put(ConfigBlob(ENCODING, "{}")),
            prompt_refs={"refine": sub.objects.put_text("md")},
            seed=1, seed_state=seed, budget_ref=sub.put(BudgetSpec()),
            required_capabilities=(), run_metadata={},
        )
    assert _journal_bytes(tmp_path, run) == before


# -- intent-to-effect binding pass: reconciliation, budget, evidence --------------------------------


def test_reconcile_failure_after_crash_before_terminal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A crash AFTER the failure record but BEFORE the terminal reconciles to
    the SAME outcome on resume — never re-running the operation."""
    run = new_run_id()
    per = len(TASK.selection_cases())
    real_complete = Substrate.complete_command
    fired = {"v": False}

    def flaky(self: Substrate, *, command_id: str, outcome: str, result: object) -> object:
        if command_id.endswith(":fork") and not fired["v"]:
            fired["v"] = True
            raise _Boom("crash after failure record, before terminal")
        return real_complete(self, command_id=command_id, outcome=outcome, result=result)

    monkeypatch.setattr(Substrate, "complete_command", flaky)
    with pytest.raises(_Boom):
        _drive(tmp_path, run, executions=per)  # base runs, candidate denied -> fail -> crash
    monkeypatch.undo()

    calls = {"n": 0}
    real_attempt = kernel._run_attempt

    def counting(*a: object, **k: object) -> object:
        calls["n"] += 1
        return real_attempt(*a, **k)  # type: ignore[arg-type]

    monkeypatch.setattr(kernel, "_run_attempt", counting)
    _drive(tmp_path, run, executions=per)  # resume: reconcile the recorded failure
    assert calls["n"] == 0  # the operation is NEVER re-run
    sub = Substrate.discover(tmp_path, run)
    fork_terminal = next(
        t for cid, t in sub.verify().completed.items() if cid.endswith(":fork")
    )
    assert fork_terminal.outcome == "failed"


def test_same_process_indeterminate_reserves_all_dimensions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An indeterminate dispatch reserves executions AND wall AND output
    IMMEDIATELY in the current process (the live budget equals the durable
    ledger after every command)."""
    from strive.sandboxes import SandboxLimits

    def boom(services: object, cid: str, label: str, state: object, state_ref: str) -> object:
        raise IndeterminateEffect("dispatched; result unknown")

    monkeypatch.setattr(kernel, "_run_attempt", boom)
    run = new_run_id()
    report = _drive(tmp_path, run)
    n = len(TASK.selection_cases())
    cap = SandboxLimits()
    assert report.usage.executions >= n  # type: ignore[attr-defined]
    assert report.usage.output_bytes >= n * cap.output_bytes  # type: ignore[attr-defined]
    assert report.usage.wall_time_s >= n * cap.wall_time_s  # type: ignore[attr-defined]


def test_backend_failure_evidence_is_preserved(tmp_path: Path) -> None:
    """A completed evaluation whose candidate ERRORS per-case is preserved with
    full evidence (report + evaluation refs) and is NOT an infra failure — the
    two are distinguished, neither collapsed to only an aggregate score."""
    from strive.contracts import Evaluation, ExecutionReport
    from strive.runtime import AttemptRecord, FORK_RESULT
    from strive.substrate import ObservationRecorded

    run = new_run_id()
    erroring = (
        "def solve(input_text: str) -> int:\n    raise ValueError('candidate boom')\n"
    )
    cfg = mc.ManualChangeConfig(
        summary="an erroring candidate", target_prompt="err proposal template",
        target_strategy=erroring,
    )
    services = KernelServices.open(tmp_path, TASK, run, seed=7, budget=BudgetSpec(executions=128))
    objects = services.substrate.objects
    run_policy(
        services, default_catalog(), "manual-change@1", cfg,
        prompt_refs=mc.prompt_refs(objects),
        seed_state=mc.seed_state(objects, code=_BASELINE, prompt="base proposal template"),
        run_metadata={},
    )
    sub = Substrate.discover(tmp_path, run)
    view = sub.verify()
    attempts: dict[str, AttemptRecord] = {}
    for env, body in zip(view.envelopes, view.bodies):
        if isinstance(body, ObservationRecorded) and body.observation_kind == FORK_RESULT:
            rec = codec.loads(sub.objects.get_text(body.observation_ref), AttemptRecord)
            attempts[rec.label] = rec
    candidate = attempts["candidate"]
    # a COMPLETED evaluation (candidate errors are scored), NOT an infra failure
    assert candidate.ok is True and candidate.failure is None
    report = codec.loads(sub.objects.get_text(candidate.report_ref), ExecutionReport)
    evaluation = codec.loads(sub.objects.get_text(candidate.evaluation_ref), Evaluation)
    assert report.outcomes and all(o.error for o in report.outcomes)  # per-case errors kept
    assert evaluation.case_evaluations and all(
        not ce.passed for ce in evaluation.case_evaluations
    )
    # the base attempt's evidence is DISTINCT (clean run, no per-case exceptions)
    base = attempts["base"]
    base_report = codec.loads(sub.objects.get_text(base.report_ref), ExecutionReport)
    assert any(o.error is None for o in base_report.outcomes)
