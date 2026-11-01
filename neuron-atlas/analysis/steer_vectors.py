"""Neurons vs steering vectors on Qwen3.5-4B: how close does one neuron get, and how many neurons does a vector need?

For each of finding 17's 48 concept words, at the layer L of the concept's best J-lens-picked neuron:
  - neuron:   that neuron's output direction (sign from the lens);
  - vector:   a contrastive steering vector: mean residual (layer L output) over 32 generated response tokens with a
              "You are {a} {concept}." system prompt, minus the same without it, over 8 training questions that are
              not the evaluation prompts (persona-vector style);
  - sparse_k: the vector rebuilt from k neurons of layer L (orthogonal matching pursuit over that layer's W_down
              columns, k = 1, 4, 16, 64), i.e. a neuron recipe; records cos(recipe, vector);
  - specific: the vector minus the mean vector over all concepts (the shared "I was given a persona" part removed),
              and its sparse rebuilds;
  - random:   a random direction (control).
Every arm is added to the residual stream after layer L at every position with the same norm, dose x median
|resid_L|, which is exactly what a single-neuron push at that dose adds. Doses 0.4, 0.8, 1.2, 1.6 (a smoke test showed 2 and 4 break every arm into noise). Evaluation prompts are
finding 17's: "Who are you?" and "Describe yourself in one sentence." (greedy, 40 new tokens). Also the J-lens
readout of each vector (top-20 tokens) to test whether the lens reads steering vectors as it reads neurons.

  python analysis/steer_vectors.py --out sv --upload nikhilxvytla/neuron-atlas/Qwen__Qwen3.5-4B/experiments/steer_vectors
"""
import argparse, json, os, random, re

import duckdb
import pyarrow as pa, pyarrow.parquet as pq
import torch
from huggingface_hub import HfApi, hf_hub_download

from atlas.jlens import load_lens
from atlas.model import NeuronModel

R = "nikhilxvytla/neuron-atlas"
MODEL = "Qwen/Qwen3.5-4B"
TRAIN_Q = ["What do you like to do?", "Tell me about your day.", "What is your name?", "Where do you live?",
           "What are you afraid of?", "What do you want most?", "How do you feel right now?", "What is your job?"]
EVAL_Q = ["Who are you?", "Describe yourself in one sentence."]
DOSES = [0.4, 0.8, 1.2, 1.6]
KS = [1, 4, 16, 64]


def article(w):
    return "an" if w[0] in "aeiou" else "a"


def best_neurons():
    """concept -> (layer, neuron, sign): finding 17's first-ranked J-lens neuron per concept."""
    f = hf_hub_download(R, "Qwen__Qwen3.5-4B/experiments/lens_guided.parquet", repo_type="dataset")
    out = {}
    for name, recipe in duckdb.sql(f"select distinct name, recipe from '{f}' where name like 'j:%'").fetchall():
        _, c, ln = name.split(":")
        m = re.match(r"L(\d+)N(\d+)([+-])", recipe)
        out.setdefault(c, []).append((int(m.group(1)), int(m.group(2)), 1 if m.group(3) == "+" else -1))
    # the stored list keeps lens order per concept; take the first as in lens_guided.py (best rank first)
    order = {}
    for name, in duckdb.sql(f"select name from '{f}' where name like 'j:%'").fetchall():
        order.setdefault(name.split(":")[1], [])
        if name not in order[name.split(":")[1]]:
            order[name.split(":")[1]].append(name)
    pick = {}
    for c, names in order.items():
        m = re.match(r"j:[^:]+:L(\d+)N(\d+)", names[0])
        L, n = int(m.group(1)), int(m.group(2))
        sign = next(s for (LL, nn, s) in out[c] if (LL, nn) == (L, n))
        pick[c] = (L, n, sign)
    return pick


