"""Print the headline table from a saved analysis JSON."""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> None:
    path = Path(sys.argv[1])
    report = json.loads(path.read_text())
    print("population:", json.dumps(report["population"], sort_keys=True))
    print("arms:", report["arms_executed"])
    print()
    header = (
        f"{'arm':9s} {'pass':>9s} {'accuracy':>9s} "
        f"{'95% CI':>18s} {'wrong':>6s} {'invalid':>8s} "
        f"{'runfail':>8s} {'turns':>12s} {'complete':>9s}"
    )
    print(header)
    for arm in ("static", "matched", "evolved"):
        if arm not in report["arm_rates"]:
            continue
        rates = report["arm_rates"][arm]
        clustered = rates["accuracy_clustered"]
        interval = f"[{clustered['lower']:+.4f},{clustered['upper']:+.4f}]"
        turns = f"{rates['assistant_turns_delivered']}/{rates['turns_scheduled']}"
        print(
            f"{arm:9s} {rates['pass']:4d}/{rates['scheduled']:<4d} "
            f"{clustered['estimate']:9.4f} {interval:>18s} "
            f"{rates['wrong']:6d} {rates['invalid']:8d} "
            f"{rates['run_failures']:8d} {turns:>12s} "
            f"{rates['episodes_with_every_turn_answered']:9d}"
        )
    print()
    print(f"primary contrast: {report['primary_contrast']}")
    print(
        f"{'contrast':26s} {'estimate':>10s} {'95% bootstrap':>20s} "
        f"{'95% normal':>20s} {'SE':>8s} {'width':>7s} {'dropped':>8s}"
    )
    for name, value in report["contrasts"].items():
        case = value["complete_case"]
        boot = f"[{case['lower']:+.4f},{case['upper']:+.4f}]"
        norm = f"[{case['normal_lower']:+.4f},{case['normal_upper']:+.4f}]"
        print(
            f"{name:26s} {case['estimate']:+10.4f} {boot:>20s} {norm:>20s} "
            f"{case['standard_error']:8.4f} "
            f"{case['upper'] - case['lower']:7.4f} "
            f"{value['pairs_dropped_to_run_failure']:8d}"
        )
    print()
    print("construction:", json.dumps(report["construction"], sort_keys=True))
    print("linkage:", json.dumps(report["linkage"], sort_keys=True))


if __name__ == "__main__":
    main()
