"""Command-line interface: run cycles, inspect state, roll back."""

from __future__ import annotations

import argparse
from pathlib import Path

from strive.loop import LoopConfig, ensure_seeded, run_cycle
from strive.store import Store
from strive.tasks import SUM_INTEGERS_TASK


def _cmd_run(store: Store, timeout_s: float) -> int:
    report = run_cycle(store, SUM_INTEGERS_TASK, LoopConfig(sandbox_timeout_s=timeout_s))
    print(f"run:      {report.run_id}")
    print(f"active:   {report.active_generation_before} -> {report.active_generation_after}")
    print(f"baseline: score={report.baseline_evaluation.score:.3f} "
          f"failing={list(report.baseline_evaluation.failing_case_ids)}")
    if report.diagnosis is not None:
        print(f"weakness: {report.diagnosis.weakness_id} "
              f"(evidence: {list(report.diagnosis.evidence_case_ids)})")
    if report.candidate is not None and report.candidate_evaluation is not None:
        print(f"candidate: {report.candidate.candidate_id} — {report.candidate.description}")
        print(f"          score={report.candidate_evaluation.score:.3f}")
    if report.decision is not None:
        verdict = "ACCEPTED" if report.decision.accepted else "REJECTED"
        print(f"decision: {verdict} — {report.decision.reason}")
    if report.diagnosis is None:
        print("decision: no weakness detected; nothing proposed")
    return 0


def _cmd_status(store: Store) -> int:
    ensure_seeded(store)
    active = store.active_generation()
    assert active is not None
    print(f"active generation: {active.generation_id} (origin={active.origin})")
    print("lineage (active -> seed):")
    for record in store.lineage():
        weakness = f" weakness={record.weakness_id}" if record.weakness_id else ""
        print(f"  {record.generation_id} origin={record.origin}{weakness}")
    return 0


def _cmd_history(store: Store) -> int:
    for entry in store.entries():
        if entry["kind"] == "generation":
            decision = entry.get("decision") or {}
            verdict = (
                "accepted" if decision.get("accepted")
                else ("rejected" if decision else "seed")
            )
            print(f"generation {entry['generation_id']} "
                  f"parent={entry['parent_id']} origin={entry['origin']} [{verdict}]")
        else:
            print(f"activation {entry['generation_id']} reason={entry['reason']}")
    return 0


def _cmd_rollback(store: Store) -> int:
    record = store.rollback()
    print(f"rolled back; active generation is now {record.generation_id}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="strive", description=__doc__)
    parser.add_argument(
        "--artifacts",
        type=Path,
        default=Path("artifacts"),
        help="artifacts root directory (default: ./artifacts)",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    run_parser = sub.add_parser("run", help="run one evolution cycle")
    run_parser.add_argument("--timeout", type=float, default=10.0)
    sub.add_parser("status", help="show active generation and lineage")
    sub.add_parser("history", help="dump the full ledger journal")
    sub.add_parser("rollback", help="reactivate the parent of the active generation")

    args = parser.parse_args(argv)
    store = Store(args.artifacts)
    if args.command == "run":
        return _cmd_run(store, args.timeout)
    if args.command == "status":
        return _cmd_status(store)
    if args.command == "history":
        return _cmd_history(store)
    if args.command == "rollback":
        return _cmd_rollback(store)
    raise AssertionError(f"unhandled command {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
