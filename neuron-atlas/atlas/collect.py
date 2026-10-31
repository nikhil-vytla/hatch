"""Read side of the atlas: run a corpus through a model and record, for every MLP neuron,
activation stats, its top (and for gated MLPs, bottom) documents with a token window, and its logit lens.

    python -m atlas.collect --model HuggingFaceTB/SmolLM2-135M-Instruct --corpus corpus.jsonl --out out/

Writes out/<slug>/{meta.json, neurons.parquet, tokens.parquet, examples/L00.parquet ...}.
Two passes over the corpus: pass 1 keeps running stats and the top-K documents per neuron (one example per
document, at the document's peak), pass 2 re-runs only the needed documents to cut each example's activation window.
"""
import argparse, json, math, os, time
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import torch

from .model import NeuronModel

BEFORE, AFTER = 16, 4          # example window around the peak token
WIN = BEFORE + 1 + AFTER


def slugify(name: str) -> str:
    return name.replace("/", "__")


def load_corpus(path, limit=None):
    with open(path) as f:
        docs = [json.loads(l) for l in f]
    return docs[:limit] if limit else docs


SKIP = 2  # leading positions never counted: first tokens act as attention sinks with huge, meaningless activations


def tokenize(nm: NeuronModel, docs, max_len, roles=False):
    """-> list of (src_id, kind, ids, skip, roles). skip also covers the chat-template prefix every chat shares
    (e.g. a default system prompt), which would otherwise fill top-example lists with the same text. roles marks
    user (1) and assistant (2) message spans; template tokens and web docs stay 0."""
    out = []
    for d in docs:
        ids = nm.tok(nm.render(d), add_special_tokens=True, truncation=True, max_length=max_len)["input_ids"]
        if len(ids) >= 8:
            rids = [0] * len(ids)
            if roles and d["kind"] == "chat":
                def ids_for(msgs):
                    if not msgs:
                        return []
                    return nm.tok(nm.render({**d, "messages": msgs}), add_special_tokens=True,
                                  truncation=True, max_length=max_len)["input_ids"]
                for i, msg in enumerate(d["messages"]):
                    role = 1 if msg["role"] == "user" else 2 if msg["role"] == "assistant" else 0
                    if not role:
                        continue
                    b = ids_for(d["messages"][:i] + [{"role": msg["role"], "content": ""}])
                    c = ids_for(d["messages"][:i + 1])
                    q = 0
                    while q < len(b) and q < len(c) and b[q] == c[q]:
                        q += 1
                    s = 0
                    while s < len(b) - q and s < len(c) - q and b[-1 - s] == c[-1 - s]:
                        s += 1
                    for p in range(q, min(len(c) - s, len(ids))):
                        rids[p] = role
            out.append([d["id"], d["kind"], ids, SKIP, rids])
    chats = [x[2] for x in out if x[1] == "chat"]
    if len(chats) > 1:
        p = 0
        while all(len(c) > p and c[p] == chats[0][p] for c in chats):
            p += 1
        for x in out:
            if x[1] == "chat":
                x[3] = max(SKIP, p)
    return [tuple(x) for x in out]


def batches(items, bs):
    for i in range(0, len(items), bs):
        yield i, items[i:i + bs]


def pad(nm, chunk):
    L = max(len(x[2]) for x in chunk)
    ids = torch.full((len(chunk), L), nm.tok.pad_token_id, dtype=torch.long)
    mask = torch.zeros((len(chunk), L), dtype=torch.bool)
    count = torch.zeros_like(mask)
    roles = torch.zeros((len(chunk), L), dtype=torch.long)
    for b, (_, _, x, skip, r) in enumerate(chunk):
        ids[b, :len(x)] = torch.tensor(x)
        mask[b, :len(x)] = True
        count[b, skip:len(x)] = True
        roles[b, :len(x)] = torch.tensor(r)
    return ids.to(nm.device), mask.to(nm.device), count.to(nm.device), roles.to(nm.device)


