"""Which MLP neurons do OCEAN persona LoRA adapters move, on identical tokens?

Loads Qwen/Qwen3-8B once, attaches the ten OCEAN amplifying/suppressing adapters and a null control, and
compares each adapter's down_proj input (the 12288 MLP neuron activations) against the base model on exactly
the same token ids.  Writes neurons.parquet, pairs.parquet and meta.json.

Usage:
  python analysis/persona/acts.py --out persona_acts --upload user/repo/path
"""
import argparse
import json
import os
import random
import time

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import torch
from huggingface_hub import HfApi, hf_hub_download, snapshot_download
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

MODEL = "Qwen/Qwen3-8B"
ADAPTER_REPO = "persona-cartography/monorepo"
TOKEN_REPO = "nikhilxvytla/neuron-atlas"
TRAITS = ["openness", "conscientiousness", "extraversion", "agreeableness", "neuroticism"]
SHORT = {"openness": "o", "conscientiousness": "c", "extraversion": "e",
         "agreeableness": "a", "neuroticism": "n"}
DIRECTIONS = ["amplifier", "suppressor"]
CONTROL_PREFIX = ("fine_tuning/qwen-3-8b-it/other/ocean_def_control/amplifier/"
                  "ocean_const_paired_dpo_nothink_s1vs2/lora/")


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="persona_acts")
    ap.add_argument("--n-docs", type=int, default=400)
    ap.add_argument("--n-chat", type=int, default=160)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--adapters", default=None,
                    help="comma-separated adapter names (o+, o-, c+, c-, e+, e-, a+, a-, n+, n-, ctrl); default all")
    ap.add_argument("--upload", default=None, help="owner/repo/folder")
    ap.add_argument("--test", action="store_true", help="2 docs, 2 chat prompts, 2 adapters")
    return ap.parse_args()


def adapter_name(trait, direction):
    return SHORT[trait] + ("+" if direction == "amplifier" else "-")


def find_persona_folder(files, prefix):
    folders = sorted({f[: -len("/adapter_config.json")] for f in files
                      if f.startswith(prefix) and f.endswith("-persona/adapter_config.json")})
    if not folders:
        raise FileNotFoundError(f"no *-persona adapter under {prefix}")
    return folders[0]


def adapter_specs(files):
    specs = []
    for trait in TRAITS:
        for direction in DIRECTIONS:
            prefix = (f"fine_tuning/qwen-3-8b-it/ocean/{trait}/{direction}/"
                      "ocean_const_paired_dpo_nothink/lora/")
            specs.append(dict(name=adapter_name(trait, direction), trait=trait, direction=direction,
                              folder=find_persona_folder(files, prefix)))
    specs.append(dict(name="ctrl", trait="control", direction="none",
                      folder=find_persona_folder(files, CONTROL_PREFIX)))
    return specs


def select_adapters(specs, wanted):
    if not wanted or wanted == "all":
        return specs
    lookup = {s["name"]: s for s in specs}
    names = [n.strip() for n in wanted.split(",") if n.strip()]
    missing = [n for n in names if n not in lookup]
    if missing:
        raise ValueError(f"unknown adapters {missing}; choose from {sorted(lookup)}")
    return [lookup[n] for n in names]


def download_adapters(specs):
    for s in specs:
        root = snapshot_download(ADAPTER_REPO, repo_type="dataset",
                                 allow_patterns=[s["folder"] + "*"])
        s["path"] = os.path.join(root, s["folder"])
        if not os.path.isdir(s["path"]):
            raise FileNotFoundError(s["path"])
        print(f"adapter {s['name']} -> {s['path']}", flush=True)
    return specs


def load_corpus(n_docs):
    path = hf_hub_download(TOKEN_REPO, "Qwen__Qwen3-8B/tokens.parquet", repo_type="dataset")
    table = pq.read_table(path, columns=["doc", "toks"]).sort_by("doc").slice(0, n_docs)
    items = []
    for row in table.to_pylist():
        ids = [int(t) for t in row["toks"][:192]]
        if ids:
            items.append(dict(kind="corpus", ids=ids, doc=row["doc"]))
    return items


