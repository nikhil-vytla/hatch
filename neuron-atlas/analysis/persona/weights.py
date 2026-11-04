"""Read OCEAN persona LoRA edits from weights alone, without a forward pass.

For Qwen/Qwen3-8B and the eleven persona adapters (o+, o-, c+, c-, e+, e-, a+, a-, n+, n-, ctrl), this reports
per-module relative Frobenius edit size, per-MLP-neuron gate/up/down relative edit size and down_proj cosine,
top singular directions of down_proj and o_proj decoded through the logit lens and J-lens, and cross-adapter
Frobenius cosine.  Writes neurons.parquet, modules.parquet, pairs.parquet and vocab.json.

Usage:
  python analysis/persona/weights.py --out persona_weights --device cuda
  python analysis/persona/weights.py --out pw --adapters o+,o-,ctrl --layers 0,18,35 --upload owner/repo/folder
"""
import argparse
import json
import math
import os
import re
from contextlib import ExitStack
from itertools import combinations

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import torch
from huggingface_hub import HfApi, hf_hub_download, snapshot_download
from safetensors import safe_open
from transformers import AutoTokenizer

MODEL = "Qwen/Qwen3-8B"
ADAPTER_REPO = "persona-cartography/monorepo"
LENS_REPO = "nikhilxvytla/neuron-atlas"
LENS_FILE = "lenses/Qwen__Qwen3-8B/j-lens.pt"
UPLOAD_REPO = "nikhilxvytla/neuron-atlas"
TRAITS = ["openness", "conscientiousness", "extraversion", "agreeableness", "neuroticism"]
SHORT = {"openness": "o", "conscientiousness": "c", "extraversion": "e",
         "agreeableness": "a", "neuroticism": "n"}
DIRECTIONS = ["amplifier", "suppressor"]
CONTROL_PREFIX = ("fine_tuning/qwen-3-8b-it/other/ocean_def_control/amplifier/"
                  "ocean_const_paired_dpo_nothink_s1vs2/lora/")
MLP_MODULES = ("gate_proj", "up_proj", "down_proj")
ATTN_MODULES = ("q_proj", "k_proj", "v_proj", "o_proj")
MODULES = MLP_MODULES + ATTN_MODULES
LENS_MODULES = ("down_proj", "o_proj")
METRICS = ("dgate", "dup", "ddown", "dcos")
TOPK = 15
TOP_SV = 3
LORA_RE = re.compile(
    r"(?:^|\.)layers\.(\d+)\.(mlp|self_attn)\."
    r"(gate_proj|up_proj|down_proj|q_proj|k_proj|v_proj|o_proj)\."
    r"lora_([AB])(?:\.[^.]+)*\.weight$")


def parse_args():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default="persona_weights")
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--adapters", default=None,
                    help="comma-separated names (o+, o-, c+, c-, e+, e-, a+, a-, n+, n-, ctrl); default all")
    ap.add_argument("--layers", default=None, help="comma-separated layers or ranges (e.g. 0,10-12); default all")
    ap.add_argument("--upload", default=None, help="owner/repo/folder or folder in nikhilxvytla/neuron-atlas")
    return ap.parse_args()


def adapter_name(trait, direction):
    return SHORT[trait] + ("+" if direction == "amplifier" else "-")


def find_persona_folder(files, prefix):
    folders = sorted({f[: -len("/adapter_config.json")] for f in files
                      if f.startswith(prefix) and f.endswith("-persona/adapter_config.json")})
    if not folders:
        raise FileNotFoundError(f"no *-persona adapter under {prefix}")
    if len(folders) > 1:
        print(f"warning: multiple *-persona folders under {prefix}; using {folders[0]}", flush=True)
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


def load_index():
    path = hf_hub_download(MODEL, "model.safetensors.index.json")
    with open(path) as f:
        return json.load(f)["weight_map"]


