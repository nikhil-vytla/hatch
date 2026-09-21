"""Offline full-split baseline and duplicate audit. Uses the existing pinned CSV cache."""
import csv
import hashlib
import json
from pathlib import Path
from collections import Counter
import time

import sklearn
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, f1_score
from sklearn.pipeline import make_pipeline

ROOT = Path(__file__).resolve().parents[2]
header, *entries = [json.loads(line) for line in (ROOT / "results/optimize.jsonl").read_text().splitlines()]
doc = header["document"]
for entry in entries:
    node = doc
    for part in entry["path"]:
        node = node[part]
    node.append(entry["value"])
result = doc["result"]
pin = result["sources"]["PolyAI-LDN/task-specific-datasets"]
cached = ROOT / ".cache/upstream/PolyAI-LDN/task-specific-datasets" / pin["commit"]

rows = {}
for split in ("train", "test"):
    filename = f"banking_data/{split}.csv"
    content = (cached / filename).read_bytes()
    assert hashlib.sha256(content).hexdigest() == pin["files"][filename]
    with (cached / filename).open() as stream:
        rows[split] = [dict(r, id=f"banking77/{split}/{i}") for i, r in enumerate(csv.DictReader(stream))]

lookup = {r["id"]: r for rs in rows.values() for r in rs}
normalize = lambda text: " ".join(text.lower().split())
selected = {s: [lookup[i] for i in ids] for s, ids in result["splits"].items()}
selected_duplicates = {}
for a, b in (("train", "validation"), ("train", "test"), ("validation", "test")):
    ta = {normalize(r["text"]) for r in selected[a]}
    selected_duplicates[f"{a}/{b}"] = [r["id"] for r in selected[b] if normalize(r["text"]) in ta]

baseline = make_pipeline(
    TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True),
    LogisticRegression(max_iter=500, C=4, random_state=42),
)
start = time.perf_counter()
baseline.fit([r["text"] for r in rows["train"]], [r["category"] for r in rows["train"]])
predictions = baseline.predict([r["text"] for r in rows["test"]])
elapsed = time.perf_counter() - start
gold = [r["category"] for r in rows["test"]]
train_text = {normalize(r["text"]) for r in rows["train"]}
overlap_test_ids = [r["id"] for r in rows["test"] if normalize(r["text"]) in train_text]
clean = [i for i, r in enumerate(rows["test"]) if r["id"] not in overlap_test_ids]
out = {
    "kind": "Offline TF-IDF plus logistic regression baseline, not a Jev evaluation",
    "sklearn_version": sklearn.__version__,
    "dataset_pin": pin["commit"],
    "dataset_counts": {s: len(rs) for s, rs in rows.items()},
    "intents": len(set(gold)),
    "test_per_intent": sorted(set(Counter(gold).values())),
    "selected_normalized_text_overlap": selected_duplicates,
    "official_train_test_normalized_text_overlap": overlap_test_ids,
    "full_test": {"correct": sum(a == b for a, b in zip(gold, predictions)), "attempted": len(gold), "accuracy": accuracy_score(gold, predictions), "macro_f1": f1_score(gold, predictions, average="macro")},
    "test_without_exact_overlap": {"attempted": len(clean), "accuracy": accuracy_score([gold[i] for i in clean], predictions[clean])},
    "fit_and_predict_seconds": elapsed,
    "scope": "All 10003 training rows and all 77 labels. This uses more labeled training data than the optimizer, so it is a resource-separated reference.",
}
print(json.dumps(out, indent=2))
