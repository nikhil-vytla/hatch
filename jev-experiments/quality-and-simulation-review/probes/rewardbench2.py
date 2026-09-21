"""Read-only RewardBench 2 audit. Emits counts and diagnostics, never candidate text.

Run with jev-experiments/.venv/bin/python. Original cached sources are required.
Only this probe's adjacent JSON output is written. No model/API calls.
"""
import ast
import collections
import gzip
import hashlib
import json
import math
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

lab = Path(__file__).resolve().parents[2]
folder = lab / "rewardbench2"
entries = [json.loads(line) for line in (folder / "results.jsonl").read_text().strip().split("\n")]
result = entries[0]["document"]["result"]
rows = [e["value"] for e in entries if e.get("path") == ["result", "rows"]]
requests = [e["value"] for e in entries if e.get("path") == ["result", "requests"]]
pairs = [e["value"] for e in entries if e.get("path") == ["result", "metrics", "ties", "per_pair"]]
raw = json.loads((lab / ".cache/rewardbench2/dataset.json").read_text())
sha = lambda value: hashlib.sha256(value).hexdigest()
assert sha((lab / ".cache/rewardbench2/test.parquet").read_bytes()) == result["provenance"]["parquet_sha256"]
assert raw == pq.read_table(lab / ".cache/rewardbench2/test.parquet").to_pylist()
source = {(r["subset"], str(r["id"])): r for r in raw}
assert len(source) == len(rows) == len({(r["subset"], r["id"]) for r in rows}) == 1865
omitted_prompts = omitted_candidates = 0
for row in rows:
    original = source[(row["subset"], row["id"])]
    if row.get("prompt_omission"):
        omitted_prompts += 1
        assert sha(original["prompt"].encode()) == row["prompt_omission"]["sha256"]
    else:
        assert row["prompt"] == original["prompt"]
    original_candidates = original["chosen"] + original["rejected"]
    order = sorted(range(len(original_candidates)), key=lambda i: sha(f"42:{original['id']}:{i}".encode()))
    assert len(row["candidates"]) == len(order)
    for candidate, index in zip(row["candidates"], order):
        assert candidate["chosen"] == (index < len(original["chosen"]))
        assert candidate["model"] == original["models"][0 if len(original["models"]) == 1 else index]
        assert 1 <= candidate["score"] <= 10
        if candidate.get("omission"):
            omitted_candidates += 1
            assert sha(original_candidates[index].encode()) == candidate["omission"]["sha256"]
        else:
            assert candidate["text"] == original_candidates[index]
    assert row["status"] == "completed"

# Execute only the pinned pure scoring functions. Downloaded code is not copied.
scorer = lab / ".cache/rewardbench2/rewardbench_utils.py"
assert sha(scorer.read_bytes()) == "56b32e5a56af46716de3308537d9ba7bbd3ac3db07face66f4b10bd6ed38d7db"
functions = [n for n in ast.parse(scorer.read_text()).body if isinstance(n, ast.FunctionDef)
             and n.name in {"_compute_prompt_stats", "process_single_model", "reroll_and_score_dataset"}]
assert len(functions) == 3
exec(compile(ast.Module(body=functions, type_ignores=[]), str(scorer), "exec"))
defaultdict = collections.defaultdict


class Dataset(list):
    column_names = []

    def add_column(self, name, values):
        return self

    def to_pandas(self):
        return pd.DataFrame(self)

    @classmethod
    def from_pandas(cls, frame):
        return cls(frame.to_dict(orient="records"))


ties = [r for r in rows if r["subset"] == "Ties"]
with np.errstate(divide="ignore", invalid="ignore"):
    _, upstream_ties = process_single_model(Dataset({"id": r["id"], "num_correct": r["num_correct"],
        "scores": [c["score"] for c in sorted(r["candidates"], key=lambda c: not c["chosen"])]} for r in ties))
regular = [r for r in rows if r["subset"] != "Ties"]
unrolled = Dataset({"id": r["id"], "subset": r["subset"], "scores": c["score"]}
    for r in regular for c in sorted(r["candidates"], key=lambda c: not c["chosen"]))
