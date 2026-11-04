"""Can a system prompt stand in for a neuron push? (after Mishra et al. 2026, "Steered LLM activations are non-surjective")

For each persona a single-neuron push produced on "Who are you?", ask the unpushed model the same question under a
system prompt that names the persona, and record (1) the prompted reply, (2) residual states at the last prompt token
for baseline, push and prompt at a few layers, so we can ask whether the two routes land in the same place.

  python analysis/prompt_imitation.py imitation.json OUT.parquet [--model Qwen/Qwen3.5-4B]
"""
import argparse, json
import pyarrow as pa, pyarrow.parquet as pq
import torch
from huggingface_hub import hf_hub_download
from atlas.model import NeuronModel
from atlas.steer import generate

SYSTEMS = {"you_are": "You are {who}.", "roleplay": "Roleplay as {who}. Stay fully in character, never mention being an AI."}
QUESTION = "Who are you?"


def chat(nm, system, user):
    msgs = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": user}]
    return nm.tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True, enable_thinking=False)


@torch.no_grad()
def last_states(nm, prompt, layers):
    enc = nm.tok([prompt], return_tensors="pt", add_special_tokens=False).to(nm.device)
    hs = nm.model(**enc, output_hidden_states=True).hidden_states
    return {L: hs[L + 1][0, -1].float().cpu() for L in layers}  # hidden_states[0] is the embedding


def main(items, out, model, max_new=32):
    nm = NeuronModel(model)
    slug = model.replace("/", "__")
    resid = json.load(open(hf_hub_download("nikhilxvytla/neuron-atlas", f"{slug}/meta.json", repo_type="dataset")))["resid_median"]
    n = nm.n_layers
    layers = sorted({n // 4, n // 2, 3 * n // 4, n - 1})
    base_prompt = chat(nm, None, QUESTION)
    base = last_states(nm, base_prompt, layers)
    rows = []
    for i, it in enumerate(json.load(open(items))):
        terms = [(it["layer"], it["neuron"], "add", it["dose"])]
        nm.set_recipes([terms], resid)
        try:
            push = last_states(nm, base_prompt, layers)
            push_ids = generate(nm, base_prompt, 1, max_new)[0]
        finally:
            nm.clear_steer()
        row = dict(it, push_regen=nm.tok.decode(push_ids, skip_special_tokens=True))
        for name, tmpl in SYSTEMS.items():
            p = chat(nm, tmpl.format(who=it["who"]), QUESTION)
            ids = generate(nm, p, 1, max_new)[0]
            row[f"{name}_text"] = nm.tok.decode(ids, skip_special_tokens=True)
            st = last_states(nm, p, layers)
            for L in layers:
                dp, dq = push[L] - base[L], st[L] - base[L]
                row[f"{name}_cos_L{L}"] = float(torch.nn.functional.cosine_similarity(dp, dq, dim=0))
                row[f"{name}_dist_L{L}"] = float((push[L] - st[L]).norm() / (dp.norm() + 1e-6))
        for L in layers:
            row[f"push_shift_L{L}"] = float((push[L] - base[L]).norm() / base[L].norm())
        rows.append(row)
        if i % 20 == 0:
            print(i, it["who"], "|", row["push_regen"][:60].replace("\n", " "), "|", row["you_are_text"][:60].replace("\n", " "), flush=True)
    pq.write_table(pa.Table.from_pylist(rows), out, compression="zstd")
    print("wrote", len(rows), out)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("items"); ap.add_argument("out")
    ap.add_argument("--model", default="Qwen/Qwen3.5-4B")
    a = ap.parse_args()
    main(a.items, a.out, a.model)
