"""Score the pre-registered predictions P1–P9 (PREREGISTRATION.md) on the output of analysis/prereg_run.py.

  python analysis/prereg_analyze.py RUN_DIR OUT.json
"""
import json, random, re, sys
import pyarrow.parquet as pq

WORD = re.compile(r"[a-z]{4,}")


def norm(toks):
    return [t.strip().lower() for t in toks if len(t.strip()) >= 4 and t.strip().isalpha()]


def hit(tokens, words):
    return any(w.startswith(t) for t in tokens for w in words)


def boot(values, stat, n=2000, seed=0):
    rng = random.Random(seed)
    xs = sorted(stat([values[rng.randrange(len(values))] for _ in values]) for _ in range(n))
    return [xs[int(0.025 * n)], xs[int(0.975 * n)]]


def main(d, out):
    A = pq.read_table(f"{d}/prereg_A.parquet").to_pylist()
    base = set(WORD.findall(json.load(open(f"{d}/prereg_A_baseline.json"))["baseline"].lower()))
    rng = random.Random(1)
    by_key = {(r["layer"], r["neuron"], r["dose"] > 0): r for r in A}
    recs = []
    for r in A:
        words = set(WORD.findall((r["text"] or "").lower())) - base
        other = A[rng.randrange(len(A))]
        opp = by_key.get((r["layer"], r["neuron"], not r["dose"] > 0))
        rec = dict(layer=r["layer"], has_words=bool(words))
        for lens in ("j", "logit"):
            own = norm(r[f"{lens}_tokens"])
            rec[f"{lens}_hit"] = bool(words) and hit(own, words)
            rec[f"{lens}_null"] = bool(words) and hit(norm(other[f"{lens}_tokens"]), words)
            rec[f"{lens}_opp"] = bool(words) and opp is not None and hit(norm(opp[f"{lens}_tokens"]), words)
            rec[f"{lens}_dlp"] = r[f"{lens}_dlp_own"] - r[f"{lens}_dlp_other"]
        recs.append(rec)

    def band(lo, hi):
        return [x for x in recs if lo <= x["layer"] <= hi]

    def rate(xs, key):
        ys = [x for x in xs if x["has_words"]]
        return sum(x[key] for x in ys) / max(len(ys), 1)

    def lift(xs, lens):
        return rate(xs, f"{lens}_hit") / max(rate(xs, f"{lens}_null"), 1e-9)

    def frac_pos(xs, lens):
        return sum(x[f"{lens}_dlp"] > 0 for x in xs) / max(len(xs), 1)

    res = {}
    allr = recs
    res["P1"] = dict(value=lift(allr, "j"), ci=boot(allr, lambda v: lift(v, "j")), hit=rate(allr, "j_hit"), chance=rate(allr, "j_null"))
    res["P1"]["holds"] = res["P1"]["value"] >= 4
    ratio = lambda v: rate(v, "j_hit") / max(rate(v, "j_opp"), 1e-9)
    res["P2"] = dict(value=ratio(allr), ci=boot(allr, ratio), opposite=rate(allr, "j_opp")); res["P2"]["holds"] = res["P2"]["value"] >= 2
    mid = band(6, 19)
    res["P3"] = dict(j=lift(mid, "j"), logit=lift(mid, "logit"), holds=lift(mid, "j") > lift(mid, "logit"),
                     ci_diff=boot(mid, lambda v: lift(v, "j") - lift(v, "logit")))
    early = band(0, 5)
    res["P4"] = dict(value=lift(early, "j"), ci=boot(early, lambda v: lift(v, "j"))); res["P4"]["holds"] = res["P4"]["value"] < 3
    for p, (lo, hi), test in (("P5", (20, 31), lambda f: f >= 0.70), ("P6", (6, 19), lambda f: f >= 0.55), ("P7", (0, 5), lambda f: 0.40 <= f <= 0.65)):
        xs = band(lo, hi)
        f = frac_pos(xs, "j")
        res[p] = dict(value=f, ci=boot(xs, lambda v: frac_pos(v, "j")), logit=frac_pos(xs, "logit"), n=len(xs), holds=test(f))

    B = pq.read_table(f"{d}/prereg_B.parquet").to_pylist()
    for x in B:
        x["mention"] = any(w.startswith(x["concept"]) for w in re.findall(r"[a-z]+", (x["text"] or "").lower()))
    lensB = [x for x in B if x["kind"] == "lens"]; rnd = [x for x in B if x["kind"] == "random"]
    m = lambda v: sum(x["mention"] for x in v) / max(len(v), 1)
    res["P8"] = dict(lens=m(lensB), random=m(rnd), ci_lens=boot(lensB, m), n_lens=len(lensB),
                     concepts=len({x["concept"] for x in lensB}), holds=m(lensB) >= 0.08 and m(rnd) <= 0.01)
    late, midB = [x for x in lensB if x["layer"] >= 20], [x for x in lensB if 8 <= x["layer"] <= 19]
    res["P9"] = dict(late=m(late), mid=m(midB), n_late=len(late), n_mid=len(midB), holds=m(late) >= 2 * m(midB))
    for k, v in res.items():
        print(k, "HOLDS" if v["holds"] else "FAILS", {a: (round(b, 4) if isinstance(b, float) else b) for a, b in v.items() if a != "holds"})
    json.dump(res, open(out, "w"), indent=1)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
