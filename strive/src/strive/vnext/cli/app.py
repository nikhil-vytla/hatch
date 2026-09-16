"""Manifest research commands, with legacy commands kept at their old entrypoint."""
import argparse
from collections.abc import Iterator
from pathlib import Path
import sys
import time

from ..contracts.manifest import TelemetryProfile
from ..errors import VerificationError
from ..report.compare import compare, comparison_spec, export
from ..report.history import history, invocation_inputs
from ..report.snapshot import snapshot
from ..telemetry.projector import HTTPExporter, MemoryExporter, Projector, cursor_status
from .data import json_bytes
from .runner import reader, resume, run, run_directory


def status(root: Path, run_id: str, *, follow: bool = False, interval: float = 0.2,
           updates: int | None = None, invocation: str | None = None) -> Iterator[dict[str, object]]:
    read = reader(root, run_id)
    previous: bytes | None = None
    emitted = 0
    while True:
        current = snapshot(read)
        state = current.verify()
        value = history(current)
        value["model_inputs"] = invocation_inputs(current, invocation)
        value["telemetry"] = cursor_status(run_directory(root, run_id) / "telemetry/cursor.json", len(state.records))
        encoded = json_bytes(value)
        if previous != encoded:
            previous = encoded
            emitted += 1
            yield value
        if not follow or value["status"] == "finished" or updates is not None and emitted >= updates:
            return
        time.sleep(interval)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="strive")
    root.add_argument("--root", type=Path, default=Path("artifacts-vnext-workflow"))
    sub = root.add_subparsers(dest="command", required=True)
    run_parser = sub.add_parser("run")
    run_parser.add_argument("manifest", type=Path)
    run_parser.add_argument("--id", required=True)
    resume_parser = sub.add_parser("resume")
    resume_parser.add_argument("run")
    compare_parser = sub.add_parser("compare")
    compare_parser.add_argument("a")
    compare_parser.add_argument("b")
    compare_parser.add_argument("--spec", type=Path, required=True)
    compare_parser.add_argument("--out", type=Path)
    experiment_parser = sub.add_parser("experiment")
    experiment_parser.add_argument("study", type=Path)
    for name in ("campaign", "budget-stop-live"):
        campaign_parser = sub.add_parser(name)
        campaign_parser.add_argument("manifest", type=Path)
        campaign_parser.add_argument("--id", required=True)
        campaign_parser.add_argument("--resume", action="store_true")
        campaign_parser.add_argument("--episodes", type=int)
        campaign_parser.add_argument("--prepare-only", action="store_true")
    status_parser = sub.add_parser("status")
    status_parser.add_argument("run")
    status_parser.add_argument("--follow", action="store_true")
    status_parser.add_argument("--invocation")
    projector = sub.add_parser("project", help="optional separate telemetry process")
    projector.add_argument("run")
    projector.add_argument("--profile", choices=list(TelemetryProfile))
    projector.add_argument("--endpoint")
    projector.add_argument("--development-endpoint", help="required distinct endpoint when exporting audit HTTP traces")
    projector.add_argument("--destination", default="development:local")
    projector.add_argument("--audit-release", type=Path)
    projector.add_argument("--rebuild", action="store_true")
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.command == "run":
            run(args.root, args.manifest, args.id, display=lambda text: print(text, flush=True))
            print(json_bytes(history(reader(args.root, args.id))).decode())
        elif args.command == "resume":
            resume(args.root, args.run)
            print(json_bytes(history(reader(args.root, args.run))).decode())
        elif args.command == "compare":
            report = compare([reader(args.root, args.a)], [reader(args.root, args.b)], comparison_spec(args.spec.read_text()))
            paths = export(report, args.out or args.root / "comparisons" / (args.a + "--" + args.b))
            print("\n".join(str(path) for path in paths))
        elif args.command == "experiment":
            from ..study.experiment import experiment
            print(json_bytes(experiment(args.root, args.study)).decode())
        elif args.command in {"campaign", "budget-stop-live"}:
            from .campaign import live
            print(json_bytes(live(args.root, args.manifest, args.id, resume=args.resume,
                episodes=args.episodes, prepare_only=args.prepare_only, budget_proof=args.command == "budget-stop-live")).decode())
        elif args.command == "status":
            for value in status(args.root, args.run, follow=args.follow, invocation=args.invocation):
                print(json_bytes(value).decode(), flush=True)
        elif args.command == "project":
            projector = Projector(reader(args.root, args.run), run_directory(args.root, args.run) / "telemetry/cursor.json",
                HTTPExporter(args.endpoint, development_endpoint=args.development_endpoint) if args.endpoint else MemoryExporter(), destination=args.destination,
                profile=TelemetryProfile(args.profile) if args.profile else None, audit_release=args.audit_release)
            print(json_bytes(projector.flush(rebuild=args.rebuild)).decode())
        return 0
    except (OSError, ValueError, VerificationError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


def accepts(argv: list[str]) -> bool:
    index = 0
    while index < len(argv):
        if argv[index] == "--root":
            index += 2
        elif argv[index] == "--json":
            index += 1
        else:
            break
    if index >= len(argv):
        return False
    word = argv[index]
    return word in {"resume", "compare", "experiment", "project", "campaign", "budget-stop-live"} or (
        word in {"run", "status"} and index + 1 < len(argv) and not argv[index + 1].startswith("-"))
