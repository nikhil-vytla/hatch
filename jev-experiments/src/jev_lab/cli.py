import argparse
import asyncio
import importlib
import json
import sys
from pathlib import Path

from .core import ROOT, Client, Ledger, Run, choice, load_shell_key, noul, save, score

EXPERIMENTS = {
    "classify": "benchmarks",
    "judge": "benchmarks",
    "robustness": "benchmarks",
    "latency": "benchmarks",
    "visuals": "pilots",
    "ui": "pilots",
    "decisions": "pilots",
    "games": "games",
    "optimize": "optimize",
    "teach": "teach",
    "language": "language",
    "routing": "compositions",
    "verify": "compositions",
    "search": "compositions",
    "beverage": "compositions",
    "music": "compositions",
    "micro": "compositions",
    "logos": "compositions",
    "reward": "teach",
    "replica": "replica",
    "access": "access",
    "adapters": "adapters",
    "language_reference": "language",
}


async def run_experiment(name, quick):
    run = Run(name, {"quick": quick, "seed": 42})
    client = Client(run)
    print(f"Running {name}: {run.path}", flush=True)
    try:
        if name == "smoke":
            result = await client.evaluate(
                "A customer was charged twice and requests money back.",
                {
                    "intent": choice("What is requested?", ["refund", "shipping"]),
                    "refund": noul("Is the customer requesting a refund?"),
                    "severity": score("Assess urgency", ["routine", "urgent", "emergency"]),
                },
            )
        else:
            module = importlib.import_module(f"jev_lab.{EXPERIMENTS[name]}")
            result = await getattr(module, name)(client, quick=quick)
        result["budget_at_finish"] = client.ledger.summary()
        run.finish(result)
        print(f"Finished {name}: {run.path / 'result.json'}", flush=True)
    except BaseException as exc:
        checkpoint = run.path / "checkpoint.json"
        partial = json.loads(checkpoint.read_text()) if checkpoint.exists() else {}
        run.finish(
            {
                **partial,
                "status": "partial"
                if partial
                else "interrupted"
                if isinstance(exc, (KeyboardInterrupt, asyncio.CancelledError))
                else "failed",
                "error": str(exc),
                "budget_at_finish": client.ledger.summary(),
            }
        )
        raise
    finally:
        await client.close()


def report():
    from .reporting import compact_game_states, transport_summary

    index, history = {}, []
    for path in sorted((ROOT / "runs").glob("*/manifest.json")):
        manifest = json.loads(path.read_text())
        history.append(
            {"manifest": manifest, "transport": transport_summary(path.parent / "requests.jsonl")}
        )
        if manifest["experiment"] in ("browser-live", "smoke", "access"):
            continue
        if manifest["status"] not in ("complete", "partial"):
            continue
        result_file = path.parent / "result.json"
        if result_file.exists():
            name = manifest["experiment"]
            if name == "language_reference":
                name = "language"
            result = json.loads(result_file.read_text())
            if name == "games":
                result = compact_game_states(result)
            result["transport"] = transport_summary(path.parent / "requests.jsonl")
            if name in ("classify", "judge") and manifest["created"] < "2026-09-20T05:03:00":
                result["latency_note"] = (
                    "This early run's row latency measures its successful final attempt only. See transport.logical_request_latency_ms_including_retries_excluding_queue for retry-aware durations."
                )
            save(ROOT / "results" / f"{name}.jsonl", {"manifest": manifest, "result": result})
            index[name] = {
                "run_id": manifest["id"],
                "status": manifest["status"],
                "created": manifest["created"],
                "file": f"{name}.json",
            }
    save(ROOT / "results" / "index.jsonl", {"experiments": index, "budget": Ledger().summary()})
    save(
        ROOT / "results" / "history.jsonl",
        {
            "runs": history,
            "note": "Includes failed and superseded runs. The gallery selects the latest completed or partial run for each experiment; raw request logs remain local.",
        },
    )
    print(json.dumps({"published": list(index), "budget": Ledger().summary()}, indent=2))


def main():
    parser = argparse.ArgumentParser(
        description="Jev laboratory: measured calls, local models, replay"
    )
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run")
    run.add_argument("experiment", choices=["all", "smoke", *EXPERIMENTS])
    run.add_argument(
        "--quick",
        action="store_true",
        help="Small integration pilot; not the planned benchmark sample",
    )
    batch = sub.add_parser(
        "batch", help="Run selected experiments sequentially, retaining each failure"
    )
    batch.add_argument("experiments", nargs="+", choices=list(EXPERIMENTS))
    batch.add_argument("--quick", action="store_true")
    sub.add_parser("report")
    sub.add_parser("budget")
    sub.add_parser("list")
    replay = sub.add_parser("replay")
    replay.add_argument("path", type=Path)
    serve = sub.add_parser("serve")
    serve.add_argument("--port", type=int, default=8792)
    sub.add_parser("deploy")
    sub.add_parser("cloudcheck")
    args = parser.parse_args()
    if args.command in ("run", "batch"):
        load_shell_key()
        names = (
            args.experiments
            if args.command == "batch"
            else list(EXPERIMENTS)
            if args.experiment == "all"
            else [args.experiment]
        )
        for name in names:
            try:
                asyncio.run(run_experiment(name, args.quick))
            except Exception as exc:
                if args.command != "batch":
                    raise
                print(f"Experiment {name} failed: {exc}", flush=True)
            report()
        report()
    elif args.command == "report":
        report()
    elif args.command == "budget":
        print(json.dumps(Ledger().summary(), indent=2))
    elif args.command == "list":
        print("\n".join(EXPERIMENTS))
    elif args.command == "replay":
        path = args.path / "result.json" if args.path.is_dir() else args.path
        if path.suffix == ".jsonl":
            from .records import read_record

            print(json.dumps(read_record(path), indent=2))
        else:
            print(path.read_text())
    elif args.command == "serve":
        import uvicorn

        load_shell_key()
        uvicorn.run("jev_lab.server:app", host="127.0.0.1", port=args.port)
    elif args.command == "deploy":
        from .deployment import deploy

        report()
        deploy()
    elif args.command == "cloudcheck":
        from .deployment import cloudcheck

        cloudcheck()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
