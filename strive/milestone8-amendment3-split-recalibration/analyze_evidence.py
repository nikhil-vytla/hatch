"""Derive IDs/sizes from published stock IDs and captured crossing-ID evidence.

No tau2 imports or task execution. Usage with the downloaded ID lists:
PYTHONPATH=src:adapters/tau2/src .venv/bin/python \
  milestone8-amendment3-split-recalibration/analyze_evidence.py STOCK_IDS_JSON
The input needs train/test arrays, as in the pinned split JSON.
"""
from collections import Counter
import hashlib
import json
from pathlib import Path
import sys

from strive_benchmark_tau2.splits import (ALGORITHM, DEFAULT_SEED, OBJECTIVE,
    TARGET, crossing_report, group_tasks, validate_partition, whole_group_split)

ROOT = Path(__file__).resolve().parents[1]
WORK = Path(__file__).resolve().parent
splits = json.loads(Path(sys.argv[1]).read_text())
selected = set(splits["train"] + splits["test"])
assert len(selected) == 114 and len(splits["train"]) == 74 and len(splits["test"]) == 40
captured = ROOT / "milestone8-live-tau2-fixes/captured-qualification-failures.json"
legacy = json.loads(captured.read_bytes())["failures"]["connected scenario group crosses train/audit"]
assert selected <= set(legacy)
groups = group_tasks([{"id": task} for task in legacy])
parts = whole_group_split(tuple(groups.values()), selected)
validate_partition(tuple(groups.values()), selected, parts)
report = {
    "status": "split-derived-from-IDs; live grading not run on host",
    "source_revision": "a2c024725189473d2d7cea3a5cfdbcc67478e41f",
    "stock_ids_source": "https://github.com/sierra-research/tau2-bench/blob/a2c024725189473d2d7cea3a5cfdbcc67478e41f/data/tau2/domains/telecom/split_tasks.json",
    "captured_evidence_sha256": hashlib.sha256(captured.read_bytes()).hexdigest(),
    "grouping_algorithm": ALGORITHM, "seed": DEFAULT_SEED, "objective": OBJECTIVE,
    "group_order": list(groups),
    "selected_group_to_ids": {root: [task for task in ids if task in selected] for root, ids in groups.items()},
    "captured_crossing_group_to_ids": groups,
    "captured_scope": "The full mapping here covers the captured crossing IDs, not an independently loaded task inventory. Linux certification retains the complete inventory mapping.",
    "target_sizes": dict(zip(("development", "validation", "audit"), TARGET)),
    "actual_sizes": dict(zip(("development", "validation", "audit"), map(len, parts))),
    "exact_target_achievable": tuple(map(len, parts)) == TARGET,
    "partitions": dict(zip(("development", "validation", "audit"), parts)),
    "stock_test_ids": splits["test"],
    "stock_legacy_crossing": {"severity": "informational", "fatal": False, "inventory_id_count": len(legacy),
                              "by_root": dict(Counter(task.split("]")[0] + "]" for task in legacy))},
    "root_crossing_on_captured_ids": crossing_report(tuple(groups.values()), set(splits["train"]), set(splits["test"])),
}
(WORK / "derived-split.json").write_text(json.dumps(report, sort_keys=True, indent=2) + "\n")
print(json.dumps({k: report[k] for k in ("actual_sizes", "exact_target_achievable", "stock_legacy_crossing")}, indent=2))
