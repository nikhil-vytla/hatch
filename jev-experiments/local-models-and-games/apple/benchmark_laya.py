"""Warm, five-question case latency on the same test cases as causal models."""

import json, time, statistics
import mlx.core as mx
from prepare import CACHE, ROOT
from data import examples, collate
from mlx_model import load

items = examples("test")
training = json.loads((CACHE / "training-result.json").read_text())
enc, head = load(
    CACHE / "base/model.safetensors", json.loads((CACHE / "base/encoder/config.json").read_text())
)
head.w = mx.load(str(CACHE / "finetuned-head.safetensors"))


def predict(a):
    p = mx.softmax(head(enc(a[0], a[1]), *a[1:5]) / training["temperature"], axis=-1)
    mx.eval(p)


predict([mx.array(x) for x in collate(items[:5])])
times = []
mx.reset_peak_memory()
for i in range(0, len(items), 5):
    a = [mx.array(x) for x in collate(items[i : i + 5])]
    start = time.perf_counter()
    predict(a)
    times.append((time.perf_counter() - start) * 1000)
report = {
    "cases": len(times),
    "questions_per_case": 5,
    "case_latency_ms": {
        "median": statistics.median(times),
        "p95": sorted(times)[int(0.95 * (len(times) - 1))],
    },
    "peak_mlx_gib": mx.get_peak_memory() / 2**30,
    "method": "Batch of five full state/question rows, dynamic padding; float32. Model loading and first warm-up excluded. Head weights are the selected fine-tune.",
}
(ROOT / "local-models-and-games/apple/laya-timing.json").write_text(
    json.dumps(report, indent=2) + "\n"
)
print(json.dumps(report))
