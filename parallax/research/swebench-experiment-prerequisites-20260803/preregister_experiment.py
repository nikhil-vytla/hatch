from __future__ import annotations

import json
from pathlib import Path

from parallax.canonical import atomic_write, canonical_bytes, canonical_digest

ROOT = Path(__file__).parent
EVIDENCE = ROOT / "evidence"
SOURCES = (
    "astropy__astropy-14508",
    "django__django-13786",
    "pydata__xarray-4695",
)
TRIAL_SEEDS = (2026080401, 2026080402, 2026080403)
PRIOR_STATIC_METERED_USD = 0.908775
EVOLVED_COST_MULTIPLIER = 2.0


def main() -> None:
    admissions = []
    for source in SOURCES:
        path = EVIDENCE / source / "admission.json"
        record = json.loads(path.read_text(encoding="utf-8"))
        if record["decision"] not in {"admitted", "admitted_flaky"}:
            raise ValueError(f"source is not admitted: {source}")
        admissions.append(
            {
                "admission_decision": record["decision"],
                "source_id": record["source_id"],
                "spec_digest": record["spec_digest"],
            }
        )
    evolved_estimate = PRIOR_STATIC_METERED_USD * EVOLVED_COST_MULTIPLIER
    body = {
        "admissions": admissions,
        "budget": {
            "evolved_agent_steps": [6, 6],
            "max_output_tokens": 4096,
            "static_agent_steps": [12],
        },
        "conditions": ["static", "evolved"],
        "construction_seed": 20260803,
        "cost": {
            "approval_cap_usd": 3.5,
            "estimated_evolved_usd": evolved_estimate,
            "estimated_static_usd": PRIOR_STATIC_METERED_USD,
            "estimated_total_usd": PRIOR_STATIC_METERED_USD + evolved_estimate,
            "evolved_multiplier": EVOLVED_COST_MULTIPLIER,
            "pricing_input_usd_per_million": 5.0,
            "pricing_output_usd_per_million": 25.0,
        },
        "expected_response_model": "claude-opus-4-8",
        "kind": "single_vs_evolved_manifest",
        "model": "claude-opus-4-8",
        "schema_version": 1,
        "trial_seeds": TRIAL_SEEDS,
        "units": [
            {
                "arm": arm,
                "source_id": f"swebench:{source}",
                "trial_index": index,
                "trial_seed": seed,
            }
            for source in SOURCES
            for index, seed in enumerate(TRIAL_SEEDS)
            for arm in ("static", "evolved")
        ],
    }
    manifest = {"design_digest": canonical_digest(body), **body}
    atomic_write(
        EVIDENCE / "single-vs-evolved-design.json",
        canonical_bytes(manifest) + b"\n",
    )


if __name__ == "__main__":
    main()
