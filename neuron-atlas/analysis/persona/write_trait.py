"""Write Big Five traits into Qwen3-8B at inference time and compare intervention families.

Usage:
  python analysis/persona/write_trait.py --out persona_write --traits neuroticism,openness \
      --acts persona_acts/neurons.parquet --lexicon persona_lexicon.json --upload owner/repo/folder

Interventions are hooks on the base Qwen/Qwen3-8B model (bf16, cuda): residual steering, DPN-style
top-neuron pushes, activation-study neurons, J-lens pole neurons and an amplifier LoRA reference.
Writes replies.parquet, mmlu.json, selections.json and meta.json.
"""
import argparse
import json
import math
import os
import random
from contextlib import contextmanager

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import torch
from huggingface_hub import HfApi, hf_hub_download, snapshot_download
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

MODEL = "Qwen/Qwen3-8B"
ADAPTER_REPO = "persona-cartography/monorepo"
MMLU_REPO = "cais/mmlu"
TRAITS = ["openness", "conscientiousness", "extraversion", "agreeableness", "neuroticism"]
SHORT = {"openness": "o", "conscientiousness": "c", "extraversion": "e",
         "agreeableness": "a", "neuroticism": "n"}
LETTER = {v: k for k, v in SHORT.items()}
CONTROL_PREFIX = ("fine_tuning/qwen-3-8b-it/other/ocean_def_control/amplifier/"
                  "ocean_const_paired_dpo_nothink_s1vs2/lora/")
GENERAL_PROMPTS = [
    "Tell me about your weekend plans.",
    "How should I prepare for a job interview?",
    "What do you think about rainy days?",
    "Can you recommend a good book?",
    "How do I cook pasta for four people?",
    "What should I know before moving to a new city?",
    "Why do leaves change color in autumn?",
    "How can I improve my sleep routine?",
    "What is a good way to learn a new language?",
    "Tell me a fun fact about the ocean.",
    "How do I change a flat tire?",
    "What are some tips for saving money?",
    "How does a bill become a law?",
    "What should I plant in a small garden?",
    "How do I make a simple breakfast?",
    "What is the best way to organize a closet?",
    "Can you explain how the internet works?",
    "What are some good exercises for beginners?",
    "How do I prepare for a long flight?",
    "What is a memorable way to celebrate a birthday?",
]
METHOD_STRENGTHS = {
    "base": [0.0],
    "lora": [0.5, 1.0, 1.5],
    "steer": [0.5, 1.0, 2.0],
    "dpn": [1.0, 2.0, 4.0],
    "adapter": [1.0, 2.0, 4.0],
    "lens": [0.5, 1.0, 2.0],
}
TEST_STRENGTHS = {
    "base": [0.0],
    "lora": [1.0],
    "steer": [1.0],
    "dpn": [2.0],
    "adapter": [2.0],
    "lens": [1.0],
}


def parse_args():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default="persona_write_trait")
    ap.add_argument("--traits", default="neuroticism,openness")
    ap.add_argument("--n-train", type=int, default=600)
    ap.add_argument("--n-eval", type=int, default=40)
    ap.add_argument("--n-mmlu", type=int, default=200)
    ap.add_argument("--steer-layer", type=int, default=18)
    ap.add_argument("--acts", default=None, help="neurons.parquet written by analysis/persona/acts.py")
    ap.add_argument("--lexicon", default=None, help="JSON written by analysis/persona/lexicon.py")
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--gen-batch", type=int, default=8)
    ap.add_argument("--mmlu-batch", type=int, default=16)
    ap.add_argument("--max-new", type=int, default=120)
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--upload", default=None, help="owner/repo/folder")
    ap.add_argument("--test", action="store_true", help="1 trait, 8 train pairs, 4 eval prompts, 10 MMLU")
    return ap.parse_args()


def normalize_traits(text):
    out = []
    for raw in text.split(","):
        name = raw.strip().lower()
        if not name:
            continue
        if name in LETTER:
            name = LETTER[name]
        if name not in SHORT:
            raise ValueError(f"unknown trait {raw!r}; choose from {TRAITS} or {sorted(LETTER)}")
        if name not in out:
            out.append(name)
    if not out:
        raise ValueError("no traits requested")
    return out


