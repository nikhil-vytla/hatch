"""Does a neuron's lens readout predict what pushing it makes the model say?

For every stored push reply of an all-neuron sweep, take the words the reply adds over the unpushed reply and check
whether any of the neuron's top-10 lens tokens for the push's sign (up for +, down for -) shows up among them (a token
matches a word it is a prefix of, tokens shorter than 4 letters are ignored). The null swaps in a random other
neuron's tokens from the same layer and sign; the sign control uses the neuron's own tokens for the opposite sign.

  python analysis/lens_vs_push.py SWEEP_DIR JLENS_DIR OUT.json
"""
import json, random, re, sys
import duckdb, pyarrow.parquet as pq

WORD = re.compile(r"[a-z]{4,}")


def norm_tokens(toks):
    out = []
    for t in toks:
        t = t.strip().lower()
        if len(t) >= 4 and t.isalpha():
            out.append(t)
    return out


def hit(tokens, words):
    return any(w.startswith(t) for t in tokens for w in words)


def main(sweep, jdir, out, seed=0):
    rng = random.Random(seed)
    c = duckdb.connect()
    base = {p: set(WORD.findall((t or "").lower())) for p, t in
            c.sql(f"select prompt, text from '{sweep}/steer/baseline.parquet' where layer < 0").fetchall()}
    lenses = None
    res = {}
    for L in range(64):
        try:
            t = pq.read_table(f"{jdir}/L{L:02d}.parquet").to_pydict()
        except FileNotFoundError:
            continue
        lenses = lenses or sorted({k.rsplit("_", 1)[0] for k in t if k != "neuron"})
        tok = {name: {s: [norm_tokens(x) for x in t[f"{name}_{'up' if s > 0 else 'down'}"]] for s in (1, -1)}
               for name in lenses}
        rows = c.sql(f"select neuron, dose, prompt, text from '{sweep}/steer/L{L:02d}.parquet'").fetchall()
        n_neur = len(t["neuron"])
        acc = {name: [0, 0, 0, 0] for name in lenses}  # hits, null hits, opposite-sign hits, replies with new words
        for n, d, p, text in rows:
            words = set(WORD.findall((text or "").lower())) - base.get(p, set())
            if not words:
                continue
            s = 1 if d > 0 else -1
            other = rng.randrange(n_neur - 1)
            other += other >= n
            for name in lenses:
                a = acc[name]
                a[0] += hit(tok[name][s][n], words)
                a[1] += hit(tok[name][s][other], words)
                a[2] += hit(tok[name][-s][n], words)
                a[3] += 1
        res[L] = {name: dict(hit=a[0] / max(a[3], 1), null=a[1] / max(a[3], 1), opposite=a[2] / max(a[3], 1), n=a[3])
                  for name, a in acc.items()}
        print(f"L{L:02d} " + "  ".join(f"{name} {r['hit']:.3f}/{r['null']:.3f}/{r['opposite']:.3f}"
                                       for name, r in res[L].items()), flush=True)
    tot = {}
    for L, r in res.items():
        for name, v in r.items():
            T = tot.setdefault(name, [0, 0, 0, 0])
            T[0] += v["hit"] * v["n"]; T[1] += v["null"] * v["n"]; T[2] += v["opposite"] * v["n"]; T[3] += v["n"]
    summary = {name: dict(hit=T[0] / T[3], null=T[1] / T[3], opposite=T[2] / T[3], lift=T[0] / max(T[1], 1), n=T[3])
               for name, T in tot.items()}
    print(json.dumps(summary, indent=1))
    json.dump(dict(summary=summary, by_layer=res), open(out, "w"), indent=1)


if __name__ == "__main__":
    main(*sys.argv[1:4])