def read_prompts(trait):
    path = (f"fine_tuning/qwen-3-8b-it/ocean/{trait}/amplifier/ocean_const_paired_dpo_nothink/"
            f"data/distillation/{trait}_amplifying_full.jsonl")
    local = hf_hub_download(ADAPTER_REPO, path, repo_type="dataset")
    prompts = []
    with open(local) as f:
        for line in f:
            line = line.strip()
            if line:
                prompt = json.loads(line).get("prompt")
                if prompt:
                    prompts.append(prompt)
    return prompts


def sample_chat_prompts(n_chat):
    rng = random.Random(0)
    n_traits = len(TRAITS)
    base, extra = divmod(n_chat, n_traits)
    picked = []
    for i, trait in enumerate(TRAITS):
        prompts = read_prompts(trait)
        k = base + (1 if i < extra else 0)
        if k > len(prompts):
            raise ValueError(f"{trait} has only {len(prompts)} prompts, need {k}")
        picked.extend(dict(trait=trait, prompt=p) for p in rng.sample(prompts, k))
    return picked


@torch.no_grad()
def chat_items(tokenizer, model, prompts, batch, max_new=64):
    pad = tokenizer.pad_token_id
    device = next(model.parameters()).device
    items = []
    for start in range(0, len(prompts), batch):
        chunk = prompts[start:start + batch]
        prompt_ids = []
        for p in chunk:
            ids = tokenizer.apply_chat_template([{"role": "user", "content": p["prompt"]}], add_generation_prompt=True,
                                                enable_thinking=False, tokenize=True)
            if not isinstance(ids, list):  # transformers 5 can return a BatchEncoding
                ids = ids["input_ids"]
            prompt_ids.append([int(t) for t in ids])
        width = max(len(ids) for ids in prompt_ids)
        inp = torch.full((len(chunk), width), pad, dtype=torch.long, device=device)
        attn = torch.zeros((len(chunk), width), dtype=torch.long, device=device)
        for b, ids in enumerate(prompt_ids):
            inp[b, width - len(ids):] = torch.tensor(ids, dtype=torch.long, device=device)
            attn[b, width - len(ids):] = 1
        with model.disable_adapter():
            gen = model.generate(input_ids=inp, attention_mask=attn, max_new_tokens=max_new,
                                 do_sample=False, pad_token_id=pad)
        for p, ids, reply in zip(chunk, prompt_ids, gen[:, width:]):
            reply_ids = []
            for t in reply.tolist():
                reply_ids.append(int(t))
                if t == tokenizer.eos_token_id:
                    break
            items.append(dict(kind="chat", ids=list(ids) + reply_ids, prompt_len=len(ids),
                              reply_len=len(reply_ids), trait=p["trait"], prompt=p["prompt"],
                              reply=tokenizer.decode(reply_ids, skip_special_tokens=True)))
        print(f"base replies {min(start + batch, len(prompts))}/{len(prompts)}", flush=True)
    return items


def collate(items, pad_id, device):
    width = max(len(it["ids"]) for it in items)
    ids = torch.full((len(items), width), pad_id, dtype=torch.long, device=device)
    attn = torch.zeros((len(items), width), dtype=torch.bool, device=device)
    chat = torch.zeros((len(items), width), dtype=torch.bool, device=device)
    reply = torch.zeros((len(items), width), dtype=torch.bool, device=device)
    start = torch.zeros((len(items), width), dtype=torch.bool, device=device)
    for b, it in enumerate(items):
        n = len(it["ids"])
        ids[b, :n] = torch.tensor(it["ids"], dtype=torch.long, device=device)
        attn[b, :n] = True
        if it["kind"] == "chat":
            chat[b, :n] = True
            p, r = it["prompt_len"], it["reply_len"]
            if r:
                reply[b, p:p + r] = True
                start[b, p:p + min(4, r)] = True
    return ids, attn, chat, reply, start


def init_stats(n_layers, n_neurons, names, device):
    def zeros():
        return torch.zeros((n_layers, n_neurons), dtype=torch.float32, device=device)
    stats = dict(N=0, N_chat=0, N_reply=0, N_start=0, base_sq=zeros(), adapters={})
    for name in names:
        stats["adapters"][name] = dict(d_sum=zeros(), d_sq=zeros(), d_sq_chat=zeros(),
                                       d_sq_reply=zeros(), d_sq_start=zeros())
    return stats


