"""Lens-guided pushes: pick neurons by what they *say* (top lens tokens), push them, and see if the model becomes it.

For each concept word and each lens (logit, j, r), take up to K neurons whose top-10 up tokens contain the word (pushed
up, +dose) or whose top-10 down tokens contain it (pushed down, -dose), best rank first, from layers >= MIN_LAYER.
Controls: random neurons from the same layers. Writes a recipes TSV for atlas.steer.run_recipes and a JSON key.

  python analysis/lens_guided.py JLENS_DIR OUT_DIR
"""
import json, os, random, sys
import pyarrow.parquet as pq

CONCEPTS = ["cat", "dog", "bird", "fish", "horse", "wolf", "dragon", "ocean", "river", "mountain", "tree", "flower",
            "fire", "moon", "sun", "star", "ghost", "angel", "robot", "king", "queen", "doctor", "teacher", "soldier",
            "music", "poem", "money", "chef", "pizza", "coffee", "car", "train", "ship", "bridge", "castle", "city",
            "child", "mother", "god", "computer", "water", "snow", "space", "light", "dream", "love", "war", "death"]
K, DOSE, MIN_LAYER = 6, 0.8, 8


def main(jdir, out, seed=0):
    rng = random.Random(seed)
    hits = {}  # (concept, lens) -> [(rank, layer, neuron, sign)]
    layers = []
    for L in range(64):
        p = os.path.join(jdir, f"L{L:02d}.parquet")
        if not os.path.exists(p):
            continue
        layers.append(L)
        if L < MIN_LAYER:
            continue
        t = pq.read_table(p).to_pydict()
        lenses = sorted({k.rsplit("_", 1)[0] for k in t if k != "neuron"})
        for name in lenses:
            for sign, col in ((1, f"{name}_up"), (-1, f"{name}_down")):
                for n, toks in zip(t["neuron"], t[col]):
                    for rank, tok in enumerate(toks):
                        w = tok.strip().lower()
                        if w in CONCEPTS:
                            hits.setdefault((w, name), []).append((rank, L, n, sign))
    recipes, key = [], []
    for (w, name), hs in sorted(hits.items()):
        hs.sort()
        for rank, L, n, sign in hs[:K]:
            nm = f"{name}:{w}:L{L}N{n}"
            recipes.append((nm, f"L{L}N{n}{'+' if sign > 0 else '-'}{DOSE:g}"))
            key.append(dict(name=nm, lens=name, concept=w, layer=L, neuron=n, sign=sign, rank=rank))
    late = [L for L in layers if L >= MIN_LAYER]
    for i in range(300):
        L, n, s = rng.choice(late), rng.randrange(9216), rng.choice((1, -1))
        nm = f"random::L{L}N{n}{'+' if s > 0 else '-'}"
        recipes.append((nm, f"L{L}N{n}{'+' if s > 0 else '-'}{DOSE:g}"))
        key.append(dict(name=nm, lens="random", concept="", layer=L, neuron=n, sign=s, rank=-1))
    os.makedirs(out, exist_ok=True)
    open(os.path.join(out, "lens_recipes.tsv"), "w").write("".join(f"{a}\t{b}\n" for a, b in recipes))
    json.dump(key, open(os.path.join(out, "lens_key.json"), "w"), indent=0)
    cov = {}
    for k in key:
        cov.setdefault(k["lens"], set()).add(k["concept"])
    print(len(recipes), "recipes;", {k: len(v) for k, v in cov.items()}, "concepts covered per lens")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
