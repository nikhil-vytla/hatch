"""Read every MLP neuron's write direction through a fitted Jacobian lens (J-lens) or LRP-style lens (R-lens).

Lens_L(w_n) = unembed(J_L w_n): J_L transports the layer-L down-projection column w_n into a target-layer basis,
then the final norm and unembedding read it as token logits. A lens without an entry for L uses the identity
(plain logit lens). Lenses are pre-fitted tensors from the Hugging Face Hub or local paths.

    python -m atlas.jlens --model Qwen/Qwen3.5-4B --lens j=REPO:PATH --out out/
"""
import argparse, json, os, time
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import torch

from .collect import slugify
from .model import NeuronModel


def load_lens(spec):
    """'REPO:PATH' from the Hub or a local .pt path -> {source_layer: J (d_model, d_model) float32}."""
    if os.path.exists(spec):
        path = spec
    else:
        from huggingface_hub import hf_hub_download
        repo, filename = spec.split(":", 1)
        path = hf_hub_download(repo, filename)
    obj = torch.load(path, map_location="cpu", weights_only=True)  # tensors and plain containers only: no pickled code
    J = obj["J"] if isinstance(obj, dict) and "J" in obj else obj
    return {int(k): v.float() for k, v in J.items()}


def _jaccard(a, b):
    inter = (a[:, :, None] == b[:, None, :]).any(2).sum(1)
    return float((inter / (a.shape[1] + b.shape[1] - inter)).mean())


@torch.no_grad()
def neuron_lens(nm: NeuronModel, J, k=10, chunk=512, layers=None):
    """dict[layer -> (up_ids, down_ids)] of (d_mlp, k) LongTensors read out through J (or the logit lens if None)."""
    W_U, gamma = nm.unembed()
    W_U = W_U.float()
    if gamma is not None:
        gamma = gamma.float()
    out = {}
    for L in range(nm.n_layers) if layers is None else layers:
        cols = nm.down_cols(L)
        if J is not None and L in J:
            cols = cols @ J[L].to(cols).T
        if gamma is not None:
            cols = cols * gamma.to(cols.device)
        tu, td = [], []
        for s in range(0, cols.shape[0], chunk):
            lg = cols[s:s + chunk] @ W_U.T
            lg = lg - lg.mean(1, keepdim=True)
            tu.append(lg.topk(k, dim=1).indices.cpu())
            td.append(lg.topk(k, dim=1, largest=False).indices.cpu())
        out[L] = (torch.cat(tu), torch.cat(td))
    return out


def run(model, lenses, out, k=10, device=None, layers=None, chunk=512):
    t0 = time.time()
    nm = NeuronModel(model, device=device)
    specs = {"logit": None}
    for s in lenses:
        name, spec = s.split("=", 1)
        specs[name] = load_lens(spec)
    names = list(specs)
    ls = list(range(nm.n_layers)) if layers is None else list(layers)
    slug = slugify(model)
    od = os.path.join(out, slug, "jlens")
    os.makedirs(od, exist_ok=True)

    agreement = {}
    for L in ls:
        lt = time.time()
        up = {name: neuron_lens(nm, specs[name], k=k, chunk=chunk, layers=[L])[L] for name in names}
        a = {name: _jaccard(up["logit"][0], up[name][0]) for name in names}
        agreement[str(L)] = a
        tbl = pa.table({"neuron": pa.array(np.arange(nm.d_mlp, dtype=np.int32))})
        for name in names:
            u, d = up[name]
            tbl = tbl.append_column(f"{name}_up", pa.array([nm.token_strings(r) for r in u.tolist()],
                                                           type=pa.list_(pa.string())))
            tbl = tbl.append_column(f"{name}_down", pa.array([nm.token_strings(r) for r in d.tolist()],
                                                             type=pa.list_(pa.string())))
        pq.write_table(tbl, os.path.join(od, f"L{L:02d}.parquet"), compression="zstd")
        print(f"L{L:02d} " + " ".join(f"{name} {a[name]:.2f}" for name in names) + f"  {time.time() - lt:.1f}s",
              flush=True)

    with open(os.path.join(od, "agreement.json"), "w") as f:
        json.dump(agreement, f, indent=1)
    print(f"wrote {od} in {time.time() - t0:.0f}s")
    return od


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--lens", action="append", default=[], metavar="NAME=SPEC")
    ap.add_argument("--out", default="out")
    ap.add_argument("--k", type=int, default=10)
    ap.add_argument("--device")
    ap.add_argument("--layers", type=int, nargs="*")
    ap.add_argument("--chunk", type=int, default=512)
    a = ap.parse_args()
    run(a.model, a.lens, a.out, k=a.k, device=a.device, layers=a.layers, chunk=a.chunk)
