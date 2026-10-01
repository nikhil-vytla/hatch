"""
SGLang's /v1/decisions and /v1/systemone, ported to MLX so they run on a Mac.

SGLang (https://github.com/sgl-project/sglang, Apache-2.0) turns a chat model into a decision
model: each question is rendered into a chat prompt with reasoning off, the model runs one
prefill, and the probabilities of the answer-label tokens (A-Z, 0-9, yes/no) at the answer
position become the answer's distribution. Nothing is generated.

This file ports that method from sgl-project/sglang at commit 99c9d65b32c2 (1 Oct 2026):
python/sglang/srt/entrypoints/openai/serving_decisions.py (PROMPT_FORMAT_VERSION 1, the
question wording, label checks and scoring) and python/sglang/srt/entrypoints/systemone/
(the System One wire shape and confidences). It is not SGLang: SGLang needs a CUDA GPU and
batches on a radix cache; this runs one question at a time, with no prefix cache, which is
SGLang's `--disable-radix-cache` behaviour.

    uv run --with mlx-lm python server.py --model mlx-community/Qwen3.8-27B-4bit --port 30000

POST /v1/systemone  {state, questions: {id: {type: noul|choice|score, instructions, criteria}}}
POST /v1/decisions  {input, questions: [{id, type, question, options|levels|yes/no}]}
GET  /health
"""

from __future__ import annotations

import argparse
import json
import math
import string
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

PROMPT_FORMAT_VERSION = 1
PAIR_LABELS = [a + b for a in string.ascii_uppercase for b in string.ascii_uppercase]


def render_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def render_question(text: str, kind: str, question: Any, labels: list[str], names: list[str], details: list[Any]) -> str:
    """SGLang's _render_question, PROMPT_FORMAT_VERSION 1."""
    q = "" if blank(question) else render_text(question)

    if kind == "choice":
        lines = [f"Question: {q}"] if q else []
        for label, name, description in zip(labels, names, details):
            d = render_text(description)
            lines.append(f"{label}: {name} - {d}" if d else f"{label}: {name}")
        lines.append("Answer with the letter of one option only.")
    elif kind == "score":
        lines = [f"Question: {q}"] if q else []
        lines += [f"{label}: {render_text(level)}" for label, level in zip(labels, details)]
        lines.append("Answer with the number of one level only.")
    else:
        lines = [f"Is the following true? {q}" if q else "Is the following true?"]
        for label, description in zip(labels, details):
            d = render_text(description)
            if d:
                lines.append(f"{label}: {d}")
        lines.append("Answer with yes or no only.")

    return "\n".join([text, "", *lines])


