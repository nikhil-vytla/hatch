"""Measure the PR and round-trip a proposed JSONL representation without changing data."""
from pathlib import Path
import collections
import json
import subprocess

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent

def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)

AUDITED_HEAD = "f6926cc548682df8ac5921b09c02d5ad0f0aed13"
base = git("merge-base", "origin/main", AUDITED_HEAD).decode().strip()
rows = []
for line in git("diff", "--numstat", base, AUDITED_HEAD).decode().splitlines():
    added, removed, path = line.split("\t")
    blob = git("show", AUDITED_HEAD + ":" + path)
    if "/results/" in path or path.endswith(("live-check.json", "public-check.json")):
        category = "Recorded results"
    elif Path(path).name in {"bun.lock", "uv.lock", "Cargo.lock", "go.sum"}:
        category = "Lockfiles"
    elif path.startswith("jev-experiments/web/"):
        category = "Earlier web application"
    elif path.startswith("jev-experiments/experience-prototypes/") and Path(path).suffix in {".ts", ".tsx", ".js", ".css", ".html"}:
        category = "Current web application"
    elif any(part in path for part in ["/src/jev_lab/", "/adapters/", "/tests/"]):
        category = "Research runners and adapters"
    else:
        category = "Reports, configuration, and artifacts"
    rows.append({"path": path, "lines": 0 if added == "-" else int(added), "bytes": len(blob), "category": category})
groups = {}
for row in rows:
    group = groups.setdefault(row["category"], {"files": 0, "lines": 0, "bytes": 0})
    group["files"] += 1
    group["lines"] += row["lines"]
    group["bytes"] += row["bytes"]
summary = {"head": AUDITED_HEAD, "base": base, "files": len(rows), "lines": sum(r["lines"] for r in rows), "bytes": sum(r["bytes"] for r in rows), "groups": groups, "largest_files": sorted(rows, key=lambda r: r["lines"], reverse=True)[:10]}
(OUT / "diff-breakdown.json").write_text(json.dumps(summary, indent=2) + "\n")

estimates = []
for name in ["classify", "games", "robustness"]:
    path = "jev-experiments/results/" + name + ".json"
    original = git("show", AUDITED_HEAD + ":" + path)
    document = json.loads(original)
    result = document["result"]
    extracted = {"classify": ["experiments"], "games": ["episodes", "observations"], "robustness": ["rows"]}[name]
    records = [{"kind": "metadata", "manifest": document["manifest"], "result": {k: v for k, v in result.items() if k not in extracted}}]
    if name == "classify":
        for group_id, group in result["experiments"].items():
            records.append({"kind": "group", "id": group_id, "metadata": {k: v for k, v in group.items() if k != "rows"}})
            records.extend({"kind": "row", "group": group_id, "value": row} for row in group["rows"])
    else:
        for key in extracted:
            records.extend({"kind": key, "value": row} for row in result[key])
    encoded = "".join(json.dumps(row, separators=(",", ":"), ensure_ascii=False) + "\n" for row in records).encode()
    # Decode the proposed representation and verify every original value.
    lines = [json.loads(line) for line in encoded.splitlines()]
    restored = {"manifest": lines[0]["manifest"], "result": lines[0]["result"]}
    target = restored["result"]
    if name == "classify":
        target["experiments"] = {}
        for row in lines[1:]:
            if row["kind"] == "group":
                target["experiments"][row["id"]] = {**row["metadata"], "rows": []}
            else:
                target["experiments"][row["group"]]["rows"].append(row["value"])
    else:
        target.update({key: [] for key in extracted})
        for row in lines[1:]:
            target[row["kind"]].append(row["value"])
    assert restored == document, "JSONL round trip changed " + path
    estimates.append({"file": path, "json_lines": len(original.splitlines()), "jsonl_lines": len(records), "json_bytes": len(original), "jsonl_bytes": len(encoded), "round_trip_equal": True})
(OUT / "jsonl-estimate.json").write_text(json.dumps(estimates, indent=2) + "\n")
print(json.dumps({"pr_lines": summary["lines"], "groups": groups, "jsonl": estimates}, indent=2))
