"""Create ten causal variant contracts for one existing task specification."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from parallax.variants import TaskSpec, default_variant_blueprints


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("task_spec", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    source = TaskSpec.from_dict(json.loads(args.task_spec.read_text()))
    rows = [
        {
            "source_task_id": source.task_id,
            "source_digest": source.digest(),
            "family": blueprint.family,
            "components": list(blueprint.components),
            "intent_relation": blueprint.relation,
            "state_mode": blueprint.state_mode,
            "verifier_policy": blueprint.verifier_policy,
            "research_question": blueprint.research_question,
            "independent_benchmark_task": blueprint.independent_benchmark_task,
        }
        for blueprint in default_variant_blueprints()
    ]
    payload = {
        "schema_version": "parallax-variants-v0.1",
        "source": source.to_dict(),
        "variant_contracts": rows,
        "analysis_unit": "source_task_cluster",
        "warning": (
            "These are causal variant contracts, not ten independent benchmark tasks. "
            "Generated candidates require admission and verifier validation."
        ),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"source_task_id": source.task_id, "contracts": len(rows)}))


if __name__ == "__main__":
    main()
