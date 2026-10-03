"""Read-only audit of the published latency sweep and optional local attempt log.

Run from the repository root with Python 3. Uses no network or third-party packages.
"""
import json
import math
from collections import Counter
from datetime import datetime
from pathlib import Path

root = Path(__file__).resolve().parents[2]
lines = [json.loads(line) for line in (root / "results/latency.jsonl").read_text().splitlines()]
document = lines[0]["document"]
for entry in lines[1:]:
    node = document
    for key in entry["path"]:
        node = node[key]
    assert len(node) == entry["index"]
    node.append(entry["value"])
result = document["result"]
rows = result["rows"]


def percentile(values, quantile):
    values = sorted(values)
    position = (len(values) - 1) * quantile
    lower = math.floor(position)
    upper = math.ceil(position)
    return values[lower] + (values[upper] - values[lower]) * (position - lower)


summary = {
    "manifest": document["manifest"],
    "requests": len(rows),
    "successful_requests": sum("latency_ms" in r for r in rows),
    "requested_question_slots": sum(r["questions"] for r in rows),
    "returned_question_slots": sum(r["questions"] for r in rows if "latency_ms" in r),
    "all_request_total_ms": sum(r["total_ms"] for r in rows),
    "all_request_p95_total_ms": percentile([r["total_ms"] for r in rows], 0.95),
    "success_input_tokens": sum(r.get("usage", {}).get("input_tokens", 0) for r in rows),
    "success_output_tokens": sum(r.get("usage", {}).get("output_tokens", 0) for r in rows),
    "transport": result["transport"],
    "groups": [],
}
for group in result["groups"]:
    selected = [r for r in rows if r["state_words"] == group["state_words"] and r["questions"] == group["questions"]]
    success = [r["latency_ms"] for r in selected if "latency_ms" in r]
    assert abs(group["p50_ms"] - percentile(success, 0.5)) < 1e-6
    assert abs(group["p95_ms"] - percentile(success, 0.95)) < 1e-6
    summary["groups"].append({
        **group,
        "p95_all_terminal_ms": percentile([r["total_ms"] for r in selected], 0.95),
        "returned_slots_per_second": sum(r["questions"] for r in selected if "latency_ms" in r) / (sum(r["total_ms"] for r in selected) / 1000),
        "failures": [r for r in selected if "error" in r],
    })
attempt_path = root / "runs" / document["manifest"]["id"] / "requests.jsonl"
if attempt_path.exists():
    attempts = [json.loads(line) for line in attempt_path.read_text().splitlines()]
    successful = [a for a in attempts if a["status"] == "ok"]
    questions = [q["instructions"] for a in attempts for q in a["request"]["questions"].values()]
    answers = [v for a in successful for v in a["response"]["answers"].values()]
    events = []
    for a in attempts:
        start = datetime.fromisoformat(a["at"]).timestamp()
        events += [(start, 1), (start + a["latency_ms"] / 1000, -1)]
    inflight = maximum = 0
    for _, change in sorted(events):
        inflight += change
        maximum = max(maximum, inflight)
    summary["local_attempt_check"] = {
        "attempts": len(attempts),
        "statuses": dict(Counter(a.get("http_status") for a in attempts)),
        "request_hashes": len({a["request_hash"] for a in attempts}),
        "unique_question_instructions": sorted(set(questions)),
        "state_word_counts": sorted({len(a["request"]["state"].split()) for a in attempts}),
        "wire_models": sorted({a["request"]["model"] for a in attempts}),
        "response_models": sorted({str(a["response"].get("model")) for a in successful}),
        "retry_count_distribution": dict(Counter(Counter(a["tag"] for a in attempts).values())),
        "max_attempts_in_flight": maximum,
        "returned_noul_slots": len(answers),
        "noul_value_counts": dict(Counter(v.get("noul") for v in answers)),
        "slot_success_at_0_5": sum(v.get("noul", 0) >= 0.5 for v in answers),
        "raw_recorded_costs": dict(Counter(str(a.get("cost_usd")) for a in attempts)),
    }
print(json.dumps(summary, indent=2))
