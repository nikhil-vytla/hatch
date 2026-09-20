"""Export the selected MLX-trained Laya head to a complete Core ML model.

A PyTorch bridge provides conversion only. MLX owns the fine-tuning. Actual
Core ML predictions are checked against MLX, including decision probabilities.
"""

import sys, json, time, statistics, hashlib
from pathlib import Path
import numpy as np
import torch
import coremltools as ct
import mlx.core as mx
from safetensors.torch import load_file
from prepare import CACHE, ROOT
from data import examples, collate, MAX_LEN, MAX_OPTIONS
from mlx_model import load
from coremltools.converters.mil.mil import Builder as mb, types
from coremltools.converters.mil.frontend.torch.torch_op_registry import register_torch_op
from coremltools.converters.mil.frontend.torch.ops import _get_inputs, NUM_TO_DTYPE_STRING


# Transformers' padding-mask construction emits aten::new_ones. Coremltools 9
# has ones/new_zeros but lacks this spelling. Preserve its explicit output dtype.
@register_torch_op
def new_ones(context, node):
    inputs = _get_inputs(context, node)
    shape = inputs[1]
    if isinstance(shape, list):
        shape = mb.concat(values=shape, axis=0)
    dtype = (
        NUM_TO_DTYPE_STRING[inputs[2].val]
        if inputs[2] is not None
        else types.builtin_to_string(inputs[0].dtype)
    )
    if shape.val is not None and np.size(shape.val) == 0:
        value = mb.const(val=np.float32(1))
    else:
        value = mb.fill(shape=mb.cast(x=shape, dtype="int32"), value=1.0)
    context.add(mb.cast(x=value, dtype=dtype, name=node.name))


# NumPy 2.5 no longer accepts int(array([n])). Preserve Core ML's scalar-cast
# semantics by explicitly extracting the one constant element.
@register_torch_op(torch_alias=["int"], override=True)
def scalar_int(context, node):
    x = _get_inputs(context, node, expected=1)[0]
    if x.val is not None:
        if np.size(x.val) != 1:
            raise ValueError("Integer conversion requires one scalar element")
        value = mb.const(val=int(np.asarray(x.val).item()), name=node.name)
    else:
        value = mb.cast(x=mb.squeeze(x=x) if len(x.shape) else x, dtype="int32", name=node.name)
    context.add(value, node.name)


sys.path.insert(0, str(ROOT / ".cache/laya-research"))
from laya.common import build_model

training = json.loads((CACHE / "training-result.json").read_text())
temperature = training["temperature"]
cfg = json.loads((CACHE / "base/rl_agent_config.json").read_text())
ecfg = json.loads((CACHE / "base/encoder/config.json").read_text())
model = build_model(cfg, encoder_dir=str(CACHE / "base/encoder")).eval()
weights = load_file(CACHE / "base/model.safetensors")
weights.update(load_file(CACHE / "finetuned-head.safetensors"))
model.load_state_dict(weights)
model.encoder.config.reference_compile = False
torch.backends.mha.set_fastpath_enabled(False)
torch.set_num_threads(4)


# The export has a fixed 768-token shape and always starts at position zero.
# Compute trigonometric tables in float32 before tracing. Our full-test
# comparison found identical predictions to default conversion: this did not
# explain or eliminate the observed float16 drift.
class FixedRotary(torch.nn.Module):
    def __init__(self, original):
        super().__init__()
        for kind in ["full_attention", "sliding_attention"]:
            cos, sin = original(torch.zeros(1, MAX_LEN, 1024), torch.arange(MAX_LEN)[None], kind)
            self.register_buffer(kind + "_cos", cos)
            self.register_buffer(kind + "_sin", sin)

    def forward(self, x, position_ids, layer_type):
        return getattr(self, layer_type + "_cos"), getattr(self, layer_type + "_sin")


model.encoder.rotary_emb = FixedRotary(model.encoder.rotary_emb)
head_hash = hashlib.sha256((CACHE / "finetuned-head.safetensors").read_bytes()).hexdigest()


