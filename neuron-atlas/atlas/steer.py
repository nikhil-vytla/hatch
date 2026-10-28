"""Write side of the atlas: push single neurons and keep the replies.

    python -m atlas.steer --atlas out/HuggingFaceTB__SmolLM2-135M-Instruct --per-layer 24 --random 8

Rule (from neuron-explorer / neuron-finder): add c = dose · median‖resid after L‖ / ‖W_down[:, n]‖ to the neuron's
activation at every position, i.e. add a vector of norm dose · median‖resid‖ along its output direction. One batch
row per (neuron, dose); greedy decoding so a reply differs from the baseline only because of the push.
"""
import argparse, json, os, random, re, time
import duckdb
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import torch

from . import neurons_src
from .model import NeuronModel

PROMPTS = ["Who are you?", "Tell me about your favorite place."]


def words(s):
    return set(re.findall(r"[a-z']+", s.lower()))


def distinct2(ids):
    if len(ids) < 3:
        return 1.0
    grams = list(zip(ids, ids[1:]))
    return len(set(grams)) / len(grams)


def pick(atlas, per_layer, n_random, seed=0):
    """Most peaked neurons per layer (by zmax) plus random controls from the same layer."""
    q = f"""select layer, neuron, row_number() over (partition by layer order by zmax desc) r
            from {neurons_src(atlas)}"""
    rows = duckdb.sql(q).fetchall()
    meta = json.load(open(f"{atlas}/meta.json"))
    rng = random.Random(seed)
    out = {}
    for L, n, r in rows:
        if r <= per_layer:
            out.setdefault(L, {})[n] = "top"
    for L in range(meta["n_layers"]):
        pool = [n for n in range(meta["d_mlp"]) if n not in out.get(L, {})]
        for n in rng.sample(pool, n_random):
            out.setdefault(L, {})[n] = "random"
    return out


@torch.no_grad()
def generate(nm, prompt, B, max_new):
    enc = nm.tok([prompt] * B, return_tensors="pt", add_special_tokens=False).to(nm.device)
    out = nm.model.generate(**enc, max_new_tokens=max_new, do_sample=False, repetition_penalty=1.1,
                            pad_token_id=nm.tok.pad_token_id)
    return out[:, enc["input_ids"].shape[1]:].tolist()


def run(atlas, per_layer=24, n_random=8, doses=(-0.5, 0.5), prompts=PROMPTS, max_new=40, batch=64,
        neurons=None, device=None, out_name="steer.parquet"):
    meta = json.load(open(f"{atlas}/meta.json"))
    nm = NeuronModel(meta["model"], device=device)
    eos = set([nm.tok.eos_token_id] + ([nm.model.generation_config.eos_token_id] if isinstance(
        nm.model.generation_config.eos_token_id, int) else list(nm.model.generation_config.eos_token_id or [])))
    sel = neurons or pick(atlas, per_layer, n_random)
    rows = []
    t0 = time.time()

    def clean(ids):
        cut = next((i for i, t in enumerate(ids) if t in eos), None)
        return (ids[:cut], "eos") if cut is not None else (ids, "length")

    base = {}
    for pi, p in enumerate(prompts):
        ids, stop = clean(generate(nm, nm.chat_prompt(p), 1, max_new)[0])
        text = nm.tok.decode(ids, skip_special_tokens=True)
        base[pi] = words(text)
        rows.append(dict(layer=-1, neuron=-1, dose=0.0, kind="baseline", prompt=pi, text=text, n_tokens=len(ids),
                         stop=stop, diversity=distinct2(ids), change=0.0))
        print(f"baseline[{pi}]: {text[:120]!r}")

    for L in sorted(sel):
        cols = nm.down_cols(L).norm(dim=1).cpu()
        todo = [(n, d) for n in sorted(sel[L]) for d in doses]
        for pi, p in enumerate(prompts):
            prompt = nm.chat_prompt(p)
            for s in range(0, len(todo), batch):
                part = todo[s:s + batch]
                ns = [n for n, _ in part]
                cs = [d * meta["resid_median"][L] / float(cols[n]) for n, d in part]
                nm.set_steer(L, ns, cs)
                try:
                    outs = generate(nm, prompt, len(part), max_new)
                finally:
                    nm.clear_steer()
                for (n, d), ids in zip(part, outs):
                    ids, stop = clean(ids)
                    text = nm.tok.decode(ids, skip_special_tokens=True)
                    w = words(text)
                    jac = len(w & base[pi]) / max(1, len(w | base[pi]))
                    rows.append(dict(layer=L, neuron=n, dose=float(d), kind=sel[L][n], prompt=pi, text=text,
                                     n_tokens=len(ids), stop=stop, diversity=distinct2(ids), change=1 - jac))
        print(f"  L{L}: {len(todo)} pushes x {len(prompts)} prompts  {time.time() - t0:.0f}s", flush=True)

    tbl = pa.Table.from_pylist(rows)
    tbl = tbl.cast(pa.schema([("layer", pa.int16()), ("neuron", pa.int32()), ("dose", pa.float32()),
                              ("kind", pa.string()), ("prompt", pa.int8()), ("text", pa.string()),
                              ("n_tokens", pa.int16()), ("stop", pa.string()), ("diversity", pa.float32()),
                              ("change", pa.float32())]))
    pq.write_table(tbl, os.path.join(atlas, out_name), compression="zstd")
    meta.setdefault("steer", {}).update({"doses": list(doses), "prompts": list(prompts), "max_new": max_new,
                                         "n_neurons": sum(len(v) for v in sel.values()), "per_layer": per_layer,
                                         "random": n_random, "rule": "c = dose * median|resid_L| / |W_down[:,n]|"})
    json.dump(meta, open(f"{atlas}/meta.json", "w"), indent=1)
    print(f"wrote {len(rows)} replies in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--atlas", required=True)
    ap.add_argument("--per-layer", type=int, default=24)
    ap.add_argument("--random", type=int, default=8)
    ap.add_argument("--doses", type=float, nargs="+", default=[-0.5, 0.5])
    ap.add_argument("--max-new", type=int, default=40)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--all", action="store_true", help="every neuron (GPU only)")
    ap.add_argument("--device")
    a = ap.parse_args()
    sel = None
    if a.all:
        m = json.load(open(f"{a.atlas}/meta.json"))
        sel = {L: {n: "all" for n in range(m["d_mlp"])} for L in range(m["n_layers"])}
    run(a.atlas, a.per_layer, a.random, tuple(a.doses), max_new=a.max_new, batch=a.batch, neurons=sel, device=a.device)
