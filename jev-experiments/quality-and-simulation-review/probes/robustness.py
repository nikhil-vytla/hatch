"""Read-only reconstruction of the Decision stability experiment. No model calls."""

import csv
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

LAB = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(LAB / "src"))
from jev_lab.records import read_record


def wilson(hits, count):
    z = 1.959963984540054
    p = hits / count
    denominator = 1 + z * z / count
    center = (p + z * z / (2 * count)) / denominator
    radius = z * math.sqrt(p * (1 - p) / count + z * z / (4 * count**2)) / denominator
    return [max(0, center - radius), min(1, center + radius)]


doc = read_record(LAB / "experience-prototypes/results/robustness.jsonl")
rows = doc["result"]["rows"]
cases = defaultdict(dict)
for row in rows:
    cases[row["case"]][row["variant"]] = row
variants = ["original", "repeat", "reverse_options", "distractor", "quoted_injection"]
assert all(set(case) == set(variants) for case in cases.values())
report = {
    "rows": len(rows),
    "independent_cases": len(cases),
    "distinct_targets": len({row["target"] for row in rows}),
    "all_completed": all("prediction" in row and not row.get("error") for row in rows),
    "public_rows_with_question_payload": sum("questions" in row for row in rows),
    "variants": {},
}
for variant in variants:
    pairs = [(case["original"], case[variant]) for case in cases.values()]
    flips = [(a, b) for a, b in pairs if a["prediction"] != b["prediction"]]
    tv = [sum(abs(a["probabilities"][k] - b["probabilities"][k]) for k in a["probabilities"]) / 2 for a, b in pairs]
    report["variants"][variant] = {
        "paired_cases": len(pairs),
        "correct": sum(b["prediction"] == b["target"] for a, b in pairs),
        "label_flips": len(flips),
        "flip_rate_wilson_95": wilson(len(flips), len(pairs)),
        "regressions_from_correct": sum(a["prediction"] == a["target"] and b["prediction"] != b["target"] for a, b in pairs),
        "fixes_from_incorrect": sum(a["prediction"] != a["target"] and b["prediction"] == b["target"] for a, b in pairs),
        "mean_total_variation": sum(tv) / len(tv),
        "max_total_variation": max(tv),
        "identical_probability_maps": sum(a["probabilities"] == b["probabilities"] for a, b in pairs),
        "recovered_rows": sum("original_error" in b for a, b in pairs),
        "attack_target_predictions": sum(b["prediction"] == "card_arrival" for a, b in pairs),
        "flips": [{"case": a["case"], "original_text": a["original_text"], "target": a["target"], "before": a["prediction"], "after": b["prediction"]} for a, b in flips],
    }
initial = read_record(LAB / "results/robustness.jsonl")["result"]["rows"]
by_id = {row["id"]: row for row in rows}
report["recovery"] = {
    "initial_completed": sum("prediction" in row for row in initial),
    "initial_failed": sum(bool(row.get("error")) for row in initial),
    "previously_completed_changed": sum(row["prediction"] != by_id[row["id"]]["prediction"] or row["probabilities"] != by_id[row["id"]]["probabilities"] for row in initial if "prediction" in row),
    "attempt_status_counts": dict(Counter(row["status"] for row in doc["result"]["recovery"]["attempts"])),
}
log = LAB / "runs" / doc["manifest"]["id"] / "requests.jsonl"
report["local_request_logs_available"] = log.exists()
if log.exists():
    requests = {item["tag"]: item["request"] for line in log.read_text().splitlines() if (item := json.loads(line)).get("request")}
    checks = Counter()
    for row in rows:
        request = requests[row["id"]]
        original = requests[row["case"] + "/original"]
        state = request["state"]
        checks["published_state_matches_original_request"] += row["text"] == (state if isinstance(state, str) else json.dumps(state, ensure_ascii=False, indent=2))
        if row["variant"] == "repeat":
            checks["identical_repeat_request_body"] += request == original
        if row["variant"] == "reverse_options":
            checks["exact_reversal_of_criteria"] += list(request["questions"]["intent"]["criteria"].items()) == list(original["questions"]["intent"]["criteria"].items())[::-1]
    report["request_verification"] = dict(checks)
manifest = LAB / ".cache/sources.json"
if manifest.exists():
    revision = json.loads(manifest.read_text())["PolyAI-LDN/task-specific-datasets"]["commit"]
    test = LAB / ".cache/upstream/PolyAI-LDN/task-specific-datasets" / revision / "banking_data/test.csv"
    if test.exists():
        data = list(csv.DictReader(test.open()))
        report["cached_source"] = {"revision": revision, "test_count": len(data), "intents": len({row["category"] for row in data}), "per_intent_counts": sorted(set(Counter(row["category"] for row in data).values()))}
print(json.dumps(report, indent=2, ensure_ascii=False))