def adapter_name(trait):
    return SHORT[trait] + "+"


def find_persona_folder(files, prefix):
    folders = sorted({f[: -len("/adapter_config.json")] for f in files
                      if f.startswith(prefix) and f.endswith("-persona/adapter_config.json")})
    if not folders:
        raise FileNotFoundError(f"no *-persona adapter under {prefix}")
    if len(folders) > 1:
        print(f"warning: multiple *-persona folders under {prefix}; using {folders[0]}", flush=True)
    return folders[0]


def download_adapters(traits, files):
    specs = []
    for trait in traits:
        prefix = (f"fine_tuning/qwen-3-8b-it/ocean/{trait}/amplifier/"
                  "ocean_const_paired_dpo_nothink/lora/")
        spec = dict(trait=trait, name=adapter_name(trait), folder=find_persona_folder(files, prefix))
        root = snapshot_download(ADAPTER_REPO, repo_type="dataset",
                                 allow_patterns=[spec["folder"] + "*"])
        spec["path"] = os.path.join(root, spec["folder"])
        if not os.path.isdir(spec["path"]):
            raise FileNotFoundError(spec["path"])
        print(f"adapter {spec['name']} -> {spec['path']}", flush=True)
        specs.append(spec)
    return specs


def load_trait_data(trait, n_train, n_eval):
    path = (f"fine_tuning/qwen-3-8b-it/ocean/{trait}/amplifier/ocean_const_paired_dpo_nothink/"
            f"data/distillation/{trait}_amplifying_full.jsonl")
    local = hf_hub_download(ADAPTER_REPO, path, repo_type="dataset")
    rows = []
    with open(local) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            prompt = obj.get("prompt")
            high = obj.get("response")
            low = obj.get("qwen-3-8b-it")
            if prompt and high and low:
                rows.append(dict(prompt=prompt, high=high, low=low))
    if len(rows) <= n_eval:
        raise ValueError(f"{trait}: only {len(rows)} usable rows, need more than {n_eval} eval prompts")
    random.Random(0).shuffle(rows)
    held = rows[-n_eval:]
    usable = len(rows) - n_eval
    train = rows[: min(n_train, usable)]
    return train, [r["prompt"] for r in held]


def template_ids(tokenizer, messages, add_generation_prompt):
    ids = tokenizer.apply_chat_template(messages, add_generation_prompt=add_generation_prompt,
                                        enable_thinking=False, tokenize=True)
    if not isinstance(ids, list):
        ids = ids["input_ids"]
    return [int(t) for t in ids]


def encode_chat_prompt(tokenizer, prompt):
    return template_ids(tokenizer, [{"role": "user", "content": prompt}], True)


def encode_answer(tokenizer, prompt, answer):
    user = [{"role": "user", "content": prompt}]
    prompt_ids = template_ids(tokenizer, user, True)
    full_ids = template_ids(tokenizer, user + [{"role": "assistant", "content": answer}], False)
    if full_ids[: len(prompt_ids)] != prompt_ids:
        raise ValueError("chat-template prompt is not a prefix of the full conversation")
    start = len(prompt_ids)
    if start >= len(full_ids):
        raise ValueError("assistant answer produced no tokens")
    return full_ids, start


def load_mmlu(n_rows):
    files = HfApi().list_repo_files(MMLU_REPO, repo_type="dataset")
    test_files = sorted(f for f in files
                        if f.startswith("all/") and "test" in f and f.endswith(".parquet"))
    if not test_files:
        raise FileNotFoundError("no all/test parquet file in cais/mmlu")
    rows = []
    for name in test_files:
        path = hf_hub_download(MMLU_REPO, name, repo_type="dataset")
        rows.extend(pq.read_table(path).to_pylist())
    random.Random(0).shuffle(rows)
    if len(rows) < n_rows:
        raise ValueError(f"cais/mmlu test has {len(rows)} rows, need {n_rows}")
    return rows[:n_rows]


