import sys, json, time
from pathlib import Path
import numpy as np
import mlx.core as mx
import torch
from safetensors.torch import load_file
from prepare import CACHE, ROOT
from data import examples, collate
from mlx_model import load

sys.path.insert(0, str(ROOT / ".cache/laya-research"))
from laya.common import build_model

cfg = json.loads((CACHE / "base/rl_agent_config.json").read_text())
ecfg = json.loads((CACHE / "base/encoder/config.json").read_text())
enc, head = load(CACHE / "base/model.safetensors", ecfg)
items = examples("train")
print("packed", len(items), "max tokens", max(len(x["ids"]) for x in items), flush=True)
model = build_model(cfg, encoder_dir=str(CACHE / "base/encoder")).eval()
model.load_state_dict(load_file(CACHE / "base/model.safetensors"))
model.encoder.config.reference_compile = False
model.encoder.set_attn_implementation("eager")
torch.set_num_threads(4)
checks = []
for indices in [[0], [1, 2], [1500, 3000, 4500]]:
    a = collate([items[i] for i in indices])
    start = time.perf_counter()
    with torch.no_grad():
        expected = model(*[torch.from_numpy(x) for x in a[:5]])[0].numpy()
    h = enc(mx.array(a[0]), mx.array(a[1]))
    actual = head(h, *[mx.array(x) for x in a[1:5]])
    mx.eval(actual)
    error = float(np.max(np.abs(np.array(actual) - expected)))
    checks.append(
        {
            "indices": indices,
            "max_abs_logit_error": error,
            "same_argmax": bool(np.array_equal(np.argmax(actual, axis=-1), expected.argmax(-1))),
            "seconds": time.perf_counter() - start,
        }
    )
    print(checks[-1], flush=True)
report = {
    "checks": checks,
    "tolerance": 0.005,
    "passed": all(c["max_abs_logit_error"] < 0.005 and c["same_argmax"] for c in checks),
}
(ROOT / "local-models-and-games/apple/port-parity.json").write_text(
    json.dumps(report, indent=2) + "\n"
)
if not report["passed"]:
    raise SystemExit(1)
