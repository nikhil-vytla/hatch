"""Is the *content* of a push neuron-specific? For each +dose reply, does it contain one of the pushed neuron's own
logit-lens tokens (top 10, word-like, >= 3 chars)? Null: the same reply checked against the lens of another pushed
neuron from the same model (a fixed random derangement), so word frequency and reply length are matched.

    python lens_hits.py --out-dir <atlas out dir>
"""
import argparse, random, re
import duckdb


def words(lens):
    return {w for t in lens if len(w := t.strip().lower()) >= 3 and re.fullmatch(r"[a-z]+", w)}


def main(out):
    for slug in ["openai-community__gpt2", "HuggingFaceTB__SmolLM2-135M-Instruct", "Qwen__Qwen3-0.6B"]:
        rows = duckdb.sql(f"""select s.layer, s.neuron, s.kind, s.dose, lower(s.text), n.lens_up, n.lens_down
            from '{out}/{slug}/steer.parquet' s join '{out}/{slug}/neurons.parquet' n using (layer, neuron)
            where s.layer >= 0""").fetchall()
        for sign, col in [(1, 5), (-1, 6)]:
            rs = [r for r in rows if r[3] * sign > 0]
            perm = list(range(len(rs)))
            random.Random(0).shuffle(perm)
            own = other = 0
            for i, r in enumerate(rs):
                toks = set(re.findall(r"[a-z]+", r[4]))
                own += bool(words(r[col]) & toks)
                other += bool(words(rs[perm[i]][col]) & toks)
            by_kind = {}
            for r in rs:
                toks = set(re.findall(r"[a-z]+", r[4]))
                k = by_kind.setdefault(r[2], [0, 0]); k[0] += bool(words(r[col]) & toks); k[1] += 1
            print(f"{slug:40s} {'push +' if sign > 0 else 'push -'} lens_{'up' if sign > 0 else 'down'}: "
                  f"own {own / len(rs):.3f}  other neuron's {other / len(rs):.3f}  (n={len(rs)})  " +
                  "  ".join(f"{k} {a / b:.3f}" for k, (a, b) in sorted(by_kind.items())))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", required=True)
    main(ap.parse_args().out_dir)