class Wrapper(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.model = model

    def forward(self, input_ids, attention_mask, marker_pos, marker_mask, qtype):
        h = self.model.encoder(input_ids=input_ids, attention_mask=attention_mask).last_hidden_state
        h = h + self.model.type_emb(qtype)[:, None, :]
        for layer in self.model.head.layers:
            h = layer(h, src_key_padding_mask=~attention_mask.bool())
        anchors = torch.gather(h, 1, marker_pos[:, :, None].expand(-1, -1, h.size(-1)))
        z = self.model.scorer(anchors).squeeze(-1).float().masked_fill(~marker_mask.bool(), -1e4)
        return torch.softmax(z / temperature, dim=-1)


wrapper = Wrapper().eval()
items = examples("test")
a = collate([items[0]], fixed=True)
inputs = tuple(torch.from_numpy(x.astype(np.int32)) for x in a[:5])
package = CACHE / "LayaDecisions.mlpackage"
if package.exists():
    metadata = ct.models.MLModel(str(package), skip_model_load=True).user_defined_metadata
    if (
        metadata.get("trained_head_sha256") != head_hash
        or metadata.get("export_version") != "fixed-rope-v1"
        or metadata.get("temperature") != str(temperature)
    ):
        raise ValueError(
            "Cached Core ML package does not match this checkpoint/export. Move the named package aside and rerun conversion."
        )
if not package.exists():
    print("Tracing full model", flush=True)
    with torch.no_grad():
        traced = torch.jit.trace(wrapper, inputs, check_trace=False)
    print("Converting Core ML", flush=True)
    converted = ct.convert(
        traced,
        convert_to="mlprogram",
        minimum_deployment_target=ct.target.macOS14,
        compute_precision=ct.precision.FLOAT16,
        inputs=[
            ct.TensorType(name=n, shape=tuple(v.shape), dtype=np.int32)
            for n, v in zip(
                ["input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype"], inputs
            )
        ],
        outputs=[ct.TensorType(name="probabilities")],
    )
    converted.short_description = "Laya decision model, specialist head fine-tuned with MLX on Typed Decisions. Local inference only."
    converted.user_defined_metadata.update(
        {
            "base_model": "convaiinnovations/laya",
            "base_revision": training["revision"],
            "training_runtime": "MLX",
            "temperature": str(temperature),
            "input_limit": str(MAX_LEN),
            "max_options": str(MAX_OPTIONS),
            "trained_head_sha256": head_hash,
            "export_version": "fixed-rope-v1",
        }
    )
    converted.save(str(package))
    print("Saved Core ML package", flush=True)
enc, head = load(CACHE / "base/model.safetensors", ecfg)
head.w = mx.load(str(CACHE / "finetuned-head.safetensors"))
checks = []
timings = {}
# CPU+GPU may schedule operators on either backend. No claim of Neural Engine placement.
for units in [ct.ComputeUnit.CPU_ONLY, ct.ComputeUnit.ALL]:
    cm = ct.models.MLModel(str(package), compute_units=units)
    times = []
    for idx in [0, 1, 2, 500, 1000, 1500]:
        arrays = collate([items[idx]], fixed=True)
        data = {
            n: v.astype(np.int32)
            for n, v in zip(
                ["input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype"], arrays[:5]
            )
        }
        start = time.perf_counter()
        p = cm.predict(data)["probabilities"]
        times.append((time.perf_counter() - start) * 1000)
        z = head(enc(mx.array(arrays[0]), mx.array(arrays[1])), *[mx.array(x) for x in arrays[1:5]])
        expected = np.array(mx.softmax(z / temperature, axis=-1))
        delta = float(np.max(np.abs(p - expected)))
        checks.append(
            {
                "compute_units": units.name,
                "question_index": idx,
                "max_probability_error": delta,
                "same_argmax": bool(p.argmax() == expected.argmax()),
            }
        )
    # Warm repeat timing on an identical input, reported separately from mixed lengths.
    repeats = []
    for _ in range(10):
        start = time.perf_counter()
        cm.predict(data)
        repeats.append((time.perf_counter() - start) * 1000)
    timings[units.name] = {
        "cold_first_ms": times[0],
        "warm_median_ms": statistics.median(repeats),
        "warm_p95_ms": sorted(repeats)[9],
        "samples": 10,
        "padded_tokens": MAX_LEN,
    }
passed = all(c["same_argmax"] and c["max_probability_error"] < 0.02 for c in checks)
report = {
    "package": "jev-experiments/.cache/apple-decisions/LayaDecisions.mlpackage",
    "package_bytes": sum(p.stat().st_size for p in package.rglob("*") if p.is_file()),
    "precision": "float16",
    "rotary_tables": "Precomputed in float32 before tracing at the fixed 768-token shape.",
    "trained_head_sha256": head_hash,
    "input_tokens": MAX_LEN,
    "max_options": MAX_OPTIONS,
    "conversion_bridge": "PyTorch; training was native MLX",
    "checks": checks,
    "latency": timings,
    "probability_tolerance": 0.02,
    "passed": passed,
    "neural_engine_placement": "Not measured; ALL allows Core ML to select compute units.",
}
(ROOT / "local-models-and-games/apple/coreml-verification.json").write_text(
    json.dumps(report, indent=2) + "\n"
)
print(json.dumps(report), flush=True)
if not passed:
    raise SystemExit(1)