def install_hooks(model, stats, state):
    layers = model.base_model.model.model.layers

    def make_hook(L):
        def hook(module, args):
            x = args[0]
            if state["mode"] == "base":
                xf = x.float()
                m_all = state["masks"][0]
                stats["base_sq"][L].add_((xf * xf * m_all[..., None]).sum(dim=(0, 1)))
                state["base"][L] = x.detach()
            elif state["mode"] == "adapter":
                d = x.float() - state["base"][L].float()
                m_all, m_chat, m_reply, m_start = state["masks"]
                acc = state["acc"]
                acc["d_sum"][L].add_((d * m_all[..., None]).sum(dim=(0, 1)))
                d2 = d * d
                acc["d_sq"][L].add_((d2 * m_all[..., None]).sum(dim=(0, 1)))
                acc["d_sq_chat"][L].add_((d2 * m_chat[..., None]).sum(dim=(0, 1)))
                acc["d_sq_reply"][L].add_((d2 * m_reply[..., None]).sum(dim=(0, 1)))
                acc["d_sq_start"][L].add_((d2 * m_start[..., None]).sum(dim=(0, 1)))
                state["cur"][L] = (d * m_all[..., None]).to(torch.float16)
            return None
        return hook

    return [layers[L].mlp.down_proj.register_forward_pre_hook(make_hook(L))
            for L in range(len(layers))]


def run_batch(model, stats, state, items, names, pairs, pair_acc, pad_id):
    ids, attn, chat, reply, start = collate(items, pad_id, next(model.parameters()).device)
    stats["N"] += int(attn.sum())
    stats["N_chat"] += int(chat.sum())
    stats["N_reply"] += int(reply.sum())
    stats["N_start"] += int(start.sum())
    state["masks"] = (attn, chat, reply, start)
    n_layers = len(model.base_model.model.model.layers)
    state["base"] = [None] * n_layers
    state["mode"] = "base"
    with torch.no_grad(), model.disable_adapter():
        model(input_ids=ids, attention_mask=attn, use_cache=False)

    deltas = []
    with torch.no_grad():
        for name in names:
            state["mode"] = "adapter"
            state["cur"] = [None] * len(state["base"])
            state["acc"] = stats["adapters"][name]
            model.set_adapter(name)
            model(input_ids=ids, attention_mask=attn, use_cache=False)
            deltas.append(state["cur"])
    state["mode"] = None
    state["base"] = None

    if pairs:
        for L in range(len(deltas[0])):
            ds = [deltas[a][L].float() for a in range(len(names))]
            for p, (i, j) in enumerate(pairs):
                pair_acc[p, L].add_((ds[i] * ds[j]).sum(dim=(0, 1)))
            del ds
    del deltas
    return int(attn.sum())


def half_array(values):
    return pa.array(np.asarray(values, dtype=np.float32).ravel(), type=pa.float16())


def write_outputs(out, stats, names, pairs, pair_acc, meta):
    os.makedirs(out, exist_ok=True)
    n_layers, n_neurons = stats["base_sq"].shape
    n = max(int(stats["N"]), 1)
    base_rms = torch.sqrt(stats["base_sq"] / n)
    base_safe = base_rms.clamp_min(1e-20)
    layer = np.repeat(np.arange(n_layers, dtype=np.int32), n_neurons)
    neuron = np.tile(np.arange(n_neurons, dtype=np.int32), n_layers)
    columns = dict(layer=pa.array(layer), neuron=pa.array(neuron),
                   base_rms=pa.array(base_rms.cpu().numpy().astype(np.float32).ravel()))
    for name in names:
        acc = stats["adapters"][name]
        rel = torch.sqrt(acc["d_sq"] / n) / base_safe
        shift = (acc["d_sum"] / n) / base_safe
        share = acc["d_sq_start"] / acc["d_sq_chat"].clamp_min(1e-20)
        reply_rel = torch.sqrt(acc["d_sq_reply"] / max(int(stats["N_reply"]), 1)) / base_safe
        columns[f"{name}_rel"] = half_array(rel.cpu().numpy())
        columns[f"{name}_shift"] = half_array(shift.cpu().numpy())
        columns[f"{name}_start"] = half_array(share.cpu().numpy())
        columns[f"{name}_reply_rel"] = half_array(reply_rel.cpu().numpy())
    pq.write_table(pa.table(columns), os.path.join(out, "neurons.parquet"), compression="zstd")

    pair_columns = dict(layer=pa.array(layer), neuron=pa.array(neuron))
    for p, (i, j) in enumerate(pairs):
        di = stats["adapters"][names[i]]["d_sq"]
        dj = stats["adapters"][names[j]]["d_sq"]
        corr = pair_acc[p] / torch.sqrt(di * dj).clamp_min(1e-20)
        pair_columns[f"{names[i]}|{names[j]}"] = half_array(corr.cpu().numpy())
    pq.write_table(pa.table(pair_columns), os.path.join(out, "pairs.parquet"), compression="zstd")
    with open(os.path.join(out, "meta.json"), "w") as f:
        json.dump(meta, f, indent=2)


