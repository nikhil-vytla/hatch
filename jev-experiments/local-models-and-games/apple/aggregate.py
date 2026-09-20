"""Join predictions by original case/question IDs; publish compact full evidence."""

import json, statistics, platform
from collections import defaultdict
from datetime import datetime, timezone
from prepare import ROOT, CACHE, DATA, DREV, MODEL, REV
from metrics import metrics

training = json.loads((CACHE / "training-result.json").read_text())
rows = training["rows"]
specs = json.loads((ROOT / "local-models-and-games/apple/open-models.json").read_text())
models = []
predictions = {}
workflows = sorted(set(r["workflow"] for r in rows))


def add(mid, name, kind, rs, key, **other):
    assert len(rs) == 2000, (mid, len(rs))
    mapped = {(r["id"], r["question_key"]): r for r in rs}
    assert len(mapped) == 2000
    predictions[mid] = {}
    for r in rows:
        x = mapped[(r["id"], r["question_key"])]
        assert x["keys"] == r["keys"], (mid, r["id"])
        p = x[key]
        assert (
            len(p) == len(r["target"])
            and all(0 <= n <= 1.00001 for n in p)
            and abs(sum(p) - 1) < 0.01
        )
        predictions[mid][(r["id"], r["question_key"])] = p
    models.append(
        {
            "id": mid,
            "name": name,
            "kind": kind,
            "metrics": metrics(rs, key),
            "by_workflow": {
                w: metrics([r for r in rs if r["workflow"] == w], key) for w in workflows
            },
            **other,
        }
    )


add(
    "laya-base",
    "Laya · original",
    "Untuned encoder + decision head",
    rows,
    "before",
    url="https://huggingface.co/" + MODEL,
    revision=REV,
    method="Published English root checkpoint, published per-type temperatures, our full-text 768-token packing. No adaptation on Typed Decisions.",
)
timing = json.loads((ROOT / "local-models-and-games/apple/laya-timing.json").read_text())
add(
    "laya-tuned",
    "Laya · MLX fine-tune",
    "Specialist head, frozen encoder",
    rows,
    "after",
    url="https://huggingface.co/" + MODEL,
    revision=REV,
    method=training["training"],
    **{k: timing[k] for k in ["case_latency_ms", "peak_mlx_gib"]},
)
cm_full = json.loads((CACHE / "coreml-results.json").read_text())
add(
    "laya-coreml",
    "Laya · Core ML export",
    "Same trained head, float16 inference",
    cm_full["rows"],
    "prediction",
    url="https://apple.github.io/coremltools/",
    method=cm_full["method"],
    case_latency_ms=cm_full["case_latency_ms"],
)
for s in specs + [{**specs[0], "folder": specs[0]["folder"] + "-sequence", "readout": "sequence"}]:
    d = json.loads((CACHE / (s["folder"] + "-results.json")).read_text())
    mid = s["folder"]
    name = s["model"].split("/")[-1].replace("-4bit", "") + (
        " · option text" if s.get("readout") == "sequence" else " · labels"
    )
    add(
        mid,
        name,
        "Untuned language model",
        d["rows"],
        "prediction",
        url="https://huggingface.co/" + s["model"],
        revision=s["revision"],
        method=d["method"]
        + " Floating activations and scales use float32; quantized weights stay packed.",
        case_latency_ms=d["case_latency_ms"],
        peak_mlx_gib=d["peak_mlx_gib"],
        prefix_cache_parity=d["prefix_cache_parity"],
    )
jev = []
batchlat = []
for r in rows:
    record = json.loads((CACHE / "jev" / f"{r['id']}.json").read_text())
    a = record["answers"][r["question_key"]]
    p = (
        [1 - a["value"], a["value"]]
        if r["qtype"] == 2
        else [a["probabilities"][k] for k in r["keys"]]
    )
    total = sum(p)
    p = [v / total for v in p]
    jev.append({**r, "prediction": p})
    batchlat.append(record["latency_ms"])
