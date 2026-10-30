"""Fit, load and apply a Jacobian lens (J-lens) to every MLP neuron's write direction.

J_l = E[d h_T / d h_l], where h_l is the residual stream output of decoder block l and T is a target block
(default n_layers - 2). Lens_L(w_n) = unembed(J_L w_n): J_L transports the layer-L down-projection column w_n into
a target-layer basis, then the final norm and unembedding read it as token logits. A lens without an entry for L
uses the identity (plain logit lens). Lenses are fitted locally or loaded from the Hugging Face Hub / local paths.

    python -m atlas.jlens --model Qwen/Qwen3.5-4B --lens j=REPO:PATH --out out/
    python -m atlas.jlens --model Qwen/Qwen3.5-4B --fit 200 --out out/
"""
import argparse, json, os, sys, time
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


def _encode(nm, text, max_len):
    ids = nm.tok(text, add_special_tokens=True, truncation=True, max_length=max_len)["input_ids"]
    if ids and isinstance(ids[0], list):
        ids = ids[0]
    return torch.as_tensor(ids, dtype=torch.long)


def _hub_texts(spec, n):
    """first n docs with >= 32 tokens from a dataset repo's '<slug>/tokens.parquet'."""
    from huggingface_hub import hf_hub_download
    repo, slug = spec.split(":", 1)
    path = hf_hub_download(repo, f"{slug}/tokens.parquet", repo_type="dataset")
    tab = pq.read_table(path, columns=["doc", "toks"]).sort_by("doc")
    out = []
    for toks in tab.column("toks").to_pylist():
        if len(toks) >= 32:
            out.append("".join(toks))
            if len(out) >= n:
                break
    return out


def fit_lens(nm: NeuronModel, texts, target=None, dim_batch=64, skip_first=16, max_len=128,
             log_every=10) -> dict[int, torch.Tensor]:
    """Estimate J_l = E[d h_T / d h_l] on `texts`; returns {0..target-1: (d_model, d_model)} + {target: identity}."""
    target = nm.n_layers - 2 if target is None else target
    if not 0 <= target < nm.n_layers:
        raise ValueError(f"target must be in 0..{nm.n_layers - 1}, got {target}")
    d = nm.d_model
    J = {l: torch.zeros(d, d, dtype=torch.float32) for l in range(target)}
    captured = {}
    handles = []

    def capture(l):
        def hook(mod, args, out):
            captured[l] = out[0] if isinstance(out, tuple) else out
        return hook

    for l in range(target + 1):
        mod = nm.layer_modules[l]
        if mod is None:
            raise ValueError(f"cannot locate decoder block {l}")
        handles.append(mod.register_forward_hook(capture(l)))

    emb = nm.model.get_input_embeddings()

    def req_grad(mod, args, out):
        t = out[0] if isinstance(out, tuple) else out
        t.requires_grad_(True)
        return out

    handles.append(emb.register_forward_hook(req_grad))
    nm.clear_steer()
    nm.model.requires_grad_(False)  # only activation gradients are needed; the embedding hook roots the graph
    old_cache = getattr(nm.model.config, "use_cache", None)
    nm.model.config.use_cache = False
    n, t0 = 0, time.time()
    try:
        with torch.enable_grad():
            for text in texts:
                ids = _encode(nm, text, max_len).to(nm.device)
                L = ids.numel()
                if L < skip_first + 2:
                    continue
                valid = torch.arange(skip_first, L - 1, device=nm.device)
                n += 1
                for start in range(0, d, dim_batch):
                    dims = list(range(start, min(start + dim_batch, d)))
                    b = len(dims)
                    captured.clear()
                    nm.model(input_ids=ids[None].repeat(b, 1), use_cache=False)
                    hT = captured[target]
                    for l in range(target):
                        captured[l].retain_grad()
                        captured[l].grad = None
                    cot = torch.zeros_like(hT)
                    cot[torch.arange(b, device=nm.device)[:, None], valid[None, :],
                        torch.tensor(dims, device=nm.device)[:, None]] = 1.0
                    torch.autograd.backward(hT, grad_tensors=cot)
                    for l in range(target):
                        J[l][dims] += captured[l].grad[:, valid, :].mean(1).float().cpu()
                captured.clear()
                if n % log_every == 0:
                    print(f"fit {n}/{len(texts)} prompts {time.time() - t0:.1f}s", flush=True)
    finally:
        for h in handles:
            h.remove()
        if old_cache is not None:
            nm.model.config.use_cache = old_cache
    if not n:
        raise ValueError("no prompts long enough to fit")
    J = {l: v / n for l, v in J.items()}
    J[target] = torch.eye(d, dtype=torch.float32)
    return J


