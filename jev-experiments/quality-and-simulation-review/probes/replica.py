"""Read committed replica evidence and cached data. No network, weights, or training."""

import csv
import hashlib
import json
import math
import random
import statistics
import sys
from collections import Counter
from pathlib import Path

LAB = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(LAB / "src"))
from jev_lab.data import balanced, train_validation
from jev_lab.replica import records


def decode(path):
    lines = path.read_text().splitlines()
    document = json.loads(lines[0])["document"]
    source_lines = {}
    for lineno, line in enumerate(lines[1:], 2):
        entry = json.loads(line)
        target = document
        for key in entry["path"]:
            target = target[key]
        assert len(target) == entry["index"]
        target.append(entry["value"])
        if isinstance(entry["value"], dict) and "id" in entry["value"]:
            source_lines["/".join(entry["path"]) + ":" + entry["value"]["id"]] = lineno
    return document, source_lines


def wilson(k, n):
    z = 1.959963984540054
    p, d = k / n, 1 + z * z / n
    center = (p + z * z / (2 * n)) / d
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [center - half, center + half]


def argmax(values):
    return max(range(len(values)), key=values.__getitem__)


document, lines = decode(LAB / "results/replica.jsonl")
r = document["result"]
source = r["sources"]["PolyAI-LDN/task-specific-datasets"]
cache = LAB / ".cache/upstream/PolyAI-LDN/task-specific-datasets" / source["commit"] / "banking_data"
raw = {}
for split in ("train", "test"):
    p = cache / (split + ".csv")
    assert hashlib.sha256(p.read_bytes()).hexdigest() == source["files"]["banking_data/" + split + ".csv"]
    raw[split] = [{"id": f"banking77/{split}/{i}", "text": row["text"], "target": row["category"]}
                  for i, row in enumerate(csv.DictReader(p.open()))]
labels = json.loads((cache / "categories.json").read_text())
train, val = train_validation(raw["train"])
selected = {"train": records(balanced(train, 4), labels, 1),
            "validation": records(balanced(val, 1)[:40], labels, 2),
            "test": records(balanced(raw["test"], 1)[:77], labels, 3)}
assert [x["id"] for x in selected["test"]] == [x["id"] for x in r["after_rows"]]
assert [[q["label"] for q in x["questions"]] for x in selected["test"]] == [x["targets"] for x in r["after_rows"]]
out = {"manifest": document["manifest"], "result_keys": list(r), "split_sizes": {}, "phases": {}}
for split, rows in selected.items():
    out["split_sizes"][split] = {"n": len(rows), "classes": len({x["target"] for x in rows}),
                                 "targets": {kind: dict(Counter(x["questions"][i]["label"] for x in rows))
                                             for i, kind in enumerate(("choice", "noul", "score"))}}
draw_rng = random.Random(42)
draws = [draw_rng.randrange(308) for _ in range(240)]
out["unique_training_records_drawn"] = len(set(draws))
out["sample_exact_text_overlap"] = {f"{a}:{b}": len({x["text"].strip().lower() for x in selected[a]} & {x["text"].strip().lower() for x in selected[b]})
                                    for a, b in [("train", "validation"), ("train", "test"), ("validation", "test")]}
for phase in ("before", "after"):
    phase_rows = r[phase + "_rows"]
    result = {}
    for i, kind in enumerate(("choice", "noul", "score")):
        pairs = [(row["targets"][i], argmax(row["probabilities"][i])) for row in phase_rows]
        correct = sum(t == p for t, p in pairs)
        brier = statistics.mean(sum((v - (j == row["targets"][i])) ** 2 for j, v in enumerate(row["probabilities"][i])) for row in phase_rows)
        result[kind] = {"correct": correct, "n": len(pairs), "wilson95": wilson(correct, len(pairs)), "brier": brier,
                        "predictions": dict(Counter(p for t, p in pairs)), "targets": dict(Counter(t for t, p in pairs)),
                        "confusion": dict(Counter(f"{t}->{p}" for t, p in pairs)),
                        "mean_confidence": statistics.mean(max(row["probabilities"][i]) for row in phase_rows),
                        "confident_errors_at_0_9": sum(t != p and max(row["probabilities"][i]) >= .9 for row, (t, p) in zip(phase_rows, pairs))}
        assert math.isclose(correct / len(pairs), r[phase][kind]["accuracy"])
        assert math.isclose(brier, r[phase][kind]["brier"])
    out["phases"][phase] = result
    latencies = sorted(row["latency_ms"] for row in phase_rows)
    out["phases"][phase]["latency_ms"] = {"median": statistics.median(latencies), "max": max(latencies), "sum": sum(latencies)}
out["choice_paired_transitions"] = dict(Counter(f"{argmax(a['probabilities'][0]) == a['targets'][0]}->{argmax(b['probabilities'][0]) == b['targets'][0]}" for a, b in zip(r["before_rows"], r["after_rows"])))
refs = r["jev_reference"]["rows"]
answered = [x for x in refs if "error" not in x]
out["jev_reference"] = {"n": len(refs), "answered": len(answered), "errors": dict(Counter(x["error"].split(":")[0] for x in refs if "error" in x)),
                         "correct_answered": sum(x["target"] == x["prediction"] for x in answered), "recorded_accuracy_all_attempted": r["jev_reference"]["accuracy_all_attempted"]}
ids = {x["id"] for x in answered}
out["jev_reference"]["replica_correct_on_same_answered"] = sum(argmax(x["probabilities"][0]) == x["targets"][0] for x in r["after_rows"] if x["id"] in ids)
out["curve"] = {"points": len(r["curve"]), "first": r["curve"][0], "last": r["curve"][-1], "reported_training_seconds": r["training_seconds"]}
out["examples"] = []
for idx in [0, next(i for i, row in enumerate(r["after_rows"]) if row["targets"][1] != argmax(row["probabilities"][1]) and max(row["probabilities"][1]) > .9)]:
    sample = selected["test"][idx]
    out["examples"].append({"record": sample, "before": r["before_rows"][idx], "after": r["after_rows"][idx],
                             "after_source_line": lines["result/after_rows:" + sample["id"]]})
out["packed_separate_max_probability_difference"] = r["packed_separate_max_probability_difference"]
tokenizer_path = LAB / ".cache/huggingface/hub/models--HuggingFaceTB--SmolLM2-360M/snapshots" / r["revision"]
if (tokenizer_path / "tokenizer.json").exists():
    from transformers import AutoTokenizer
    tokenizer = AutoTokenizer.from_pretrained(str(tokenizer_path), local_files_only=True)
    document_lengths = [len(tokenizer.encode("Document:\n" + x["text"] + "\n", add_special_tokens=False)) for x in raw["test"]]
    question_text = "Question: Which intent is expressed by the customer?\n"
    question_tokens = len(tokenizer.encode(question_text, add_special_tokens=False))
    question_tokens += sum(len(tokenizer.encode("Option: " + label.replace("_", " ") + "\n", add_special_tokens=False)) for label in labels)
    question_tokens += len(tokenizer.encode("Decision:", add_special_tokens=False))
    out["full_test_token_preflight"] = {"n": len(document_lengths), "maximum_document_tokens": max(document_lengths),
                                         "documents_exceeding_160": sum(n > 160 for n in document_lengths),
                                         "full_77_option_branch_tokens": question_tokens,
                                         "maximum_77_option_packed_tokens": max(document_lengths) + question_tokens}
output = Path(__file__).with_suffix(".results.json")
output.write_text(json.dumps(out, indent=2) + "\n")
print(json.dumps(out, indent=2))
