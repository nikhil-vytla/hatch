"""TinyStories-33M: does a neuron's lens readout predict the words its push adds to the story?

The metric of analysis/lens_vs_push.py and the pre-registration: a pushed continuation "hits" when it contains a word
(lowercase letters, >= 4) absent from the unpushed continuation that starts with one of the neuron's top-10 lens
tokens for the push direction (stripped, lowercase, alphabetic, >= 4 letters). Chance: the same test with a random
other neuron's tokens (same layer). Also "character hits": the hit word is inside the parsed character.

  python analysis/ts_says.py OUT.json
"""
import json, random, re, sys

import duckdb
from huggingface_hub import hf_hub_download

sys.path.insert(0, "analysis")
from ts_characters import character  # noqa: E402

R, M = "nikhilxvytla/neuron-atlas", "roneneldan__TinyStories-33M"
WORD = re.compile(r"[a-z]{4,}")


def toks(lst):
    return {t.strip().lower() for t in lst if t.strip().isalpha() and len(t.strip()) >= 4}


def hit(text, base_words, tokens):
    new = [w for w in WORD.findall(text.lower()) if w not in base_words]
    return any(w.startswith(t) for w in new for t in tokens)


def main(out, seed=0):
    rng = random.Random(seed)
    base = {p: t for p, t in duckdb.sql(f"select prompt, text from '{hf_hub_download(R, f'{M}/sweep/steer/baseline.parquet', repo_type='dataset')}'").fetchall()}
    bw = {p: set(WORD.findall(t.lower())) for p, t in base.items()}
    res = {}
    for lens in ("j", "logit"):
        tally = {}
        for L in range(4):
            lp = hf_hub_download(R, f"{M}/jlens/L{L:02d}.parquet", repo_type="dataset")
            ln = {n: (toks(u), toks(d)) for n, u, d in duckdb.sql(f"select neuron, {lens}_up, {lens}_down from '{lp}'").fetchall()}
            ids = list(ln)
            sp = hf_hub_download(R, f"{M}/sweep/steer/L{L:02d}.parquet", repo_type="dataset")
            for n, d, p, t in duckdb.sql(f"select neuron, dose, prompt, text from '{sp}'").fetchall():
                k = 0 if d > 0 else 1
                own, oth = ln[n][k], ln[rng.choice(ids)][k]
                c = tally.setdefault((L, p), [0, 0, 0, 0])
                c[0] += hit(t, bw[p], own); c[1] += hit(t, bw[p], oth); c[3] += 1
                ch = character(t)[0]
                c[2] += any(w.startswith(x) for w in WORD.findall(ch) for x in own) and ch != character(base[p])[0]
        res[lens] = {f"L{L}p{p}": dict(hit=a / n, chance=b / n, char_hit=cc / n, n=n) for (L, p), (a, b, cc, n) in sorted(tally.items())}
        tot = [sum(v[i] for v in tally.values()) for i in range(4)]
        res[lens]["all"] = dict(hit=tot[0] / tot[3], chance=tot[1] / tot[3], char_hit=tot[2] / tot[3], n=tot[3])
    json.dump(res, open(out, "w"), indent=1)
    for lens, r in res.items():
        print(lens, {k: (round(v["hit"], 4), round(v["chance"], 4), round(v["char_hit"], 4)) for k, v in r.items()})


if __name__ == "__main__":
    main(sys.argv[1])