def mmlu_prompt(row):
    letters = "ABCD"
    options = "\n".join(f"{letters[i]}. {row['choices'][i]}" for i in range(4))
    return f"Question: {row['question']}\n\n{options}\n\nAnswer:"


def mmlu_items(tokenizer, rows):
    return [dict(ids=encode_chat_prompt(tokenizer, mmlu_prompt(row)), answer=int(row["answer"]))
            for row in rows]


def option_token_ids(tokenizer):
    ids = []
    for letter in "ABCD":
        toks = tokenizer.encode(" " + letter, add_special_tokens=False)
        if len(toks) != 1:
            raise ValueError(f"option ' {letter}' is {len(toks)} tokens, expected one")
        ids.append(int(toks[0]))
    return ids


def collate_teacher(items, pad_id, device):
    width = max(len(it["ids"]) for it in items)
    ids = torch.full((len(items), width), pad_id, dtype=torch.long, device=device)
    attn = torch.zeros((len(items), width), dtype=torch.long, device=device)
    mask = torch.zeros((len(items), width), dtype=torch.bool, device=device)
    for i, it in enumerate(items):
        n = len(it["ids"])
        ids[i, :n] = torch.tensor(it["ids"], dtype=torch.long, device=device)
        attn[i, :n] = 1
        mask[i, it["start"]:n] = True
    return ids, attn, mask


def masked_mean(x, mask):
    m = mask.to(torch.float32)
    den = m.sum(1).clamp_min(1.0)
    return (x.float() * m.unsqueeze(-1)).sum(1) / den.unsqueeze(-1)


def new_feature_stats(n_layers, d_mlp, d_model, device):
    def zeros(*shape):
        return torch.zeros(shape, dtype=torch.float32, device=device)

    return dict(
        n=0,
        neuron_sum=zeros(n_layers, d_mlp),
        neuron_sq=zeros(n_layers, d_mlp),
        neuron_abs=zeros(n_layers, d_mlp),
        resid_sum=zeros(n_layers, d_model),
        resid_sq=zeros(n_layers, d_model),
        resid_norms=[[] for _ in range(n_layers)],
    )


def make_mlp_hook(layer, state):
    def hook(module, args):
        per = masked_mean(args[0], state["mask"])
        stats = state["stats"]
        stats["neuron_sum"][layer].add_(per.sum(0))
        stats["neuron_sq"][layer].add_((per * per).sum(0))
        stats["neuron_abs"][layer].add_(per.abs().sum(0))

    return hook


def make_resid_hook(layer, state):
    def hook(module, args, output):
        hidden = output[0] if isinstance(output, tuple) else output
        per = masked_mean(hidden, state["mask"])
        stats = state["stats"]
        stats["resid_sum"][layer].add_(per.sum(0))
        stats["resid_sq"][layer].add_((per * per).sum(0))
        stats["resid_norms"][layer].extend(per.norm(dim=-1).tolist())

    return hook


def extract_group(model, layers, items, stats, batch, pad_id, device):
    if not items:
        raise ValueError("no teacher-forced examples")
    state = dict(mask=None, stats=stats)
    handles = []
    for layer, module in enumerate(layers):
        handles.append(module.mlp.down_proj.register_forward_pre_hook(make_mlp_hook(layer, state)))
        handles.append(module.register_forward_hook(make_resid_hook(layer, state)))
    try:
        with model.disable_adapter(), torch.no_grad():
            for start in range(0, len(items), batch):
                chunk = items[start:start + batch]
                ids, attn, mask = collate_teacher(chunk, pad_id, device)
                state["mask"] = mask
                model(input_ids=ids, attention_mask=attn, use_cache=False)
                stats["n"] += len(chunk)
                print(f"features {min(start + batch, len(items))}/{len(items)}", flush=True)
    finally:
        for handle in handles:
            handle.remove()