def n_model_layers(weight_map):
    layers = set()
    for name in weight_map:
        m = re.search(r"(?:^|\.)layers\.(\d+)\.", name)
        if m:
            layers.add(int(m.group(1)))
    if not layers:
        raise ValueError("no decoder layers in model.safetensors.index.json")
    return max(layers) + 1


def parse_layers(text, n_layers):
    if not text or text == "all":
        return list(range(n_layers))
    out = set()
    for chunk in text.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if "-" in chunk:
            lo, hi = chunk.split("-", 1)
            out.update(range(int(lo), int(hi) + 1))
        else:
            out.add(int(chunk))
    bad = sorted(L for L in out if L < 0 or L >= n_layers)
    if bad:
        raise ValueError(f"layers out of range 0..{n_layers - 1}: {bad}")
    return sorted(out)


def open_base(stack, weight_map, device):
    shard_files = sorted(set(weight_map.values()))
    paths = {f: hf_hub_download(MODEL, f) for f in shard_files}
    print(f"opened {len(shard_files)} base shards on {device}", flush=True)
    return {f: stack.enter_context(safe_open(paths[f], framework="pt", device=device))
            for f in shard_files}


def base_tensor(shards, weight_map, name):
    return shards[weight_map[name]].get_tensor(name).to(torch.float32)


def pattern_value(pattern, candidates):
    if not pattern:
        return None
    for key, value in pattern.items():
        if any(c == key or c.endswith("." + key) for c in candidates):
            return value
    for key, value in pattern.items():
        if any(re.match(key, c) for c in candidates):
            return value
    return None


def lora_scale(config, key, layer, module, actual_rank):
    family = "mlp" if module in MLP_MODULES else "self_attn"
    prefix = key.split(".lora_")[0]
    candidates = [prefix, f"model.layers.{layer}.{family}.{module}",
                  f"layers.{layer}.{family}.{module}", module]
    rank = pattern_value(config.get("rank_pattern") or {}, candidates)
    alpha = pattern_value(config.get("alpha_pattern") or {}, candidates)
    rank = actual_rank if rank is None else int(rank)
    alpha = float(config["lora_alpha"] if alpha is None else alpha)
    denom = math.sqrt(rank) if config.get("use_rslora") else rank
    return alpha / denom


def load_adapter(stack, spec, device):
    config_path = os.path.join(spec["path"], "adapter_config.json")
    with open(config_path) as f:
        config = json.load(f)
    weights_path = os.path.join(spec["path"], "adapter_model.safetensors")
    handle = stack.enter_context(safe_open(weights_path, framework="pt", device=device))
    entries = {}
    for key in handle.keys():
        m = LORA_RE.search(key)
        if not m:
            continue
        layer, family, module, which = int(m.group(1)), m.group(2), m.group(3), m.group(4)
        entry = entries.setdefault((layer, module), {"family": family})
        if which in entry:
            raise ValueError(f"duplicate lora_{which} for {spec['name']} layer {layer} {module}")
        entry[which] = key
    print(f"parsed {len(entries)} module pairs from {spec['name']}", flush=True)
    return dict(spec, config=config, handle=handle, entries=entries)


def load_lora(adapter, layer, module):
    entry = adapter["entries"].get((layer, module))
    if entry is None or "A" not in entry or "B" not in entry:
        raise KeyError(f"missing lora A/B for {adapter['name']} layer {layer} {module}")
    a = adapter["handle"].get_tensor(entry["A"]).to(torch.float32)
    b = adapter["handle"].get_tensor(entry["B"]).to(torch.float32)
    scale = lora_scale(adapter["config"], entry["A"], layer, module, a.shape[0])
    return a, b, scale


def delta_fro2(a, b, scale):
    ga = a @ a.T
    gb = b.T @ b
    return float(scale * scale * (gb * ga).sum())


def cross_inner(a1, b1, s1, a2, b2, s2):
    return float(s1 * s2 * ((b1.T @ b2) * (a1 @ a2.T)).sum())


