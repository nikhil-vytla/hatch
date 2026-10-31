"""SmolLM3-3B with thinking on vs off: do the same single-neuron pushes break it equally?

Same 128 random neurons per layer (seed 0), same doses (±0.8), two prompts, two modes (chat template with
enable_thinking true: 256 new tokens, the reply is mostly the <think> block; false: 48 new tokens). Judge-free scores:
  - prime: on "Is 1001 a prime number?", the reply finds a factor (7, 11, 13, 77, 91, 143) or says it is not prime;
    wrong: it calls 1001 prime instead; the rest are undecided within the token budget.
  - name: on "Who are you?", the reply still names SmolLM / Hugging Face.
  - degenerate: the reply repeats one 3-gram over a third of its 3-grams, or is mostly non-letters.
Paired: each (neuron, dose) appears in both modes, so mode differences are not neuron-sampling noise.

  python analysis/smol_think.py THINK_STEER_DIR NOTHINK_STEER_DIR OUT.json
"""
import json, re, sys
from collections import Counter

import duckdb

FACT = re.compile(r"\b(?:7|11|13|77|91|143)\b\s*(?:[×x*·]|times|multiplied)|(?:[×x*·]|times)\s*(?:7|11|13|77|91|143)\b"
                  r"|divisible by (?:7|11|13)|not (?:a )?prime|isn't (?:a )?prime|is composite|1001\s*(?:/|÷)\s*(?:7|11|13)", re.I)
NAME = re.compile(r"smol|hugging\s*face", re.I)
# explicitly calls 1001 prime ("Yes, ...", "1001 is a prime number"), but not "to determine if 1001 is a prime"
WRONG = re.compile(r"^\W*yes\b|(?<!if )(?<!whether )(?<!if the number )\b1001 is (?:indeed |definitely )?(?:a )?prime\b"
                   r"|\bit is (?:indeed |definitely )?(?:a )?prime\b", re.I)


def degenerate(t):
    w = t.split()
    if len(w) < 6:
        return False
    g = Counter(zip(w, w[1:], w[2:]))
    return g.most_common(1)[0][1] > len(w) / 3 or sum(c.isalpha() for c in t) < 0.5 * len(t)


def load(d):
    rows = duckdb.sql(f"select layer, neuron, dose, prompt, text from '{d}/L*.parquet'").fetchall()
    import os
    bp = f"{d}/baseline.parquet"
    base = dict(duckdb.sql(f"select prompt, text from '{bp}'").fetchall()) if os.path.exists(bp) else {0: "", 1: ""}
    return {(L, n, round(dz, 2), p): t for L, n, dz, p, t in rows}, base


def main(think, nothink, out):
    T, bt = load(think)
    N, bn = load(nothink)
    keys = sorted(set(T) & set(N))
    res = dict(baseline=dict(think={p: bt[p][:300] for p in bt}, nothink={p: bn[p][:300] for p in bn}),
               base_scores={m: dict(prime=bool(FACT.search(b[1])), name=bool(NAME.search(b[0])))
                            for m, b in (("think", bt), ("nothink", bn))})
    per_layer = {}
    tab = Counter()
    for k in keys:
        L, n, dz, p = k
        for mode, src in (("think", T), ("nothink", N)):
            t = src[k]
            c = per_layer.setdefault(L, Counter())
            if p == 1:
                ok = bool(FACT.search(t))
                bad = not ok and bool(WRONG.search(t))
                c[f"{mode}_prime"] += ok; c[f"{mode}_prime_n"] += 1; tab[f"{mode}_prime"] += ok; tab[f"{mode}_prime_n"] += 1
                c[f"{mode}_wrong"] += bad; tab[f"{mode}_wrong"] += bad
            else:
                ok = bool(NAME.search(t))
                c[f"{mode}_name"] += ok; c[f"{mode}_name_n"] += 1; tab[f"{mode}_name"] += ok; tab[f"{mode}_name_n"] += 1
            dg = degenerate(t)
            c[f"{mode}_degen"] += dg; c[f"{mode}_n"] += 1; tab[f"{mode}_degen"] += dg; tab[f"{mode}_n"] += 1
        if p == 1:  # paired 2x2 for prime
            tab[f"prime_pair_{int(bool(FACT.search(T[k])))}{int(bool(FACT.search(N[k])))}"] += 1
    res["totals"] = dict(tab)
    res["rates"] = {m: dict(prime=round(tab[f"{m}_prime"] / max(1, tab[f"{m}_prime_n"]), 4),
                            wrong=round(tab[f"{m}_wrong"] / max(1, tab[f"{m}_prime_n"]), 4),
                            name=round(tab[f"{m}_name"] / max(1, tab[f"{m}_name_n"]), 4),
                            degenerate=round(tab[f"{m}_degen"] / max(1, tab[f"{m}_n"]), 4)) for m in ("think", "nothink")}
    res["per_layer"] = {L: dict(c) for L, c in sorted(per_layer.items())}
    # examples where thinking survives a push that breaks the no-think answer, and vice versa
    ex = {"think_only": [], "nothink_only": []}
    for k in keys:
        if k[3] != 1:
            continue
        a, b = bool(FACT.search(T[k])), bool(FACT.search(N[k]))
        if a != b:
            lst = ex["think_only" if a else "nothink_only"]
            if len(lst) < 25:
                lst.append(dict(layer=k[0], neuron=k[1], dose=k[2], think=T[k][-300:], nothink=N[k][:200]))
    res["examples"] = ex
    json.dump(res, open(out, "w"))
    print(json.dumps(res["base_scores"]), json.dumps(res["rates"]))
    print({k: v for k, v in tab.items() if k.startswith("prime_pair")})


if __name__ == "__main__":
    main(*sys.argv[1:4])