scored = reroll_and_score_dataset(unrolled, [len(r["candidates"]) for r in regular], ["scores"])
upstream = {s: float(np.mean([r["results"] for r in scored if r["subset"] == s]))
            for s in {r["subset"] for r in regular}}
upstream["Ties"] = upstream_ties
assert all(abs(v - result["metrics"]["subsets"][s]["score"]) < 1e-12 for s, v in upstream.items())
assert abs(np.mean(list(upstream.values())) - result["metrics"]["macro_score"]) < 1e-12

duplicates = collections.defaultdict(list)
for row in rows:
    for candidate in row["candidates"]:
        if not row.get("prompt_omission") and not candidate.get("omission"):
            duplicates[(row["subset"], row["prompt"], candidate["text"])].append(
                {"subset": row["subset"], "id": row["id"], "label": candidate["label"], "score": candidate["score"]})
duplicates = [{"instances": v, "score_range": max(c["score"] for c in v) - min(c["score"] for c in v)}
              for v in duplicates.values() if len(v) > 1]

diagnostics = {}
for subset in sorted(upstream):
    selected = [r for r in rows if r["subset"] == subset]
    gaps = [sorted((c["score"] for c in r["candidates"]), reverse=True) for r in selected]
    if subset == "Ties":
        continue
    length_baselines = {}
    for name, pick in [("shortest", min), ("longest", max)]:
        points = []
        for row in selected:
            original = source[(row["subset"], row["id"])]
            candidates = [(t, True) for t in original["chosen"]] + [(t, False) for t in original["rejected"]]
            wanted = pick(len(t) for t, good in candidates)
            best = [good for text, good in candidates if len(text) == wanted]
            points.append(sum(best) / len(best))
        length_baselines[name] = float(np.mean(points))
    diagnostics[subset] = {"cases": len(selected), "exact_top_ties": sum(g[0] == g[1] for g in gaps),
        "top_gap_at_most_0_02": sum(g[0] - g[1] <= 0.020000001 for g in gaps),
        "top_gap_at_most_0_10": sum(g[0] - g[1] <= 0.100000001 for g in gaps), **length_baselines}

public_file = lab / "experience-prototypes/public/data/rewardbench2.json"
public = json.loads(public_file.read_text())["result"] if public_file.exists() else None
output = {
    "source_parquet_sha256": result["provenance"]["parquet_sha256"],
    "all_source_text_labels_order_models_verified": True,
    "cases": len(rows), "candidates": sum(len(r["candidates"]) for r in rows),
    "subset_counts": dict(collections.Counter(r["subset"] for r in rows)),
    "omissions": {"prompts": omitted_prompts, "candidates": omitted_candidates},
    "upstream_scorer_parity": upstream, "macro": float(np.mean(list(upstream.values()))),
    "requests": {"status": dict(collections.Counter(r["status"] for r in requests)),
        "attempts": sum(len(r["attempts"]) for r in requests),
        "successful_questions": sum(r["question_count"] for r in requests if r["status"] == "completed"),
        "provider_model_missing": sum("provider_model" not in r for r in requests),
        "reported_cost_values": dict(collections.Counter(str(r.get("cost_usd")) for r in requests))},
    "same_question_duplicates": duplicates,
    "ordinary_case_diagnostics": diagnostics,
    "ties_paired_margin_failures": sum(p["correctness_preferred_hard"] == 0 for p in pairs),
    "ties_margin_only_failures_hidden_by_ranking_mistakes": [p["id"] for p in pairs if
        p["correctness_preferred_hard"] == 0 and p["tied_accuracy"] == p["ref_accuracy"] == 1],
    "safety_category_counts": dict(collections.Counter(r["additional_metadata"]["category"] for r in raw if r["subset"] == "Safety")),
    "factuality_method_counts": dict(collections.Counter(r["additional_metadata"]["method"] for r in raw if r["subset"] == "Factuality")),
    "public_asset": {"bytes": public_file.stat().st_size, "local_gzip_bytes": len(gzip.compress(public_file.read_bytes())),
        "non_safety_notices": sum("content_notice" in r for r in public["rows"])} if public else None,
}
target = Path(__file__).with_suffix(".json")
target.write_text(json.dumps(output, indent=2) + "\n")
print(json.dumps(output, indent=2))
