"""Evaluate the actual Core ML package on all 400 held-out cases."""

import json, time, statistics
import numpy as np
import coremltools as ct
from prepare import CACHE, ROOT
from data import examples, collate
from metrics import metrics

items = examples("test")
training = json.loads((CACHE / "training-result.json").read_text())
baseline = {(r["id"], r["question_key"]): r["after"] for r in training["rows"]}
model = ct.models.MLModel(str(CACHE / "LayaDecisions.mlpackage"), compute_units=ct.ComputeUnit.ALL)
names = ["input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype"]


def inputs(item):
    return {n: a.astype(np.int32) for n, a in zip(names, collate([item], fixed=True)[:5])}


model.predict(inputs(items[0]))
rows = []
times = []
changes = 0
errors = []
for start in range(0, len(items), 5):
    batch = items[start : start + 5]
    data = [inputs(item) for item in batch]
    t = time.perf_counter()
    outputs = [model.predict(d)["probabilities"][0] for d in data]
    times.append((time.perf_counter() - t) * 1000)
    for item, full in zip(batch, outputs):
        p = full[: len(item["keys"])].astype(float)
        p /= p.sum()
        if not np.isfinite(p).all():
            raise ValueError("Non-finite Core ML probabilities")
        old = np.array(baseline[(item["id"], item["question_key"])])
        changes += int(p.argmax() != old.argmax())
        errors.append(float(np.max(np.abs(p - old))))
        rows.append(
            {k: item[k] for k in ["id", "workflow", "question_key", "qtype", "keys", "target"]}
            | {"prediction": p.tolist()}
        )
    if (start // 5 + 1) % 50 == 0:
        print("Core ML", start // 5 + 1, "cases", flush=True)
report = {
    "model": "Laya MLX fine-tune, Core ML export",
    "cases": 400,
    "metrics": metrics(rows, "prediction"),
    "case_latency_ms": {
        "median": statistics.median(times),
        "p95": sorted(times)[int(0.95 * (len(times) - 1))],
    },
    "method": "Core ML ALL, float16, five sequential batch-1 calls per case; each padded to 768 tokens and eight option slots. Loading, warm-up, and input collation excluded.",
    "mlx_argmax_differences": changes,
    "max_probability_error": max(errors),
    "mean_max_probability_error": statistics.mean(errors),
    "rows": rows,
}
(CACHE / "coreml-results.json").write_text(json.dumps(report))
print(json.dumps({k: v for k, v in report.items() if k != "rows"}), flush=True)