class Decider:
    def __init__(self, model_path: str):
        # Imported here so the prompt rendering can be tested without MLX.
        import mlx.core as mx
        from mlx_lm import load

        # Freed buffers beyond this are returned to the system, not kept for reuse.
        mx.set_cache_limit(256 * 1024 * 1024)
        self.model_path = model_path
        self.model, wrapper = load(model_path)
        self.requests = 0
        self.tok = getattr(wrapper, "_tokenizer", wrapper)
        self.added = {i: t for t, i in self.tok.get_added_vocab().items()}
        self.lock = threading.Lock()
        self.pair_labels: list[str] | None = None

    def last_logits(self, ids: list[int]):
        """Logits at the answer position only. The full model call would project every prompt
        position onto the 151k-token vocabulary (about 1.7 GB in float32 for 2,800 tokens)."""
        import mlx.core as mx

        # Qwen3.5 checkpoints wrap the text model in language_model; Qwen3 doesn't.
        text = getattr(self.model, "language_model", self.model)
        hidden = text.model(mx.array([ids]))[:, -1:, :]
        logits = text.model.embed_tokens.as_linear(hidden) if text.args.tie_word_embeddings else text.lm_head(hidden)

        return logits[0, -1].astype(mx.float32)

    def memory(self) -> dict:
        import mlx.core as mx

        gb = 1024**3
        return {"active_gb": round(mx.get_active_memory() / gb, 2), "cache_gb": round(mx.get_cache_memory() / gb, 2), "peak_gb": round(mx.get_peak_memory() / gb, 2)}

    def chat(self, content: str) -> str:
        return self.tok.apply_chat_template(
            [{"role": "user", "content": content}],
            tokenize=False,
            add_generation_prompt=True,
            enable_thinking=False,
        )

    def encode(self, text: str) -> list[int]:
        return self.tok.encode(text, add_special_tokens=False)

    def label_context(self, prompt: str, ids: list[int]) -> tuple[str, list[int], bool]:
        """SGLang's label_context: check labels on the text after the last added token."""
        last = next((i for i in reversed(range(len(ids))) if ids[i] in self.added), None)
        if last is not None:
            token = self.added[ids[last]]
            start = prompt.rfind(token)
            suffix = prompt[start + len(token):]
            if start >= 0 and self.encode(suffix) == ids[last + 1:]:
                return suffix, ids[last + 1:], True
        return prompt, ids, False

    def label_id(self, text: str, text_ids: list[int], label: str) -> int | None:
        ids = self.encode(text + label)
        if len(ids) != len(text_ids) + 1 or ids[:-1] != text_ids:
            return None
        return ids[-1]

    def labels_for(self, kind: str, n: int) -> list[str]:
        if kind == "choice":
            if n <= 26:
                return list(string.ascii_uppercase[:n])
            if self.pair_labels is None:
                self.pair_labels = self.find_pair_labels()
            if n > len(self.pair_labels):
                raise ValueError(f"{n} options, but this tokenizer can label at most {len(self.pair_labels)}")
            return self.pair_labels[:n]
        if kind == "score":
            return [str(i) for i in range(n)]
        return ["yes", "no"]

    def find_pair_labels(self) -> list[str]:
        """SGLang's _pair_labels: two-letter labels that are distinct single tokens."""
        contexts = [self.label_context(p, self.encode(p)) for p in (self.chat("x"), self.chat("y"))]
        (text, text_ids, shortcut), other = contexts
        if not (shortcut and other[2] and other[0] == text):
            raise ValueError("more than 26 options needs an added token before the answer position")
        labels, seen = [], set()
        for label in PAIR_LABELS:
            t = self.label_id(text, text_ids, label)
            if t is not None and t not in seen:
                labels.append(label)
                seen.add(t)
        return labels

    def score(self, text: str, kind: str, question: Any, names: list[str], details: list[Any]):
        labels = self.labels_for(kind, len(names))
        content = render_question(text, kind, question, labels, names, details)
        prompt = self.chat(content)
        # The answer position must follow any reasoning block, not sit inside it.
        tail = prompt[prompt.rfind(content.rsplit("\n", 1)[-1]):]
        if tail.rfind("<think>") > tail.rfind("</think>"):
            raise ValueError("the chat template leaves a reasoning block open at the answer position")
        ids = self.encode(prompt)
        text_ctx, ctx_ids, _ = self.label_context(prompt, ids)
        label_ids = []
        for label in labels:
            t = self.label_id(text_ctx, ctx_ids, label)
            if t is None or t in label_ids:
                raise ValueError(f"the answer label {label!r} is not one distinct token after the chat prompt")
            label_ids.append(t)

        import mlx.core as mx

        logits = self.last_logits(ids)
        logprobs = logits - mx.logsumexp(logits)
        lp = [float(x) for x in logprobs[mx.array(label_ids)].tolist()]
        # Nothing from a request is kept: no prompt cache, no arrays, and MLX's freed buffers go back.
        del logits, logprobs
        mx.clear_cache()
        top = max(lp)
        exps = [math.exp(x - top) for x in lp]
        z = math.fsum(exps)
        probabilities = [e / z for e in exps]
        mass = math.fsum(math.exp(x) for x in lp)
        return probabilities, mass, len(ids)


def choice_confidence(q: list[float]) -> float:
    n = len(q)
    return 1.0 if n == 1 else min(1.0, max(0.0, (n * max(q) - 1) / (n - 1)))


def score_confidence(q: list[float]) -> float:
    n = len(q)
    if n == 1:
        return 1.0
    top = q.index(max(q))
    spread = math.fsum(p * abs(i - top) for i, p in enumerate(q))
    uniform = math.fsum(abs(i - (n - 1) / 2) for i in range(n)) / n
    return max(0.0, 1 - spread / uniform)