def summarize_features(high, low, n_layers):
    n_high = high["n"]
    n_low = low["n"]
    if not n_high or not n_low:
        raise ValueError("feature extraction produced no examples")
    mu_high = high["neuron_sum"] / n_high
    mu_low = low["neuron_sum"] / n_low
    var_high = ((high["neuron_sq"] - n_high * mu_high * mu_high) /
                max(n_high - 1, 1)).clamp_min(0)
    var_low = ((low["neuron_sq"] - n_low * mu_low * mu_low) /
               max(n_low - 1, 1)).clamp_min(0)
    pooled = (((n_high - 1) * var_high + (n_low - 1) * var_low) /
              max(n_high + n_low - 2, 1)).sqrt()
    d = (mu_high - mu_low) / pooled.clamp_min(1e-12)
    mean_abs = (high["neuron_abs"] + low["neuron_abs"]) / (n_high + n_low)
    resid_diff = high["resid_sum"] / n_high - low["resid_sum"] / n_low
    medians = []
    for layer in range(n_layers):
        vals = high["resid_norms"][layer] + low["resid_norms"][layer]
        if not vals:
            raise ValueError(f"no residual norms for layer {layer}")
        medians.append(float(np.median(vals)))
    return dict(n_high=n_high, n_low=n_low, mu_high=mu_high, mu_low=mu_low, d=d,
                mean_abs=mean_abs, resid_diff=resid_diff, resid_medians=medians)


def select_dpn(summary, n_layers, d_mlp, device):
    d = summary["d"]
    mean_abs = summary["mean_abs"]
    eligible = mean_abs > mean_abs.median(dim=1).values[:, None]
    k_target = max(1, int(round(0.005 * n_layers * d_mlp)))
    flat = torch.nonzero(eligible.reshape(-1), as_tuple=False).squeeze(1)
    if not flat.numel():
        raise ValueError("no DPN-eligible neurons")
    vals = d.reshape(-1)[flat].abs()
    k = min(k_target, int(flat.numel()))
    top = torch.topk(vals, k).indices
    selected = flat[top]
    selected_vals = vals[top]
    diff = summary["mu_high"] - summary["mu_low"]
    records = []
    base_delta = {}
    for idx in selected.tolist():
        layer = idx // d_mlp
        neuron = idx % d_mlp
        dval = float(d[layer, neuron])
        records.append(dict(layer=layer, neuron=neuron, sign=1 if dval >= 0 else -1, d=dval))
        if layer not in base_delta:
            base_delta[layer] = torch.zeros(d_mlp, dtype=torch.float32, device=device)
        base_delta[layer][neuron] = diff[layer, neuron]
    info = dict(k=k, n_eligible=int(flat.numel()), max_abs_d=float(selected_vals.max()),
                median_abs_d_selected=float(selected_vals.median()))
    return records, base_delta, info


def select_adapter(path, letter, n_layers, d_mlp, device):
    schema = pq.read_schema(path)
    rel_col = f"{letter}+_rel"
    shift_col = f"{letter}+_shift"
    needed = ["layer", "neuron", "base_rms", rel_col, shift_col, "ctrl_rel"]
    missing = [name for name in needed if name not in schema.names]
    if missing:
        raise ValueError(f"{path} is missing columns {missing}")
    cols = pq.read_table(path, columns=needed).to_pydict()
    layer = torch.tensor(cols["layer"], dtype=torch.long, device=device)
    neuron = torch.tensor(cols["neuron"], dtype=torch.long, device=device)
    rel = torch.tensor(np.asarray(cols[rel_col], dtype=np.float32), dtype=torch.float32, device=device)
    shift = torch.tensor(np.asarray(cols[shift_col], dtype=np.float32), dtype=torch.float32, device=device)
    base_rms = torch.tensor(np.asarray(cols["base_rms"], dtype=np.float32), dtype=torch.float32, device=device)
    ctrl = torch.tensor(np.asarray(cols["ctrl_rel"], dtype=np.float32), dtype=torch.float32, device=device)
    idx = torch.nonzero(ctrl < 0.5 * rel, as_tuple=False).squeeze(1)
    if not idx.numel():
        raise ValueError(f"{path} has no adapter neurons for {letter}")
    k_target = max(1, int(round(0.005 * n_layers * d_mlp)))
    k = min(k_target, int(idx.numel()))
    top = torch.topk(rel[idx], k).indices
    selected = idx[top]
    coef = shift * base_rms
    records = []
    base_delta = {}
    for j in selected.tolist():
        layer_j = int(layer[j])
        neuron_j = int(neuron[j])
        value = float(coef[j])
        records.append(dict(layer=layer_j, neuron=neuron_j, sign=1 if value >= 0 else -1,
                            rel=float(rel[j]), shift=float(shift[j]),
                            base_rms=float(base_rms[j]), coef=value))
        if layer_j not in base_delta:
            base_delta[layer_j] = torch.zeros(d_mlp, dtype=torch.float32, device=device)
        base_delta[layer_j][neuron_j] += coef[j]
    info = dict(k=k, n_eligible=int(idx.numel()), max_rel=float(rel[selected].max()),
                median_rel_selected=float(rel[selected].median()))
    return records, base_delta, info


