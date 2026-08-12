"""Command-line interface.

Commands: run, status, inspect, compare, lineage, replay, promote, rollback,
history, resume. Every command supports ``--json`` for a machine-readable
envelope ``{"ok": bool, "command": str, "data"| "error": ...}``; store-level
failures (corrupt ledgers, unknown ids, refused promotions) exit 1 with a
clean diagnostic — never a traceback.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from strive import codec, lifecycle
from strive.cas import ObjectCorruption, ObjectMissing
from strive.contracts import (
    Activation,
    BudgetSpec,
    CycleRecord,
    Generation,
    Intervention,
    INTERVENTION_RESUME,
)
from strive.diagnose import EvidenceDiagnoser
from strive.events import EventLog, now_iso
from strive.fakemodel import scripted_fixture_adapter
from strive.loop import (
    LoopConfig,
    audit_generation,
    compare_generations,
    ensure_seeded,
    promote_generation,
    replay_run,
    rollback_generation,
    run_cycle,
)
from strive.dualwrite import (
    MirrorError,
    ParityError,
    parity_status,
    rebuild_mirror,
    run_backfill_operation,
)
from strive.reader import (
    MODE_CANARY,
    MODE_NATIVE,
    MODE_SHADOW,
    ReaderError,
    StateReader,
    clear_breaker,
    cutover_eligibility,
    enable_canary,
    force_native,
    kill_switch,
    lift_force_native,
    quarantine_reader_journal,
    read_coverage,
    reader_state,
    set_mode,
    verify_revision_snapshot,
)
from strive.migrate import migrate_legacy_ledger
from strive.migrations import apply_pending, pending_migrations
from strive.revisions import delta_label
from strive.model import ModelConfigError, adapter_from_env
from strive.model_proposer import ModelProposer
from strive.store import Store, StoreError
from strive.tasks import SUM_INTEGERS_TASK, TASKS, Task


class CliError(Exception):
    """User-facing CLI failure with a clean message."""


def _emit(as_json: bool, command: str, data: dict[str, Any], human: str) -> None:
    if as_json:
        print(json.dumps({"ok": True, "command": command, "data": data}, sort_keys=True))
    else:
        print(human, end="" if human.endswith("\n") else "\n")


def _task(name: str) -> Task:
    if name not in TASKS:
        raise CliError(f"unknown task {name!r}; known: {sorted(TASKS)}")
    return TASKS[name]


def _generation_data(store: Store, generation: Generation) -> dict[str, Any]:
    data = codec.encode(generation)
    data["active"] = (
        store.active_generation() is not None
        and store.active_generation().generation_id == generation.generation_id  # type: ignore[union-attr]
    )
    return data


def _cmd_run(store: Store, task: Task, args: argparse.Namespace) -> dict[str, Any]:
    if args.proposer == "model":
        adapter = adapter_from_env()
        if adapter is not None:
            if not args.unsafe_model_code:
                raise CliError(
                    "a real model provider is configured "
                    "(STRIVE_MODEL_PROVIDER); real-model-generated executable "
                    "code will run in a subprocess WITHOUT network or "
                    "filesystem confinement, and the AST screen is a "
                    "prefilter, not a security boundary. Re-run with "
                    "--unsafe-model-code to acknowledge this, or unset "
                    "STRIVE_MODEL_PROVIDER to use the offline scripted fixture."
                )
            adapter_note = "real (env-configured; --unsafe-model-code acknowledged)"
            unsafe = True
        else:
            adapter = scripted_fixture_adapter()
            adapter_note = (
                "scripted fixture (offline; proves the pipeline, not model "
                "capability — set STRIVE_MODEL_PROVIDER for a real model)"
            )
            unsafe = False
        config = LoopConfig(
            sandbox_timeout_s=args.timeout,
            proposer=ModelProposer(),
            diagnoser=EvidenceDiagnoser(),
            model_adapter=adapter,
            budget=BudgetSpec(model_calls=4),
            acknowledge_task_drift=args.acknowledge_task_drift,
            unsafe_model_code=unsafe,
        )
    else:
        adapter_note = None
        config = LoopConfig(
            sandbox_timeout_s=args.timeout,
            acknowledge_task_drift=args.acknowledge_task_drift,
        )
    report = run_cycle(store, task, config)
    data: dict[str, Any] = {
        "run_id": report.run_id,
        "proposer": args.proposer,
        "model_adapter": adapter_note,
        "generation_before": report.generation_before,
        "generation_after": report.generation_after,
        "frozen": report.frozen,
        "overall_score": report.evaluation.overall_score,
        "split_scores": report.evaluation.split_scores,
        "feedback": report.evaluation.feedback,
        "weakness_id": report.diagnosis.weakness_id if report.diagnosis else None,
        "proposal": codec.encode(report.proposal) if report.proposal else None,
        "proposal_failure": (
            codec.encode(report.proposal_failure) if report.proposal_failure else None
        ),
        "decision": codec.encode(report.decision) if report.decision else None,
        "diagnostics": list(store.diagnostics),
    }
    lines = [
        f"run:      {report.run_id}",
        f"proposer: {args.proposer}"
        + (f" — model adapter: {adapter_note}" if adapter_note else ""),
        f"active:   {report.generation_before} -> {report.generation_after}",
        f"score:    {report.evaluation.overall_score:.3f} "
        + " ".join(f"{k}={v:.3f}" for k, v in sorted(report.evaluation.split_scores.items())),
    ]
    if report.frozen:
        lines.append("frozen:   adaptation is frozen (see `strive resume`)")
    if report.diagnosis:
        lines.append(f"weakness: {report.diagnosis.weakness_id}")
    if report.proposal:
        lines.append(f"proposal: {report.proposal.summary}")
    if report.proposal_failure:
        lines.append(
            f"proposal: rejected [{report.proposal_failure.kind}] "
            f"— {report.proposal_failure.detail}"
        )
    if report.decision:
        verdict = "ACCEPTED" if report.decision.accepted else "REJECTED"
        lines.append(
            f"decision: {verdict} [{report.decision.policy}@{report.decision.policy_version}] "
            f"— {report.decision.reason}"
        )
    elif not report.frozen and report.diagnosis is None:
        lines.append("decision: no weakness detected; nothing proposed")
    return {"data": data, "human": "\n".join(lines)}


def _cmd_status(store: Store, task: Task, args: argparse.Namespace) -> dict[str, Any]:
    ensure_seeded(store, task)
    # the status/restart read, routed through the read boundary; the output
    # itself derives from the reader's coherent capture
    from strive.store import derive_active_activation, derive_adaptation_frozen

    reader = StateReader(store, "status")
    try:
        active = reader.read_active("status-active")
        activation = derive_active_activation(reader.ledger_entries())
        frozen = derive_adaptation_frozen(reader.ledger_entries())
        reader.add_fact("restart")  # a fresh process's first state read
    finally:
        reader.finish(None)
    assert active is not None and activation is not None
    data = {
        "active_generation": codec.encode(active),
        "activation": codec.encode(activation),
        "frozen": codec.encode(frozen) if frozen else None,
        "diagnostics": list(store.diagnostics),
    }
    lines = [
        f"active generation: {active.generation_id} (origin={active.origin}, "
        f"mode={activation.mode})",
    ]
    if frozen:
        lines.append(f"ADAPTATION FROZEN: {frozen.reason}")
    for note in store.diagnostics:
        lines.append(f"diagnostic: {note}")
    return {"data": data, "human": "\n".join(lines)}


def _cmd_lineage(store: Store, task: Task, args: argparse.Namespace) -> dict[str, Any]:
    ensure_seeded(store, task)
    reader = StateReader(store, "lineage")
    try:
        chain = reader.read_lineage("status-lineage")
    finally:
        reader.finish(None)
    data = {"lineage": [codec.encode(g) for g in chain]}
    lines = ["lineage (active -> seed):"]
    for generation in chain:
        weakness = f" weakness={generation.weakness_id}" if generation.weakness_id else ""
        lines.append(
            f"  {generation.generation_id} origin={generation.origin}{weakness} "
            f"source={generation.source_ref[:12]}"
        )
    return {"data": data, "human": "\n".join(lines)}


def _cmd_inspect(store: Store, task: Task, args: argparse.Namespace) -> dict[str, Any]:
    if args.generation:
        generation = store.generation(args.generation)
        source = store.source_of(generation)
        data: dict[str, Any] = {
            "generation": _generation_data(store, generation),
            "source": source,
        }
        lines = [
            f"generation {generation.generation_id} origin={generation.origin} "
            f"parent={generation.parent_id}",
            f"source_ref: {generation.source_ref}",
        ]
        if generation.decision:
            lines.append(
                f"decision: {'accepted' if generation.decision.accepted else 'rejected'} "
                f"[{generation.decision.policy}@{generation.decision.policy_version}] "
                f"— {generation.decision.reason}"
            )
        lines.append("--- source ---")
        lines.append(source.rstrip("\n"))
        return {"data": data, "human": "\n".join(lines)}
    if args.run:
        cycle = store.cycle(args.run)
        events = EventLog(store.runs_dir / args.run / "events.jsonl", args.run).read_all()
        if args.type:
            events = [event for event in events if event.type == args.type]
        data = {
            "cycle": codec.encode(cycle),
            "events": [codec.encode(e) for e in events],
        }
        lines = [
            f"run {cycle.run_id} generation={cycle.generation_id} "
            f"score={cycle.overall_score:.3f} accepted={cycle.accepted}",
            f"usage: wall={cycle.usage.wall_time_s:.3f}s "
            f"executions={cycle.usage.executions} model_calls={cycle.usage.model_calls} "
            f"tokens={cycle.usage.tokens} output={cycle.usage.output_bytes}B",
            f"events{f' (type={args.type})' if args.type else ''}:",
        ]
        for event in events:
            detail = ""
            if event.type == "model_call":
                detail = (
                    f" adapter={event.payload.get('adapter')} "
                    f"model={event.payload.get('model_id')} "
                    f"latency_ms={event.payload.get('latency_ms')} "
                    f"prompt_ref={str(event.payload.get('prompt_ref'))[:12]}"
                )
            elif event.type == "proposal_rejected":
                failure = event.payload.get("failure")
                if isinstance(failure, dict):
                    detail = f" kind={failure.get('kind')}"
            lines.append(f"  {event.ts} {event.type}{detail}")
        return {"data": data, "human": "\n".join(lines)}
    raise CliError("inspect requires --generation ID or --run ID")


def _cmd_compare(store: Store, task: Task, args: argparse.Namespace) -> dict[str, Any]:
    report = compare_generations(store, task, args.baseline, args.candidate)
    data = {
        "baseline": {"id": report.left_id, "scores": report.left.split_scores,
                     "overall": report.left.overall_score},
        "candidate": {"id": report.right_id, "scores": report.right.split_scores,
                      "overall": report.right.overall_score},
        "decision": codec.encode(report.decision),
    }
    verdict = "candidate WINS" if report.decision.accepted else "candidate LOSES"
    lines = [
        f"baseline  {report.left_id}: overall={report.left.overall_score:.3f} "
        + " ".join(f"{k}={v:.3f}" for k, v in sorted(report.left.split_scores.items())),
        f"candidate {report.right_id}: overall={report.right.overall_score:.3f} "
        + " ".join(f"{k}={v:.3f}" for k, v in sorted(report.right.split_scores.items())),
        f"{verdict} [{report.decision.policy}@{report.decision.policy_version}]: "
        f"{report.decision.reason}",
    ]
    return {"data": data, "human": "\n".join(lines)}


def _cmd_replay(store: Store, task: Task, args: argparse.Namespace) -> dict[str, Any]:
    report = replay_run(store, task, args.run_id)
    data = {
        "run_id": report.run_id,
        "generation_id": report.generation_id,
        "task_drift": report.task_drift,
        "recorded_score": report.recorded_score,
        "replayed_score": report.replayed_score,
        "matches": report.matches,
        "split_diffs": report.split_diffs,
        "candidate_generation_id": report.candidate_generation_id,
        "candidate_replayed_score": report.candidate_replayed_score,
        "decision_matches": report.decision_matches,
    }
    lines = [
        f"replay of {report.run_id} (generation {report.generation_id}):",
        f"  recorded={report.recorded_score:.3f} replayed={report.replayed_score:.3f} "
        f"match={report.matches}",
    ]
    if report.candidate_generation_id is not None:
        lines.append(
            f"  candidate {report.candidate_generation_id}: "
            f"replayed={report.candidate_replayed_score:.3f} "
            f"decision_reproduced={report.decision_matches}"
            if report.candidate_replayed_score is not None
            else f"  candidate {report.candidate_generation_id}: not replayed"
        )
    if report.task_drift:
        lines.append("  WARNING: task fingerprint drifted since this run was recorded")
    return {"data": data, "human": "\n".join(lines)}


def _cmd_promote(store: Store, task: Task, args: argparse.Namespace) -> dict[str, Any]:
    activation, decision = promote_generation(
        store,
        task,
        args.generation_id,
        provisional=args.provisional,
        expires_after_cycles=args.expires,
        config=LoopConfig(acknowledge_task_drift=args.acknowledge_task_drift),
    )
    data = {
        "activation": codec.encode(activation),
        "decision": codec.encode(decision) if decision else None,
    }
    if activation.mode == "provisional":
        human = (
            f"provisionally activated {activation.generation_id} "
            f"(expires after {activation.expires_after_cycles} cycles unless confirmed)"
        )
    else:
        human = f"promoted {activation.generation_id} with paired evidence"
    return {"data": data, "human": human}


def _cmd_audit(store: Store, task: Task, args: argparse.Namespace) -> dict[str, Any]:
    report = audit_generation(store, task, args.generation)
    data = {
        "generation_id": report.generation_id,
        "audit_score": report.evaluation.overall_score,
        "feedback": report.evaluation.feedback,
        "cases": [codec.encode(ce) for ce in report.evaluation.case_evaluations],
    }
    lines = [
        f"audit of {report.generation_id} (final holdout — never used in selection):",
        f"  score={report.evaluation.overall_score:.3f} — {report.evaluation.feedback}",
    ]
    return {"data": data, "human": "\n".join(lines)}


def _cmd_rollback(store: Store, task: Task, args: argparse.Namespace) -> dict[str, Any]:
    generation = rollback_generation(store)
    return {
        "data": {"active_generation": codec.encode(generation)},
        "human": f"rolled back; active generation is now {generation.generation_id}",
    }


def _cmd_resume(store: Store, task: Task, args: argparse.Namespace) -> dict[str, Any]:
    frozen = store.adaptation_frozen()
    if frozen is None:
        raise CliError("adaptation is not frozen")
    store.append(
        Intervention(
            kind=INTERVENTION_RESUME,
            reason=f"operator resume (was: {frozen.reason})",
            at=now_iso(),
        )
    )
    return {
        "data": {"resumed": True, "was": codec.encode(frozen)},
        "human": "adaptation resumed",
    }


def _cmd_migrate_legacy(task: Task, args: argparse.Namespace) -> dict[str, Any]:
    report = migrate_legacy_ledger(args.artifacts, task)
    data = {
        "migrated_entries": report.migrated_entries,
        "generations": report.generations,
        "activations": report.activations,
        "cycles": report.cycles,
        "interventions": report.interventions,
        "legacy_sha256": report.legacy_sha256,
        "task_fingerprint_used": report.task_fingerprint_used,
        "fingerprint_drifted": report.fingerprint_drifted,
    }
    lines = [
        f"migrated {report.migrated_entries} legacy entries to the "
        f"{task.task_id!r} ledger ({report.generations} generations, "
        f"{report.activations} activations, {report.cycles} cycles, "
        f"{report.interventions} interventions)",
        f"original ledger.jsonl preserved (sha256 {report.legacy_sha256[:12]}…)",
    ]
    if report.fingerprint_drifted:
        lines.append(
            "NOTE: the task definition has drifted since the legacy ledger was "
            "written; mutating commands will require --acknowledge-task-drift"
        )
    return {"data": data, "human": "\n".join(lines)}


def _cmd_parity(store: Store, task: Task, args: argparse.Namespace) -> dict[str, Any]:
    rebuild_info: dict[str, Any] | None = None
    if args.rebuild:
        rebuilt = rebuild_mirror(store)
        report = rebuilt.report
        action = "rebuilt"
        rebuild_info = {
            "quarantine_path": rebuilt.quarantine_path,
            "prior_mirror_sha256": rebuilt.prior_mirror_sha256,
        }
    elif args.repair:
        report = run_backfill_operation(store, "parity-repair")
        action = "repaired"
    else:
        report = parity_status(store)  # read-only
        action = "checked"
    data = {
        "complete": report.complete,
        "generations": report.generations,
        "activations": report.activations,
        "revision_mirrors": report.revision_mirrors,
        "activation_mirrors": report.activation_mirrors,
        "missing_source_ordinals": list(report.missing_source_ordinals),
        "mismatched": list(report.mismatched),
        "missing_objects": list(report.missing_objects),
        "closure_issues": list(report.closure_issues),
        "rebuild": rebuild_info,
        "diagnostics": list(store.diagnostics),
    }
    lines = [
        f"parity {action}: {'COMPLETE' if report.complete else 'INCOMPLETE'}",
        f"  generations={report.generations} activations={report.activations} "
        f"revision_mirrors={report.revision_mirrors} "
        f"activation_mirrors={report.activation_mirrors}",
    ]
    if report.missing_source_ordinals:
        lines.append(
            f"  missing mirrors for source ordinals: "
            f"{list(report.missing_source_ordinals)}"
        )
    for ref in report.missing_objects:
        lines.append(f"  missing derived object (repairable): {ref}")
    for issue in report.closure_issues:
        lines.append(f"  CLOSURE: {issue}")
    for issue in report.mismatched:
        lines.append(f"  AMBIGUOUS: {issue}")
    if rebuild_info:
        lines.append(
            f"  quarantined prior mirror: {rebuild_info['quarantine_path']} "
            f"(sha256 {rebuild_info['prior_mirror_sha256'][:12]}…)"
        )
    return {"data": data, "human": "\n".join(lines)}


def _cmd_revisions(store: Store, task: Task, args: argparse.Namespace) -> dict[str, Any]:
    revisions = store.revisions()
    activations = store.revision_activations()
    view = verify_revision_snapshot(store)
    # never report an active revision while the verified snapshot is unavailable
    active_revision = view.active_revision_id()
    data = {
        "active_revision": active_revision,
        "revisions": [codec.encode(r) for r in revisions],
        "revision_activations": [codec.encode(a) for a in activations],
    }
    header = (
        f"revision mirrors (active: {active_revision}):"
        if view.available
        else f"revision mirrors (active: unavailable — {view.reason}):"
    )
    lines = [header]
    for revision in revisions:
        labels = ",".join(delta_label(d) for d in revision.deltas)
        base = revision.base_parent.revision_id if revision.base_parent else None
        lines.append(
            f"  {revision.ref.revision_id} base={base} deltas=[{labels}] "
            f"proposer={revision.proposer}"
        )
    return {"data": data, "human": "\n".join(lines)}


def _cmd_lifecycle(store: Store, task: Task, args: argparse.Namespace) -> dict[str, Any]:
    """Inspect, roll back, or repair the canonical native-revision lifecycle:
    retained revisions, their evidence records, the active revision, the
    compatibility projection, and lifecycle/compatibility parity."""
    repaired: str | None = None
    if args.action == "repair":
        repaired = lifecycle.lifecycle(store).journal.repair_to_verified(
            "operator repair"
        )
    ensure_seeded(store, task)  # reconciles + syncs the lifecycle
    if args.action == "rollback":
        lifecycle.rollback(store)

    st = lifecycle.state(store)
    resolved = lifecycle.materialize_active(store) if not st.journal_errors else None
    projection = (
        lifecycle.compatibility_projection(store) if not st.journal_errors else None
    )
    parity = lifecycle.compat_parity(store)
    retained = [st.retained[rid] for rid in sorted(st.retained)]
    data = {
        "active_revision": st.active_revision_id,
        "breaker_open": st.breaker_open,
        "breaker_reason": st.breaker_reason,
        "journal_errors": st.journal_errors,
        "open_intents": [i.op_id for i in st.open_intents],
        "repaired_quarantine": repaired,
        "lineage": list(lifecycle.lineage(store)),
        "compat_parity": {
            "ok": parity.ok,
            "lifecycle_active": parity.lifecycle_active,
            "linked_generation": parity.linked_generation,
            "generation_active": parity.generation_active,
            "reason": parity.reason,
        },
        "retained": [
            {
                "revision_id": r.revision_id,
                "revision_ref": r.revision_ref,
                "base_parent_id": r.base_parent_id,
                "generation": st.links.get(r.revision_id),
                "evaluations": len(st.evaluations.get(r.revision_id, ())),
                "selections": [
                    {
                        "accepted": s.accepted,
                        "baseline": s.baseline_revision_id,
                        "policy_ref": s.policy_ref,
                        "decision_ref": s.decision_ref,
                    }
                    for s in st.selections.get(r.revision_id, ())
                ],
                "overrides": len(st.overrides.get(r.revision_id, ())),
            }
            for r in retained
        ],
        "effective_surfaces": (
            [[b.kind, b.name] for b in resolved.effective] if resolved else []
        ),
        "compatibility_projection": (
            {
                "active_revision_id": projection.active_revision_id,
                "strategy_source_ref": projection.strategy_source_ref,
                "other_surfaces": [list(s) for s in projection.other_surfaces],
                "derived": projection.derived,
            }
            if projection
            else None
        ),
    }
    header = (
        f"native revision lifecycle (active: {st.active_revision_id}"
        + (f", BREAKER OPEN: {st.breaker_reason}" if st.breaker_open else "")
        + "):"
    )
    lines = [header]
    for r in retained:
        star = "*" if r.revision_id == st.active_revision_id else " "
        selections = st.selections.get(r.revision_id, ())
        if selections:
            latest = selections[-1]
            verdict = (
                f"{'accepted' if latest.accepted else 'rejected'} vs "
                f"{latest.baseline_revision_id} by {latest.policy_ref}"
            )
        else:
            verdict = "no selection evidence"
        lines.append(
            f" {star}{r.revision_id} base={r.base_parent_id} "
            f"gen={st.links.get(r.revision_id) or '-'} "
            f"evals={len(st.evaluations.get(r.revision_id, ()))} [{verdict}]"
        )
    if resolved is not None:
        surfaces = ", ".join(f"{b.kind}/{b.name}" for b in resolved.effective)
        lines.append(f"  active manifest surfaces: {surfaces}")
    if projection is not None:
        others = (
            ", ".join(f"{k}/{n}" for k, n in projection.other_surfaces) or "(none)"
        )
        lines.append(
            f"  compatibility projection (derived, strategy-only): "
            f"source={projection.strategy_source_ref[:12]} "
            f"non-projected surfaces={others}"
        )
    lines.append(
        f"  compat parity: {'OK' if parity.ok else 'DIVERGED'} — {parity.reason}"
    )
    if repaired:
        lines.append(f"  repaired: quarantined unverified region at {repaired}")
    return {"data": data, "human": "\n".join(lines)}


def _cmd_experiment(store: Store, task: Task, args: argparse.Namespace) -> dict[str, Any]:
    """The Stage-3C.1 prompt-surface composite experiment: matched arms over
    the deterministic prompt-sensitive fixture (pipeline-wiring proof), plus
    an opt-in real-model run of the proposer arms."""
    from strive import experiment

    root = store.root / "experiment"
    if args.real_model:
        if not args.unsafe_model_code:
            raise CliError(
                "--real-model runs model-generated code without confinement; "
                "acknowledge with --unsafe-model-code (lifecycle/canary "
                "authority stays refused for these runs regardless)"
            )
        reports = experiment.run_real_model_arms(root)
        real_data: dict[str, Any] = {
            "real_model": [
                {
                    "arm": rm.arm, "model_id": rm.model_id,
                    "proposal_valid": rm.proposal_valid,
                    "failure_kind": rm.failure_kind, "accepted": rm.accepted,
                    "notes": rm.notes,
                }
                for rm in reports
            ]
        }
        lines = ["real-model proposer arms (honest outcomes; gate unchanged):"]
        for rm in reports:
            lines.append(
                f"  arm {rm.arm} [{rm.model_id}]: proposal_valid={rm.proposal_valid} "
                f"failure={rm.failure_kind or '-'} accepted={rm.accepted}"
            )
            lines.append(f"    {rm.notes}")
        return {"data": real_data, "human": "\n".join(lines)}

    report = experiment.run_prompt_experiment(root)
    data: dict[str, Any] = {
        "arms": {
            arm: {
                "description": r.description,
                "proposal_valid": r.proposal_valid,
                "failure_kind": r.failure_kind,
                "accepted": r.accepted,
                "candidate_overall": r.candidate_overall,
                "candidate_split_scores": r.candidate_split_scores,
                "regressed_cases": r.regressed_cases,
                "executions": r.executions,
                "model_calls": r.model_calls,
                "tokens": r.tokens,
                "latency_ms": r.latency_ms,
                "cost": r.cost,
                "prompt_ref": r.prompt_ref,
                "prompt_contained_input_excerpts": r.prompt_contained_input_excerpts,
                "revision_id": r.revision_id,
            }
            for arm, r in report.arms.items()
        },
        "causal_prompt_effect": report.causal_prompt_effect,
        "composite_gate_passed": report.composite_gate_passed,
        "prompt_consumed": report.prompt_consumed,
        "restart_serves_candidate_prompt": report.restart_serves_candidate_prompt,
        "rollback_restores_incumbent": report.rollback_restores_incumbent,
        "offline_fixture": report.offline,
        "passed": report.passed,
    }
    lines = [
        "prompt-surface composite experiment (deterministic offline fixture —",
        "proves causal pipeline wiring, NOT model capability):",
    ]
    for arm, r in report.arms.items():
        overall = f"{r.candidate_overall:.3f}" if r.candidate_overall is not None else "-"
        lines.append(
            f"  {arm}: accepted={r.accepted} overall={overall} "
            f"model_calls={r.model_calls} excerpts_in_prompt="
            f"{r.prompt_contained_input_excerpts} — {r.description}"
        )
    lines.append(
        f"causal prompt effect (A fails, B passes): {report.causal_prompt_effect}"
    )
    lines.append(f"composite gate passed + activated (E): {report.composite_gate_passed}")
    lines.append(f"prompt artifact consumption proven: {report.prompt_consumed}")
    lines.append(f"restart serves candidate prompt: {report.restart_serves_candidate_prompt}")
    lines.append(f"rollback restores incumbent prompt+code: {report.rollback_restores_incumbent}")
    lines.append(f"OVERALL: {'PASSED' if report.passed else 'FAILED'}")
    return {"data": data, "human": "\n".join(lines)}


def _cmd_reader(store: Store, task: Task, args: argparse.Namespace) -> dict[str, Any]:
    action = args.action
    quarantined: str | None = None
    if action == "shadow":
        set_mode(store, MODE_SHADOW, reason="operator: begin shadow burn-in")
    elif action == "native":
        set_mode(store, MODE_NATIVE, reason="operator: return to native reads")
    elif action == "kill":
        kill_switch(store, reason="operator kill switch")
    elif action == "canary":
        enable_canary(store)  # raises ReaderError with reasons when ineligible
    elif action == "clear-breaker":
        clear_breaker(store, reason="operator: breaker cleared after repair")
    elif action == "force-native":
        # the emergency override: independent of the reader journal
        force_native(store, "operator force-native override")
    elif action == "lift-force":
        lift_force_native(store)
    elif action == "reset-journal":
        quarantined = quarantine_reader_journal(
            store, "operator reset after journal corruption"
        )
    elif action != "status":
        raise CliError(f"unknown reader action {action!r}")

    state = reader_state(store)
    verdict = cutover_eligibility(store)
    coverage = verdict.coverage
    data = {
        "mode": state.mode,
        "configured_mode": state.configured_mode,
        "forced_native": state.forced_native,
        "journal_head": state.journal_head,
        "quarantined": quarantined,
        "breaker_open": state.breaker_open,
        "breaker_reason": state.breaker_reason,
        "epoch": state.epoch,
        "journal_errors": coverage.journal_errors,
        "coverage": {
            "total": coverage.total,
            "agreed": coverage.agreed,
            "diverged": coverage.diverged,
            "unavailable": coverage.unavailable,
            "missing": coverage.missing,
            "not_applicable": coverage.not_applicable,
            "native_only": coverage.native_only,
            "by_subject": coverage.by_subject,
            "facts": list(coverage.facts),
        },
        "cutover": {
            "eligible": verdict.eligible,
            "parity_complete": verdict.parity_complete,
            "reasons": list(verdict.reasons),
        },
    }
    lines = [
        f"reader mode: {state.mode}"
        + (" [FORCE-NATIVE OVERRIDE]" if state.forced_native else "")
        + (f" (BREAKER OPEN: {state.breaker_reason})" if state.breaker_open else ""),
        f"epoch: {state.epoch or '(none for this reader/projector version)'}",
        f"current-epoch checks: total={coverage.total} agreed={coverage.agreed} "
        f"diverged={coverage.diverged} unavailable={coverage.unavailable} "
        f"missing={coverage.missing} not_applicable={coverage.not_applicable}",
        f"observed paths: {', '.join(coverage.facts) if coverage.facts else '(none)'}",
    ]
    if verdict.eligible:
        lines.append("cutover: ELIGIBLE (current epoch)")
    else:
        lines.append("cutover: NOT ELIGIBLE")
        for reason in verdict.reasons:
            lines.append(f"  - {reason}")
    return {"data": data, "human": "\n".join(lines)}


def _cmd_history(store: Store, task: Task, args: argparse.Namespace) -> dict[str, Any]:
    entries = store.entries()
    data = {"entries": [codec.encode(e) for e in entries]}
    lines = []
    for entry in entries:
        if isinstance(entry, Generation):
            verdict = (
                "seed"
                if entry.decision is None
                else ("accepted" if entry.decision.accepted else "rejected")
            )
            lines.append(
                f"generation {entry.generation_id} parent={entry.parent_id} "
                f"origin={entry.origin} [{verdict}]"
            )
        elif isinstance(entry, Activation):
            lines.append(
                f"activation {entry.generation_id} reason={entry.reason} mode={entry.mode}"
            )
        elif isinstance(entry, CycleRecord):
            lines.append(
                f"cycle {entry.run_id} gen={entry.generation_id} "
                f"score={entry.overall_score:.3f} accepted={entry.accepted}"
            )
        elif isinstance(entry, Intervention):
            lines.append(f"intervention {entry.kind}: {entry.reason}")
    return {"data": data, "human": "\n".join(lines) if lines else "(empty ledger)"}


_COMMANDS = {
    "run": _cmd_run,
    "status": _cmd_status,
    "lineage": _cmd_lineage,
    "inspect": _cmd_inspect,
    "compare": _cmd_compare,
    "replay": _cmd_replay,
    "audit": _cmd_audit,
    "promote": _cmd_promote,
    "rollback": _cmd_rollback,
    "resume": _cmd_resume,
    "history": _cmd_history,
    "parity": _cmd_parity,
    "revisions": _cmd_revisions,
    "lifecycle": _cmd_lifecycle,
    "reader": _cmd_reader,
    "experiment": _cmd_experiment,
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="strive", description=__doc__)
    parser.add_argument("--artifacts", type=Path, default=Path("artifacts"))
    parser.add_argument("--task", default=SUM_INTEGERS_TASK.task_id)
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    sub = parser.add_subparsers(dest="command", required=True)

    run_parser = sub.add_parser("run", help="run one evolution cycle")
    run_parser.add_argument("--timeout", type=float, default=10.0)
    run_parser.add_argument(
        "--proposer",
        choices=("registry", "model"),
        default="registry",
        help="proposal source: deterministic registry, or model-backed "
        "(offline scripted fixture unless STRIVE_MODEL_PROVIDER is configured)",
    )
    run_parser.add_argument(
        "--acknowledge-task-drift",
        action="store_true",
        help="proceed although the task definition changed since the active "
        "generation was created (journaled)",
    )
    run_parser.add_argument(
        "--unsafe-model-code",
        action="store_true",
        help="required acknowledgement when a REAL model provider is "
        "configured: model-generated code runs without network/filesystem "
        "confinement",
    )
    sub.add_parser("status", help="active generation, freeze state, diagnostics")
    sub.add_parser("lineage", help="chain from active generation to seed")
    inspect_parser = sub.add_parser("inspect", help="details of a generation or run")
    inspect_parser.add_argument("--generation")
    inspect_parser.add_argument("--run")
    inspect_parser.add_argument(
        "--type", help="filter run events by type (e.g. model_call, proposal)"
    )
    compare_parser = sub.add_parser("compare", help="paired evaluation of two generations")
    compare_parser.add_argument("baseline")
    compare_parser.add_argument("candidate")
    replay_parser = sub.add_parser(
        "replay",
        help="execution-and-decision replay: re-execute a recorded run's "
        "generations and re-check the recorded decision (not a full-cycle "
        "replay of diagnosis/prompt/proposal)",
    )
    replay_parser.add_argument("run_id")
    audit_parser = sub.add_parser(
        "audit",
        help="evaluate a generation on the final audit holdout (on demand; "
        "never part of routine selection)",
    )
    audit_parser.add_argument("--generation", help="default: the active generation")
    promote_parser = sub.add_parser("promote", help="activate a retained generation")
    promote_parser.add_argument("generation_id")
    promote_parser.add_argument("--provisional", action="store_true")
    promote_parser.add_argument("--expires", type=int, default=3)
    promote_parser.add_argument("--acknowledge-task-drift", action="store_true")
    sub.add_parser("rollback", help="reactivate the parent of the active generation")
    sub.add_parser("resume", help="lift a stall freeze")
    sub.add_parser("history", help="dump the full ledger journal")
    parity_parser = sub.add_parser(
        "parity",
        help="check (or --repair) generation/revision mirror parity",
    )
    parity_parser.add_argument("--repair", action="store_true")
    parity_parser.add_argument(
        "--rebuild",
        action="store_true",
        help="quarantine the mirror journal byte-for-byte and rebuild it from "
        "canonical history (never touches the task ledger)",
    )
    sub.add_parser(
        "revisions",
        help="inspect the stage-3B revision mirrors and active revision",
    )
    lifecycle_parser = sub.add_parser(
        "lifecycle",
        help="the canonical native-revision lifecycle: retained revisions, "
        "evidence, active revision, compatibility projection, and "
        "whole-revision rollback",
    )
    lifecycle_parser.add_argument(
        "action",
        nargs="?",
        default="status",
        choices=("status", "rollback", "repair"),
        help="status (default) | rollback (whole-revision, drives BOTH the "
        "lifecycle and served compatibility behavior) | repair (quarantine "
        "and truncate an unverified journal region)",
    )
    experiment_parser = sub.add_parser(
        "experiment",
        help="the stage-3C.1 prompt-surface composite experiment: matched "
        "arms A-E over the deterministic prompt-sensitive fixture "
        "(pipeline-wiring proof); --real-model runs the proposer arms with "
        "the env-configured adapter",
    )
    experiment_parser.add_argument("--real-model", action="store_true")
    experiment_parser.add_argument(
        "--unsafe-model-code",
        action="store_true",
        help="required acknowledgement for --real-model",
    )
    reader_parser = sub.add_parser(
        "reader",
        help="the read boundary: status, mode changes (native/shadow), "
        "eligibility-gated canary enablement, the kill switch, and breaker "
        "recovery",
    )
    reader_parser.add_argument(
        "action",
        nargs="?",
        default="status",
        choices=(
            "status", "native", "shadow", "canary", "kill", "clear-breaker",
            "force-native", "lift-force", "reset-journal",
        ),
        help="status (default) | native | shadow | canary (requires "
        "current-epoch eligibility) | kill (immediate return to native) | "
        "clear-breaker (requires native/shadow mode, complete parity, and a "
        "fresh epoch) | force-native (emergency override independent of the "
        "reader journal) | lift-force | reset-journal (quarantine a corrupt "
        "reader journal and start fresh in native mode)",
    )
    sub.add_parser(
        "migrate",
        help="apply pending registry migrations in order (0001 legacy ledger, "
        "0002 revision backfill)",
    )
    sub.add_parser(
        "migrate-legacy",
        help="convert a stage-2a ledger/ledger.jsonl into this task's "
        "task-scoped ledger (original preserved)",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        task = _task(args.task)
        if args.command == "migrate-legacy":
            # must run before Store construction, which refuses legacy roots
            result = _cmd_migrate_legacy(task, args)
            _emit(args.json, args.command, result["data"], result["human"])
            return 0
        if args.command == "migrate":
            reports = apply_pending(args.artifacts, task)
            data = {
                "applied": [
                    {"migration_id": r.migration_id, "applied": r.applied,
                     "detail": r.detail}
                    for r in reports
                ],
                "pending_after": [
                    m.migration_id for m in pending_migrations(args.artifacts, task)
                ],
            }
            human = (
                "\n".join(f"{r.migration_id}: {r.detail}" for r in reports)
                if reports
                else "no pending migrations"
            )
            _emit(args.json, args.command, data, human)
            return 0
        store = Store(args.artifacts, task.task_id)
        result = _COMMANDS[args.command](store, task, args)
        _emit(args.json, args.command, result["data"], result["human"])
        return 0
    except (
        StoreError,
        CliError,
        codec.SchemaError,
        ObjectMissing,
        ObjectCorruption,
        ModelConfigError,
        ParityError,
        MirrorError,
        ReaderError,
        lifecycle.LifecycleError,
    ) as exc:
        message = f"{type(exc).__name__}: {exc}"
        if args.json:
            print(
                json.dumps(
                    {"ok": False, "command": args.command, "error": message},
                    sort_keys=True,
                )
            )
        else:
            print(f"error: {message}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
