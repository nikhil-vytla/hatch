"""Compare our recorded Ties metric with the unmodified pinned upstream functions."""
import ast
import json
import hashlib
import sys
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
import pandas as pd

root = Path(__file__).resolve().parent
source = root.parent / ".cache/rewardbench2/rewardbench_utils.py"
assert hashlib.sha256(source.read_bytes()).hexdigest() == "56b32e5a56af46716de3308537d9ba7bbd3ac3db07face66f4b10bd6ed38d7db"
tree = ast.parse(source.read_text())
functions = [node for node in tree.body if isinstance(node, ast.FunctionDef)
             and node.name in {"_compute_prompt_stats", "process_single_model", "reroll_and_score_dataset"}]
assert len(functions) == 3
exec(compile(ast.Module(body=functions, type_ignores=[]), str(source), "exec"))

lines = [json.loads(line) for line in (root / "results.jsonl").read_text().strip().split("\n")]
result = lines[0]["document"]["result"]
rows = [entry["value"] for entry in lines[1:] if entry["path"] == ["result", "rows"]]
ties = [row for row in rows if row["subset"] == "Ties"]
assert len(ties) == 102 and all(row.get("status") == "completed" for row in ties), "Finish all Ties cases first"

class Dataset(list):
    column_names = []

    def add_column(self, name, values):
        return self

    def to_pandas(self):
        return pd.DataFrame(self)

    @classmethod
    def from_pandas(cls, frame):
        return cls(frame.to_dict(orient="records"))

dataset = Dataset({"id": row["id"], "num_correct": row["num_correct"],
                   "scores": [c["score"] for c in sorted(row["candidates"], key=lambda c: not c["chosen"])]}
                  for row in ties)
with np.errstate(divide="ignore", invalid="ignore"):
    _, expected = process_single_model(dataset)
actual = result["metrics"]["ties"]["score"]
assert abs(expected - actual) < 1e-12, (expected, actual)
regular = [row for row in rows if row["subset"] != "Ties"]
assert len(regular) == 1763 and all(row.get("status") == "completed" for row in regular)
unrolled = Dataset({"id": row["id"], "subset": row["subset"], "scores": c["score"]}
                   for row in regular for c in sorted(row["candidates"], key=lambda c: not c["chosen"]))
scored = reroll_and_score_dataset(unrolled, [len(row["candidates"]) for row in regular], ["scores"])
regular_differences = {}
for subset in {row["subset"] for row in regular}:
    upstream = float(np.mean([r["results"] for r in scored if r["subset"] == subset]))
    local = result["metrics"]["subsets"][subset]["score"]
    regular_differences[subset] = abs(upstream - local)
    assert regular_differences[subset] < 1e-12, (subset, upstream, local)
report = {"ties_cases": len(ties), "upstream_ties_score": expected, "typescript_ties_score": actual,
          "ties_absolute_difference": abs(expected - actual), "regular_cases": len(regular),
          "regular_absolute_differences": regular_differences, "passed": True}
(root / "upstream-parity.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