def to_float16(x):
    return x.detach().cpu().numpy().astype(np.float16)


def neuron_metrics(w_gate, w_up, w_down, gate, up, down):
    a_gate, b_gate, s_gate = gate
    a_up, b_up, s_up = up
    a_down, b_down, s_down = down

    g_a_gate = a_gate @ a_gate.T
    gate_sq = ((b_gate @ g_a_gate) * b_gate).sum(1).clamp_min(0)
    d_gate = s_gate * gate_sq.sqrt() / w_gate.norm(dim=1)

    g_a_up = a_up @ a_up.T
    up_sq = ((b_up @ g_a_up) * b_up).sum(1).clamp_min(0)
    d_up = s_up * up_sq.sqrt() / w_up.norm(dim=1)

    g_b_down = b_down.T @ b_down
    down_sq = ((g_b_down @ a_down) * a_down).sum(0).clamp_min(0)
    down_norm = s_down * down_sq.sqrt()
    w_down_norm = w_down.norm(dim=0)
    d_down = down_norm / w_down_norm

    m = w_down.T @ b_down
    dot = s_down * (m * a_down.T).sum(1)
    d_cos = dot / (down_norm * w_down_norm)

    return tuple(to_float16(x) for x in (d_gate, d_up, d_down, d_cos))


def top_left_singular(a, b, scale):
    q, r = torch.linalg.qr(b, mode="reduced")
    u, sv, _ = torch.linalg.svd(r @ a, full_matrices=False)
    k = min(TOP_SV, sv.shape[0])
    return q @ u[:, :k], scale * sv[:k]


def top_tokens(logits, tokenizer):
    pos = torch.topk(logits, TOPK).indices.tolist()
    neg = torch.topk(logits, TOPK, largest=False).indices.tolist()
    return ([tokenizer.decode([int(i)]) for i in pos],
            [tokenizer.decode([int(i)]) for i in neg])


def decode_vectors(vectors, singular_values, lm_head, gamma, tokenizer, j_layer):
    out = []
    for k in range(vectors.shape[1]):
        u = vectors[:, k]
        logit_pos, logit_neg = top_tokens(lm_head @ (u * gamma), tokenizer)
        if j_layer is None:
            j_pos, j_neg = None, None
        else:
            j_pos, j_neg = top_tokens(lm_head @ ((j_layer @ u) * gamma), tokenizer)
        out.append(dict(sv=float(singular_values[k]), logit_pos=logit_pos, logit_neg=logit_neg,
                        j_pos=j_pos, j_neg=j_neg))
    return out


def add_module_rows(layer, module, weight, loras, adapters, ctx):
    fro2 = {}
    weight_norm = float(weight.norm())
    for adapter in adapters:
        name = adapter["name"]
        a, b, scale = loras[name][module]
        f2 = delta_fro2(a, b, scale)
        fro2[name] = f2
        ctx["module_rows"].append(dict(adapter=name, layer=layer, module=module,
                                       rel_fro=math.sqrt(f2) / weight_norm))
    names = [a["name"] for a in adapters]
    for i, j in combinations(range(len(names)), 2):
        n1, n2 = names[i], names[j]
        a1, b1, s1 = loras[n1][module]
        a2, b2, s2 = loras[n2][module]
        denom = math.sqrt(fro2[n1] * fro2[n2])
        cos = cross_inner(a1, b1, s1, a2, b2, s2) / denom if denom else 0.0
        ctx["pair_rows"].append(dict(layer=layer, module=module, a=n1, b=n2, cos=cos))


def add_vocab(layer, module, loras, adapters, ctx, j_layer):
    for adapter in adapters:
        name = adapter["name"]
        a, b, scale = loras[name][module]
        vectors, singular_values = top_left_singular(a, b, scale)
        entries = decode_vectors(vectors, singular_values, ctx["lm_head"], ctx["gamma"],
                                 ctx["tokenizer"], j_layer)
        ctx["vocab"].setdefault(name, {}).setdefault(str(layer), {})[module] = entries


