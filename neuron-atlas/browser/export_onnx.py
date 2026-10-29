"""Export SmolLM2-135M-Instruct with add-on-input neuron steering to ONNX, fp32 and int8.

    python browser/export_onnx.py [--model HuggingFaceTB/SmolLM2-135M-Instruct] [--out browser/build] [--kv]

A neuron is one input channel of a layer's mlp.down_proj. The wrapper takes input_ids [1,T] and a steer tensor
[n_layers,d_mlp], adds steer[L] to that layer's down_proj input at every position, and returns only the last
position's logits [1,vocab]. No KV cache: each decoding step recomputes the sequence.

With --kv it also writes a cache-aware wrapper (inputs input_ids [1,T_new], steer [n_layers,d_mlp], attention_mask
[1,T_past+T_new] and past_key_values.{i}.key/value [1,n_kv_heads,T_past,head_dim]; outputs logits [1,vocab] for the
last position and present.{i}.key/value), then two weight-only nbits copies (q8 and q4).
"""
import argparse, json, re, sys
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from huggingface_hub import hf_hub_download
from transformers import AutoModelForCausalLM, AutoTokenizer, DynamicCache

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from atlas.model import DOWN_RE, SKIP_TOWERS  # noqa: E402

EXTERNAL_LIMIT = int(1.8 * 1024**3)


def short_name(model_id):
    """File stem for a model id: Qwen/Qwen3-0.6B -> qwen3-0.6b, SmolLM2-135M-Instruct -> smollm2."""
    name = model_id.rstrip("/").rsplit("/", 1)[-1].lower()
    if name == "smollm2-135m-instruct":
        return "smollm2"
    return re.sub(r"[^a-z0-9._-]+", "-", name).strip("-") or "model"


def external_data_name(path):
    return Path(path).name + ".data"


def load_onnx(path):
    import onnx
    return onnx.load(str(path), load_external_data=True)


def initializer_nbytes(tensor):
    """Byte size of one initializer, without materializing it or serializing the model."""
    import onnx
    if tensor.raw_data:
        return len(tensor.raw_data)
    for entry in tensor.external_data:
        if entry.key == "length" and entry.value:
            return int(entry.value)
    try:
        dtype = onnx.helper.tensor_dtype_to_np_dtype(tensor.data_type)
        count = int(np.prod(tensor.dims, dtype=np.int64)) if tensor.dims else 1
        return count * np.dtype(dtype).itemsize
    except Exception:
        return int(np.asarray(onnx.numpy_helper.to_array(tensor)).nbytes)


def model_nbytes(model):
    """Sum the initializer payloads; this is the data that makes a proto too large to serialize."""
    return sum(initializer_nbytes(t) for t in model.graph.initializer)


def save_onnx(model, path):
    """Write one file below the threshold, or a .onnx plus one .data file above it."""
    import onnx
    path = Path(path)
    data = path.with_name(external_data_name(path))
    if data.exists():
        data.unlink()
    if model_nbytes(model) < EXTERNAL_LIMIT:
        onnx.save(model, str(path), save_as_external_data=False)
    else:
        onnx.save(model, str(path), save_as_external_data=True, all_tensors_to_one_file=True,
                  location=external_data_name(path), size_threshold=1024)


class SteerDown(nn.Module):
    def __init__(self, down, layer, owner):
        super().__init__()
        self.down, self.layer = down, layer
        object.__setattr__(self, "owner", owner)  # plain attr: an nn.Module attr would make a repr cycle

    def forward(self, x):
        if self.owner._steer is not None:
            x = x + self.owner._steer[self.layer].to(x.dtype)[None, None, :]
        return self.down(x)