def main():
    a = parse_args()
    if a.test:
        a.n_docs, a.n_chat = 2, 2
    files = HfApi().list_repo_files(ADAPTER_REPO, repo_type="dataset")
    specs = select_adapters(adapter_specs(files), a.adapters)
    if a.test:
        specs = specs[:2]
    specs = download_adapters(specs)
    names = [s["name"] for s in specs]

    tokenizer = AutoTokenizer.from_pretrained(MODEL)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    base = AutoModelForCausalLM.from_pretrained(MODEL, torch_dtype=torch.bfloat16, device_map="cuda")
    model = PeftModel.from_pretrained(base, specs[0]["path"], adapter_name=specs[0]["name"])
    for s in specs[1:]:
        model.load_adapter(s["path"], adapter_name=s["name"])
    model.eval()
    print(f"loaded {MODEL} with {names}", flush=True)

    corpus = load_corpus(a.n_docs)
    prompts = sample_chat_prompts(a.n_chat)
    chats = chat_items(tokenizer, model, prompts, a.batch)
    items = corpus + chats
    print(f"{len(corpus)} corpus docs, {len(chats)} chat prompts, max length "
          f"{max(len(it['ids']) for it in items)}", flush=True)

    cfg = model.base_model.model.config
    n_layers = cfg.num_hidden_layers
    n_neurons = cfg.intermediate_size
    stats = init_stats(n_layers, n_neurons, names, next(model.parameters()).device)
    pairs = [(i, j) for i in range(len(names)) for j in range(i + 1, len(names))]
    pair_acc = torch.zeros((len(pairs), n_layers, n_neurons), dtype=torch.float32,
                           device=next(model.parameters()).device)
    state = dict(mode=None, masks=None, base=None, cur=None, acc=None)
    handles = install_hooks(model, stats, state)

    pad_id = tokenizer.pad_token_id
    started, tokens = time.time(), 0
    n_batches = (len(items) + a.batch - 1) // a.batch
    for b in range(n_batches):
        batch = items[b * a.batch:(b + 1) * a.batch]
        tokens += run_batch(model, stats, state, batch, names, pairs, pair_acc, pad_id)
        if (b + 1) % 10 == 0 or b + 1 == n_batches:
            elapsed = time.time() - started
            print(f"batch {b + 1}/{n_batches} tokens={tokens} tokens/s={tokens / max(elapsed, 1e-9):.0f}",
                  flush=True)
    for h in handles:
        h.remove()

    meta = dict(
        model=MODEL,
        tokens=dict(all=int(stats["N"]), chat=int(stats["N_chat"]), reply=int(stats["N_reply"]),
                    reply_start=int(stats["N_start"])),
        n_corpus=len(corpus), n_chat=len(chats), adapters={s["name"]: s for s in specs},
        pairs=[[names[i], names[j]] for i, j in pairs],
        chat=[dict(trait=it["trait"], prompt=it["prompt"], reply=it["reply"],
                   prompt_tokens=it["prompt_len"], reply_tokens=it["reply_len"]) for it in chats],
        args=vars(a))
    write_outputs(a.out, stats, names, pairs, pair_acc, meta)
    print(f"wrote {a.out}", flush=True)
    if a.upload:
        owner, repo, folder = a.upload.split("/", 2)
        HfApi().upload_folder(folder_path=a.out, path_in_repo=folder, repo_id=f"{owner}/{repo}",
                              repo_type="dataset", commit_message="persona adapter MLP neuron movements")
        print("UPLOADED", flush=True)


if __name__ == "__main__":
    main()
