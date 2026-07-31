from __future__ import annotations

import argparse
import json
from dataclasses import asdict
from pathlib import Path

from parallax.autoresearch import generate_lookup_tasks


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--campaign-id", required=True)
    parser.add_argument("--model", default="claude-haiku-4-5")
    parser.add_argument("--count", type=int, default=12)
    parser.add_argument("--rows", type=int, default=18)
    parser.add_argument("--repetitions", type=int, default=1)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    tasks = []
    for task in generate_lookup_tasks(args.count, args.rows, args.seed):
        value = asdict(task)
        value["kind"] = "lookup"
        tasks.append(value)
    payload = {
        "campaign_id": args.campaign_id,
        "conditions": ["static", "repeat-deep", "combined-deep"],
        "max_calls_non_static": 7,
        "model": args.model,
        "protocol_version": "parallax-autoresearch-v1",
        "repetitions": args.repetitions,
        "seed": args.seed,
        "tasks": tasks,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    print(f"wrote {len(tasks)} task(s) to {args.out}")


if __name__ == "__main__":
    main()
