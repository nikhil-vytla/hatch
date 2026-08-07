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

from strive import codec
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
from strive.fakemodel import demo_adapter
from strive.loop import (
    LoopConfig,
    compare_generations,
    ensure_seeded,
    promote_generation,
    replay_run,
    run_cycle,
)
from strive.model import adapter_from_env
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
        adapter_note = "real (env-configured)"
        if adapter is None:
            adapter = demo_adapter()
            adapter_note = "fake (offline; set STRIVE_MODEL_PROVIDER for a real model)"
        config = LoopConfig(
            sandbox_timeout_s=args.timeout,
            proposer=ModelProposer(),
            diagnoser=EvidenceDiagnoser(),
            model_adapter=adapter,
            budget=BudgetSpec(model_calls=4),
        )
    else:
        adapter_note = None
        config = LoopConfig(sandbox_timeout_s=args.timeout)
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
    active = store.active_generation()
    activation = store.active_activation()
    assert active is not None and activation is not None
    frozen = store.adaptation_frozen()
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
    chain = store.lineage()
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


def _cmd_rollback(store: Store, task: Task, args: argparse.Namespace) -> dict[str, Any]:
    generation = store.rollback()
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
    "promote": _cmd_promote,
    "rollback": _cmd_rollback,
    "resume": _cmd_resume,
    "history": _cmd_history,
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
        "(offline fake unless STRIVE_MODEL_PROVIDER is configured)",
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
    replay_parser = sub.add_parser("replay", help="re-execute a recorded run and diff")
    replay_parser.add_argument("run_id")
    promote_parser = sub.add_parser("promote", help="activate a retained generation")
    promote_parser.add_argument("generation_id")
    promote_parser.add_argument("--provisional", action="store_true")
    promote_parser.add_argument("--expires", type=int, default=3)
    sub.add_parser("rollback", help="reactivate the parent of the active generation")
    sub.add_parser("resume", help="lift a stall freeze")
    sub.add_parser("history", help="dump the full ledger journal")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        store = Store(args.artifacts)
        task = _task(args.task)
        result = _COMMANDS[args.command](store, task, args)
        _emit(args.json, args.command, result["data"], result["human"])
        return 0
    except (StoreError, CliError, codec.SchemaError, ObjectMissing, ObjectCorruption) as exc:
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