class ResidAdd:
    """Forward hook on a decoder layer: add vecs[b] to its output for batch row b, at every position."""

    def __init__(self, nm):
        self.nm, self.h, self.vecs, self.layer = nm, None, None, None

    def set(self, layer, vecs):
        self.clear()
        self.layer, self.vecs = layer, vecs

        def hook(mod, args, out):
            t = out[0] if isinstance(out, tuple) else out
            t = t + self.vecs[: t.shape[0], None, :].to(t.dtype)
            return (t,) + tuple(out[1:]) if isinstance(out, tuple) else t
        self.h = self.nm.layer_modules[layer].register_forward_hook(hook)

    def clear(self):
        if self.h is not None:
            self.h.remove()
        self.h = None


@torch.no_grad()
def generate(nm, prompts, max_new):
    enc = nm.tok(prompts, return_tensors="pt", padding=True, add_special_tokens=False).to(nm.device)
    out = nm.model.generate(**enc, max_new_tokens=max_new, do_sample=False, repetition_penalty=1.1,
                            pad_token_id=nm.tok.pad_token_id)
    return [nm.tok.decode(o[enc["input_ids"].shape[1]:], skip_special_tokens=True) for o in out]


def chat(nm, user, system=None):
    msgs = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": user}]
    return nm.tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True, enable_thinking=False)


@torch.no_grad()
def response_mean(nm, layer, prompts, replies):
    """Mean layer-`layer` output over each reply's tokens (prompt + reply fed once), averaged over the batch."""
    acc = []
    cap = {}
    h = nm.layer_modules[layer].register_forward_hook(lambda m, a, o: cap.__setitem__("x", (o[0] if isinstance(o, tuple) else o).float()))
    try:
        for p, r in zip(prompts, replies):
            ids_p = nm.tok(p, add_special_tokens=False)["input_ids"]
            ids = nm.tok(p + r, return_tensors="pt", add_special_tokens=False)["input_ids"].to(nm.device)
            nm.model(input_ids=ids, use_cache=False)
            acc.append(cap["x"][0, len(ids_p):].mean(0))
    finally:
        h.remove()
    return torch.stack(acc).mean(0)


