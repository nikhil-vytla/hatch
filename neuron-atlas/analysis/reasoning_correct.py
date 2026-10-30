"""Score bat-and-ball and turn-right-twice answers of pushed replies (labeled vs random neurons, by layer block).

  python analysis/reasoning_correct.py STEER_DIR [--r1]
STEER_DIR holds Lxx.parquet shards and baseline.parquet; prompt 0 = bat-and-ball, prompt 1 = turning question.
"""
import re, sys
import duckdb

MATH = re.compile(r"(\$\s?0?\.05\b|\b5 cents|five cents|\$0\.05)", re.I)
WRONG_MATH = re.compile(r"(\$\s?0?\.10\b|\b10 cents|ten cents)", re.I)


def final_part(t, r1):
    # R1 thinks first; score the text after </think> if present, else the last 300 chars
    if r1 and "</think>" in t:
        return t.split("</think>", 1)[1]
    return t[-300:] if r1 else t


def math_ok(t):
    return bool(MATH.search(t))


def spatial_ok(t):
    s = [m.group(0).lower() for m in re.finditer(r"\b(north|south|east|west)\b", t, re.I)]
    return bool(s) and s[-1] == "south"


def main(d, r1=False):
    c = duckdb.connect()
    base = c.sql(f"select prompt, text from '{d}/baseline.parquet' where layer < 0").fetchall()
    for p, t in base:
        f = math_ok if p == 0 else spatial_ok
        print(f"baseline prompt {p}: correct={f(final_part(t, r1))} {t[-160:]!r}")
    rows = c.sql(f"select layer, kind, dose, prompt, text, stop from read_parquet('{d}/L*.parquet')").fetchall()
    nL = max(r[0] for r in rows) + 1
    blk = max(1, nL // 8)
    for p, name, f in ((0, "bat-and-ball", math_ok), (1, "turning", spatial_ok)):
        print(f"\n{name}")
        tot = {}
        for L, kind, dose, pp, t, stop in rows:
            if pp != p:
                continue
            ok = f(final_part(t or "", r1))
            for key in ((kind, "all"), (kind, L // blk), ("dose", round(abs(dose), 2))):
                v = tot.setdefault(key, [0, 0]); v[0] += ok; v[1] += 1
        for kind in sorted({k for k, _ in tot if k != "dose"}):
            a = tot[(kind, "all")]
            print(f"  {kind:8s} {a[0] / a[1]:.0%} of {a[1]}  by layer block: " +
                  " ".join(f"{b * blk}-{b * blk + blk - 1}:{tot[(kind, b)][0] / tot[(kind, b)][1]:.0%}" for b in range(8) if (kind, b) in tot))
        print("  by |dose|: " + " ".join(f"{k[1]}: {v[0] / v[1]:.0%}" for k, v in sorted(tot.items()) if k[0] == "dose"))


if __name__ == "__main__":
    main(sys.argv[1], "--r1" in sys.argv)