def select_lens(path, letter, n_layers, d_mlp, resid_medians, layers, device):
    with open(path) as f:
        obj = json.load(f)
    rows = obj.get("neurons")
    if not isinstance(rows, list):
        raise ValueError(f"{path} has no 'neurons' list")
    key = letter.upper() + "+"
    candidates = []
    for row in rows:
        layer = int(row["layer"])
        neuron = int(row["neuron"])
        if layer < 6 or layer >= n_layers or neuron < 0 or neuron >= d_mlp:
            continue
        up = row.get("up") or {}
        down = row.get("down") or {}
        if key in up:
            sign = 1
        elif key in down:
            sign = -1
        else:
            continue
        candidates.append((layer, neuron, sign))
    n_candidates = len(candidates)
    candidates.sort(key=lambda item: (-item[0], item[1]))
    candidates = candidates[:64]
    records = []
    base_delta = {}
    for layer, neuron, sign in candidates:
        weight = layers[layer].mlp.down_proj.weight
        norm = float(weight[:, neuron].float().norm().item())
        coef = sign * resid_medians[layer] / max(norm, 1e-12)
        records.append(dict(layer=layer, neuron=neuron, sign=sign,
                            coef_base=coef, w_down_norm=norm))
        if layer not in base_delta:
            base_delta[layer] = torch.zeros(d_mlp, dtype=torch.float32, device=device)
        base_delta[layer][neuron] += coef
    info = dict(k=len(candidates), n_candidates=n_candidates)
    if candidates:
        info["max_layer"] = max(item[0] for item in candidates)
        info["min_layer"] = min(item[0] for item in candidates)
    return records, base_delta, info


@contextmanager
def neuron_hooks(base_model, deltas):
    handles = []
    layers = base_model.model.layers
    for layer, delta in deltas.items():
        def make(d):
            def hook(module, args):
                x = args[0]
                return (x + d.to(x.dtype),) + tuple(args[1:])
            return hook
        handles.append(layers[layer].mlp.down_proj.register_forward_pre_hook(make(delta)))
    try:
        yield
    finally:
        for handle in handles:
            handle.remove()


@contextmanager
def steer_hooks(base_model, layer, delta):
    def hook(module, args, output):
        hidden = output[0] if isinstance(output, tuple) else output
        new = hidden + delta.to(hidden.dtype)
        if isinstance(output, tuple):
            return (new,) + output[1:]
        return new

    handle = base_model.model.layers[layer].register_forward_hook(hook)
    try:
        yield
    finally:
        handle.remove()


@contextmanager
def scaled_lora(model, name, strength):
    saved = []
    for module in model.modules():
        scaling = getattr(module, "scaling", None)
        if isinstance(scaling, dict) and name in scaling:
            saved.append((module, float(scaling[name])))
            scaling[name] = scaling[name] * strength
    try:
        yield
    finally:
        for module, value in saved:
            module.scaling[name] = value


