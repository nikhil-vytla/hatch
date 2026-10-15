"""Count how often phrases from the skill's own examples leak into generated answers."""
import json, re
from collections import defaultdict
from pathlib import Path

# Phrases specific to the skill's examples (worked-example.md, depth.md, range.md, SKILL.md)
MARKERS = {
    "DuckDB": r"duckdb", "Cox/hazard model": r"\bcox\b|hazard", "200 ms": r"200\s?ms", "launch-email contrast (holdout)": r"holdout group",
    "short seller": r"short[- ]seller", "forensic accountant": r"forensic accountant",
    "eight quarters / back-test": r"eight quarters|back-?test",
}
rows = [json.loads(l) for l in open(Path(__file__).parent / "results/gen.jsonl")]
conds = ["baseline", "baseline_long", "skill_body", "skill_full", "skill_body_v2", "skill_full_v2"]
hits = defaultdict(lambda: defaultdict(int)); n = defaultdict(int)
for g in rows:
    n[g["cond"]] += 1
    for k, rx in MARKERS.items():
        if re.search(rx, g["text"], re.I):
            hits[k][g["cond"]] += 1
conds = [c for c in conds if n[c]]
print("| Marker (from skill examples) | " + " | ".join(conds) + " |")
print("|---|" + "---|" * len(conds))
for k in MARKERS:
    print(f"| {k} | " + " | ".join(f"{hits[k][c]}/{n[c]}" for c in conds) + " |")
