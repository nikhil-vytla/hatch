"""Parity checks for the browser ONNX exports against NeuronModel + our PyTorch steering hooks.

    python browser/check_onnx.py [--build browser/build] [--kv]

Without --kv: checks last-position logits, then greedy 32-token replies (repetition penalty 1.1) for no push, one
neuron and a two-neuron recipe. ORT fp32 must match the reference token for token; ORT int8 is reported and, if it
drifts on the no-push prompts, a float16 model is exported and checked instead.

With --kv: the same six-case greedy table for the KV-cache fp32/q8/q4 models, file sizes and one-thread CPU
ms/token, and build/models.json for the browser's default-model pick.
"""
import argparse, json, sys, time
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from atlas.model import NeuronModel, parse_recipe  # noqa: E402
from atlas.steer import generate as torch_generate  # noqa: E402
import export_onnx as ex  # noqa: E402

MAX_NEW, PENALTY = 32, 1.1
RECIPE = "L5N200-0.5 L12N300+0.5"


def session(path, threads=4):
    so = ort.SessionOptions()
    so.intra_op_num_threads = threads
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])


def encode(tok, prompt):
    return tok(prompt, return_tensors="pt", add_special_tokens=False)["input_ids"]


def steer_for(terms, d_mlp, resid, colnorm):
    s = np.zeros((len(resid), d_mlp), dtype=np.float32)
    for layer, neuron, op, value in terms:
        if op == "add":
            s[layer, neuron] += value * resid[layer] / colnorm[layer, neuron]
    return s


@torch.no_grad()
def ref_generate(nm, ids, terms, resid):
    if terms:
        nm.set_recipes([terms], resid)
    else:
        nm.clear_steer()
    return torch_generate(nm, nm.tok.batch_decode(ids, skip_special_tokens=False)[0], 1, MAX_NEW)[0]


def ort_generate(sess, ids, steer, eos):
    prompt_len = int(ids.shape[1])
    seq = ids.flatten().tolist()
    for _ in range(MAX_NEW):
        logits = sess.run(None, {"input_ids": np.array([seq], dtype=np.int64), "steer": steer})[0][0]
        for t in set(seq):
            if logits[t] > 0:
                logits[t] /= PENALTY
            else:
                logits[t] *= PENALTY
        nxt = int(logits.argmax())
        seq.append(nxt)
        if nxt in eos:
            break
    return seq[prompt_len:]


def match32(a, b):
    return sum((a[i] if i < len(a) else None) == (b[i] if i < len(b) else None) for i in range(MAX_NEW))


def kv_past_shape(meta, sess):
    n_kv, head_dim = meta.get("n_kv_heads"), meta.get("head_dim")
    if n_kv is None or head_dim is None:
        for inp in sess.get_inputs():
            if inp.name == "past_key_values.0.key":
                n_kv, head_dim = inp.shape[1], inp.shape[3]
                break
    return n_kv, head_dim


def kv_feed(ids, steer, mask_len, past, n_layers):
    feed = {"input_ids": np.asarray(ids, dtype=np.int64), "steer": steer,
            "attention_mask": np.ones((1, mask_len), dtype=np.int64)}
    for i in range(n_layers):
        feed[f"past_key_values.{i}.key"] = past[2 * i]
        feed[f"past_key_values.{i}.value"] = past[2 * i + 1]
    return feed


def empty_past(n_layers, n_kv, head_dim):
    return [np.zeros((1, n_kv, 0, head_dim), dtype=np.float32) for _ in range(2 * n_layers)]


def ort_generate_kv(sess, ids, steer, eos, n_layers, n_kv, head_dim):
    prompt_len = int(ids.shape[1])
    seq = ids.flatten().tolist()
    past = empty_past(n_layers, n_kv, head_dim)
    outs = sess.run(None, kv_feed(ids.numpy(), steer, prompt_len, past, n_layers))
    logits = outs[0][0]
    present = list(outs[1:])
    for _ in range(MAX_NEW):
        for t in set(seq):
            if logits[t] > 0:
                logits[t] /= PENALTY
            else:
                logits[t] *= PENALTY
        nxt = int(logits.argmax())
        seq.append(nxt)
        if nxt in eos or len(seq) - prompt_len >= MAX_NEW:
            break
        feed = kv_feed(np.array([[nxt]], dtype=np.int64), steer, len(seq), present, n_layers)
        outs = sess.run(None, feed)
        logits = outs[0][0]
        present = list(outs[1:])
    return seq[prompt_len:]


