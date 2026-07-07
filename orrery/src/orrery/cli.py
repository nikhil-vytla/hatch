"""Command-line interface.

orrery run worlds/support_desk.toml --seed 42 --out runs/
orrery run --generate support_desk --seeds 20        # population QA
orrery replay worlds/support_desk.toml runs/support_desk-42.jsonl
orrery generate support_desk --seed 7 --out spec.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from orrery import engine
from orrery.entities import EntityStore
from orrery.plugins import build_registry
from orrery.spec import WorldSpec
from orrery.trace import Trace


def load_spec(path: Path) -> WorldSpec:
    if path.suffix == ".toml":
        return WorldSpec.from_toml(path)
    return WorldSpec.model_validate_json(path.read_text())


def _print_verdicts(result: engine.RunResult, seed: int) -> None:
    print(f"\nseed={seed}  spec={result.trace.meta.spec_name}  events={len(result.trace.events)}")
    for verdict in result.verdicts:
        marker = {"pass": "PASS", "fail": "FAIL"}.get(verdict.status, "????")
        evidence = f"  evidence={verdict.evidence[:3]}" if verdict.evidence else ""
        print(f"  [{marker}] {verdict.name}: {verdict.details}{evidence}")


def cmd_run(args: argparse.Namespace) -> int:
    seeds = args.seed or [0]
    if args.generate:
        registry = build_registry(uses=args.uses)
        brief = json.loads(args.brief) if args.brief else {}
        specs = {
            seed: registry.generators[args.generate](brief, seed)
            for seed in (range(args.seeds) if args.seeds else seeds)
        }
    else:
        spec = load_spec(Path(args.spec))
        specs = {seed: spec for seed in seeds}

    passed = 0
    for seed, spec in specs.items():
        result = asyncio.run(engine.run(spec, seed))
        _print_verdicts(result, seed)
        passed += result.passed
        if args.out:
            out_dir = Path(args.out)
            trace_path = out_dir / f"{spec.name}-{seed}.jsonl"
            result.trace.write(trace_path)
            print(f"  trace -> {trace_path}")
    total = len(specs)
    print(f"\n{passed}/{total} runs passed their contract")
    return 0 if passed == total else 1


def cmd_replay(args: argparse.Namespace) -> int:
    spec = load_spec(Path(args.spec))
    trace = Trace.read(Path(args.trace))
    try:
        asyncio.run(engine.replay(spec, trace))
    except engine.ReplayDivergence as exc:
        print(f"REPLAY DIVERGED: {exc}")
        return 1
    print(f"replay ok: fingerprint {trace.event_fingerprint[:16]}… reproduced bit-for-bit")
    return 0


def cmd_verify(args: argparse.Namespace) -> int:
    spec = load_spec(Path(args.spec))
    trace = Trace.read(Path(args.trace))
    registry = build_registry(uses=spec.uses)
    store = EntityStore.model_validate(trace.final_state)
    verdicts = [v.verify(trace, store) for v in engine.build_verifiers(spec, registry)]
    ok = all(v.passed for v in verdicts)
    for verdict in verdicts:
        print(f"[{verdict.status.upper():4}] {verdict.name}: {verdict.details}")
    return 0 if ok else 1


def cmd_adapt(args: argparse.Namespace) -> int:
    registry = build_registry(uses=args.uses)
    adapter = registry.adapters.get(args.adapter)
    if adapter is None:
        print(f"no adapter {args.adapter!r}; known: {', '.join(sorted(registry.adapters))}")
        return 1
    brief = json.loads(args.brief) if args.brief else {}
    rows = [json.loads(line) for line in Path(args.file).read_text().splitlines() if line.strip()]
    specs = adapter(rows, brief)
    print(f"adapted {len(specs)} task(s) from {args.file}")
    failures = 0
    for spec in specs:
        if args.out:
            out_path = Path(args.out) / f"{spec.name.replace(':', '-')}.json"
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_text(json.dumps(spec.model_dump(mode="json"), indent=2))
            print(f"  {spec.name} -> {out_path} (hash {spec.spec_hash()[:12]}…)")
        if args.run:
            result = asyncio.run(engine.run(spec, 0))
            _print_verdicts(result, 0)
            failures += not result.passed
    return 1 if failures else 0


def cmd_export(args: argparse.Namespace) -> int:
    from orrery import export

    spec = load_spec(Path(args.spec))
    trace = Trace.read(Path(args.trace))
    rows = asyncio.run(export.export_sft(spec, trace, require_pass=not args.include_failing))
    if not rows:
        print("no records exported (run failed its contract; use --include-failing to keep it)")
        return 1
    export.write_jsonl(rows, Path(args.out))
    print(f"{len(rows)} records -> {args.out} (reward={rows[0]['reward']:.3f})")
    return 0


def cmd_generate(args: argparse.Namespace) -> int:
    registry = build_registry(uses=args.uses)
    brief = json.loads(args.brief) if args.brief else {}
    spec = registry.generators[args.template](brief, args.seed)
    payload = json.dumps(spec.model_dump(mode="json"), indent=2)
    if args.out:
        Path(args.out).write_text(payload)
        print(f"spec -> {args.out} (hash {spec.spec_hash()[:16]}…)")
    else:
        print(payload)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="orrery")
    sub = parser.add_subparsers(dest="command", required=True)

    p_run = sub.add_parser("run", help="run a world and check its contract")
    p_run.add_argument("spec", nargs="?", help="WorldSpec file (.toml or .json)")
    p_run.add_argument("--seed", type=int, action="append", help="repeatable")
    p_run.add_argument("--generate", help="generate specs from this template instead of a file")
    p_run.add_argument("--seeds", type=int, help="with --generate: run seeds 0..N-1")
    p_run.add_argument("--brief", help="with --generate: JSON brief")
    p_run.add_argument("--uses", action="append", default=["orrery.domains.support"])
    p_run.add_argument("--out", help="directory for trace files")
    p_run.set_defaults(fn=cmd_run)

    p_replay = sub.add_parser("replay", help="re-derive a trace; fail on divergence")
    p_replay.add_argument("spec")
    p_replay.add_argument("trace")
    p_replay.set_defaults(fn=cmd_replay)

    p_verify = sub.add_parser("verify", help="re-run the contract over a stored trace")
    p_verify.add_argument("spec")
    p_verify.add_argument("trace")
    p_verify.set_defaults(fn=cmd_verify)

    p_adapt = sub.add_parser("adapt", help="convert benchmark rows (JSONL) into WorldSpecs")
    p_adapt.add_argument("adapter", help="adapter name, e.g. bfcl_style")
    p_adapt.add_argument("file", help="benchmark rows, one JSON object per line")
    p_adapt.add_argument("--brief", help="JSON brief (e.g. agent policy override)")
    p_adapt.add_argument("--uses", action="append", default=[])
    p_adapt.add_argument("--out", help="directory for adapted spec files")
    p_adapt.add_argument("--run", action="store_true", help="also run each adapted world")
    p_adapt.set_defaults(fn=cmd_adapt)

    p_export = sub.add_parser("export", help="export a trace as contract-labeled training data")
    p_export.add_argument("spec")
    p_export.add_argument("trace")
    p_export.add_argument("--out", required=True, help="output JSONL path")
    p_export.add_argument("--include-failing", action="store_true")
    p_export.set_defaults(fn=cmd_export)

    p_gen = sub.add_parser("generate", help="emit a WorldSpec from a generator template")
    p_gen.add_argument("template")
    p_gen.add_argument("--seed", type=int, default=0)
    p_gen.add_argument("--brief", help="JSON brief")
    p_gen.add_argument("--uses", action="append", default=["orrery.domains.support"])
    p_gen.add_argument("--out")
    p_gen.set_defaults(fn=cmd_generate)

    args = parser.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
