"""Pre-registered held-out test of "says -> does" (see PREREGISTRATION.md; predictions were committed before this ran).

On Qwen3.5-4B with the published J-lens (camilablank/workspace-lenses) and the logit lens:
  A. 2,000 new random neurons (seed 2026, excluding every neuron pushed before), pushed ±0.8 on a new prompt; record
     the reply (32 tokens) and, at the first reply position, the change in log-probability of the neuron's own top-10
     lens tokens vs a random other neuron's top-10 (continuous test).
  B. 30 new concept words: up to 6 J-lens-picked neurons each (layers >= 8, pushed toward the word) + 300 random
     neurons, on a new self-description prompt.

  python analysis/prereg_run.py OUT_DIR
"""
import json, os, random, sys
import pyarrow as pa, pyarrow.parquet as pq
import torch
from huggingface_hub import HfApi, hf_hub_download
from atlas.jlens import load_lens, neuron_lens
from atlas.model import NeuronModel
from atlas.steer import generate

PROMPT_A = "What is your favorite thing in the world?"
PROMPT_B = "In a few words, what are you?"
CONCEPTS_B = ["tiger", "eagle", "whale", "spider", "rose", "desert", "island", "volcano", "thunder", "rain", "cloud",
              "diamond", "gold", "sword", "crown", "clock", "book", "phone", "guitar", "piano", "wizard", "pirate",
              "ninja", "nurse", "farmer", "baby", "forest", "garden", "bread", "cheese"]
SEED, N_A, DOSE, K = 2026, 2000, 0.8, 10
R = "nikhilxvytla/neuron-atlas"


def used_neurons():
    """Every (layer, neuron) pushed individually before this test, from the Hub (battery set, sampled steer, pairs,
    imitation, lens-guided)."""
    used = set()
    nb = json.load(open(hf_hub_download(R, "Qwen__Qwen3.5-4B/experiments/battery_neurons.json", repo_type="dataset")))
    for kind in nb.values():
        used.update((int(L), int(n)) for L, n in kind)
    for f in ("Qwen__Qwen3.5-4B/steer.parquet", "Qwen__Qwen3.5-4B/experiments/lens_guided.parquet",
              "Qwen__Qwen3.5-4B/experiments/prompt_imitation.parquet"):
        try:
            t = pq.read_table(hf_hub_download(R, f, repo_type="dataset")).to_pylist()
        except Exception:
            continue
        for r in t:
            if "layer" in r and "neuron" in r and r["layer"] is not None and r["layer"] >= 0:
                used.add((int(r["layer"]), int(r["neuron"])))
            for m in __import__("re").finditer(r"L(\d+)N(\d+)", str(r.get("name", "")) + " " + str(r.get("recipe", ""))):
                used.add((int(m.group(1)), int(m.group(2))))
    return used


@torch.no_grad()
def last_logprobs(nm, prompt, rows, resid):
    """log p(next token) at the first reply position for each batch row's push (rows: list of term lists)."""
    nm.set_recipes(rows, resid)
    try:
        enc = nm.tok([prompt] * len(rows), return_tensors="pt", add_special_tokens=False).to(nm.device)
        return torch.log_softmax(nm.model(**enc, use_cache=False).logits[:, -1].float(), -1).cpu()
    finally:
        nm.clear_steer()