def add_neuron_metrics(ctx, name, layer, metrics):
    for metric, values in zip(METRICS, metrics):
        ctx["neuron_store"][f"{name}_{metric}"].append(values)
    d_down = metrics[2].astype(np.float32)
    for i in np.argsort(-d_down)[:5]:
        ctx["tops"].setdefault(name, []).append((float(d_down[i]), layer, int(i)))
    ctx["tops"][name] = sorted(ctx["tops"][name], reverse=True)[:5]


def process_mlp_layer(layer, adapters, ctx, j_layer):
    weights = {m: base_tensor(ctx["shards"], ctx["weight_map"],
                              f"model.layers.{layer}.mlp.{m}.weight") for m in MLP_MODULES}
    loras = {a["name"]: {m: load_lora(a, layer, m) for m in MLP_MODULES} for a in adapters}
    for module in MLP_MODULES:
        add_module_rows(layer, module, weights[module], loras, adapters, ctx)
        if module in LENS_MODULES:
            add_vocab(layer, module, loras, adapters, ctx, j_layer)
    for adapter in adapters:
        name = adapter["name"]
        metrics = neuron_metrics(weights["gate_proj"], weights["up_proj"], weights["down_proj"],
                                 loras[name]["gate_proj"], loras[name]["up_proj"],
                                 loras[name]["down_proj"])
        add_neuron_metrics(ctx, name, layer, metrics)
    del weights, loras


def process_attn_layer(layer, adapters, ctx, j_layer):
    for module in ATTN_MODULES:
        weight = base_tensor(ctx["shards"], ctx["weight_map"],
                             f"model.layers.{layer}.self_attn.{module}.weight")
        loras = {a["name"]: {module: load_lora(a, layer, module)} for a in adapters}
        add_module_rows(layer, module, weight, loras, adapters, ctx)
        if module in LENS_MODULES:
            add_vocab(layer, module, loras, adapters, ctx, j_layer)
        del weight, loras


def load_j_lens():
    path = hf_hub_download(LENS_REPO, LENS_FILE, repo_type="dataset")
    obj = torch.load(path, map_location="cpu", weights_only=True)
    J = obj["J"] if isinstance(obj, dict) and "J" in obj else obj
    return {int(k): v for k, v in J.items()}


def write_neurons(out, layers, store, names):
    n_neurons = len(store[f"{names[0]}_{METRICS[0]}"][0])
    columns = {
        "layer": np.repeat(np.asarray(layers, dtype=np.int16), n_neurons),
        "neuron": np.tile(np.arange(n_neurons, dtype=np.int32), len(layers)),
    }
    for name in names:
        for metric in METRICS:
            columns[f"{name}_{metric}"] = np.concatenate(store[f"{name}_{metric}"])
    table = pa.table(columns)
    path = os.path.join(out, "neurons.parquet")
    pq.write_table(table, path)
    print(f"wrote {path} ({table.num_rows} rows)", flush=True)


def write_modules(out, rows):
    table = pa.table({
        "adapter": pa.array([r["adapter"] for r in rows], type=pa.string()),
        "layer": pa.array([r["layer"] for r in rows], type=pa.int16()),
        "module": pa.array([r["module"] for r in rows], type=pa.string()),
        "rel_fro": pa.array([r["rel_fro"] for r in rows], type=pa.float32()),
    })
    path = os.path.join(out, "modules.parquet")
    pq.write_table(table, path)
    print(f"wrote {path} ({table.num_rows} rows)", flush=True)


def write_pairs(out, rows):
    table = pa.table({
        "layer": pa.array([r["layer"] for r in rows], type=pa.int16()),
        "module": pa.array([r["module"] for r in rows], type=pa.string()),
        "a": pa.array([r["a"] for r in rows], type=pa.string()),
        "b": pa.array([r["b"] for r in rows], type=pa.string()),
        "cos": pa.array([r["cos"] for r in rows], type=pa.float32()),
    })
    path = os.path.join(out, "pairs.parquet")
    pq.write_table(table, path)
    print(f"wrote {path} ({table.num_rows} rows)", flush=True)


