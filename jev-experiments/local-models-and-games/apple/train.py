"""Fine-tune only Laya's decision head in native MLX; reserve test until selection."""

import json, random, time, hashlib
from pathlib import Path
import numpy as np
import mlx.core as mx
import mlx.nn as nn
import mlx.optimizers as optim
from mlx_model import load, Head
from data import examples, collate
from prepare import CACHE, ROOT, MODEL, REV, DATA, DREV
from metrics import metrics

mx.random.seed(42)
rng = random.Random(42)
all_train = examples("train")
case_ids = sorted(set(x["id"] for x in all_train))
train_ids = set()
validation_ids = set()
for workflow in sorted(set(x["workflow"] for x in all_train)):
    ids = sorted({x["id"] for x in all_train if x["workflow"] == workflow})
    rng.shuffle(ids)
    train_ids.update(ids[:240])
    validation_ids.update(ids[240:])
train = [x for x in all_train if x["id"] in train_ids]
validation = [x for x in all_train if x["id"] in validation_ids]
assert len(train) == 4800 and len(validation) == 1200 and not (train_ids & validation_ids)
cfg = json.loads((CACHE / "base/encoder/config.json").read_text())
enc, head = load(CACHE / "base/model.safetensors", cfg)
base = Head({k: mx.array(v) for k, v in head.w.items()})
optimizer = optim.AdamW(learning_rate=3e-5, weight_decay=0.01)


def loss(h, x, pad, markers, valid, qt, target):
    logits = h(x, pad, markers, valid, qt)
    return -mx.mean(mx.sum(target * nn.log_softmax(logits, axis=-1), axis=-1))


grad = nn.value_and_grad(head, loss)
curve = []
start = time.perf_counter()
best = float("inf")
best_weights = None


def evaluate(items, current, temperature=1.0, with_base=False):
    out = []
    for offset in range(0, len(items), 8):
        batch = items[offset : offset + 8]
        arrays = [mx.array(x) for x in collate(batch)]
        h = enc(arrays[0], arrays[1])
        z = current(h, *arrays[1:5])
        p = mx.softmax(z / temperature, axis=-1)
        mx.eval(p)
        old = None
        if with_base:
            # Original published per-type calibration, explicitly not fitted on our test.
            temp = mx.array([1.636903, 1.251430, 1.983400])[arrays[4]][:, None]
            old = mx.softmax(base(h, *arrays[1:5]) / temp, axis=-1)
            mx.eval(old)
        for i, item in enumerate(batch):
            k = len(item["keys"])
            r = {key: value for key, value in item.items() if key not in ["ids", "markers"]}
            r["token_count"] = len(item["ids"])
            r["after"] = np.array(p[i, :k]).tolist()
            if with_base:
                r["before"] = np.array(old[i, :k]).tolist()
            out.append(r)
    return out


for epoch in range(2):
    rng.shuffle(train)
    for offset in range(0, len(train), 16):
        a = [mx.array(x) for x in collate(train[offset : offset + 16])]
        h = mx.stop_gradient(enc(a[0], a[1]))
        value, g = grad(head, h, *a[1:])
        g, _ = optim.clip_grad_norm(g, 1.0)
        optimizer.update(head, g)
        mx.eval(head.parameters(), optimizer.state, value)
        n = epoch * 300 + offset // 16 + 1
        if n % 25 == 0:
            row = {"step": n, "train_loss": float(value), "elapsed_s": time.perf_counter() - start}
            curve.append(row)
            print(json.dumps(row), flush=True)
        if n % 150 == 0:
            val = evaluate(validation, head)
            score = metrics(val, "after")["kl"]
            curve[-1]["validation_kl"] = score
            print("validation", n, score, flush=True)
            if score < best:
                best = score
                best_weights = {k: mx.array(v) for k, v in head.w.items()}
                mx.eval(best_weights)
                mx.save_safetensors(str(CACHE / "finetuned-head.safetensors"), best_weights)
head.w = best_weights
# Fit one temperature on validation only. Selection minimizes KL to the supplied soft teacher.
val = evaluate(validation, head)
temperatures = [0.7, 1.0, 1.3, 1.6, 2.0]
candidates = []
for temp in temperatures:
    scored = []
    for r in val:
        z = np.log(np.maximum(r["after"], 1e-12)) / temp
        p = np.exp(z - z.max())
        p /= p.sum()
        scored.append({**r, "calibrated": p.tolist()})
    candidates.append({"temperature": temp, **metrics(scored, "calibrated")})
temperature = min(candidates, key=lambda x: x["kl"])["temperature"]
# Test is evaluated once, after checkpoint and temperature selection.
test = examples("test")
assert not (set(x["id"] for x in test) & train_ids)
rows = evaluate(test, head, temperature, with_base=True)
report = {
    "model": MODEL,
    "revision": REV,
    "runtime": "MLX",
    "hardware": "Apple M4 Max, 48 GiB",
    "training": "Specialist fine-tune of the existing decision head; encoder frozen. Soft-target cross-entropy, two epochs, no sampled RL.",
    "dataset": DATA,
    "dataset_revision": DREV,
    "train_cases": 960,
    "validation_cases": 240,
    "test_cases": 400,
    "train_decisions": 4800,
    "steps": 600,
    "selected_validation_kl": best,
    "temperature": temperature,
    "calibration_candidates": candidates,
    "training_seconds": time.perf_counter() - start,
    "before": metrics(rows, "before"),
    "after": metrics(rows, "after"),
    "curve": curve,
    "rows": rows,
    "input_limit": 768,
    "truncated_questions": 0,
    "split_case_ids": {"train": sorted(train_ids), "validation": sorted(validation_ids)},
}
(CACHE / "training-result.json").write_text(json.dumps(report))
(ROOT / "local-models-and-games/apple/training-summary.json").write_text(
    json.dumps({k: v for k, v in report.items() if k not in ["rows", "split_case_ids"]}, indent=2)
    + "\n"
)
print(
    json.dumps(
        {
            "before": report["before"],
            "after": report["after"],
            "seconds": report["training_seconds"],
        }
    ),
    flush=True,
)