@torch.no_grad()
def pass1(nm: NeuronModel, toks, bs, k_pos, k_neg, roles=False):
    nL, d = nm.n_layers, nm.d_mlp
    dev = nm.device
    st = {
        "sum": torch.zeros(nL, d, dtype=torch.float64, device=dev),
        "sq": torch.zeros(nL, d, dtype=torch.float64, device=dev),
        "npos": torch.zeros(nL, d, dtype=torch.float64, device=dev),
        "max": torch.full((nL, d), -math.inf, device=dev),
        "min": torch.full((nL, d), math.inf, device=dev),
        "pv": torch.full((nL, k_pos, d), -math.inf, device=dev), "pd": torch.zeros(nL, k_pos, d, dtype=torch.long, device=dev),
        "pp": torch.zeros(nL, k_pos, d, dtype=torch.long, device=dev),
        "nv": torch.full((nL, max(k_neg, 1), d), math.inf, device=dev), "nd": torch.zeros(nL, max(k_neg, 1), d, dtype=torch.long, device=dev),
        "np": torch.zeros(nL, max(k_neg, 1), d, dtype=torch.long, device=dev),
    }
    if roles:
        for k in ("sum_user", "sum_assistant", "n_user", "n_assistant"):
            st[k] = torch.zeros(nL, d, dtype=torch.float64, device=dev)
    count = 0
    resid = [[] for _ in range(nL)]
    ctx = {}

    def make_hook(L):
        def hook(mod, args):
            a = args[0].float()                      # (B, T, d)
            m = ctx["mask"]                          # (B, T), leading positions excluded
            mf = m[..., None].float()
            st["sum"][L] += (a * mf).sum((0, 1)).double()
            st["sq"][L] += (a * a * mf).sum((0, 1)).double()
            st["npos"][L] += ((a > 0) & m[..., None]).sum((0, 1)).double()
            r = ctx["roles"]
            if r is not None:
                mu = ((r == 1) & m).float()
                ma = ((r == 2) & m).float()
                st["sum_user"][L] += (a * mu[..., None]).sum((0, 1)).double()
                st["sum_assistant"][L] += (a * ma[..., None]).sum((0, 1)).double()
                st["n_user"][L] += mu.sum((0, 1)).double()
                st["n_assistant"][L] += ma.sum((0, 1)).double()
            hi = a.masked_fill(~m[..., None], -math.inf)
            dmax, darg = hi.max(1)                   # per-document peak (B, d)
            st["max"][L] = torch.maximum(st["max"][L], dmax.max(0).values)
            docs = ctx["doc_idx"][:, None].expand_as(dmax)
            v = torch.cat([st["pv"][L], dmax]); di = torch.cat([st["pd"][L], docs]); pi = torch.cat([st["pp"][L], darg])
            top = v.topk(k_pos, dim=0)
            st["pv"][L] = top.values; st["pd"][L] = di.gather(0, top.indices); st["pp"][L] = pi.gather(0, top.indices)
            lo = a.masked_fill(~m[..., None], math.inf)
            dmin, dargm = lo.min(1)
            st["min"][L] = torch.minimum(st["min"][L], dmin.min(0).values)
            if k_neg:
                v = torch.cat([st["nv"][L], dmin]); di = torch.cat([st["nd"][L], docs]); pi = torch.cat([st["np"][L], dargm])
                bot = v.topk(k_neg, dim=0, largest=False)
                st["nv"][L] = bot.values; st["nd"][L] = di.gather(0, bot.indices); st["np"][L] = pi.gather(0, bot.indices)
        return hook

    hooks = [dn.register_forward_pre_hook(make_hook(L)) for L, dn in enumerate(nm.downs)]
    gen = torch.Generator().manual_seed(0)
    t0 = time.time()
    try:
        for i, chunk in batches(toks, bs):
            ids, mask, m, rids = pad(nm, chunk)
            ctx["mask"] = m
            ctx["roles"] = rids if roles else None
            ctx["doc_idx"] = torch.arange(i, i + len(chunk), device=nm.device)
            out = nm.model(input_ids=ids, attention_mask=mask, output_hidden_states=True, use_cache=False)
            count += int(m.sum())
            flat = m.flatten().nonzero().squeeze(1).cpu()
            pick = flat[torch.randperm(len(flat), generator=gen)[:64]]
            for L in range(nL):
                h = out.hidden_states[L + 1].flatten(0, 1)[pick.to(nm.device)].float()
                resid[L].append(h.norm(dim=-1).cpu())
            if (i // bs) % 20 == 0:
                print(f"  pass1 {i + len(chunk)}/{len(toks)} docs  {time.time() - t0:.0f}s", flush=True)
    finally:
        for h in hooks:
            h.remove()
    st = {k: v.cpu() for k, v in st.items()}
    resid_median = [float(torch.cat(r).median()) for r in resid]
    return st, count, resid_median


@torch.no_grad()
def pass2(nm: NeuronModel, toks, bs, entries):
    """entries[L] = (doc_idx, pos, neuron) LongTensors. Returns windows[L] float32 (E, WIN)."""
    nL = nm.n_layers
    windows = [torch.zeros(len(e[0]), WIN) for e in entries]
    need = set()
    for e in entries:
        need.update(e[0].tolist())
    order = sorted(need)
    sub = [toks[i] for i in order]
    ctx = {}

    def make_hook(L):
        def hook(mod, args):
            a = args[0].float()
            ed, ep, en = entries[L]
            local = ctx["local"][ed]
            sel = (local >= 0).nonzero().squeeze(1)
            if len(sel) == 0:
                return
            b = local[sel].to(a.device)
            off = torch.arange(-BEFORE, AFTER + 1)
            pos = ep[sel][:, None] + off[None]
            lens = ctx["lens"][b.cpu()][:, None]
            ok = (pos >= 0) & (pos < lens)
            posc = pos.clamp(0).minimum(lens - 1).to(a.device)
            vals = a[b[:, None], posc, en[sel][:, None].to(a.device)].cpu()
            windows[L][sel] = vals * ok
        return hook

    hooks = [dn.register_forward_pre_hook(make_hook(L)) for L, dn in enumerate(nm.downs)]
    try:
        for j, chunk in batches(sub, bs):
            local = torch.full((len(toks),), -1, dtype=torch.long)
            local[torch.tensor(order[j:j + len(chunk)])] = torch.arange(len(chunk))
            ctx["local"] = local
            ctx["lens"] = torch.tensor([len(x[2]) for x in chunk])
            ids, mask, _, _ = pad(nm, chunk)
            nm.model(input_ids=ids, attention_mask=mask, use_cache=False)
    finally:
        for h in hooks:
            h.remove()
    return windows


@torch.no_grad()
def logit_lens(nm: NeuronModel, k=10, chunk=512):
    W_U, gamma = nm.unembed()
    up, down = [], []
    for L in range(nm.n_layers):
        cols = nm.down_cols(L)
        if gamma is not None:
            cols = cols * gamma
        tu, td = [], []
        for s in range(0, cols.shape[0], chunk):
            lg = cols[s:s + chunk] @ W_U.T
            lg = lg - lg.mean(1, keepdim=True)
            tu.append(lg.topk(k, dim=1).indices.cpu()); td.append(lg.topk(k, dim=1, largest=False).indices.cpu())
        up.append(torch.cat(tu)); down.append(torch.cat(td))
    return up, down


def layout(nm: NeuronModel, seed=0):
    """2D map of all neurons from their (unit-norm) output directions: PCA-50 then UMAP (cosine)."""
    from sklearn.decomposition import PCA
    X = torch.cat([torch.nn.functional.normalize(nm.down_cols(L).cpu(), dim=1) for L in range(nm.n_layers)]).numpy()
    Z = PCA(50, random_state=seed).fit_transform(X)
    try:
        import umap
        xy = umap.UMAP(n_neighbors=15, min_dist=0.1, metric="cosine", random_state=seed, low_memory=True).fit_transform(Z)
    except Exception as e:  # pragma: no cover - fallback when umap is unavailable
        print("umap failed, using PCA-2:", e)
        xy = Z[:, :2]
    xy = (xy - xy.min(0)) / (xy.max(0) - xy.min(0) + 1e-9)
    return xy.astype(np.float32)


def list_col(rows2d, typ):
    rows2d = np.asarray(rows2d)
    n, w = rows2d.shape
    return pa.ListArray.from_arrays(pa.array(np.arange(0, n * w + 1, w, dtype=np.int32)), pa.array(rows2d.reshape(-1), type=typ))


def run(model, corpus, out, max_len=128, bs=16, k_pos=8, k_neg=None, limit=None, do_layout=True, device=None,
        roles=False, variant=None):
    t0 = time.time()
    nm = NeuronModel(model, device=device)
    gated = nm.model_type not in ("gpt2", "gpt_neox", "phi", "gptj", "opt")
    if k_neg is None:
        k_neg = 4 if gated else 0
    print(f"{model}: {nm.n_layers} layers x {nm.d_mlp} neurons = {nm.n_layers * nm.d_mlp:,} ({'gated' if gated else 'plain'} MLP) on {nm.device}")
    docs = load_corpus(corpus, limit)
    toks = tokenize(nm, docs, max_len, roles)
    toks.sort(key=lambda x: len(x[2]))           # less padding; doc index below is into this sorted list
    print(f"{len(toks)} docs, {sum(len(x[2]) for x in toks):,} tokens")

    st, count, resid_median = pass1(nm, toks, bs, k_pos, k_neg, roles)
    mean = (st["sum"] / count).float()
    std = (st["sq"] / count - (st["sum"] / count) ** 2).clamp(min=0).sqrt().float()
    print(f"pass1 done {time.time() - t0:.0f}s")

    nL, d = nm.n_layers, nm.d_mlp
    entries, meta_rows = [], []
    for L in range(nL):
        parts = [(st["pd"][L], st["pp"][L], st["pv"][L], 1, k_pos)]
        if k_neg:
            parts.append((st["nd"][L], st["np"][L], st["nv"][L], -1, k_neg))
        eds, eps, ens, info = [], [], [], []
        for dd, pp, vv, sign, k in parts:
            for r in range(k):
                ok = torch.isfinite(vv[r])
                n = ok.nonzero().squeeze(1)
                eds.append(dd[r][n]); eps.append(pp[r][n]); ens.append(n)
                info.append((torch.full_like(n, r), torch.full_like(n, sign), vv[r][n]))
        entries.append((torch.cat(eds), torch.cat(eps), torch.cat(ens)))
        meta_rows.append(tuple(torch.cat(x) for x in zip(*info)))
    windows = pass2(nm, toks, bs, entries)
    print(f"pass2 done {time.time() - t0:.0f}s")

    up, down = logit_lens(nm)
    print(f"logit lens done {time.time() - t0:.0f}s")

    slug = slugify(model + "-" + variant) if variant else slugify(model)
    od = os.path.join(out, slug)
    os.makedirs(os.path.join(od, "examples"), exist_ok=True)

    # tokens table: every corpus doc as token strings (the explorer cuts windows from it)
    pq.write_table(pa.table({
        "doc": pa.array(np.arange(len(toks), dtype=np.int32)),
        "kind": [k for _, k, _, _, _ in toks],
        "src_id": pa.array([i for i, _, _, _, _ in toks], type=pa.int32()),
        "skip": pa.array([x[3] for x in toks], type=pa.int16()),
        "toks": [nm.token_strings(x[2]) for x in toks],
    }), os.path.join(od, "tokens.parquet"), compression="zstd")

    peak_tokens = [[[] for _ in range(d)] for _ in range(nL)]
    for L in range(nL):
        ed, ep, en = entries[L]
        rank, sign, act = meta_rows[L]
        w = windows[L].numpy()
        scale = np.abs(w).max(1)
        q = np.round(127 * w / np.maximum(scale[:, None], 1e-9)).astype(np.int8)
        o = np.lexsort((rank.numpy(), -sign.numpy(), en.numpy()))
        pq.write_table(pa.table({
            "layer": pa.array(np.full(len(o), L, dtype=np.int16)),
            "neuron": pa.array(en.numpy()[o].astype(np.int32)),
            "sign": pa.array(sign.numpy()[o].astype(np.int8)),
            "rank": pa.array(rank.numpy()[o].astype(np.int8)),
            "act": pa.array(act.numpy()[o].astype(np.float32)),
            "doc": pa.array(ed.numpy()[o].astype(np.int32)),
            "pos": pa.array(ep.numpy()[o].astype(np.int32)),
            "scale": pa.array(scale[o].astype(np.float32)),
            "q": list_col(q[o], pa.int8()),
        }), os.path.join(od, "examples", f"L{L:02d}.parquet"), compression="zstd", row_group_size=8192)
        for e in np.nonzero(sign.numpy() == 1)[0]:
            peak_tokens[L][int(en[e])].append(nm.token_strings([toks[int(ed[e])][2][int(ep[e])]])[0])

    xy = layout(nm) if do_layout else np.zeros((nL * d, 2), np.float32)
    print(f"layout done {time.time() - t0:.0f}s")

    W_norm = torch.stack([nm.down_cols(L).norm(dim=1).cpu() for L in range(nL)])
    LL = np.repeat(np.arange(nL), d); NN = np.tile(np.arange(d), nL)
    zmax = ((st["max"] - mean) / (std + 1e-6)).numpy().reshape(-1)
    zmin = ((mean - st["min"]) / (std + 1e-6)).numpy().reshape(-1)
    role_counts = None
    if roles:
        mu = st["sum_user"] / st["n_user"].clamp(min=1)
        ma = st["sum_assistant"] / st["n_assistant"].clamp(min=1)
        rd = ((mu - ma) / (std.double() + 1e-6)).float()
        pq.write_table(pa.table({
            "layer": pa.array(LL.astype(np.int16)), "neuron": pa.array(NN.astype(np.int32)),
            "mean_user": pa.array(mu.float().numpy().reshape(-1)),
            "mean_assistant": pa.array(ma.float().numpy().reshape(-1)),
            "role_d": pa.array(rd.numpy().reshape(-1)),
        }), os.path.join(od, "roles.parquet"), compression="zstd")
        role_counts = {"n_user": int(st["n_user"][0, 0].item()), "n_assistant": int(st["n_assistant"][0, 0].item())}
    tbl = pa.table({
        "layer": pa.array(LL.astype(np.int16)), "neuron": pa.array(NN.astype(np.int32)),
        "mean": mean.numpy().reshape(-1), "std": std.numpy().reshape(-1),
        "max": st["max"].numpy().reshape(-1), "min": st["min"].numpy().reshape(-1),
        "frac_pos": (st["npos"] / count).float().numpy().reshape(-1),
        "zmax": zmax.astype(np.float32), "zmin": zmin.astype(np.float32),
        "w_norm": W_norm.numpy().reshape(-1),
        "x": xy[:, 0], "y": xy[:, 1],
        "lens_up": [nm.token_strings(r) for L in range(nL) for r in up[L].tolist()],
        "lens_down": [nm.token_strings(r) for L in range(nL) for r in down[L].tolist()],
        "peaks": [peak_tokens[L][n] for L in range(nL) for n in range(d)],
    })
    pq.write_table(tbl, os.path.join(od, "neurons.parquet"), compression="zstd", row_group_size=16384)

    meta = {
        "model": model, "slug": slug, "model_type": nm.model_type, "n_layers": nL, "d_mlp": d, "d_model": nm.d_model,
        "n_neurons": nL * d, "gated": gated, "k_pos": k_pos, "k_neg": k_neg, "before": BEFORE, "after": AFTER,
        "n_docs": len(toks), "n_tokens": count, "max_len": max_len, "resid_median": resid_median,
        "corpus": os.path.basename(corpus), "seconds": round(time.time() - t0, 1), "device": nm.device,
        "created": time.strftime("%Y-%m-%d"),
    }
    if variant:
        meta["variant"] = variant
    if role_counts is not None:
        meta["roles"] = role_counts
    with open(os.path.join(od, "meta.json"), "w") as f:
        json.dump(meta, f, indent=1)
    from .neighbors import add as add_neighbors
    add_neighbors(od, nm=nm)
    meta["seconds"] = round(time.time() - t0, 1)
    with open(os.path.join(od, "meta.json"), "w") as f:
        json.dump(meta, f, indent=1)
    print(f"wrote {od} in {time.time() - t0:.0f}s")
    return od


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--out", default="out")
    ap.add_argument("--max-len", type=int, default=128)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--k", type=int, default=8)
    ap.add_argument("--limit", type=int)
    ap.add_argument("--no-layout", action="store_true")
    ap.add_argument("--roles", action="store_true")
    ap.add_argument("--variant")
    ap.add_argument("--device")
    a = ap.parse_args()
    run(a.model, a.corpus, a.out, a.max_len, a.batch, a.k, limit=a.limit, do_layout=not a.no_layout, device=a.device,
        roles=a.roles, variant=a.variant)