class SteerBase(nn.Module):
    """Shared setup: find each dense MLP down projection and wrap it with a steer input hook."""

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
        cfg = model.config
        self.n_kv_heads = getattr(cfg, "num_key_value_heads", None) or getattr(cfg, "num_attention_heads")
        self.head_dim = getattr(cfg, "head_dim", None) or (cfg.hidden_size // cfg.num_attention_heads)

    def colnorm(self):
        out = []
        for wrap in self.downs:
            w = wrap.down.weight
            cols = (w if self.conv1d else w.T).float()
            out.append(cols.norm(dim=1).cpu().numpy())
        return np.stack(out).astype("<f4")


class SteerWrapper(SteerBase):
    """Causal LM with a steer input; returns the last position's logits only."""

    def forward(self, input_ids, steer):
        self._steer = steer
        out = self.model(input_ids=input_ids, use_cache=False, return_dict=True)
        return out.logits[:, -1, :].float()


class KVCacheWrapper(nn.Module):
    """Cache-aware view over an existing SteerWrapper: one forward is either a prefill or one decoding step."""

    def __init__(self, base):
        super().__init__()
        object.__setattr__(self, "base", base)  # plain attr: base already owns the wrapped modules
        self.model = base.model
        self.n_layers = base.n_layers
        self.n_kv_heads = base.n_kv_heads
        self.head_dim = base.head_dim

    def forward(self, input_ids, steer, attention_mask, *past):
        self.base._steer = steer
        pairs = [(past[2 * i], past[2 * i + 1]) for i in range(self.n_layers)]
        cache = DynamicCache(ddp_cache_data=pairs)
        t_past = past[0].shape[2]
        position_ids = (torch.arange(input_ids.shape[1], device=input_ids.device) + t_past).unsqueeze(0)
        out = self.model(input_ids=input_ids, attention_mask=attention_mask, position_ids=position_ids,
                         past_key_values=cache, use_cache=True, return_dict=True)
        presents = []
        for i in range(self.n_layers):
            presents.append(out.past_key_values.layers[i].keys)
            presents.append(out.past_key_values.layers[i].values)
        return (out.logits[:, -1, :].float(), *presents)


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
              do_constant_folding=True, external_data=True)
    try:
        torch.onnx.export(wrapper, (ids, steer), str(path), dynamo=False,
                          dynamic_axes={"input_ids": {0: "batch", 1: "T"}, "logits": {0: "batch"}}, **kw)
    except Exception as e:
        print(f"legacy exporter failed ({type(e).__name__}: {e}); retrying with dynamo=True")
        from torch.export import Dim
        torch.onnx.export(wrapper, (ids, steer), str(path), dynamo=True,
                          dynamic_shapes={"input_ids": {0: Dim("batch"), 1: Dim("T", min=1)}, "steer": {}}, **kw)


def export_kv(wrapper, tok, path):
    """Export the cache-aware wrapper. Trace with T_past > 0 so the concat stays in the graph."""
    ids = tok(chat_prompt(tok, "Who are you?"), return_tensors="pt", add_special_tokens=False)["input_ids"]
    n_layers, n_kv, hd = wrapper.n_layers, wrapper.n_kv_heads, wrapper.head_dim
    past_len = min(4, max(1, ids.shape[1] - 1))
    new_ids = ids[:, past_len:]
    past = []
    for _ in range(n_layers):
        past.append(torch.zeros(1, n_kv, past_len, hd, dtype=torch.float32))
        past.append(torch.zeros(1, n_kv, past_len, hd, dtype=torch.float32))
    steer = torch.zeros(n_layers, wrapper.base.d_mlp, dtype=torch.float32)
    attention_mask = torch.ones(1, ids.shape[1], dtype=torch.int64)
    args = (new_ids, steer, attention_mask, *past)

    in_names = ["input_ids", "steer", "attention_mask"]
    out_names = ["logits"]
    dyn = {"input_ids": {0: "batch", 1: "T_new"}, "attention_mask": {0: "batch", 1: "T"},
           "logits": {0: "batch"}}
    for i in range(n_layers):
        for kv in ("key", "value"):
            in_names.append(f"past_key_values.{i}.{kv}")
            out_names.append(f"present.{i}.{kv}")
            dyn[f"past_key_values.{i}.{kv}"] = {0: "batch", 2: "T_past"}
            dyn[f"present.{i}.{kv}"] = {0: "batch", 2: "T"}
    torch.onnx.export(wrapper, args, str(path), input_names=in_names, output_names=out_names,
                      opset_version=18, do_constant_folding=True, external_data=True,
                      dynamo=False, dynamic_axes=dyn)


def export_fp16(src, dst):
    from onnxruntime.transformers.float16 import convert_float_to_float16
    model = load_onnx(src)
    model = convert_float_to_float16(model, keep_io_types=True, force_fp16_initializers=True)
    save_onnx(model, dst)


