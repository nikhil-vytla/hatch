from __future__ import annotations

import argparse
import json
from pathlib import Path

from parallax.autoresearch import load_records, summarize_records


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--records", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    summary = summarize_records(load_records(args.records))
    evolving = {
        name: row
        for name, row in summary["conditions"].items()
        if name not in {"static", "repeat"} and "+" not in name
    }
    valid = {
        name: row
        for name, row in evolving.items()
        if row["accuracy"] is not None
        and row["provider_errors"] + row["harness_errors"] == 0
    }
    repeat_accuracy = summary["conditions"].get("repeat", {}).get("accuracy")
    degraded = {
        name: row
        for name, row in valid.items()
        if repeat_accuracy is not None and row["accuracy"] < repeat_accuracy
    }
    hardest = min(degraded, key=lambda name: degraded[name]["accuracy"]) if degraded else None
    if hardest:
        next_intervention = {
            "condition": hardest,
            "intervention": "canonical-active-intent-ledger-v1",
            "reason": "lowest evolving-condition accuracy below matched control",
        }
    elif valid:
        next_intervention = {
            "condition": None,
            "intervention": "increase-transition-depth",
            "reason": "all valid evolving conditions are saturated at the matched control",
        }
    else:
        next_intervention = {
            "condition": None,
            "intervention": None,
            "reason": "no valid evolving condition available",
        }
    summary["next_intervention"] = next_intervention

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    print(json.dumps(summary["next_intervention"], sort_keys=True))


if __name__ == "__main__":
    main()
