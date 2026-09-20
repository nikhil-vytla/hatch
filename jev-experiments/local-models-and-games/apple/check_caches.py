"""Compare fresh/cached paths and reverse question order across every workflow."""

import copy, json, gc
import numpy as np
import mlx.core as mx
from prefill import PrefillDecision
from sequence import SequenceDecision
from prepare import ROOT, CACHE

specs = json.loads((ROOT / "local-models-and-games/apple/open-models.json").read_text())
cases = json.loads((CACHE / "test.json").read_text())
checks = []
for s in specs + [{**specs[0], "readout": "sequence"}]:
    reader = (SequenceDecision if s.get("readout") == "sequence" else PrefillDecision)(
        CACHE / "open-models" / s["folder"]
    )
    for idx in [0, 100, 200, 300]:
        c = cases[idx]
        state = json.loads(c["state"])
        qs = json.loads(c["questions"])
        original = copy.deepcopy(qs)
        normal = reader.predict(state, qs, check=True)
        reverse = reader.predict(state, dict(reversed(list(qs.items()))))
        difference = max(
            float(
                np.max(
                    np.abs(np.array(a["probabilities"]) - reverse["answers"][k]["probabilities"])
                )
            )
            for k, a in normal["answers"].items()
        )
        if difference > 1e-5:
            raise ValueError(f"Question ordering leaked between caches: {difference}")
        assert qs == original, "Input questions mutated"
        checks.append(
            {
                "model": s["model"],
                "method": s.get("readout", "labels"),
                "case": c["id"],
                "max_cache_readout_error": max(normal["parity_errors"]),
                "max_question_order_probability_error": difference,
            }
        )
    del reader
    gc.collect()
    mx.clear_cache()
report = {
    "passed": True,
    "checks": checks,
    "note": "Readout error is in raw label logits for first-token methods and mean token log likelihood for full-option scoring. Question-order errors are probability differences. Float32 activations; packed quantized weights unchanged.",
}
(ROOT / "local-models-and-games/apple/cache-verification.json").write_text(
    json.dumps(report, indent=2) + "\n"
)
print(json.dumps(report))