def tie_lm_head(path):
    """torch.onnx stores the tied embedding twice (Gather table and a transposed MatMul copy for the LM head).
    Point the LM head at the Gather table with Gemm(transB=1) and drop the copy: ~113 MB less for SmolLM2."""
    from onnx import helper, numpy_helper
    import numpy as np
    m = load_onnx(path)
    g = m.graph
    inits = {t.name: t for t in g.initializer}
    gather = next(n for n in g.node if n.op_type == "Gather" and n.input[0] in inits)
    emb = inits[gather.input[0]]
    vocab, hidden = emb.dims
    head = next(n for n in g.node if n.op_type == "MatMul" and n.input[1] in inits
                and list(inits[n.input[1]].dims) == [hidden, vocab])
    E = numpy_helper.to_array(emb)
    W = numpy_helper.to_array(inits[head.input[1]])
    if not np.array_equal(W, E.T):
        print("lm head is not tied to the embedding; left as is")
        return
    a, out, dead = head.input[0], head.output[0], head.input[1]
    k = lambda name: f"tie_{name}"
    g.initializer.extend([numpy_helper.from_array(np.array([-1, hidden], np.int64), k("flat")),
                          numpy_helper.from_array(np.array([vocab], np.int64), k("vocab")),
                          numpy_helper.from_array(np.array([0], np.int64), k("zero")),
                          numpy_helper.from_array(np.array([-1], np.int64), k("last"))])
    new = [helper.make_node("Reshape", [a, k("flat")], [k("a2")]),
           helper.make_node("Gemm", [k("a2"), emb.name], [k("y2")], transB=1),
           helper.make_node("Shape", [a], [k("shape")]),
           helper.make_node("Slice", [k("shape"), k("zero"), k("last")], [k("lead")]),
           helper.make_node("Concat", [k("lead"), k("vocab")], [k("oshape")], axis=0),
           helper.make_node("Reshape", [k("y2"), k("oshape")], [out])]
    i = list(g.node).index(head)
    g.node.remove(head)
    for j, n in enumerate(new):
        g.node.insert(i + j, n)
    g.initializer.remove(inits[dead])
    save_onnx(m, path)


def quantize_nbits(src, dst, bits):
    """Weight-only MatMul quantization; activations and the embedding Gather stay float32."""
    from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer
    model = load_onnx(src)
    quantizer = MatMulNBitsQuantizer(model, bits=bits, block_size=32, is_symmetric=True,
                                     op_types_to_quantize=("MatMul",))
    quantizer.process()
    quantizer.model.topological_sort()
    save_onnx(quantizer.model.model, dst)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="HuggingFaceTB/SmolLM2-135M-Instruct")
    ap.add_argument("--out", default=str(Path(__file__).with_name("build")))
    ap.add_argument("--kv", action="store_true", help="also export the KV-cache wrapper and its q8/q4 copies")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    tok, wrapper = load_model(a.model)
    short = short_name(a.model)
    files = {}
    fp32 = out / f"{short}_steer.onnx"
    export_fp32(wrapper, tok, fp32)
    files["fp32"] = fp32.name
    size = fp32.stat().st_size
    print(f"fp32   {fp32}  {size / 1e6:.1f} MB")

    from onnxruntime.quantization import QuantType, quantize_dynamic
    int8 = out / f"{short}_steer_int8.onnx"
    quantize_dynamic(str(fp32), str(int8), weight_type=QuantType.QInt8, per_channel=True)
    files["int8"] = int8.name
    print(f"int8   {int8}  {int8.stat().st_size / 1e6:.1f} MB")

    if a.kv:
        kv_wrapper = KVCacheWrapper(wrapper)
        kv_fp32 = out / f"{short}_steer_kv.onnx"
        export_kv(kv_wrapper, tok, kv_fp32)
        tie_lm_head(kv_fp32)
        files["kv"] = kv_fp32.name
        print(f"kv fp32 {kv_fp32}  {kv_fp32.stat().st_size / 1e6:.1f} MB")
        kv_fp16 = out / f"{short}_steer_kv_fp16.onnx"
        export_fp16(kv_fp32, kv_fp16)
        files["kv_fp16"] = kv_fp16.name
        print(f"kv fp16 {kv_fp16}  {kv_fp16.stat().st_size / 1e6:.1f} MB")
        for bits in (8, 4):
            dst = out / f"{short}_steer_kv_q{bits}.onnx"
            try:
                quantize_nbits(kv_fp32, dst, bits)
                files[f"kv_q{bits}"] = dst.name
                print(f"kv q{bits}  {dst}  {dst.stat().st_size / 1e6:.1f} MB")
            except Exception as e:
                print(f"kv q{bits} failed ({type(e).__name__}: {e}); skipped")

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
    meta = {"model": a.model, "files": files, "n_layers": wrapper.n_layers, "d_mlp": wrapper.d_mlp,
            "vocab": int(wrapper.model.get_output_embeddings().weight.shape[0]),
            "n_kv_heads": wrapper.n_kv_heads, "head_dim": wrapper.head_dim,
            "resid_median": [float(x) for x in resid], "eos": sorted(eos),
            "chat_template_prefix": {"before": prompt[:i], "after": prompt[i + 1:]}}
    (out / "steer_meta.json").write_text(json.dumps(meta, indent=1) + "\n")
    wrapper.colnorm().tofile(out / "colnorm.f32")
    print(f"meta   {out / 'steer_meta.json'}  layers={wrapper.n_layers} d_mlp={wrapper.d_mlp} "
          f"vocab={meta['vocab']} eos={meta['eos']}")
    print(f"colnorm {out / 'colnorm.f32'}  {wrapper.n_layers * wrapper.d_mlp * 4 / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
