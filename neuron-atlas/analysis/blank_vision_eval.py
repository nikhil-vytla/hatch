"""Score the blank-image test (analysis/blank_vision.py): when a pushed vision neuron makes the model see something in
a plain gray/black/white image, does what it sees match what that neuron responds to in real images?

Judge-free. For each push whose answer differs from the unpushed answer for that blank, take the neuron's
top-activating stimuli (by mean activation, or by most negative for negative doses) and check whether the answer
contains their expected label word ("red", "cat", "left", "3"...). Chance: the same check against stimuli drawn at
random. Also reports the answers' most common content words, the "hallucination vocabulary" of the vision tower.

  python analysis/blank_vision_eval.py BV_DIR OUT.json
"""
import collections, json, os, random, re, sys

import duckdb

NUM = {"1": "one", "2": "two", "3": "three", "4": "four", "5": "five", "6": "six", "7": "seven"}
STOPW = set("the a an of and or is in on with this image appears to be it there are no any its shows picture "
            "completely plain solid single color background which that has have just only some very".split())


def words(label):
    w = {label.lower()}
    if label in NUM:
        w.add(NUM[label])
    return w


def mentions(text, label):
    t = text.lower()
    return any(re.search(rf"\b{re.escape(w)}", t) for w in words(label))


def main(bv, out, k=3, seed=0):
    meta = json.load(open(os.path.join(bv, "meta.json")))
    stim = meta["stimuli"]
    acts = {(L, n): a for L, n, a in duckdb.sql(f"select layer, neuron, acts from '{bv}/acts.parquet'").fetchall()}
    src = os.path.join(bv, "push", "vlm.parquet")
    if not os.path.exists(src):
        src = os.path.join(bv, "push", "vlm", "*.parquet")
    rows = duckdb.sql(f"select id, layer, neuron, dose, text from '{src}'").fetchall()
    base = {i: t for i, L, n, d, t in rows if L < 0}
    rng = random.Random(seed)
    usable = [j for j, s in enumerate(stim) if s["expected"]]
    tally = collections.Counter()
    by_layer = collections.defaultdict(collections.Counter)
    vocab = collections.Counter()
    examples = []
    for i, L, n, d, t in rows:
        if L < 0:
            continue
        changed = t.strip() != base[i].strip()
        tally["pushes"] += 1
        by_layer[L]["pushes"] += 1
        if not changed:
            continue
        tally["changed"] += 1
        by_layer[L]["changed"] += 1
        a = acts[(L, n)]
        order = sorted(usable, key=lambda j: a[j] * (1 if d > 0 else -1), reverse=True)
        own = [stim[j]["expected"] for j in order[:k]]
        rnd = [stim[j]["expected"] for j in rng.sample(usable, k)]
        hit, ch = any(mentions(t, w) for w in own), any(mentions(t, w) for w in rnd)
        tally["hit"] += hit; tally["chance"] += ch
        by_layer[L]["hit"] += hit; by_layer[L]["chance"] += ch
        vocab.update(w for w in re.findall(r"[a-z]{3,}", t.lower()) if w not in STOPW)
        if len(examples) < 4000:
            examples.append([L, n, d, i, t[:160], own, hit])
    res = dict(model=meta["model"], k=k, tally=dict(tally),
               hit_rate=round(tally["hit"] / max(1, tally["changed"]), 4),
               chance_rate=round(tally["chance"] / max(1, tally["changed"]), 4),
               by_layer={L: dict(c) for L, c in sorted(by_layer.items())},
               vocab=vocab.most_common(80), baseline=base, examples=examples)
    json.dump(res, open(out, "w"))
    print(json.dumps({k_: res[k_] for k_ in ("tally", "hit_rate", "chance_rate")}))
    for L, c in sorted(by_layer.items()):
        print(f"L{L:02d} changed {c['changed']:3d}/{c['pushes']:3d} hit {c['hit']:3d} chance {c['chance']:3d}")
    print("vocab:", vocab.most_common(40))


if __name__ == "__main__":
    main(*sys.argv[1:3])
