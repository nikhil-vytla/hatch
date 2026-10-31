"""Fit, load and apply a Jacobian lens (J-lens) to every MLP neuron's write direction.

J_l = E[d h_T / d h_l], where h_l is the residual stream output of decoder block l and T is a target block
(default n_layers - 2). Lens_L(w_n) = unembed(J_L w_n): J_L transports the layer-L down-projection column w_n into
a target-layer basis, then the final norm and unembedding read it as token logits. A lens without an entry for L
uses the identity (plain logit lens). Lenses are fitted locally or loaded from the Hugging Face Hub / local paths.

The R-lens fits the same matrix with LRP rules in the backward pass (detach the residual-norm factor, linearise the
MLP activation, and split relevance between gate and up); forward values are unchanged. Use --rules j or --rules r.

    python -m atlas.jlens --model Qwen/Qwen3.5-4B --lens j=REPO:PATH --out out/
    python -m atlas.jlens --model Qwen/Qwen3.5-4B --fit 200 --out out/
"""
import argparse, contextlib, json, os, sys, time
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


_NORM_NAMES = {"input_layernorm", "post_attention_layernorm", "pre_feedforward_layernorm",
               "post_feedforward_layernorm", "ln_1", "ln_2", "ln_f", "norm", "final_layernorm"}


def _norm_eps(mod):
    for attr in ("variance_epsilon", "eps"):
        value = getattr(mod, attr, None)
        if value is not None:
            return float(value)
    return 1e-6


def _norm_kind(mod):
    cls = type(mod).__name__.lower()
    if "rms" in cls or hasattr(mod, "variance_epsilon"):
        return "rms"
    if "layernorm" in cls or "layer_norm" in cls or getattr(mod, "bias", None) is not None:
        return "ln"
    return "rms"


def _rms_scale(mod, orig_forward, eps):
    """The per-channel scale convention (w for Llama/Qwen2, 1 + w for Gemma/Qwen3.5), read from the module itself."""
    w = getattr(mod, "weight", None)
    if w is None:
        return None
    try:
        probe = torch.ones((1, w.shape[0]), dtype=w.dtype, device=w.device)
        with torch.no_grad():
            out = orig_forward(probe)
        out = out[0] if isinstance(out, tuple) else out
        denom = torch.rsqrt(torch.tensor(1.0 + eps, dtype=torch.float32, device=out.device))
        scale = out.float().reshape(-1) / denom
        if scale.numel() == w.numel() and bool(torch.isfinite(scale).all()):
            return scale
    except Exception:
        pass
    cls = type(mod).__name__.lower()
    offset = 1.0 if ("gemma" in cls or "qwen3_5" in cls) else 0.0
    return w.float() + offset


def _identity_act(act, z):
    """act(z) as z * stop_grad(act(z) / z), so relevance flows through the nonlinearity linearly."""
    a = act(z)
    safe = z.abs() > 1e-6
    ratio = a / torch.where(safe, z, torch.ones_like(z))
    ratio = torch.where(safe, ratio, torch.full_like(ratio, 0.5))
    return z * ratio.detach()


def _gated_mlp_forward(mod, x):
    a = _identity_act(mod.act_fn, mod.gate_proj(x))
    u = mod.up_proj(x)
    h = 0.5 * (a * u.detach()) + 0.5 * (a.detach() * u)
    h = mod.down_proj(h)
    dropout = getattr(mod, "dropout", None)
    return dropout(h) if dropout is not None else h


def _gpt2_mlp_forward(mod, x):
    h = _identity_act(mod.act, mod.c_fc(x))
    h = mod.c_proj(h)
    dropout = getattr(mod, "dropout", None)
    return dropout(h) if dropout is not None else h


def _mlp_wrapper(fn):
    def forward(self, *args, **kwargs):
        x = args[0] if args else kwargs.get("hidden_states")
        return fn(self, x)
    return forward


