"""Summarize checkpoint-evolution screening evidence.

Validates every evidence record against the typed models, confirms the
per-stage delivery/receipt chain for both arms, and emits the per-seed
per-arm per-stage outcome table plus the paired evolved-vs-carry
contrast the preregistration calls for.

Run from `parallax/`:

    uv run python research/checkpoint-evolution-slice/summarize_screening.py \
        research/checkpoint-evolution-slice/evidence/screening.jsonl
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from parallax.checkpoint_evolution import EMPTY_WORKSPACE, load_seed_family
from parallax.checkpoint_runner import (
    CeFamilyRecord,
    CeManifestRecord,
    CeRunRecord,
)

SEED_PATH = Path(__file__).parent.parent.parent / (
    "tests/fixtures/checkpoint_family.json"
)


def stage_label(receipt) -> str:
    outcome = receipt.outcome
    if outcome.kind == "run_failure":
        return f"FAIL({outcome.failure_kind})"
    if outcome.strict_pass:
        return "strict"
    if outcome.isolated_pass:
        return "isolated"
    if outcome.core_pass:
        return "core"
    return "fail"


def main(evidence_path: Path) -> None:
    lines = evidence_path.read_text().splitlines()
    manifest = CeManifestRecord.model_validate_json(lines[0])
    family_record = CeFamilyRecord.model_validate_json(lines[1])
    runs = [CeRunRecord.model_validate_json(line) for line in lines[2:]]

    fixture = load_seed_family(SEED_PATH)
    reference_digests = [stage.digest for stage in fixture.references.stages]
    empty_digest = EMPTY_WORKSPACE.digest
    total_stages = len(fixture.family.checkpoints)

    scheduled = len(manifest.units) * len(manifest.arm_configs) * total_stages
    delivered = sum(len(run.receipts) for run in runs)

    # Receipt-chain confirmation: evolved carries the model's own output;
    # carry-reference always starts each stage from the frozen reference.
    chain_ok = 0
    for run in runs:
        for receipt in run.receipts:
            if receipt.index == 1:
                expected = empty_digest
            elif run.arm == "carry-reference":
                expected = reference_digests[receipt.index - 2]
            else:
                prior = run.receipts[receipt.index - 2]
                expected = prior.output_workspace_digest
            assert receipt.input_workspace_digest == expected, (
                f"chain break: seed {run.trial_seed} {run.arm} stage {receipt.index}"
            )
            chain_ok += 1

    table: dict[int, dict[str, list[str]]] = {}
    for run in runs:
        labels = [stage_label(r) for r in run.receipts]
        labels += ["censored"] * len(run.censored)
        table.setdefault(run.trial_seed, {})[run.arm] = labels

    def strict_at(seed: int, arm: str, stage: int) -> int | None:
        label = table[seed][arm][stage - 1]
        if label.startswith("FAIL") or label == "censored":
            return None
        return 1 if label == "strict" else 0

    contrast = {}
    for stage in (2, 3):
        pairs = []
        for seed in sorted(table):
            evolved = strict_at(seed, "evolved", stage)
            carry = strict_at(seed, "carry-reference", stage)
            pairs.append(
                {
                    "seed": seed,
                    "evolved": evolved,
                    "carry": carry,
                    "diff": None
                    if evolved is None or carry is None
                    else evolved - carry,
                }
            )
        diffs = [p["diff"] for p in pairs if p["diff"] is not None]
        # Bounds-only treatment: unverifiable stages (upstream failure)
        # are scored both ways to bound the paired difference.
        lower = sum(p["diff"] if p["diff"] is not None else -1 for p in pairs)
        upper = sum(p["diff"] if p["diff"] is not None else 1 for p in pairs)
        contrast[stage] = {
            "pairs": pairs,
            "observed_diff_sum": sum(diffs),
            "observed_pairs": len(diffs),
            "bound_lower": lower,
            "bound_upper": upper,
        }

    failure_kinds: dict[str, int] = {}
    verified = 0
    spend = 0.0
    tokens_in = 0
    tokens_out = 0
    for run in runs:
        for receipt in run.receipts:
            if receipt.usage is not None:
                spend += receipt.usage.estimated_cost_usd
                tokens_in += receipt.usage.prompt_tokens
                tokens_out += receipt.usage.completion_tokens
            if receipt.outcome.kind == "run_failure":
                kind = receipt.outcome.failure_kind
                failure_kinds[kind] = failure_kinds.get(kind, 0) + 1
            else:
                verified += 1

    summary = {
        "evidence": evidence_path.name,
        "records": {
            "manifest": 1,
            "family": 1,
            "runs": len(runs),
            "all_validated": True,
        },
        "design_digest": manifest.design_digest,
        "family_digest": family_record.family.digest,
        "scheduled_stage_calls": scheduled,
        "delivered_receipts": delivered,
        "receipt_chain_confirmed": chain_ok,
        "verified_stages": verified,
        "stage_run_failures": failure_kinds,
        "run_failure_rate": round(sum(failure_kinds.values()) / delivered, 4),
        "per_seed_outcomes": {str(seed): arms for seed, arms in sorted(table.items())},
        "paired_strict_contrast": {
            str(stage): {key: value for key, value in data.items() if key != "pairs"}
            for stage, data in contrast.items()
        },
        "spend": {
            "estimated_cost_usd": round(spend, 6),
            "prompt_tokens": tokens_in,
            "completion_tokens": tokens_out,
        },
    }

    out_path = evidence_path.with_name("screening-summary.json")
    out_path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")

    print(f"validated: manifest + family + {len(runs)} runs")
    print(f"receipt chain confirmed for {chain_ok}/{delivered} receipts")
    print(
        f"verified {verified}/{delivered} delivered stages "
        f"({scheduled} scheduled); failures: {failure_kinds}"
    )
    print(f"spend ${spend:.4f} ({tokens_in} in / {tokens_out} out tokens)")
    header = " | ".join(f"s{i}" for i in range(1, total_stages + 1))
    print(f"\nseed | arm | {header}")
    for seed in sorted(table):
        for arm in ("evolved", "carry-reference"):
            print(f"{seed} | {arm} | " + " | ".join(table[seed][arm]))
    for stage, data in contrast.items():
        print(
            f"\nstage {stage} paired strict diff (evolved - carry): "
            f"observed {data['observed_diff_sum']:+d} over "
            f"{data['observed_pairs']} decidable pairs; "
            f"bounds [{data['bound_lower']:+d}, {data['bound_upper']:+d}] "
            f"over all 10 pairs"
        )
    print(f"\nsummary written to {out_path}")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
