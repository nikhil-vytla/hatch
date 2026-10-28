"""Export SmolLM2-135M-Instruct with add-on-input neuron steering to ONNX, fp32 and int8.

    python browser/export_onnx.py [--model HuggingFaceTB/SmolLM2-135M-Instruct] [--out browser/build]

A neuron is one input channel of a layer's mlp.down_proj. The wrapper takes input_ids [1,T] and a steer tensor
[n_layers,d_mlp], adds steer[L] to that layer's down_proj input at every position, and returns only the last
position's logits [1,vocab]. No KV cache: each decoding step recomputes the sequence.
"""
import argparse, json, sys
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from huggingface_hub import hf_hub_download
from transformers import AutoModelForCausalLM, AutoTokenizer

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from atlas.model import DOWN_RE, SKIP_TOWERS  # noqa: E402


class SteerDown(nn.Module):
    def __init__(self, down, layer, owner):
        super().__init__()
        self.down, self.layer = down, layer
        object.__setattr__(self, "owner", owner)  # plain attr: an nn.Module attr would make a repr cycle

    def forward(self, x):
        if self.owner._steer is not None:
            x = x + self.owner._steer[self.layer].to(x.dtype)[None, None, :]
        return self.down(x)


class SteerWrapper(nn.Module):
    """Causal LM with a steer input; returns the last position's logits only."""

    def __init__(self, model):
        super().__init__()
        self.model = model
        self._steer = None
        found = []
        for name, mod in list(model.named_modules()):
            m = DOWN_RE.search(name)
            if m and ".experts." not in name and not any(t in name.lower() for t in SKIP_TOWERS):
                found.append((int(m.group(1)), name, mod))
        if not found:
            raise ValueError("no dense MLP down projections found")
        found.sort(key=lambda x: x[0])
        self.n_layers = len(found)
        self.downs = []
        for layer, name, mod in found:
            parent_name, _, child = name.rpartition(".")
            parent = model.get_submodule(parent_name) if parent_name else model
            wrap = SteerDown(mod, layer, self)
            setattr(parent, child, wrap)
            self.downs.append(wrap)
        w = found[0][2].weight
        self.conv1d = type(found[0][2]).__name__ == "Conv1D"
        self.d_mlp, self.d_model = (w.shape[0], w.shape[1]) if self.conv1d else (w.shape[1], w.shape[0])
        self.layers = [L for L, _, _ in found]

    def forward(self, input_ids, steer):
        self._steer = steer
        out = self.model(input_ids=input_ids, use_cache=False, return_dict=True)
        return out.logits[:, -1, :].float()

    def colnorm(self):
        out = []
        for wrap in self.downs:
            w = wrap.down.weight
            cols = (w if self.conv1d else w.T).float()
            out.append(cols.norm(dim=1).cpu().numpy())
        return np.stack(out).astype("<f4")


def chat_prompt(tok, user):
    if tok.chat_template:
        return tok.apply_chat_template([{"role": "user", "content": user}], tokenize=False,
                                       add_generation_prompt=True, enable_thinking=False)
    return f"User: {user}\n\nAssistant:"


def load_model(name):
    tok = AutoTokenizer.from_pretrained(name)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    model = AutoModelForCausalLM.from_pretrained(name, dtype=torch.float32, attn_implementation="eager")
    model = model.eval()
    model.requires_grad_(False)
    return tok, SteerWrapper(model)


def export_fp32(wrapper, tok, path):
    ids = tok(chat_prompt(tok, "Who are you?"), return_tensors="pt", add_special_tokens=False)["input_ids"]
    steer = torch.zeros(wrapper.n_layers, wrapper.d_mlp, dtype=torch.float32)
    kw = dict(input_names=["input_ids", "steer"], output_names=["logits"], opset_version=18,
              do_constant_folding=True, external_data=False)
    try:
        torch.onnx.export(wrapper, (ids, steer), str(path), dynamo=False,
                          dynamic_axes={"input_ids": {0: "batch", 1: "T"}, "logits": {0: "batch"}}, **kw)
    except Exception as e:
        print(f"legacy exporter failed ({type(e).__name__}: {e}); retrying with dynamo=True")
        from torch.export import Dim
        torch.onnx.export(wrapper, (ids, steer), str(path), dynamo=True,
                          dynamic_shapes={"input_ids": {0: Dim("batch"), 1: Dim("T", min=1)}, "steer": {}}, **kw)


def export_fp16(src, dst):
    from onnxruntime.transformers.float16 import convert_float_to_float16
    import onnx
    model = onnx.load(str(src))
    model = convert_float_to_float16(model, keep_io_types=True, force_fp16_initializers=True)
    onnx.save(model, str(dst), save_as_external_data=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="HuggingFaceTB/SmolLM2-135M-Instruct")
    ap.add_argument("--out", default=str(Path(__file__).with_name("build")))
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    tok, wrapper = load_model(a.model)
    fp32 = out / "smollm2_steer.onnx"
    export_fp32(wrapper, tok, fp32)
    size = fp32.stat().st_size
    print(f"fp32   {fp32}  {size / 1e6:.1f} MB")

    from onnxruntime.quantization import QuantType, quantize_dynamic
    int8 = out / "smollm2_steer_int8.onnx"
    quantize_dynamic(str(fp32), str(int8), weight_type=QuantType.QInt8, per_channel=True)
    print(f"int8   {int8}  {int8.stat().st_size / 1e6:.1f} MB")

    slug = a.model.replace("/", "__")
    pub = hf_hub_download(repo_id="nikhilxvytla/neuron-atlas", repo_type="dataset",
                          filename=f"{slug}/meta.json")
    resid = json.load(open(pub))["resid_median"]
    if len(resid) != wrapper.n_layers:
        raise ValueError(f"resid_median has {len(resid)} layers, model has {wrapper.n_layers}")

    eos = set()
    for v in (tok.eos_token_id, getattr(wrapper.model.generation_config, "eos_token_id", None)):
        if isinstance(v, int):
            eos.add(v)
        elif v:
            eos.update(int(x) for x in v)

    prompt = chat_prompt(tok, "X")
    i = prompt.index("X")
    meta = {"model": a.model, "n_layers": wrapper.n_layers, "d_mlp": wrapper.d_mlp,
            "vocab": int(wrapper.model.get_output_embeddings().weight.shape[0]),
            "resid_median": [float(x) for x in resid], "eos": sorted(eos),
            "chat_template_prefix": {"before": prompt[:i], "after": prompt[i + 1:]}}
    (out / "steer_meta.json").write_text(json.dumps(meta, indent=1) + "\n")
    wrapper.colnorm().tofile(out / "colnorm.f32")
    print(f"meta   {out / 'steer_meta.json'}  layers={wrapper.n_layers} d_mlp={wrapper.d_mlp} "
          f"vocab={meta['vocab']} eos={meta['eos']}")
    print(f"colnorm {out / 'colnorm.f32'}  {wrapper.n_layers * wrapper.d_mlp * 4 / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