def _norm_forward(mod, kind, scale):
    eps = _norm_eps(mod)

    if kind == "rms":
        def forward(self, *args, **kwargs):
            x = args[0] if args else kwargs.get("hidden_states")
            xf = x.float()
            rstd = torch.rsqrt(xf.pow(2).mean(-1, keepdim=True) + eps)
            y = (xf * rstd.detach()).to(x.dtype)
            if scale is not None:
                y = y * scale.to(device=y.device, dtype=y.dtype)
            return y
    else:
        w, b = getattr(mod, "weight", None), getattr(mod, "bias", None)

        def forward(self, *args, **kwargs):
            x = args[0] if args else kwargs.get("hidden_states")
            xf = x.float()
            mean = xf.mean(-1, keepdim=True)
            rstd = torch.rsqrt((xf - mean).pow(2).mean(-1, keepdim=True) + eps)
            y = ((xf - mean) * rstd.detach()).to(x.dtype)
            if w is not None:
                y = y * w.to(device=y.device, dtype=y.dtype)
            if b is not None:
                y = y + b.to(device=y.device, dtype=y.dtype)
            return y
    return forward


class _RestoreForwards:
    def __init__(self, installed):
        self.installed = installed

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        for mod, had_forward, prior in self.installed:
            if had_forward:
                mod.forward = prior
            else:
                mod.__dict__.pop("forward", None)
        return False


def lrp_rules(nm):
    """Context manager installing LRP forward-equivalent rules on residual norms and MLP nonlinearities."""
    from types import MethodType
    mods = list(nm.model.named_modules())
    installed, seen = [], set()

    def install(mod, forward):
        if id(mod) in seen:
            return
        seen.add(id(mod))
        had_forward = "forward" in mod.__dict__
        prior = mod.__dict__.get("forward")
        mod.forward = MethodType(forward, mod)
        installed.append((mod, had_forward, prior))

    for _, mod in mods:
        if all(hasattr(mod, a) for a in ("gate_proj", "up_proj", "down_proj", "act_fn")):
            install(mod, _mlp_wrapper(_gated_mlp_forward))
        elif all(hasattr(mod, a) for a in ("c_fc", "c_proj", "act")):
            install(mod, _mlp_wrapper(_gpt2_mlp_forward))
    for name, mod in mods:
        leaf = name.rsplit(".", 1)[-1]
        if leaf not in _NORM_NAMES or leaf in ("q_norm", "k_norm") or "Norm" not in type(mod).__name__:
            continue
        # a bare "norm" is a residual norm only at the top (the final norm); inside a block it can be e.g. Qwen3.5's
        # gated linear-attention norm, whose forward takes a gate this rule would drop
        if leaf == "norm" and (".layers." in f".{name}" or "attn" in name or "Gated" in type(mod).__name__):
            continue
        kind = _norm_kind(mod)
        scale = _rms_scale(mod, mod.forward, _norm_eps(mod)) if kind == "rms" else None
        install(mod, _norm_forward(mod, kind, scale))
    return _RestoreForwards(installed)


def fit_lens(nm: NeuronModel, texts, target=None, dim_batch=64, skip_first=16, max_len=128,
             log_every=10, rules="j", checkpoint=None, upload=None, every=16) -> dict[int, torch.Tensor]:
    """Estimate J_l = E[d h_T / d h_l] on `texts`; returns {0..target-1: (d_model, d_model)} + {target: identity}."""
    if rules not in ("j", "r"):
        raise ValueError(f"rules must be 'j' or 'r', got {rules!r}")
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
        if rules == "r":  # the rules must not change what the model computes: check once on a real prompt
            probe = _encode(nm, texts[0], max_len).to(nm.device)[None]
            with torch.no_grad():
                plain = nm.model(input_ids=probe, use_cache=False).logits.float()
                with lrp_rules(nm):
                    ruled = nm.model(input_ids=probe, use_cache=False).logits.float()
            gap = float((plain - ruled).abs().max() / (plain.abs().max() + 1e-6))
            print(f"lrp rules: max relative logit change {gap:.2e}", flush=True)
            if gap > 2e-2:
                raise RuntimeError(f"LRP rules changed the forward pass (relative gap {gap:.2e}); not fitting")
        with torch.enable_grad(), (lrp_rules(nm) if rules == "r" else contextlib.nullcontext()):
            done = 0  # sandboxes die: keep running sums in `checkpoint` (and on the Hub via `upload`) and resume
            if checkpoint and os.path.exists(checkpoint):
                ck = torch.load(checkpoint, map_location="cpu", weights_only=True)
                J, n, done = {int(k): v for k, v in ck["sum"].items()}, int(ck["n"]), int(ck["done"])
                print(f"resuming from {checkpoint}: {n} prompts", flush=True)
            for i, text in enumerate(texts):
                if i < done:
                    continue
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
                if checkpoint and n % every == 0:
                    tmp = checkpoint + ".tmp"
                    torch.save({"sum": J, "n": n, "done": i + 1}, tmp)
                    os.replace(tmp, checkpoint)
                    if upload:
                        try:
                            from huggingface_hub import HfApi
                            repo, path = upload.split(":", 1)
                            HfApi().upload_file(path_or_fileobj=checkpoint, path_in_repo=path, repo_id=repo, repo_type="dataset")
                        except Exception as e:
                            print("checkpoint upload failed:", str(e)[:120], flush=True)
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