@contextmanager
def run_condition(model, base_model, method, strength, ctx):
    if method == "lora":
        model.set_adapter(ctx["adapter_name"])
        with scaled_lora(model, ctx["adapter_name"], strength):
            yield
        return
    with model.disable_adapter():
        if method == "base":
            yield
        elif method == "steer":
            delta = ctx["steer_unit"] * (strength * ctx["resid_norm"])
            with steer_hooks(base_model, ctx["steer_layer"], delta):
                yield
        elif method in ("dpn", "adapter", "lens"):
            if method == "lens" and not ctx["k"]:
                yield
            else:
                factor = strength / math.sqrt(ctx["k"]) if method == "lens" else strength
                deltas = {layer: delta * factor for layer, delta in ctx["base_delta"].items()}
                with neuron_hooks(base_model, deltas):
                    yield
        else:
            raise ValueError(f"unknown method {method}")


@torch.no_grad()
def generate_replies(model, tokenizer, items, batch, max_new, pad_id, device):
    rows = []
    for start in range(0, len(items), batch):
        chunk = items[start:start + batch]
        width = max(len(it["ids"]) for it in chunk)
        inp = torch.full((len(chunk), width), pad_id, dtype=torch.long, device=device)
        attn = torch.zeros((len(chunk), width), dtype=torch.long, device=device)
        for i, it in enumerate(chunk):
            ids = it["ids"]
            inp[i, width - len(ids):] = torch.tensor(ids, dtype=torch.long, device=device)
            attn[i, width - len(ids):] = 1
        gen = model.generate(input_ids=inp, attention_mask=attn, max_new_tokens=max_new,
                             do_sample=False, pad_token_id=pad_id)
        for it, seq in zip(chunk, gen):
            new = [int(t) for t in seq[width:].tolist()]
            reply = []
            for token in new:
                if token == tokenizer.eos_token_id:
                    break
                reply.append(token)
            text = tokenizer.decode(reply, skip_special_tokens=True).strip()
            rows.append(dict(kind=it["kind"], prompt=it["prompt"], reply=text))
        print(f"replies {min(start + batch, len(items))}/{len(items)}", flush=True)
    return rows


@torch.no_grad()
def mmlu_accuracy(model, items, option_ids, batch, pad_id, device):
    if not items:
        return 0.0
    correct = 0
    for start in range(0, len(items), batch):
        chunk = items[start:start + batch]
        width = max(len(it["ids"]) for it in chunk)
        inp = torch.full((len(chunk), width), pad_id, dtype=torch.long, device=device)
        attn = torch.zeros((len(chunk), width), dtype=torch.long, device=device)
        for i, it in enumerate(chunk):
            ids = it["ids"]
            inp[i, width - len(ids):] = torch.tensor(ids, dtype=torch.long, device=device)
            attn[i, width - len(ids):] = 1
        logits = model(input_ids=inp, attention_mask=attn, use_cache=False).logits[:, -1, :].float()
        pred = logits[:, option_ids].argmax(dim=-1).tolist()
        correct += sum(int(p == it["answer"]) for p, it in zip(pred, chunk))
        print(f"mmlu {min(start + batch, len(items))}/{len(items)}", flush=True)
    return correct / len(items)


def prompt_items(tokenizer, held, general):
    items = [dict(kind="held", prompt=prompt, ids=encode_chat_prompt(tokenizer, prompt))
             for prompt in held]
    items += [dict(kind="general", prompt=prompt, ids=encode_chat_prompt(tokenizer, prompt))
              for prompt in general]
    return items


