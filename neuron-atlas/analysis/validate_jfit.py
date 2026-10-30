"""Check our J-lens fitter against a published lens: compare a fitted Qwen3.5-4B lens with
camilablank/workspace-lenses (cosine of each J_l, and top-10 neuron-token overlap per layer).

  python analysis/validate_jfit.py [N]            fit on N corpus docs, then compare
  python analysis/validate_jfit.py --ours FILE    compare a lens already fitted (atlas.jlens --fit)
"""
import json, sys
import torch
from atlas.model import NeuronModel
from atlas.jlens import fit_lens, load_lens, neuron_lens, _hub_texts

nm = NeuronModel("Qwen/Qwen3.5-4B")
ref = load_lens("camilablank/workspace-lenses:qwen3.5-4b/j-lens/lens.pt")
target = max(ref)
if "--ours" in sys.argv:
    ours, n = load_lens(sys.argv[sys.argv.index("--ours") + 1]), "fitted file"
else:
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 24
    ours = fit_lens(nm, _hub_texts("nikhilxvytla/neuron-atlas:Qwen__Qwen3.5-4B", n), target=target, dim_batch=64)
out = {}
for L in sorted(ref):
    if L == target:
        continue
    out[L] = dict(cos=float(torch.nn.functional.cosine_similarity(ours[L].flatten(), ref[L].flatten(), dim=0)))
    if L % 4 == 0:
        ua, _ = neuron_lens(nm, {L: ours[L]}, layers=[L])[L]
        ub, _ = neuron_lens(nm, {L: ref[L]}, layers=[L])[L]
        inter = (ua[:, :, None] == ub[:, None, :]).any(2).sum(1).float()
        out[L]["top10_jaccard"] = float((inter / (20 - inter)).mean())
print(json.dumps(out, indent=1))
json.dump(dict(source=n, layers=out), open("validate_jfit.json", "w"), indent=1)