def says_index(jdir, out_dir, lens="j", per_word=40, min_layer=6):
    """Word -> neurons index from jlens/Lxx.parquet: for each lowercase alphabetic word (3+ letters) in a neuron's
    top-10 up/down tokens, keep the per_word best (rank, then later layer). One file per first letter, so a browser
    fetches only the shard it needs: out_dir/<letter>.parquet with word, layer, neuron, sign, rank."""
    import glob, re
    from collections import defaultdict
    word_re = re.compile(r"^[a-z]{3,}$")
    hits = defaultdict(list)
    for f in sorted(glob.glob(os.path.join(jdir, "L*.parquet"))):
        L = int(os.path.basename(f)[1:3])
        if L < min_layer:
            continue
        t = pq.read_table(f, columns=["neuron", f"{lens}_up", f"{lens}_down"]).to_pydict()
        for sign, col in ((1, f"{lens}_up"), (-1, f"{lens}_down")):
            for n, toks in zip(t["neuron"], t[col]):
                for rank, tok in enumerate(toks):
                    w = tok.strip().lower()
                    if word_re.match(w):
                        hits[w].append((rank, -L, n, sign))
    shards = defaultdict(list)
    for w, hs in hits.items():
        hs.sort()
        seen = set()  # " ocean", "Ocean" and "ocean" can all be in one neuron's list: keep its best rank once
        hs = [h for h in hs if (h[1], h[2], h[3]) not in seen and not seen.add((h[1], h[2], h[3]))]
        for rank, negL, n, sign in hs[:per_word]:
            shards[w[0]].append((w, -negL, n, sign, rank))
    os.makedirs(out_dir, exist_ok=True)
    for letter, rows in shards.items():
        rows.sort()
        cols = list(zip(*rows))
        pq.write_table(pa.table({"word": pa.array(cols[0]), "layer": pa.array(cols[1], pa.int16()),
                                 "neuron": pa.array(cols[2], pa.int32()), "sign": pa.array(cols[3], pa.int8()),
                                 "rank": pa.array(cols[4], pa.int8())}),
                       os.path.join(out_dir, f"{letter}.parquet"), compression="zstd")
    print(f"says index: {len(hits)} words, {sum(len(v) for v in shards.values())} rows, {len(shards)} shards")


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


