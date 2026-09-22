#!/usr/bin/env python3
"""Compare retained derivatives with their Git predecessors without emitting record bodies."""
import argparse
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re
import subprocess


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def same(left, right):
    if isinstance(left, dict):
        return isinstance(right, dict) and left.keys() == right.keys() and all(same(v, right[k]) for k, v in left.items())
    if isinstance(left, list):
        return isinstance(right, list) and len(left) == len(right) and all(same(a, b) for a, b in zip(left, right))
    if type(left) in (int, float):
        return type(right) in (int, float) and left == right
    return type(left) is type(right) and left == right


def field(payload, kind, record, pointer):
    current = payload[record] if kind == "transcript" else payload
    pieces = [x.replace("~1", "/").replace("~0", "~") for x in pointer[1:].split("/")]
    for piece in pieces[:-1]:
        current = current[int(piece)] if isinstance(current, list) else current[piece]
    key = int(pieces[-1]) if isinstance(current, list) else pieces[-1]
    return current, key


def recover_bindings(before, after, bindings):
    """Known derivative aliases locate exact predecessor spans; their hashes must match."""
    mapped = {entry["uri"]: entry for entry in bindings}
    if len(mapped) != len(bindings): raise ValueError("Duplicate field alias")
    matcher = re.compile("|".join(re.escape(uri) for uri in sorted(mapped, key=len, reverse=True)))
    pieces, names, last = [], {}, 0
    for match in matcher.finditer(after):
        pieces.append(re.escape(after[last:match.start()]))
        uri = match.group()
        if uri in names:
            pieces.append("(?P=" + names[uri] + ")")
        else:
            names[uri] = "p" + str(len(names))
            pieces.append("(?P<" + names[uri] + ">.*?)")
        last = match.end()
    pieces.append(re.escape(after[last:]))
    match = re.fullmatch("".join(pieces), before, flags=re.DOTALL)
    if not match or names.keys() != mapped.keys(): raise ValueError("Explicit span reconstruction failed")
    result = before
    for uri, entry in mapped.items():
        original = match.group(names[uri])
        if not original.startswith("/") or sha(original.encode()) != entry["sourcePathSha256"] or result.count(original) != entry["occurrences"]:
            raise ValueError("Predecessor span identity changed")
        result = result.replace(original, uri)
    if result != after: raise ValueError("Unlisted field transformation")


def counts(value):
    if isinstance(value, dict):
        children = [counts(x) for x in value.values()]
    elif isinstance(value, list):
        children = [counts(x) for x in value]
    else:
        return {"numeric": int(type(value) in (int, float)), "boolean": int(type(value) is bool), "null": int(value is None)}
    return {kind: sum(x[kind] for x in children) for kind in ("numeric", "boolean", "null")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--selection", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists(): parser.error("Choose a new report")
    selection = json.loads(args.selection.read_text())
    def original(path):
        return subprocess.check_output(["git", "show", selection["base"] + ":" + path], cwd=args.repo, stderr=subprocess.PIPE)
    rows = []
    for entry in selection["removals"]:
        raw = original(entry["path"])
        derivative = json.loads((args.repo / entry["replacedBy"]).read_text())
        if sha(raw) != entry["predecessorSha256"] or derivative["source"]["sha256"] != sha(raw) or derivative["source"]["bytes"] != len(raw):
            raise ValueError("Predecessor lineage changed")
        kind = derivative["kind"]
        payload = json.loads(raw) if kind == "summary" else {"text": raw.decode()} if kind == "text" else [json.loads(line) for line in raw.splitlines() if line.strip()]
        if derivative["source"]["recordCount"] != (len(payload) if kind == "transcript" else 1):
            raise ValueError("Event count changed")
        expected = deepcopy(payload)
        for edit in derivative["transformation"]["fields"]:
            parent, key = field(expected, kind, edit["record"], edit["pointer"])
            target, target_key = field(derivative["payload"], kind, edit["record"], edit["pointer"])
            before, after = parent[key], target[target_key]
            if sha(before.encode()) != edit["originalSha256"] or sha(after.encode()) != edit["derivativeSha256"]:
                raise ValueError("Field identity changed")
            recover_bindings(before, after, edit["bindings"])
            parent[key] = after
        if not same(expected, derivative["payload"]): raise ValueError("Non-location data changed")
        if (args.repo / entry["path"]).exists(): raise ValueError("Ambiguous retained tree")
        rows.append({"path": entry["replacedBy"], "kind": kind, "harness": derivative["harness"],
                     "originalSha256": sha(raw), "derivativeSha256": sha((args.repo / entry["replacedBy"]).read_bytes()),
                     "recordCount": derivative["source"]["recordCount"], "editedFields": len(derivative["transformation"]["fields"]),
                     "unchangedScalarCounts": counts(payload), "explicitSpanOnly": True, "allOtherDataEqual": True})
    index_path = "jev-experiments/roadmap/integration/evidence/index.json"
    before = json.loads(original(index_path))
    after = json.loads((args.repo / index_path).read_text())
    lineage = after.pop("retained_record_index")
    if lineage["originalIndexSha256"] != sha(original(index_path)): raise ValueError("Index predecessor identity changed")
    historical = {row["run"]: row for row in before["runs"]}
    for run in after["runs"]:
        run.pop("retainedRecords", None)
        for key in ("summary", "transcript"):
            run[key] = historical[run["run"]][key]
    if not same(before, after): raise ValueError("Historical index changed beyond explicit links")
    selected = all(sha((args.repo / path).read_bytes()) == row["sha256"] for path, row in selection["selected"].items())
    result = {"base": selection["base"], "derivatives": rows, "recordCount": len(rows), "historicalRuns": len(before["runs"]),
              "checks": {"allPredecessorAndFieldIdentitiesMatch": True, "onlyExplicitLocationSpansDiffer": True,
                         "allNonLocationValuesEventsOutcomesAndAccountingEqual": True, "historicalIndexChronologyGatesAndUnknownsEqual": True,
                         "originalAndDerivativeTreesUnambiguous": True, "selectedSourceHashesMatch": selected},
              "allPassed": selected, "originalBodiesEmitted": False, "providerCalls": 0}
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({k: result[k] for k in ("recordCount", "historicalRuns", "allPassed", "originalBodiesEmitted")}))


if __name__ == "__main__":
    main()