def write_outputs(out, replies, mmlu, selections, meta):
    table = pa.table({
        "trait": pa.array([r["trait"] for r in replies], type=pa.string()),
        "method": pa.array([r["method"] for r in replies], type=pa.string()),
        "strength": pa.array([r["strength"] for r in replies], type=pa.float32()),
        "prompt_kind": pa.array([r["prompt_kind"] for r in replies], type=pa.string()),
        "prompt": pa.array([r["prompt"] for r in replies], type=pa.string()),
        "reply": pa.array([r["reply"] for r in replies], type=pa.string()),
    })
    pq.write_table(table, os.path.join(out, "replies.parquet"), compression="zstd")
    with open(os.path.join(out, "mmlu.json"), "w") as f:
        json.dump(mmlu, f, indent=2)
    with open(os.path.join(out, "selections.json"), "w") as f:
        json.dump(selections, f, indent=2)
    with open(os.path.join(out, "meta.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print(f"wrote {out}", flush=True)


def main():
    args = parse_args()
    traits = normalize_traits(args.traits)
    if args.test:
        traits = traits[:1]
        args.n_train = 8
        args.n_eval = 4
        args.n_mmlu = 10
    args.traits = ",".join(traits)
    os.makedirs(args.out, exist_ok=True)
    if args.device.startswith("cuda") and not torch.cuda.is_available():
        raise RuntimeError("cuda requested but not available")
    print(f"traits {traits}", flush=True)

    files = HfApi().list_repo_files(ADAPTER_REPO, repo_type="dataset")
    specs = download_adapters(traits, files)
    by_trait = {spec["trait"]: spec for spec in specs}

    tokenizer = AutoTokenizer.from_pretrained(MODEL)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "left"
    pad_id = tokenizer.pad_token_id
    option_ids = option_token_ids(tokenizer)

    base = AutoModelForCausalLM.from_pretrained(MODEL, torch_dtype=torch.bfloat16,
                                                device_map=args.device)
    model = PeftModel.from_pretrained(base, specs[0]["path"], adapter_name=specs[0]["name"])
    for spec in specs[1:]:
        model.load_adapter(spec["path"], adapter_name=spec["name"])
    model.eval()
    layers = base.model.layers
    n_layers = base.config.num_hidden_layers
    d_mlp = base.config.intermediate_size
    d_model = base.config.hidden_size
    if not 0 <= args.steer_layer < n_layers:
        raise ValueError(f"--steer-layer must be in 0..{n_layers - 1}")
    print(f"loaded {MODEL}: {n_layers} layers, d_model {d_model}, d_mlp {d_mlp}", flush=True)

    mmlu_rows = load_mmlu(args.n_mmlu)
    mmlu_eval = mmlu_items(tokenizer, mmlu_rows)
    strengths = TEST_STRENGTHS if args.test else METHOD_STRENGTHS

    all_replies = []
    mmlu_out = {}
    selections_out = {}
    meta_traits = {}

    for trait in traits:
        print(f"=== {trait} ===", flush=True)
        train_rows, held = load_trait_data(trait, args.n_train, args.n_eval)
        print(f"{len(train_rows)} train pairs, {len(held)} held-out prompts", flush=True)

        high_items = []
        low_items = []
        for row in train_rows:
            ids, start = encode_answer(tokenizer, row["prompt"], row["high"])
            high_items.append(dict(ids=ids, start=start))
            ids, start = encode_answer(tokenizer, row["prompt"], row["low"])
            low_items.append(dict(ids=ids, start=start))

        high_stats = new_feature_stats(n_layers, d_mlp, d_model, args.device)
        low_stats = new_feature_stats(n_layers, d_mlp, d_model, args.device)
        extract_group(model, layers, high_items, high_stats, args.batch, pad_id, args.device)
        extract_group(model, layers, low_items, low_stats, args.batch, pad_id, args.device)
        summary = summarize_features(high_stats, low_stats, n_layers)
        # the atlas's per-token median residual norms (the unit of every push in the project); the per-example
        # mean vectors above are shorter than single tokens' residuals, so they are kept only for reference
        resid_medians = [float(x) for x in json.load(open(hf_hub_download(
            "nikhilxvytla/neuron-atlas", "Qwen__Qwen3-8B/meta.json", repo_type="dataset")))["resid_median"]]

        dpn_records, dpn_delta, dpn_info = select_dpn(summary, n_layers, d_mlp, args.device)
        selection = {
            "base": dict(method="base", k=0),
            "lora": dict(method="lora", k=0, adapter=by_trait[trait]["name"],
                         folder=by_trait[trait]["folder"]),
            "dpn": dict(method="dpn", k=dpn_info["k"], selected=dpn_records, stats=dpn_info),
        }
        contexts = {
            "base": {},
            "lora": dict(adapter_name=by_trait[trait]["name"]),
            "dpn": dict(k=dpn_info["k"], base_delta=dpn_delta),
        }

        steer_layer = args.steer_layer
        steer_vec = summary["resid_diff"][steer_layer].float()
        steer_norm = float(steer_vec.norm().item())
        if steer_norm < 1e-12:
            raise ValueError(f"{trait}: zero residual-difference vector at layer {steer_layer}")
        steer_unit = steer_vec / steer_norm
        resid_norm = resid_medians[steer_layer]
        selection["steer"] = dict(
            method="steer", layer=steer_layer, resid_norm=resid_norm,
            diff_norm=steer_norm,
            norm_by_strength={f"{s:g}": s * resid_norm for s in strengths["steer"]},
            unit=[float(x) for x in steer_unit.tolist()],
        )
        contexts["steer"] = dict(steer_layer=steer_layer, steer_unit=steer_unit,
                                 resid_norm=resid_norm)

        method_order = ["base", "lora", "steer", "dpn"]
        if args.acts:
            ad_records, ad_delta, ad_info = select_adapter(args.acts, SHORT[trait],
                                                           n_layers, d_mlp, args.device)
            selection["adapter"] = dict(method="adapter", k=ad_info["k"],
                                        selected=ad_records, stats=ad_info)
            contexts["adapter"] = dict(k=ad_info["k"], base_delta=ad_delta)
            method_order.append("adapter")
        if args.lexicon:
            lens_records, lens_delta, lens_info = select_lens(
                args.lexicon, SHORT[trait], n_layers, d_mlp, resid_medians, layers, args.device)
            selection["lens"] = dict(method="lens", k=lens_info["k"],
                                     selected=lens_records, stats=lens_info)
            contexts["lens"] = dict(k=lens_info["k"], base_delta=lens_delta)
            method_order.append("lens")
        selections_out[trait] = selection

        items = prompt_items(tokenizer, held, GENERAL_PROMPTS)
        for method in method_order:
            for strength in strengths[method]:
                with run_condition(model, base, method, strength, contexts[method]):
                    replies = generate_replies(model, tokenizer, items, args.gen_batch,
                                               args.max_new, pad_id, args.device)
                    accuracy = mmlu_accuracy(model, mmlu_eval, option_ids, args.mmlu_batch,
                                             pad_id, args.device)
                for row in replies:
                    all_replies.append(dict(trait=trait, method=method, strength=float(strength),
                                            prompt_kind=row["kind"], prompt=row["prompt"],
                                            reply=row["reply"]))
                mmlu_out[f"{trait}/{method}/{strength:g}"] = accuracy
                print(f"{trait} {method} {strength:g}: mmlu {accuracy:.4f}", flush=True)

        meta_traits[trait] = dict(
            n_train=len(train_rows), n_held=len(held), resid_medians=resid_medians,
            steer_layer=steer_layer, steer_resid_norm=resid_norm,
            selection_counts={name: value.get("k", 0) for name, value in selection.items()},
            adapter=by_trait[trait],
        )

    meta = dict(model=MODEL, args=vars(args), traits=traits, n_mmlu=len(mmlu_rows),
                option_token_ids=option_ids,
                resid_medians={trait: meta_traits[trait]["resid_medians"] for trait in traits},
                traits_detail=meta_traits)
    write_outputs(args.out, all_replies, mmlu_out, selections_out, meta)
    if args.upload:
        owner, repo, folder = args.upload.split("/", 2)
        HfApi().upload_folder(folder_path=args.out, path_in_repo=folder,
                              repo_id=f"{owner}/{repo}", repo_type="dataset",
                              commit_message="persona trait writing interventions")
        print("UPLOADED", flush=True)


if __name__ == "__main__":
    main()