def write_vocab(out, vocab):
    path = os.path.join(out, "vocab.json")
    with open(path, "w") as f:
        json.dump(vocab, f)
    print(f"wrote {path}", flush=True)


def upload_folder(out, spec):
    parts = [p for p in spec.strip("/").split("/") if p]
    if len(parts) >= 3:
        repo, path = "/".join(parts[:2]), "/".join(parts[2:])
    else:
        repo, path = UPLOAD_REPO, "/".join(parts)
    HfApi().upload_folder(folder_path=out, repo_id=repo, repo_type="dataset", path_in_repo=path)
    print(f"uploaded {out} -> {repo}:{path}", flush=True)


def print_summaries(adapters, ctx):
    by = {}
    for row in ctx["module_rows"]:
        by.setdefault(row["adapter"], {}).setdefault(row["module"], []).append(row["rel_fro"])
    for adapter in adapters:
        name = adapter["name"]
        means = {m: float(np.mean(v)) for m, v in by.get(name, {}).items()}
        mlp = float(np.mean([means[m] for m in MLP_MODULES]))
        attn = float(np.mean([means[m] for m in ATTN_MODULES]))
        detail = " ".join(f"{m}={means[m]:.4f}" for m in MODULES if m in means)
        top = ", ".join(f"L{L}N{n}={v:.4f}" for v, L, n in ctx["tops"].get(name, [])[:5])
        print(f"{name}: mlp={mlp:.4f} attn={attn:.4f} [{detail}] | top d_down: {top}", flush=True)


def main():
    args = parse_args()
    print(f"device {args.device}", flush=True)
    files = HfApi().list_repo_files(ADAPTER_REPO, repo_type="dataset")
    specs = download_adapters(select_adapters(adapter_specs(files), args.adapters))
    weight_map = load_index()
    n_layers = n_model_layers(weight_map)
    layers = parse_layers(args.layers, n_layers)
    print(f"{len(specs)} adapters, {len(layers)} layers of {n_layers}", flush=True)

    tokenizer = AutoTokenizer.from_pretrained(MODEL)
    J = load_j_lens()
    print(f"loaded J-lens for {len(J)} layers", flush=True)

    ctx = dict(module_rows=[], pair_rows=[], vocab={}, tops={}, neuron_store={},
               tokenizer=tokenizer, weight_map=weight_map)
    for spec in specs:
        for metric in METRICS:
            ctx["neuron_store"][f"{spec['name']}_{metric}"] = []

    with ExitStack() as stack:
        ctx["shards"] = open_base(stack, weight_map, args.device)
        adapters = [load_adapter(stack, spec, args.device) for spec in specs]
        ctx["lm_head"] = base_tensor(ctx["shards"], weight_map, "lm_head.weight")
        ctx["gamma"] = base_tensor(ctx["shards"], weight_map, "model.norm.weight")
        print(f"lm_head {tuple(ctx['lm_head'].shape)} norm {tuple(ctx['gamma'].shape)}", flush=True)
        for layer in layers:
            j_layer = J[layer].to(args.device, torch.float32) if layer in J else None
            print(f"layer {layer}", flush=True)
            process_mlp_layer(layer, adapters, ctx, j_layer)
            process_attn_layer(layer, adapters, ctx, j_layer)
            del j_layer

    os.makedirs(args.out, exist_ok=True)
    names = [spec["name"] for spec in specs]
    write_neurons(args.out, layers, ctx["neuron_store"], names)
    write_modules(args.out, ctx["module_rows"])
    write_pairs(args.out, ctx["pair_rows"])
    write_vocab(args.out, ctx["vocab"])
    print_summaries(adapters, ctx)
    if args.upload:
        upload_folder(args.out, args.upload)


if __name__ == "__main__":
    main()
