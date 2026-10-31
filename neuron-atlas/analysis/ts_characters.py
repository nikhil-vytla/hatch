"""TinyStories-33M: which character does each pushed neuron call into the story?

Both sweep prompts end where the story introduces someone ("Once upon a time, there was a" / "... met a"), so the
first noun phrase of the continuation is the character. Unpushed, they are "little girl named Lily" and "boy named
Max". No judge: a rule-based parse of the first words.

  python analysis/ts_characters.py STEER_DIR OUT.json
"""
import collections, json, re, sys
import duckdb

STOP = r"(?:named|called|who|that|which|with|and|in|on|at|from|of|to|was|is|had|,|\.|!|\n)"


def character(text):
    t = text.strip().lower()
    t = re.sub(r"^((?:[a-z'-]+ ){0,2}[a-z'-]+), (?=[a-z])", r"\1 ", t)  # "a big, friendly dog"
    m = re.match(rf"^((?:[a-z'-]+ ){{0,3}}?[a-z'-]+?)(?= {STOP}\b|[,.!\n]|$)", t)
    head = m.group(1) if m else " ".join(t.split()[:2])
    name = re.search(r"named (\w+)", text)
    return re.sub(r"^(?:an? |the )", "", head), (name.group(1) if name else None)


def main(steer, out):
    base = {p: character(t) for p, t in duckdb.sql(f"select prompt, text from '{steer}/baseline.parquet'").fetchall()}
    rows = duckdb.sql(f"select layer, neuron, dose, prompt, text from '{steer}/L*.parquet'").fetchall()
    per = []
    counts = collections.Counter()
    by_layer = collections.defaultdict(lambda: [0, 0])
    for L, n, d, p, t in rows:
        c, nm = character(t)
        changed = c != base[p][0]
        by_layer[(L, p)][0] += changed; by_layer[(L, p)][1] += 1
        if changed:
            counts[(p, c)] += 1
            per.append([L, n, round(d, 2), p, c, nm, t[:120]])
    top = {p: [[c, k] for (pp, c), k in counts.most_common() if pp == p][:60] for p in base}
    res = dict(base={p: v[0] for p, v in base.items()},
               changed_rate={f"L{L}p{p}": round(a / b, 4) for (L, p), (a, b) in sorted(by_layer.items())},
               top=top, n=len(rows), changed=per)
    json.dump(res, open(out, "w"))
    print("baseline:", res["base"]); print("changed rate:", res["changed_rate"])
    for p in top: print(p, top[p][:25])


if __name__ == "__main__":
    main(*sys.argv[1:])
