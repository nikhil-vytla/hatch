"""Cross-session unique-payment accounting for the single-vs-evolved run.

Replayed units carry their original metered cost into every later evidence
file, so summing files double-counts. This script attributes each payment
to the session that actually incurred it and cross-checks the total.

Session history (see NOTES.md):
- run 1 (delivery-wire defect): all failure rows recorded $0 while roughly
  four episodes of real spend went unmetered (the old failure path raised
  before collecting token counts). A standing accounting gap, not
  recoverable; the estimate below prices the same astropy units at what they
  cost when they were re-run and metered.
- run 2 (frame-limit defect): paid astropy static trial-0/trial-1 and the
  destroyed evolved trial-0 episode; its orphaned process also paid the
  evolved trial-1 episode whose cost is first recorded in the run-3 file.
- run 3 (gateway connection failures): paid everything else, including
  partial costs on the five destroyed xarray episodes.
- run 4 (final recovery): paid five fresh xarray episodes; all other units
  replayed from caches with no new inference.
"""

from __future__ import annotations

import json
from pathlib import Path

from parallax.canonical import atomic_write, canonical_bytes
from parallax.screening import ScreeningRun, read_screening_jsonl

EVIDENCE = Path(__file__).parent / "evidence"
OUTPUT = EVIDENCE / "cross-session-spend.json"
# The three astropy units recorded at $0 in run 1, plus the evolved trial-1
# episode in flight when it aborted, cost $0.128415, $0.087925, $0.095215 and
# $0.080445 when they were later re-run and metered. The upper end bounds four
# episodes at this experiment's most expensive single episode. A first estimate
# of $0.40-0.80 extrapolated from round-2 averages that were priced at the
# retired Opus 4.1 rate card; see research/spend-audit-20260803/.
RUN1_UNMETERED_ESTIMATE_USD = (0.311555, 0.52)
SUPERSEDED_RUN1_ESTIMATE_USD = (0.40, 0.80)

ASTROPY = "swebench:astropy__astropy-14508"
XARRAY = "swebench:pydata__xarray-4695"
# Paid in run 2 (the last by its orphaned process) and carried by value
# into the run-3 file.
RUN2_KEYS_IN_RUN3_FILE = {
    (ASTROPY, 0, "static"),
    (ASTROPY, 1, "static"),
    (ASTROPY, 1, "evolved"),
}
# The only units the final run paid for; everything else replayed.
RUN4_FRESH_KEYS = {
    (XARRAY, trial, arm) for trial in (0, 1, 2) for arm in ("static", "evolved")
} - {(XARRAY, 1, "evolved")}


def _runs(name: str) -> list[ScreeningRun]:
    records = read_screening_jsonl(EVIDENCE / name)
    return [record for record in records[1:] if isinstance(record, ScreeningRun)]


def _key(run: ScreeningRun) -> tuple[str, int, str]:
    return (str(run.unit.source_id), int(run.unit.trial_index), str(run.unit.arm))


def main() -> None:
    run2 = _runs("experiment-frame-limit-failure.jsonl")
    run3 = _runs("experiment-connection-failures.jsonl")
    run4 = _runs("experiment.jsonl")

    run3_by_key = {_key(run): run for run in run3}
    run4_by_key = {_key(run): run for run in run4}

    run2_direct = {_key(run): run.estimated_cost_usd for run in run2}
    orphan_key = (ASTROPY, 1, "evolved")
    run2_payments = dict(run2_direct)
    run2_payments[orphan_key] = run3_by_key[orphan_key].estimated_cost_usd

    run3_payments = {
        key: run.estimated_cost_usd
        for key, run in run3_by_key.items()
        if key not in RUN2_KEYS_IN_RUN3_FILE
    }
    run4_payments = {
        key: run4_by_key[key].estimated_cost_usd for key in RUN4_FRESH_KEYS
    }

    for key in RUN2_KEYS_IN_RUN3_FILE - {orphan_key}:
        if run3_by_key[key].estimated_cost_usd != run2_direct[key]:
            raise ValueError(f"carried cost drifted for {key!r}")
    for key, run in run4_by_key.items():
        if key in RUN4_FRESH_KEYS:
            continue
        if run.estimated_cost_usd != run3_by_key[key].estimated_cost_usd:
            raise ValueError(f"final replay cost drifted for {key!r}")

    superseded = {
        "run2_destroyed_evolved_trial0_usd": run2_direct[(ASTROPY, 0, "evolved")],
        "run3_destroyed_xarray_partials_usd": sum(
            run3_by_key[key].estimated_cost_usd for key in RUN4_FRESH_KEYS
        ),
    }
    unique_total = (
        sum(run2_payments.values())
        + sum(run3_payments.values())
        + sum(run4_payments.values())
    )
    final_total = sum(run.estimated_cost_usd for run in run4)
    reconstruction = (
        final_total
        + superseded["run2_destroyed_evolved_trial0_usd"]
        + superseded["run3_destroyed_xarray_partials_usd"]
    )
    if abs(unique_total - reconstruction) > 1e-9:
        raise ValueError("unique-payment total fails the reconstruction check")

    def _serialize(payments: dict[tuple[str, int, str], float]) -> dict[str, float]:
        return {
            f"{source}/trial-{trial}/{arm}": cost
            for (source, trial, arm), cost in sorted(payments.items())
        }

    report = {
        "schema_version": 1,
        "sessions": {
            "run1_delivery_wire": {
                "metered_usd": 0.0,
                "unmetered_episode_estimate_usd": list(RUN1_UNMETERED_ESTIMATE_USD),
                "superseded_estimate_usd": list(SUPERSEDED_RUN1_ESTIMATE_USD),
                "note": (
                    "roughly four episodes of real spend lost to the "
                    "pre-fix failure path that raised before usage capture; "
                    "the superseded estimate used round-2 averages priced at "
                    "the retired Opus 4.1 rate card"
                ),
            },
            "run2_frame_limit": {
                "payments": _serialize(run2_payments),
                "total_usd": sum(run2_payments.values()),
                "note": (
                    "includes the evolved trial-1 episode paid by the "
                    "orphaned run-2 process and first recorded in the "
                    "run-3 file"
                ),
            },
            "run3_connection_failures": {
                "payments": _serialize(run3_payments),
                "total_usd": sum(run3_payments.values()),
            },
            "run4_final_recovery": {
                "payments": _serialize(run4_payments),
                "total_usd": sum(run4_payments.values()),
            },
        },
        "superseded_payments_included_above": superseded,
        "unique_metered_total_usd": unique_total,
        "with_run1_unmetered_estimate_usd": [
            unique_total + RUN1_UNMETERED_ESTIMATE_USD[0],
            unique_total + RUN1_UNMETERED_ESTIMATE_USD[1],
        ],
        "final_evidence_file_sum_usd": final_total,
        "reconstruction_check": (
            "unique_metered_total_usd == final_evidence_file_sum_usd "
            "+ superseded run-2 and run-3 destroyed-episode costs"
        ),
    }
    atomic_write(OUTPUT, canonical_bytes(report) + b"\n")
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
