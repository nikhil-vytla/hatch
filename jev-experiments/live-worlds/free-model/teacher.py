"""The local teacher first tried: Qwen3-4B-Instruct-2507 (Apache-2.0), 4-bit, on MLX.

The shipped student learned from teacher_fireworks.py instead; this one's labels are kept as a
second-teacher comparison on the gold sets (see README).

Reuses local-models-and-games/apple/prefill.py: each question is answered by the first-token
probabilities of its lettered options after one shared prompt prefix. No generated text.

Labels come only from this open model; no Jev output is read, fitted or selected against
(TypeSafe's Master Customer Agreement section 2.3(b) forbids training a model on Jev output).

    teacher.py IN.jsonl OUT.jsonl     # rows {id, request:{state, questions}} -> {id, answers}
"""

import json, os, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "local-models-and-games" / "apple"))

from prefill import PrefillDecision  # noqa: E402
from huggingface_hub import snapshot_download  # noqa: E402

TEACHER = "mlx-community/Qwen3-4B-Instruct-2507-4bit"


def main(src, dst):
    done = set()
    if os.path.exists(dst):
        done = {json.loads(l)["id"] for l in open(dst) if l.strip()}
    rows = [json.loads(l) for l in open(src) if l.strip()]
    todo = [r for r in rows if r["id"] not in done]
    print(f"{len(rows)} rows, {len(done)} done, {len(todo)} to label", flush=True)
    model = PrefillDecision(snapshot_download(TEACHER))
    started = time.perf_counter()
    with open(dst, "a") as out:
        for n, r in enumerate(todo, 1):
            res = model.predict(r["request"]["state"], r["request"]["questions"])
            answers = {k: dict(zip(v["keys"], v["probabilities"])) for k, v in res["answers"].items()}
            out.write(json.dumps({"id": r["id"], "answers": answers, "ms": round(res["latency_ms"])}) + "\n")
            if n % 100 == 0:
                out.flush()
                rate = n / (time.perf_counter() - started)
                print(f"{n}/{len(todo)}  {rate:.1f}/s  eta {(len(todo) - n) / rate / 60:.1f} min", flush=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