def time_kv(sess, ids, steer, n_layers, n_kv, head_dim, steps=MAX_NEW):
    prompt_len = int(ids.shape[1])
    past = empty_past(n_layers, n_kv, head_dim)
    feed = kv_feed(ids.numpy(), steer, prompt_len, past, n_layers)
    t0 = time.perf_counter()
    outs = sess.run(None, feed)
    prefill_ms = (time.perf_counter() - t0) * 1000
    present = list(outs[1:])
    token = int(np.argmax(outs[0][0]))
    times = []
    for k in range(steps):
        feed = kv_feed(np.array([[token]], dtype=np.int64), steer, prompt_len + k + 1, present, n_layers)
        t0 = time.perf_counter()
        outs = sess.run(None, feed)
        times.append(time.perf_counter() - t0)
        present = list(outs[1:])
        token = int(np.argmax(outs[0][0]))
    return prefill_ms, 1000 * sum(times) / len(times)


def text(tok, ids):
    return tok.decode(ids, skip_special_tokens=True).replace("\n", " ").strip()


def run_kv_checks(build, meta, n_layers, d_mlp, resid, colnorm, eos, nm):
    prompts = ["Who are you?", "Tell me a short story."]
    conds = [("none", []), ("L10N100+0.8", [(10, 100, "add", 0.8)]),
             ("recipe", parse_recipe(RECIPE))]
    paths = {"fp32": build / "smollm2_steer_kv.onnx",
             "fp16": build / "smollm2_steer_kv_fp16.onnx",
             "q8": build / "smollm2_steer_kv_q8.onnx",
             "q4": build / "smollm2_steer_kv_q4.onnx"}
    names = {k: p.name for k, p in paths.items()}
    sessions, dims = {}, {}
    for key, path in paths.items():
        if not path.exists():
            print(f"missing {path}; skipping {key}")
            continue
        sess = session(path, threads=1)
        sessions[key] = sess
        dims[key] = kv_past_shape(meta, sess)
    if "fp32" not in sessions:
        raise SystemExit(f"missing {paths['fp32']}")

    prompt = nm.chat_prompt("Who are you?")
    ids = encode(nm.tok, prompt)
    zero = np.zeros((n_layers, d_mlp), dtype=np.float32)
    single = steer_for([(10, 100, "add", 0.8)], d_mlp, resid, colnorm)
    n_kv, head_dim = dims["fp32"]
    diffs = {}
    for name, terms, steer in (("zero steer", [], zero),
                               ("L10N100 +0.8", [(10, 100, "add", 0.8)], single)):
        if terms:
            nm.set_recipes([terms], resid)
        else:
            nm.clear_steer()
        with torch.no_grad():
            ref = nm.model(input_ids=ids, use_cache=False, return_dict=True).logits[:, -1, :].numpy()
        past = empty_past(n_layers, n_kv, head_dim)
        got = sessions["fp32"].run(None, kv_feed(ids.numpy(), steer, int(ids.shape[1]), past,
                                                n_layers))[0][0]
        diffs[name] = float(np.max(np.abs(ref[0] - got)))
    nm.clear_steer()

    print("\nlogits KV fp32 prefill (last position)")
    print(f"  {'case':22s} {'max|diff|':>10s}  ok")
    logit_ok = True
    for name, d in diffs.items():
        ok = d < 1e-3
        logit_ok &= ok
        print(f"  {name:22s} {d:10.2e}  {'yes' if ok else 'NO'}")

    results = {k: [] for k in sessions}
    rows = []
    for p in prompts:
        pid = encode(nm.tok, nm.chat_prompt(p))
        for cname, terms in conds:
            ref = ref_generate(nm, pid, terms, resid)
            steer = steer_for(terms, d_mlp, resid, colnorm)
            m = {}
            for key, sess in sessions.items():
                kv, hd = dims[key]
                got = ort_generate_kv(sess, pid, steer, eos, n_layers, kv, hd)
                m[key] = match32(ref, got)
                results[key].append(m[key])
            rows.append((p, cname, len(ref), m))
            cols = "  ".join(f"{key} {m[key]:2d}/32" for key in sessions)
            print(f"  {p[:22]:22s} {cname:14s} {len(ref):2d} tok -> {cols}", flush=True)
    nm.clear_steer()

    print("\ngreedy 32 tokens, repetition penalty 1.1 (KV cache)")
    labels = {"fp32": "kv fp32", "fp16": "kv fp16", "q8": "q8", "q4": "q4"}
    header = f"  {'prompt':22s} {'push':14s}" + "".join(f" {labels[k]:>8s}" for k in sessions)
    print(header)
    for p, cname, nref, m in rows:
        vals = "".join(f" {m[k]:5d}/32" for k in sessions)
        print(f"  {p[:22]:22s} {cname:14s}{vals}")

    timing_id = encode(nm.tok, nm.chat_prompt("Who are you?"))
    timing_steer = np.zeros((n_layers, d_mlp), dtype=np.float32)
    print("\nfile sizes and CPU speed (onnxruntime, 1 thread; prefill once, then one token/step)")
    print(f"  {'model':32s} {'MB':>8s} {'prefill ms':>11s} {'ms/token':>9s}")
    for key, path in paths.items():
        if key not in sessions:
            continue
        kv, hd = dims[key]
        prefill_ms, per_token_ms = time_kv(sessions[key], timing_id, timing_steer, n_layers, kv, hd)
        print(f"  {path.name:32s} {path.stat().st_size / 1e6:8.1f} {prefill_ms:11.1f} "
              f"{per_token_ms:9.1f}", flush=True)

    files = {}
    for key, path in paths.items():
        if path.exists():
            files[names[key]] = {"bytes": path.stat().st_size,
                                 "matches": int(sum(results.get(key, [0]))),
                                 "per_case": [int(x) for x in results.get(key, [])]}

    def good(key):
        vals = results.get(key, [])
        return len(vals) == len(prompts) * len(conds) and all(v >= 30 for v in vals)

    # smallest file that still reproduces PyTorch greedy decoding
    if good("fp16"):
        default = names["fp16"]
    elif good("q8"):
        default = names["q8"]
    elif good("q4"):
        default = names["q4"]
    else:
        default = names["fp32"]
    (build / "models.json").write_text(json.dumps({"default": default, "files": files}, indent=1) + "\n")
    print(f"\nwrote {build / 'models.json'}  default={default}")

    fp32_ok = all(m == 32 for m in results["fp32"])
    ok = logit_ok and fp32_ok
    print(f"\n{'PASS' if ok else 'FAIL'}: KV logits {'ok' if logit_ok else 'bad'}, "
          f"kv fp32 greedy {'ok' if fp32_ok else 'mismatch'}")
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--build", default=str(Path(__file__).with_name("build")))
    ap.add_argument("--kv", action="store_true", help="check the KV-cache fp32/q8/q4 exports instead")
    a = ap.parse_args()
    build = Path(a.build)
    meta = json.load(open(build / "steer_meta.json"))
    n_layers, d_mlp, resid = meta["n_layers"], meta["d_mlp"], meta["resid_median"]
    colnorm = np.fromfile(build / "colnorm.f32", dtype="<f4").reshape(n_layers, d_mlp)
    eos = set(meta["eos"])

    nm = NeuronModel(meta["model"], device="cpu", dtype=torch.float32)
    nm.clear_steer()
    if a.kv:
        sys.exit(run_kv_checks(build, meta, n_layers, d_mlp, resid, colnorm, eos, nm))

    wrapper = ex.SteerWrapper(nm.model)  # wraps the same model in place; nm's hooks still apply
    wrapper._steer = None

    fp32 = session(build / "smollm2_steer.onnx")
    int8 = session(build / "smollm2_steer_int8.onnx")

    def ort_logits(sess, ids, steer):
        return sess.run(None, {"input_ids": ids.numpy().astype(np.int64), "steer": steer})[0][0]

    prompt = nm.chat_prompt("Who are you?")
    ids = encode(nm.tok, prompt)
    zero = np.zeros((n_layers, d_mlp), dtype=np.float32)
    single = steer_for([(10, 100, "add", 0.8)], d_mlp, resid, colnorm)
    diffs = {}
    for name, steer in (("zero steer", zero), ("L10N100 +0.8", single)):
        with torch.no_grad():
            ref = wrapper(ids, torch.from_numpy(steer))[0].numpy()
        diffs[name] = float(np.max(np.abs(ref - ort_logits(fp32, ids, steer))))
    wrapper._steer = None

    print("\nlogits fp32 (last position)")
    print(f"  {'case':22s} {'max|diff|':>10s}  ok")
    logit_ok = True
    for name, d in diffs.items():
        ok = d < 1e-3
        logit_ok &= ok
        print(f"  {name:22s} {d:10.2e}  {'yes' if ok else 'NO'}")

    prompts = ["Who are you?", "Tell me a short story."]
    conds = [("none", []), ("L10N100+0.8", [(10, 100, "add", 0.8)]),
             ("recipe", parse_recipe(RECIPE))]
    rows, texts = [], {}
    for p in prompts:
        pid = encode(nm.tok, nm.chat_prompt(p))
        for cname, terms in conds:
            ref = ref_generate(nm, pid, terms, resid)
            steer = steer_for(terms, d_mlp, resid, colnorm)
            got32 = ort_generate(fp32, pid, steer, eos)
            got8 = ort_generate(int8, pid, steer, eos)
            rows.append((p, cname, match32(ref, got32), match32(ref, got8), len(ref), len(got8)))
            texts[(p, cname)] = (ref, got8)
            print(f"  {p[:22]:22s} {cname:14s} {len(ref):2d} tok -> fp32 {match32(ref, got32):2d}/32  "
                  f"int8 {match32(ref, got8):2d}/32", flush=True)
    nm.clear_steer()
    wrapper._steer = None

    print("\ngreedy 32 tokens, repetition penalty 1.1")
    print(f"  {'prompt':22s} {'push':14s} {'fp32':>7s} {'int8':>7s}")
    fp32_ok = True
    for p, cname, m32, m8, nref, n8 in rows:
        fp32_ok &= m32 == 32
        print(f"  {p[:22]:22s} {cname:14s} {m32:4d}/32 {m8:4d}/32")
    print("\nint8 replies (reference vs int8)")
    for (p, cname), (ref, got8) in texts.items():
        print(f"  [{p} / {cname}]  ref={len(ref)}tok int8={len(got8)}tok")
        print(f"    ref : {text(nm.tok, ref)}")
        print(f"    int8: {text(nm.tok, got8)}")

    bad = [m8 for _, cname, _, m8, *_ in rows if cname == "none" and m8 < 16]
    if bad:
        fp16_path = build / "smollm2_steer_fp16.onnx"
        ex.export_fp16(build / "smollm2_steer.onnx", fp16_path)
        print(f"\nint8 drift on no-push prompts ({bad}); wrote {fp16_path} "
              f"({fp16_path.stat().st_size / 1e6:.1f} MB)")
        fp16 = session(fp16_path)
        print(f"  {'prompt':22s} {'push':14s} {'fp16':>7s}")
        for p in prompts:
            pid = encode(nm.tok, nm.chat_prompt(p))
            for cname, terms in conds:
                ref = ref_generate(nm, pid, terms, resid)
                got = ort_generate(fp16, pid, steer_for(terms, d_mlp, resid, colnorm), eos)
                print(f"  {p[:22]:22s} {cname:14s} {match32(ref, got):4d}/32")
        nm.clear_steer()
        wrapper._steer = None

    ok = logit_ok and fp32_ok
    print(f"\n{'PASS' if ok else 'FAIL'}: logits {'ok' if logit_ok else 'bad'}, "
          f"fp32 greedy {'ok' if fp32_ok else 'mismatch'}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
