"""Check our J-lens fitter against a published lens: fit Qwen3.5-4B on N corpus docs and compare with
camilablank/workspace-lenses (cosine of each J_l, and top-10 neuron-token overlap on a sample of neurons).

  python analysis/validate_jfit.py [N]
"""
import json, sys
import torch
from atlas.model import NeuronModel
from atlas.jlens import fit_lens, load_lens, neuron_lens, _hub_texts

N = int(sys.argv[1]) if len(sys.argv) > 1 else 24
nm = NeuronModel("Qwen/Qwen3.5-4B")
ref = load_lens("camilablank/workspace-lenses:qwen3.5-4b/j-lens/lens.pt")
target = max(ref)
ours = fit_lens(nm, _hub_texts("nikhilxvytla/neuron-atlas:Qwen__Qwen3.5-4B", N), target=target, dim_batch=64)
out = {}
for L in sorted(ref):
    if L == target:
        continue
    a, b = ours[L].flatten(), ref[L].flatten()
    out[L] = dict(cos=float(torch.nn.functional.cosine_similarity(a, b, dim=0)))
for L in (8, 16, 24):
    ua, _ = neuron_lens(nm, {L: ours[L]}, layers=[L])[L]
    ub, _ = neuron_lens(nm, {L: ref[L]}, layers=[L])[L]
    inter = (ua[:, :, None] == ub[:, None, :]).any(2).sum(1).float()
    out[L]["top10_jaccard"] = float((inter / (20 - inter)).mean())
print(json.dumps(out, indent=1))
json.dump(out, open("validate_jfit.json", "w"), indent=1)
