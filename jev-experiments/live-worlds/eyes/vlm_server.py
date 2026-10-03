"""Local decision scorer for a vision-language model, the way SGLang's /v1/decisions works.

One prefill over (image + question) with thinking off, then the label tokens' logits at the
answer position become probabilities (softmax over the labels only). No text is generated.
Runs on Apple silicon with MLX-VLM. Used by record.ts to record the reef-style "pixels" lane of
Eyes against state; the browser only replays what this recorded.

    python live-worlds/eyes/vlm_server.py --model mlx-community/Qwen3-VL-4B-Instruct-4bit --port 30100

POST /score {"image_png_b64": str, "question": str, "labels": ["A","B",...]}
  -> {"probabilities": {label: p}, "label_mass": float, "ms": float, "prompt_tokens": int}
GET /health -> model, memory
"""

import argparse
import base64
import io
import json
import math
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import mlx.core as mx
from mlx_vlm import load
from mlx_vlm.prompt_utils import apply_chat_template
from mlx_vlm.utils import prepare_inputs
from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument("--model", default="mlx-community/Qwen3-VL-4B-Instruct-4bit")
parser.add_argument("--port", type=int, default=30100)
args = parser.parse_args()

model, processor = load(args.model)
config = model.config
mx.set_cache_limit(256 * 1024 * 1024)
tokenizer = processor.tokenizer if hasattr(processor, "tokenizer") else processor
requests = 0


def label_ids(labels):
    ids = []
    for label in labels:
        toks = tokenizer.encode(label, add_special_tokens=False)
        if len(toks) != 1:
            raise ValueError(f"label {label!r} is not a single token: {toks}")
        ids.append(toks[0])
    return ids


def score(image_png_b64, question, labels):
    global requests
    image = Image.open(io.BytesIO(base64.b64decode(image_png_b64))).convert("RGB")
    prompt = apply_chat_template(processor, config, question, num_images=1)
    t0 = time.perf_counter()
    inputs = prepare_inputs(processor, images=[image], prompts=[prompt], image_token_index=getattr(config, "image_token_index", None))
    input_ids = inputs["input_ids"]
    pixel_values = inputs.get("pixel_values")
    mask = inputs.get("attention_mask")
    extra = {k: v for k, v in inputs.items() if k not in ("input_ids", "pixel_values", "attention_mask")}
    emb = model.get_input_embeddings(input_ids, pixel_values, mask=mask, **extra)
    kw = {k: v for k, v in emb.to_dict().items() if k != "inputs_embeds" and v is not None}
    out = model.language_model(input_ids, inputs_embeds=emb.inputs_embeds, logits_to_keep=1, **kw)
    logits = out.logits[0, -1, :].astype(mx.float32)
    logprobs = logits - mx.logsumexp(logits)
    ids = label_ids(labels)
    picked = mx.array([logprobs[i].item() for i in ids])
    mx.eval(picked)
    ms = (time.perf_counter() - t0) * 1000
    vals = picked.tolist()
    top = max(vals)
    exps = [math.exp(v - top) for v in vals]
    z = sum(exps)
    probabilities = {label: e / z for label, e in zip(labels, exps)}
    label_mass = sum(math.exp(v) for v in vals)
    tokens = int(input_ids.shape[1])
    del out, emb, logits, logprobs, inputs
    mx.clear_cache()
    requests += 1
    return {"probabilities": probabilities, "label_mass": label_mass, "ms": ms, "prompt_tokens": tokens}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {
                "ok": True,
                "model": args.model,
                "requests": requests,
                "active_gb": round(mx.get_active_memory() / 1e9, 2),
                "peak_gb": round(mx.get_peak_memory() / 1e9, 2),
            })
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/score":
            return self._send(404, {"error": "not found"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            self._send(200, score(body["image_png_b64"], body["question"], body["labels"]))
        except Exception as e:  # report, don't crash the server
            self._send(500, {"error": str(e)})

    def log_message(self, *a):
        pass


print(f"Serving {args.model} on http://127.0.0.1:{args.port}", flush=True)
ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