def systemone(d: Decider, body: dict) -> dict:
    text = render_text(body.get("state"))
    answers, tokens = {}, 0

    for qid, q in body["questions"].items():
        kind = q["type"]
        if kind == "choice":
            names, details = list(q["criteria"]), list(q["criteria"].values())
            k = "choice"
        elif kind == "score":
            names, details = [str(i) for i in range(len(q["criteria"]))], list(q["criteria"])
            k = "score"
        else:
            c = q.get("criteria") or {}
            names, details = ["yes", "no"], [c.get("true"), c.get("false")]
            k = "yes_no"
        try:
            p, mass, n = d.score(text, k, q.get("instructions"), names, details)
        except ValueError as e:
            raise ValueError(f"question {qid!r}: {e}") from e
        tokens += n
        if k == "yes_no":
            answers[qid] = {"type": "noul", "noul": p[0], "x_label_mass": mass}
        elif k == "choice":
            answers[qid] = {
                "type": "choice",
                "choice": names[p.index(max(p))],
                "confidence": choice_confidence(p),
                "probabilities": dict(zip(names, p)),
                "x_label_mass": mass,
            }
        else:
            answers[qid] = {
                "type": "score",
                "score": math.fsum(i * x for i, x in enumerate(p)),
                "confidence": score_confidence(p),
                "legend": dict(zip(names, details)),
                "probabilities": dict(zip(names, p)),
                "x_label_mass": mass,
            }

    return {"model": d.model_path, "answers": answers, "usage": {"input_tokens": tokens, "output_tokens": 0}}


def decisions(d: Decider, body: dict) -> dict:
    text = render_text(body.get("input"))
    answers, tokens = {}, 0

    for q in body["questions"]:
        kind = q["type"]
        if kind == "choice":
            names = [o["name"] for o in q["options"]]
            details = [o.get("description") for o in q["options"]]
        elif kind == "score":
            names, details = [str(i) for i in range(len(q["levels"]))], list(q["levels"])
        else:
            kind, names, details = "yes_no", ["yes", "no"], [q.get("yes"), q.get("no")]
        p, mass, n = d.score(text, kind, q.get("question"), names, details)
        tokens += n
        a = {"type": q["type"], "probabilities": dict(zip(names, p)), "label_mass": mass}
        if kind == "choice":
            a["choice"] = names[p.index(max(p))]
        elif kind == "score":
            a["score"] = math.fsum(i * x for i, x in enumerate(p))
        answers[q["id"]] = a

    return {
        "model": d.model_path,
        "prompt_format_version": PROMPT_FORMAT_VERSION,
        "answers": answers,
        "usage": {"prompt_tokens": tokens, "total_tokens": tokens},
    }


def serve(d: Decider, port: int):
    class Handler(BaseHTTPRequestHandler):
        def reply(self, code: int, obj: dict):
            data = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/health":
                return self.reply(200, {"ok": True, "model": d.model_path, "prompt_format_version": PROMPT_FORMAT_VERSION, "requests": d.requests, **d.memory()})
            self.reply(404, {"error": "not found"})

        def do_POST(self):
            routes = {"/v1/systemone": systemone, "/v1/decisions": decisions}
            if self.path not in routes:
                return self.reply(404, {"error": "not found"})
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                started = time.perf_counter()
                # One GPU, one request at a time, like a single SGLang worker without batching.
                with d.lock:
                    out = routes[self.path](d, body)
                    d.requests += 1
                    if d.requests % 100 == 0:
                        print(json.dumps({"requests": d.requests, **d.memory()}), flush=True)
                out["latency_ms"] = round((time.perf_counter() - started) * 1000, 1)
                self.reply(200, out)
            except (ValueError, KeyError, TypeError) as e:
                self.reply(400, {"error": str(e)})

        def log_message(self, *args):
            pass

    print(f"Serving {d.model_path} on http://127.0.0.1:{port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="mlx-community/Qwen3.8-27B-4bit")
    ap.add_argument("--port", type=int, default=30000)
    a = ap.parse_args()
    serve(Decider(a.model), a.port)