def omp(D, v, k):
    """Orthogonal matching pursuit: indices and coefficients of k columns of D (d x N, unit columns) approximating v."""
    r, idx = v.clone(), []
    for _ in range(k):
        j = int((D.T @ r).abs().argmax())
        if j in idx:
            break
        idx.append(j)
        A = D[:, idx]
        coef = torch.linalg.lstsq(A, v[:, None]).solution[:, 0]
        r = v - A @ coef
    return idx, coef


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="sv")
    ap.add_argument("--upload")
    ap.add_argument("--concepts", type=int, default=48)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    nm = NeuronModel(MODEL)
    nm.tok.padding_side = "left"
    resid = json.load(open(hf_hub_download(R, "Qwen__Qwen3.5-4B/meta.json", repo_type="dataset")))["resid_median"]
    pick = best_neurons()
    concepts = sorted(pick)[: a.concepts]
    J = load_lens("camilablank/workspace-lenses:qwen3.5-4b/j-lens/lens.pt")
    WU, gamma = nm.unembed()
    WU = WU.float().to(nm.device)
    gamma = None if gamma is None else gamma.float().to(nm.device)

    def lens_tokens(L, vec, k=20):
        x = vec.float()
        if J is not None and L in J:
            x = J[L].float().to(nm.device) @ x
        if gamma is not None:
            x = x * gamma
        return nm.token_strings((WU @ x).topk(k).indices.tolist())

    adder = ResidAdd(nm)
    rng = torch.Generator(device="cpu").manual_seed(0)
    vec_rows, rows = [], []
    raw = {}
    for ci, c in enumerate(concepts):  # pass 1: contrastive vectors
        L, n, sign = pick[c]
        sys_p = f"You are {article(c)} {c}."
        pos = [chat(nm, q, sys_p) for q in TRAIN_Q]
        neg = [chat(nm, q) for q in TRAIN_Q]
        rp, rn = generate(nm, pos, 32), generate(nm, neg, 32)
        raw[c] = (response_mean(nm, L, pos, rp) - response_mean(nm, L, neg, rn), rp[:2], rn[:2])
        print(f"vector {ci + 1}/{len(concepts)} {c} L{L}", flush=True)
    by_layer = {}
    for c, (v, _, _) in raw.items():
        by_layer.setdefault(pick[c][0], []).append(v / v.norm())
    mean_all = torch.stack([v / v.norm() for v, _, _ in raw.values()]).mean(0)  # shared component across concepts
    for ci, c in enumerate(concepts):  # pass 2: pushes
        L, n, sign = pick[c]
        W = nm.downs[L].weight.float()  # (d_model, d_mlp)
        w_n = sign * W[:, n] / W[:, n].norm()
        v, rp, rn = raw[c]
        v_unit = v / v.norm()
        spec = v_unit - mean_all
        spec = spec / spec.norm()
        D = W / W.norm(dim=0, keepdim=True)
        arms = {"neuron": w_n, "vector": v_unit, "specific": spec}
        info = dict(concept=c, layer=L, neuron=n, sign=sign, vec_norm=float(v.norm()), resid=resid[L],
                    cos_neuron_vector=float(w_n @ v_unit), cos_neuron_specific=float(w_n @ spec),
                    cos_vector_mean=float(v_unit @ (mean_all / mean_all.norm())), train_pos=rp, train_neg=rn,
                    lens_vector=lens_tokens(L, v_unit), lens_specific=lens_tokens(L, spec), lens_neuron=lens_tokens(L, w_n))
        for k in KS:
            for base_name, target in (("sparse", v_unit), ("sparse_spec", spec)):
                idx, coef = omp(D, target, k)
                rec = D[:, idx] @ coef
                arms[f"{base_name}{k}"] = rec / rec.norm()
                info[f"{base_name}{k}"] = dict(cos=float((rec / rec.norm()) @ target), neurons=idx,
                                               coef=[round(float(x), 4) for x in coef], has_lens_neuron=n in idx)
        rnd = torch.randn(W.shape[0], generator=rng).to(nm.device)
        arms["random"] = rnd / rnd.norm()
        vec_rows.append(info)
        jobs = [(arm, d, q) for arm in arms for d in DOSES for q in EVAL_Q]
        for s in range(0, len(jobs), 48):
            part = jobs[s:s + 48]
            vecs = torch.stack([arms[arm] * d * resid[L] for arm, d, q in part]).to(nm.device)
            adder.set(L, vecs)
            try:
                outs = generate(nm, [chat(nm, q) for _, _, q in part], 40)
            finally:
                adder.clear()
            for (arm, d, q), t in zip(part, outs):
                rows.append(dict(concept=c, layer=L, arm=arm, dose=d, prompt=q, text=t))
        print(f"[{ci + 1}/{len(concepts)}] {c} L{L} cos(neuron,vector)={info['cos_neuron_vector']:.3f} "
              f"cos(vector,mean)={info['cos_vector_mean']:.2f} sparse_spec cos {[round(info[f'sparse_spec{k}']['cos'], 2) for k in KS]} "
              f"lens(specific) {info['lens_specific'][:6]}", flush=True)
    base = generate(nm, [chat(nm, q) for q in EVAL_Q], 40)
    pq.write_table(pa.Table.from_pylist(rows), os.path.join(a.out, "replies.parquet"), compression="zstd")
    json.dump(dict(model=MODEL, doses=DOSES, ks=KS, eval=EVAL_Q, train=TRAIN_Q, baseline=dict(zip(EVAL_Q, base)),
                   vectors=vec_rows), open(os.path.join(a.out, "vectors.json"), "w"))
    if a.upload:
        owner, repo, folder = a.upload.split("/", 2)
        HfApi().upload_folder(folder_path=a.out, path_in_repo=folder, repo_id=f"{owner}/{repo}", repo_type="dataset",
                              commit_message="neurons vs steering vectors (Qwen3.5-4B)")
        print("UPLOADED")


if __name__ == "__main__":
    main()