add(
    "jev",
    "Jev · AI Gateway",
    "Hosted general decision model",
    jev,
    "prediction",
    url="https://vercel.com/ai-gateway/models/jev",
    method="Live typesafe-ai/jev. Each question includes its own complete state. Network batches initially contained eight cases, then four after transient overload. Optional boolean criteria are written into the instruction.",
)
# Class-frequency baseline uses only the 960 training cases, with soft labels.
priors = defaultdict(list)
ids = set(training["split_case_ids"]["train"])
for c in json.loads((CACHE / "train.json").read_text()):
    if c["id"] not in ids:
        continue
    for k, a in json.loads(c["gold"]).items():
        priors[(c["workflow"], k)].append(a["probabilities"])
uniform = []
prior = []
for r in rows:
    u = [1 / len(r["keys"])] * len(r["keys"])
    pool = priors[(r["workflow"], r["question_key"])]
    p = [sum(a[k] for a in pool) / len(pool) for k in r["keys"]]
    total = sum(p)
    p = [v / total for v in p]
    uniform.append({**r, "prediction": u})
    prior.append({**r, "prediction": p})
add("uniform", "Uniform options", "Code baseline; ties use first option", uniform, "prediction")
add(
    "train-prior",
    "Training label prior",
    "Code baseline per workflow and question",
    prior,
    "prediction",
)
cases = {}
for r in rows:
    c = cases.setdefault(
        r["id"], {"id": r["id"], "workflow": r["workflow"], "state": r["state"], "questions": []}
    )
    q = r["question"]
    crit = q.get("criteria", {})
    if q["type"] == "choice":
        options = [crit[k] for k in r["keys"]]
    elif q["type"] == "score":
        options = crit
    else:
        options = [
            crit.get("false", "No, the statement does not hold."),
            crit.get("true", "Yes, the statement holds."),
        ]
    c["questions"].append(
        {
            "key": r["question_key"],
            "type": q["type"],
            "instructions": q["instructions"],
            "keys": r["keys"],
            "options": options,
            "target": r["target"],
            "predictions": {
                mid: ps[(r["id"], r["question_key"])] for mid, ps in predictions.items()
            },
            "laya_tokens": r["token_count"],
        }
    )
assert len(cases) == 400 and all(len(c["questions"]) == 5 for c in cases.values())
coreml = json.loads((ROOT / "local-models-and-games/apple/coreml-verification.json").read_text())
coreml["full_test"] = {k: v for k, v in cm_full.items() if k != "rows"}
provenance = {
    "name": "Typed Decisions",
    "url": "https://huggingface.co/datasets/" + DATA,
    "revision": DREV,
    "organization": "LocalLLaMA",
    "split": "test",
    "license": "Apache-2.0",
    "sampling": "All 400 test cases, five questions each, four equally sized workflows. Synthetic teacher probability targets; no independent human ground truth. Full text is included below.",
}
record = {
    "manifest": {"created": datetime.now(timezone.utc).isoformat(), "experiment": "local-models"},
    "result": {
        "provenance": provenance,
        "dataset": provenance,
        "hardware": "Apple M4 Max, 48 GiB RAM",
        "workflows": workflows,
        "models": models,
        "training": {k: v for k, v in training.items() if k not in ["rows", "split_case_ids"]},
        "coreml": coreml,
        "cases": sorted(cases.values(), key=lambda c: c["id"]),
        "timing_note": f"Local measurements ran sequentially after training completed, without concurrent local model inference. Models load before timing. First-token tokenization and Laya input collation are outside the timed region; full-option scoring includes question/option branch tokenization. MLX first-token and option-text paths use packed 4-bit weights where supplied, with float32 activations/scales to pass cache parity. Laya uses float32. Hosted response latency, weighted by cases in each batch and including retries, ranged from {min(batchlat):.0f} to {max(batchlat):.0f} ms for batches of 20–40 questions; not comparable to local five-question case latency. Jev costs returned by the gateway were recorded per batch; this page makes no per-case price claim.",
    },
}
(CACHE / "publication.json").write_text(json.dumps(record, ensure_ascii=False))
print(
    json.dumps(
        [
            {"model": m["name"], "accuracy": m["metrics"]["accuracy"], "kl": m["metrics"]["kl"]}
            for m in models
        ],
        indent=2,
    )
)