def save_lens(J, path, n_prompts):
    d = next(iter(J.values())).shape[-1]
    parent = os.path.dirname(os.path.abspath(path))
    os.makedirs(parent, exist_ok=True)
    torch.save({"J": {l: J[l].detach().cpu().half() for l in J}, "n_prompts": int(n_prompts),
                "source_layers": sorted(J), "d_model": int(d)}, path)
    return path


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


def run(model, lenses, out, k=10, device=None, layers=None, chunk=512, nm=None):
    t0 = time.time()
    nm = nm or NeuronModel(model, device=device)
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


def _selftest():
    from types import SimpleNamespace
    from transformers import LlamaConfig, LlamaForCausalLM
    torch.manual_seed(0)
    cfg = LlamaConfig(hidden_size=64, intermediate_size=128, num_hidden_layers=2, num_attention_heads=4,
                      num_key_value_heads=4, vocab_size=300)
    model = LlamaForCausalLM(cfg).eval().requires_grad_(False)

    class Tok:
        def __call__(self, text, add_special_tokens=True, truncation=True, max_length=128):
            return {"input_ids": [1 + ord(c) % 299 for c in text][:max_length]}

    nm = SimpleNamespace(model=model, tok=Tok(), d_model=cfg.hidden_size, d_mlp=cfg.intermediate_size,
                         n_layers=cfg.num_hidden_layers, layer_modules=list(model.model.layers),
                         downs=[b.mlp.down_proj for b in model.model.layers], device="cpu",
                         clear_steer=lambda: None)
    text, target = "the quick brown fox jumps", 1
    J = fit_lens(nm, [text], target=target, skip_first=0, dim_batch=64)
    ids = _encode(nm, text, 128)
    valid = torch.arange(0, ids.numel() - 1)
    with torch.no_grad():
        h_src = model(ids[None], output_hidden_states=True).hidden_states[target]
    box = {}

    def cap(mod, args, out):
        box["h"] = out[0] if isinstance(out, tuple) else out

    def pre(mod, args, kwargs):
        x = box["x"]
        if args:
            return (x,) + tuple(args[1:]), kwargs
        return args, {**kwargs, "hidden_states": x}

    block = model.model.layers[target]
    hc = block.register_forward_hook(cap)
    hp = block.register_forward_pre_hook(pre, with_kwargs=True)

    def f(x):
        box["x"] = x[None]
        model(input_ids=ids[None], use_cache=False)
        return box["h"][0]

    try:
        jac = torch.autograd.functional.jacobian(f, h_src[0].detach())
    finally:
        hc.remove()
        hp.remove()
    brute = torch.stack([jac[valid, i][:, valid].sum(0).mean(0) for i in range(cfg.hidden_size)])
    ok = torch.allclose(J[target - 1], brute, atol=1e-4)
    print(f"selftest {'ok' if ok else 'FAIL'} max|diff|={(J[target - 1] - brute).abs().max():.2e}", flush=True)
    if not ok:
        raise SystemExit(1)


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        _selftest()
        raise SystemExit(0)
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--lens", action="append", default=[], metavar="NAME=SPEC")
    ap.add_argument("--fit", type=int, metavar="N", help="fit a J-lens on N docs from --corpus, then read neurons")
    ap.add_argument("--corpus", help="HUBREPO:SLUG (default nikhilxvytla/neuron-atlas:<model-slug>)")
    ap.add_argument("--target", type=int)
    ap.add_argument("--dim-batch", type=int, default=64)
    ap.add_argument("--out", default="out")
    ap.add_argument("--k", type=int, default=10)
    ap.add_argument("--device")
    ap.add_argument("--layers", type=int, nargs="*")
    ap.add_argument("--chunk", type=int, default=512)
    a = ap.parse_args()
    nm = None
    lenses = list(a.lens)
    if a.fit:
        slug = slugify(a.model)
        texts = _hub_texts(a.corpus or f"nikhilxvytla/neuron-atlas:{slug}", a.fit)
        if not texts:
            raise SystemExit("no corpus docs with >= 32 tokens")
        nm = NeuronModel(a.model, device=a.device)
        J = fit_lens(nm, texts, target=a.target, dim_batch=a.dim_batch)
        path = os.path.join(a.out, slug, "jlens", "fitted_j.pt")
        save_lens(J, path, len(texts))
        print(f"fitted {len(J)} lens layers on {len(texts)} prompts -> {path}", flush=True)
        lenses.append(f"j={path}")
    run(a.model, lenses, a.out, k=a.k, device=a.device, layers=a.layers, chunk=a.chunk, nm=nm)
