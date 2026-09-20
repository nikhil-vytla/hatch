import json, time, gc, os, statistics
from pathlib import Path
import mlx.core as mx
from prepare import CACHE, ROOT
from prefill import PrefillDecision
from sequence import SequenceDecision
from metrics import metrics

models = json.loads((ROOT / "local-models-and-games/apple/open-models.json").read_text())
cases = json.loads((CACHE / "test.json").read_text())
models.append(
    {
        **models[0],
        "folder": models[0]["folder"] + "-sequence",
        "weights_folder": models[0]["folder"],
        "readout": "sequence",
    }
)
for spec in models:
    destination = CACHE / (spec["folder"] + "-results.json")
    if destination.exists():
        continue
    print("Loading", spec["model"], flush=True)
    reader = (SequenceDecision if spec.get("readout") == "sequence" else PrefillDecision)(
        CACHE / "open-models" / spec.get("weights_folder", spec["folder"])
    )
    first = cases[0]
    parity = reader.predict(json.loads(first["state"]), json.loads(first["questions"]), check=True)
    rows = []
    times = []
    saved = []
    mx.reset_peak_memory()
    start = time.perf_counter()
    for i, case in enumerate(cases):
        state = json.loads(case["state"])
        questions = json.loads(case["questions"])
        gold = json.loads(case["gold"])
        r = reader.predict(state, questions)
        times.append(r["latency_ms"])
        saved.append(r["reused_prefix_tokens"])
        for key, q in questions.items():
            a = r["answers"][key]
            target = [gold[key]["probabilities"][k] for k in a["keys"]]
            total = sum(target)
            target = [x / total for x in target]
            rows.append(
                {
                    "id": case["id"],
                    "workflow": case["workflow"],
                    "question_key": key,
                    "qtype": {"choice": 0, "score": 1, "noul": 2}[q["type"]],
                    "target": target,
                    "prediction": a["probabilities"],
                    "keys": a["keys"],
                }
            )
        if (i + 1) % 50 == 0:
            print(spec["folder"], i + 1, "cases", flush=True)
    result = {
        **spec,
        "method": (
            "Shared state and question caches, mean token log-likelihood of complete option text; sequential independent branches; untuned."
            if spec.get("readout") == "sequence"
            else "Shared prefix, first-token label readout; sequential independent cached branches; thinking disabled. Untuned general model."
        ),
        "cases": len(cases),
        "metrics": metrics(rows, "prediction"),
        "case_latency_ms": {
            "median": statistics.median(times),
            "p95": sorted(times)[int(0.95 * (len(times) - 1))],
        },
        "peak_mlx_gib": mx.get_peak_memory() / 2**30,
        "prefix_cache_parity": parity["parity_errors"],
        "reused_prefix_tokens": sum(saved),
        "wall_seconds": time.perf_counter() - start,
        "rows": rows,
    }
    destination.write_text(json.dumps(result))
    print(json.dumps({k: v for k, v in result.items() if k != "rows"}), flush=True)
    del reader
    gc.collect()
    mx.clear_cache()