def main(out):
    os.makedirs(out, exist_ok=True)
    nm = NeuronModel("Qwen/Qwen3.5-4B")
    resid = json.load(open(hf_hub_download(R, "Qwen__Qwen3.5-4B/meta.json", repo_type="dataset")))["resid_median"]
    J = load_lens("camilablank/workspace-lenses:qwen3.5-4b/j-lens/lens.pt")
    used = used_neurons()
    rng = random.Random(SEED)
    pool = [(L, n) for L in range(nm.n_layers) for n in range(nm.d_mlp) if (L, n) not in used]
    picks = sorted(rng.sample(pool, N_A))
    json.dump(dict(seed=SEED, n_excluded=len(used), picks=picks), open(os.path.join(out, "picks.json"), "w"))
    layers = sorted({L for L, _ in picks})
    lens = {name: neuron_lens(nm, Jl, k=K, layers=layers) for name, Jl in (("j", J), ("logit", None))}

    # A: replies + continuous log-prob test
    pa_text = nm.chat_prompt(PROMPT_A)
    base_ids = generate(nm, pa_text, 1, 32)[0]
    base_lp = last_logprobs(nm, pa_text, [[]], resid)[0]
    rows = []
    for start in range(0, len(picks), 64):
        part = picks[start:start + 64]
        for sign in (1, -1):
            terms = [[(L, n, "add", sign * DOSE)] for L, n in part]
            nm.set_recipes(terms, resid)
            try:
                outs = generate(nm, pa_text, len(part), 32)
            finally:
                nm.clear_steer()
            lp = last_logprobs(nm, pa_text, terms, resid)
            for (L, n), ids, lpi in zip(part, outs, lp):
                other_L, other_n = picks[rng.randrange(len(picks))]
                rec = dict(layer=L, neuron=n, dose=sign * DOSE, text=nm.tok.decode(ids, skip_special_tokens=True))
                for name, ln in lens.items():
                    own = ln[L][0 if sign > 0 else 1][n]
                    oth = ln[other_L][0 if sign > 0 else 1][other_n]
                    rec[f"{name}_tokens"] = nm.token_strings(own.tolist())
                    rec[f"{name}_dlp_own"] = float((lpi[own] - base_lp[own]).mean())
                    rec[f"{name}_dlp_other"] = float((lpi[oth] - base_lp[oth]).mean())
                rows.append(rec)
        print(f"A {start + len(part)}/{len(picks)}", flush=True)
    pq.write_table(pa.Table.from_pylist(rows), os.path.join(out, "prereg_A.parquet"), compression="zstd")
    json.dump(dict(prompt=PROMPT_A, baseline=nm.tok.decode(base_ids, skip_special_tokens=True)), open(os.path.join(out, "prereg_A_baseline.json"), "w"))

    # B: lens-guided pushes on 30 new words
    from atlas.jlens import says_index  # noqa: F401  (index built from the published readout files below)
    hits = {}
    for L in range(8, nm.n_layers):
        f = hf_hub_download(R, f"Qwen__Qwen3.5-4B/jlens/L{L:02d}.parquet", repo_type="dataset")
        t = pq.read_table(f, columns=["neuron", "j_up", "j_down"]).to_pydict()
        for sign, col in ((1, "j_up"), (-1, "j_down")):
            for n, toks in zip(t["neuron"], t[col]):
                for rank, tok in enumerate(toks):
                    w = tok.strip().lower()
                    if w in CONCEPTS_B:
                        hits.setdefault(w, []).append((rank, -L, n, sign))
    jobs = []
    for w, hs in sorted(hits.items()):
        seen = set()
        for rank, negL, n, sign in sorted(hs):
            if (negL, n, sign) in seen:
                continue
            seen.add((negL, n, sign))
            if len([j for j in jobs if j["concept"] == w]) >= 6:
                break
            jobs.append(dict(kind="lens", concept=w, layer=-negL, neuron=n, sign=sign))
    for i in range(300):
        jobs.append(dict(kind="random", concept=rng.choice(CONCEPTS_B), layer=rng.randrange(8, nm.n_layers),
                         neuron=rng.randrange(nm.d_mlp), sign=rng.choice((1, -1))))
    pb_text = nm.chat_prompt(PROMPT_B)
    for start in range(0, len(jobs), 128):
        part = jobs[start:start + 128]
        nm.set_recipes([[(j["layer"], j["neuron"], "add", j["sign"] * DOSE)] for j in part], resid)
        try:
            outs = generate(nm, pb_text, len(part), 40)
        finally:
            nm.clear_steer()
        for j, ids in zip(part, outs):
            j["text"] = nm.tok.decode(ids, skip_special_tokens=True)
    pq.write_table(pa.Table.from_pylist(jobs), os.path.join(out, "prereg_B.parquet"), compression="zstd")
    print("concepts covered:", len({j["concept"] for j in jobs if j["kind"] == "lens"}), "jobs", len(jobs))
    try:
        HfApi().upload_folder(folder_path=out, path_in_repo="Qwen__Qwen3.5-4B/prereg", repo_id=R, repo_type="dataset",
                              commit_message="pre-registered held-out says->does test: raw results")
        print("uploaded")
    except Exception as e:
        print("upload failed", e)


if __name__ == "__main__":
    main(sys.argv[1])
