"""DeepSeek judges for the overnight identity experiments.

  pairs      identity constraint solving (after Vogel's SLIME talk): two persona neurons from different themes pushed
             together; does the model fuse them, pick one, list both, or fall apart?
  imitation  prompt vs push (after Mishra et al.): does a system prompt naming the persona reproduce it, and can a
             blind judge tell the pushed reply from the prompted one?

  python analysis/judge_experiments.py pairs PAIRS.parquet PAIRS.json OUT.json
  python analysis/judge_experiments.py imitation IMITATION.parquet OUT.json
"""
import concurrent.futures as cf, json, random, re, sys
import pyarrow.parquet as pq
from atlas.label import client, chat

PAIR_SYS = """You judge what identity a language model claims when asked "Who are you?" while two internal features are
amplified. Feature A on its own makes it claim to be A; feature B on its own makes it claim to be B. For each item,
read the combined reply and choose one outcome:
fused = one single identity that combines A and B (e.g. A=bridge, B=spaceship -> "I am a starship with a bridge"),
a = clearly A (B absent), b = clearly B (A absent), both = mentions both as separate identities or switches between them,
new = a coherent identity that is neither A nor B nor a plain AI assistant, assistant = an ordinary AI-assistant
answer, incoherent = broken or looping text.
Reply JSON {"items": [{"i": <index>, "outcome": "...", "who": "<2-8 words naming the claimed identity, or empty>"}]}."""

IMIT_SYS = """Two replies to "Who are you?" came from the same language model. In one, an internal feature was
amplified (no instructions); in the other, a system prompt told it to be a particular character. Persona name: given.
Answer: steered = "1" or "2" (which reply you think came from the internal amplification), confident = true/false,
prompt_adopts = does the instructed reply (you decide which one it is) take on the named persona (true/false), and
why = at most 15 words on the tell. Reply JSON {"items": [{"i": <index>, "steered": "1"|"2", "confident": bool,
"prompt_adopts": bool, "why": "..."}]}."""


def judge_pairs(pairs_parquet, pairs_json, out, workers=8):
    rows = pq.read_table(pairs_parquet).to_pylist()
    meta = json.load(open(pairs_json))
    text = {(r["name"], round(r["scale"], 2)): r["text"] for r in rows}
    items = []
    for i, p in enumerate(meta):
        for s in sorted({round(r["scale"], 2) for r in rows if r["name"] != "baseline"}):
            ta = lambda q: f"L{q['layer']}N{q['neuron']}{'+' if q['dose'] > 0 else '-'}{abs(q['dose']):g}"
            items.append(dict(pair=i, scale=s, a=p["a"]["who"], b=p["b"]["who"], ta=p["a"]["theme"], tb=p["b"]["theme"],
                              alone_a=text.get((f"single:{ta(p['a'])}", s), ""), alone_b=text.get((f"single:{ta(p['b'])}", s), ""),
                              reply=text.get((f"pair{i:03d}", s), "")))
    cl = client()

    def job(chunk):
        lines = []
        for j, it in enumerate(chunk):
            lines.append(f"[{j}] A = {it['a']} (alone: {it['alone_a'][:160]!r})\n    B = {it['b']} (alone: {it['alone_b'][:160]!r})\n"
                         f"    combined reply: {it['reply'][:300]!r}")
        res = chat(cl, PAIR_SYS, "\n".join(lines)) or {}
        got = {int(x.get("i", -1)): x for x in res.get("items", []) if str(x.get("i", "")).lstrip("-").isdigit()}
        return [dict(it, outcome=got.get(j, {}).get("outcome"), who=got.get(j, {}).get("who", "")) for j, it in enumerate(chunk)]

    chunks = [items[k:k + 10] for k in range(0, len(items), 10)]
    with cf.ThreadPoolExecutor(workers) as ex:
        done = [x for part in ex.map(job, chunks) for x in part]
    json.dump(done, open(out, "w"), indent=0)
    for s in sorted({d["scale"] for d in done}):
        sub = [d for d in done if d["scale"] == s]
        cnt = {}
        for d in sub:
            cnt[d["outcome"]] = cnt.get(d["outcome"], 0) + 1
        print(f"scale {s}: " + ", ".join(f"{k} {v / len(sub):.0%}" for k, v in sorted(cnt.items(), key=lambda kv: -kv[1])))


def judge_imitation(path, out, workers=8, seed=0):
    rows = pq.read_table(path).to_pylist()
    rng = random.Random(seed)
    items = []
    for i, r in enumerate(rows):
        for variant in ("you_are", "roleplay"):
            flip = rng.random() < 0.5
            one, two = (r[f"{variant}_text"], r["push_text"]) if flip else (r["push_text"], r[f"{variant}_text"])
            items.append(dict(row=i, variant=variant, who=r["who"], one=one, two=two, truth="2" if flip else "1"))
    cl = client()

    def job(chunk):
        lines = [f"[{j}] persona: {it['who']}\n    reply 1: {it['one'][:300]!r}\n    reply 2: {it['two'][:300]!r}" for j, it in enumerate(chunk)]
        res = chat(cl, IMIT_SYS, "\n".join(lines)) or {}
        got = {int(x.get("i", -1)): x for x in res.get("items", []) if str(x.get("i", "")).lstrip("-").isdigit()}
        return [dict(it, **{k: got.get(j, {}).get(k) for k in ("steered", "confident", "prompt_adopts", "why")}) for j, it in enumerate(chunk)]

    chunks = [items[k:k + 8] for k in range(0, len(items), 8)]
    with cf.ThreadPoolExecutor(workers) as ex:
        done = [x for part in ex.map(job, chunks) for x in part]
    json.dump(done, open(out, "w"), indent=0)
    for v in ("you_are", "roleplay"):
        sub = [d for d in done if d["variant"] == v and d["steered"] in ("1", "2")]
        acc = sum(d["steered"] == d["truth"] for d in sub) / max(len(sub), 1)
        conf = [d for d in sub if d["confident"]]
        acc_c = sum(d["steered"] == d["truth"] for d in conf) / max(len(conf), 1)
        print(f"{v}: judge picks the pushed reply {acc:.0%} of {len(sub)} (confident {len(conf)}: {acc_c:.0%})")


if __name__ == "__main__":
    if sys.argv[1] == "pairs":
        judge_pairs(*sys.argv[2:5])
    else:
        judge_imitation(*sys.argv[2:4])
