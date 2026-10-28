"""Per-neuron uptake: does pushing a neuron make the model write that neuron's own logit-lens words? For each pushed
neuron, count the replies whose words overlap its lens and subtract a null: the same replies checked against the
lenses of k_null other pushed neurons (one fixed draw per neuron).

    python -m atlas.uptake --atlas out/<slug>
"""
import argparse, random, re
import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

from . import neurons_src


def words(lens):
    return {w for t in (lens or []) if len(w := t.strip().lower()) >= 3 and re.fullmatch(r"[a-z]+", w)}


def reply_words(text):
    return set(re.findall(r"[a-z]+", text.lower()))


def run(atlas, k_null=20, seed=0):
    con = duckdb.connect()
    rows = con.sql(f"""select layer, neuron, dose, kind, prompt, text from '{atlas}/steer.parquet'
                       where layer >= 0 order by layer, neuron, dose, prompt""").fetchall()
    lens = {(L, n): (u, d) for L, n, u, d in con.sql(f"""select n.layer, n.neuron, n.lens_up, n.lens_down
        from {neurons_src(atlas)} n join (select distinct layer, neuron from '{atlas}/steer.parquet' where layer >= 0) s
        using (layer, neuron)""").fetchall()}
    replies, kinds = {}, {}
    for L, n, dose, kind, prompt, text in rows:
        replies.setdefault((L, n), []).append((dose, reply_words(text)))
        kinds.setdefault((L, n), kind)

    keys = sorted(replies)
    up_sets = {k: words(lens.get(k, (None, None))[0]) for k in keys}
    down_sets = {k: words(lens.get(k, (None, None))[1]) for k in keys}
    rng = random.Random(seed)
    null_draw = {}
    for i, k in enumerate(keys):  # sample indices, skipping k itself: O(k_null) per neuron, also for --all runs
        idx = rng.sample(range(len(keys) - 1), min(k_null, len(keys) - 1))
        null_draw[k] = [keys[j + (j >= i)] for j in idx]

    def rate(rw, other_keys, sets):
        return sum(bool(rw & sets[j]) for j in other_keys) / len(other_keys) if other_keys else 0.0

    out = []
    for k in keys:
        rs = replies[k]
        ups = [rw for dose, rw in rs if dose > 0]
        downs = [rw for dose, rw in rs if dose < 0]
        up_hits = sum(bool(rw & up_sets[k]) for rw in ups)
        down_hits = sum(bool(rw & down_sets[k]) for rw in downs)
        up_null = sum(rate(rw, null_draw[k], up_sets) for rw in ups) / len(ups) if ups else None
        down_null = sum(rate(rw, null_draw[k], down_sets) for rw in downs) / len(downs) if downs else None
        uptake = up_hits / len(ups) - up_null if ups else None
        L, n = k
        out.append(dict(layer=L, neuron=n, kind=kinds[k], up_n=len(ups), up_hits=up_hits, up_null=up_null,
                        down_n=len(downs), down_hits=down_hits, down_null=down_null, uptake=uptake))

    tbl = pa.Table.from_pylist(out).cast(pa.schema([
        ("layer", pa.int16()), ("neuron", pa.int32()), ("kind", pa.string()),
        ("up_n", pa.int16()), ("up_hits", pa.int16()), ("up_null", pa.float32()),
        ("down_n", pa.int16()), ("down_hits", pa.int16()), ("down_null", pa.float32()),
        ("uptake", pa.float32())]))
    pq.write_table(tbl, f"{atlas}/uptake.parquet", compression="zstd")

    order = [k for k in ("top", "random") if any(r["kind"] == k for r in out)]
    order += sorted({r["kind"] for r in out} - set(order) - {"all"}) + ["all"]
    for kind in order:
        grp = out if kind == "all" else [r for r in out if r["kind"] == kind]
        us = [r["uptake"] for r in grp if r["uptake"] is not None]
        hit = sum(r["up_hits"] > 0 for r in grp)
        print(f"{kind:8s} mean uptake {sum(us) / len(us) if us else 0:.3f}  "
              f"up_hits > 0 {hit}/{len(grp)} ({hit / max(1, len(grp)):.2f})  n={len(grp)}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--atlas", required=True)
    ap.add_argument("--k-null", type=int, default=20)
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    run(a.atlas, a.k_null, a.seed)
