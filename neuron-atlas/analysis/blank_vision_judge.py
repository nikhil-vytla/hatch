"""Blind judge for the blank-image test: does a vision neuron's hallucination describe what that neuron responds to?

For every pushed answer that describes something other than a blank image, show the judge two sets of three stimulus
descriptions, in random order: the neuron's top-activating stimuli for the push direction, and three random stimuli.
The judge picks the set the hallucination resembles more, or "neither". Own-set picks above the random-set picks
mean the hallucination carries the neuron's preferred content. Also: consistency, i.e. how often one neuron's
hallucinations on the gray, black and white images share content (judged per neuron).

  python analysis/blank_vision_judge.py OUT.json
"""
import concurrent.futures as cf, json, random, re, sys

import duckdb
from huggingface_hub import hf_hub_download

from atlas.judges import make_judge

R, P = "nikhilxvytla/neuron-atlas", "Qwen__Qwen2.5-VL-3B-Instruct/blank/"
BLANK = re.compile(r"blank|no visible|empty|plain|solid|uniform|nothing|no (?:discernible|distinct|objects|content|details)"
                   r"|completely|entirely|cannot|sorry|unable", re.I)
SYS = """A vision-language model was shown a plain, empty image while one neuron in its vision encoder was artificially
pushed, and it described something. For each item you get that description and two sets (A and B) of short
descriptions of real test images. Say which set the description resembles more in content (objects, shapes,
patterns, colors, text, counts), or "neither" if it resembles neither clearly. Ignore the words "black", "white" and
"gray" when they only describe the background. Answer JSON: {"items": [{"i": 0, "pick": "A"|"B"|"neither"}, ...]}"""
CONS = """Each item lists two or three descriptions a vision-language model gave of different plain, empty images while
the same neuron was pushed. Say whether they share specific content (the same object, pattern, shape or text), beyond
being dark/light/abstract. Answer JSON: {"items": [{"i": 0, "shared": true|false}, ...]}"""


def describe(s):
    """'dots_3' + count + '3' -> 'an image of 3 dots' style text from the stimulus id."""
    sid, kind, exp = s["id"], s["kind"], s["expected"]
    words = sid.replace("_", " ")
    return f"{kind} image '{words}' (answer: {exp})"


def main(out, k=3, seed=0):
    meta = json.load(open(hf_hub_download(R, P + "meta.json", repo_type="dataset")))
    stim = meta["stimuli"]
    acts = {(L, n): a for L, n, a in duckdb.sql(f"select layer, neuron, acts from '{hf_hub_download(R, P + 'acts.parquet', repo_type='dataset')}'").fetchall()}
    rows = duckdb.sql(f"select id, layer, neuron, dose, text from '{hf_hub_download(R, P + 'vlm.parquet', repo_type='dataset')}' where layer >= 0").fetchall()
    rng = random.Random(seed)
    items = []
    for i, L, n, d, t in rows:
        if BLANK.search(t):
            continue
        a = acts[(L, n)]
        order = sorted(range(len(stim)), key=lambda j: a[j] * (1 if d > 0 else -1), reverse=True)
        own = [describe(stim[j]) for j in order[:k]]
        rnd = [describe(stim[j]) for j in rng.sample(order[k:], k)]
        own_is_a = rng.random() < 0.5
        items.append(dict(blank=i, layer=L, neuron=n, dose=d, text=t, own=own, rnd=rnd, own_is_a=own_is_a))
    judge = make_judge("deepseek")

    def ask(chunk):
        lines = []
        for j, x in enumerate(chunk):
            A, B = (x["own"], x["rnd"]) if x["own_is_a"] else (x["rnd"], x["own"])
            lines.append(f"[{j}] description: {x['text'][:200]!r}\n    A: {'; '.join(A)}\n    B: {'; '.join(B)}")
        res = judge.ask(SYS, "\n".join(lines)) or {}
        for y in res.get("items", []):
            try:
                x = chunk[int(y["i"])]
            except (KeyError, ValueError, IndexError, TypeError):
                continue
            p = y.get("pick")
            x["verdict"] = "neither" if p not in ("A", "B") else ("own" if (p == "A") == x["own_is_a"] else "random")

    with cf.ThreadPoolExecutor(8) as ex:
        list(ex.map(ask, [items[s:s + 10] for s in range(0, len(items), 10)]))
    # consistency: neurons (and dose) with a hallucination on at least two of the three blanks
    groups = {}
    for x in items:
        groups.setdefault((x["layer"], x["neuron"], x["dose"]), []).append(x["text"])
    multi = [(key, ts) for key, ts in groups.items() if len(ts) >= 2]
    shared = {}

    def ask_c(chunk):
        res = judge.ask(CONS, "\n".join(f"[{j}] " + " | ".join(repr(t[:150]) for t in ts) for j, (_, ts) in enumerate(chunk))) or {}
        for y in res.get("items", []):
            try:
                shared[chunk[int(y["i"])][0]] = bool(y["shared"])
            except (KeyError, ValueError, IndexError, TypeError):
                pass

    with cf.ThreadPoolExecutor(8) as ex:
        list(ex.map(ask_c, [multi[s:s + 10] for s in range(0, len(multi), 10)]))
    judged = [x for x in items if "verdict" in x]
    c = {v: sum(x["verdict"] == v for x in judged) for v in ("own", "random", "neither")}
    res = dict(n_hallucinations=len(items), n_judged=len(judged), verdicts=c,
               n_multi=len(multi), n_shared=sum(shared.values()), n_cons_judged=len(shared),
               shared=[[*key, v] for key, v in shared.items()], items=items)
    json.dump(res, open(out, "w"))
    print(json.dumps({k_: v for k_, v in res.items() if k_ not in ("items", "shared")}))



def shuffled_control(res_path, seed=1):
    """Same consistency question on groups of hallucinations drawn from different neurons (same group sizes)."""
    res = json.load(open(res_path))
    groups = {}
    for x in res["items"]:
        groups.setdefault((x["layer"], x["neuron"], x["dose"]), []).append(x["text"])
    sizes = [len(ts) for ts in groups.values() if len(ts) >= 2]
    pool = [x["text"] for x in res["items"]]
    rng = random.Random(seed)
    fake = [rng.sample(pool, s) for s in sizes]
    judge = make_judge("deepseek")
    got = []
    for s in range(0, len(fake), 10):
        chunk = fake[s:s + 10]
        r = judge.ask(CONS, "\n".join(f"[{j}] " + " | ".join(repr(t[:150]) for t in ts) for j, ts in enumerate(chunk))) or {}
        got += [bool(y.get("shared")) for y in r.get("items", [])]
    res["control_shared"], res["control_judged"] = sum(got), len(got)
    json.dump(res, open(res_path, "w"))
    print(f"shuffled control: {sum(got)} of {len(got)} groups judged as sharing content")


if __name__ == "__main__":
    shuffled_control(sys.argv[2]) if sys.argv[1] == "--control" else main(sys.argv[1])