def _selftest_r():
    from types import SimpleNamespace
    from transformers import (GPT2Config, GPT2LMHeadModel, LlamaConfig, LlamaForCausalLM,
                              Qwen2Config, Qwen2ForCausalLM)

    class Tok:
        def __call__(self, text, add_special_tokens=True, truncation=True, max_length=128):
            return {"input_ids": [1 + ord(c) % 299 for c in text][:max_length]}

    cases = [
        ("llama", LlamaConfig(hidden_size=32, intermediate_size=64, num_hidden_layers=2,
                              num_attention_heads=4, num_key_value_heads=4, vocab_size=300), LlamaForCausalLM),
        ("qwen2", Qwen2Config(hidden_size=32, intermediate_size=64, num_hidden_layers=2,
                             num_attention_heads=4, num_key_value_heads=4, vocab_size=300), Qwen2ForCausalLM),
        ("gpt2", GPT2Config(n_embd=32, n_inner=64, n_layer=2, n_head=4, n_positions=32, n_ctx=32,
                            vocab_size=300, bos_token_id=0, eos_token_id=0), GPT2LMHeadModel),
    ]
    text, target = "the quick brown fox jumps over", 1
    print("selftest r:", flush=True)
    for seed, (name, cfg, cls) in enumerate(cases):
        torch.manual_seed(seed)
        model = cls(cfg).eval().requires_grad_(False)
        if hasattr(model, "transformer"):
            layers = list(model.transformer.h)
            downs = [b.mlp.c_proj for b in layers]
            d_model, d_mlp = cfg.n_embd, cfg.n_inner
        else:
            layers = list(model.model.layers)
            downs = [b.mlp.down_proj for b in layers]
            d_model, d_mlp = cfg.hidden_size, cfg.intermediate_size
        nm = SimpleNamespace(model=model, tok=Tok(), d_model=d_model, d_mlp=d_mlp, n_layers=len(layers),
                             layer_modules=layers, downs=downs, device="cpu", clear_steer=lambda: None)
        ids = _encode(nm, text, 128)
        with torch.no_grad():
            base = model(input_ids=ids[None], use_cache=False).logits.clone()
            before = {id(m): ("forward" in m.__dict__, m.__dict__.get("forward"))
                      for _, m in model.named_modules()}
            with lrp_rules(nm):
                ruled = model(input_ids=ids[None], use_cache=False).logits
        after = {id(m): ("forward" in m.__dict__, m.__dict__.get("forward"))
                 for _, m in model.named_modules()}
        with torch.no_grad():
            again = model(input_ids=ids[None], use_cache=False).logits
        values_ok = torch.allclose(base, ruled, atol=1e-5)
        restore_ok = before == after and torch.allclose(base, again, atol=1e-5)
        J = fit_lens(nm, [text], target=target, skip_first=0, dim_batch=32, rules="j")
        R = fit_lens(nm, [text], target=target, skip_first=0, dim_batch=32, rules="r")
        differs = not torch.allclose(J[target - 1], R[target - 1])
        ok = values_ok and restore_ok and differs
        print(f"  {name}: values={values_ok} differs={differs} restore={restore_ok} "
              f"max|R-J|={(R[target - 1] - J[target - 1]).abs().max():.2e} {'ok' if ok else 'FAIL'}",
              flush=True)
        if not ok:
            raise SystemExit(1)
    print(f"selftest r ok on {len(cases)} models", flush=True)


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        _selftest()
        _selftest_r()
        raise SystemExit(0)
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--lens", action="append", default=[], metavar="NAME=SPEC")
    ap.add_argument("--fit", type=int, metavar="N", help="fit a J-lens on N docs from --corpus, then read neurons")
    ap.add_argument("--corpus", help="HUBREPO:SLUG (default nikhilxvytla/neuron-atlas:<model-slug>)")
    ap.add_argument("--target", type=int)
    ap.add_argument("--rules", choices=("j", "r"), default="j")
    ap.add_argument("--checkpoint-repo", metavar="HF_DATASET", help="save partial sums there every 16 docs and resume")
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
        ckpt = up = None
        if a.checkpoint_repo:  # resume a fit a lost sandbox left behind, and keep saving partial sums there
            tag = f"{a.out.strip('/').replace('/', '_')}_{a.rules}_{a.fit}"
            ckpt = os.path.join(a.out, slug, "jlens", f"ckpt_{a.rules}.pt")
            up = f"{a.checkpoint_repo}:checkpoints/{slug}/{tag}.pt"
            os.makedirs(os.path.dirname(ckpt), exist_ok=True)
            if not os.path.exists(ckpt):
                try:
                    from huggingface_hub import hf_hub_download
                    import shutil
                    shutil.copy(hf_hub_download(a.checkpoint_repo, f"checkpoints/{slug}/{tag}.pt", repo_type="dataset"), ckpt)
                except Exception:
                    pass
        J = fit_lens(nm, texts, target=a.target, dim_batch=a.dim_batch, rules=a.rules, checkpoint=ckpt, upload=up)
        path = os.path.join(a.out, slug, "jlens", f"fitted_{a.rules}.pt")
        save_lens(J, path, len(texts))
        print(f"fitted {len(J)} {a.rules}-lens layers on {len(texts)} prompts -> {path}", flush=True)
        lenses.append(f"{a.rules}={path}")
    run(a.model, lenses, a.out, k=a.k, device=a.device, layers=a.layers, chunk=a.chunk, nm=nm)
