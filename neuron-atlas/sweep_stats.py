"""Per-layer reply-kind estimates for an all-neuron sweep, and the persona library file the explorer reads.

classify_sweep labels every "Who are you?" reply that drops the model's name (weight 1) plus a seeded random sample
of the rest (weight = rest rows / sampled rows), so weighted counts are unbiased estimates of how every push answers.
With mode="sample" (prompt batteries) it labels only the seeded sample; every labeled row gets weight rows / sampled.

  python sweep_stats.py SWEEP_DIR OUT_MODEL_DIR [--themes CACHE.json]
      ->  OUT/sweep_stats.parquet, OUT/personas.parquet
"""
import argparse, os
import duckdb


def build(sweep, out, theme_cache=None, mode="model"):
    c = duckdb.connect()
    c.sql(f"create view steer as select * from read_parquet('{sweep}/steer/L*.parquet')")
    c.sql(f"create view lab as select * from read_parquet('{sweep}/labels/L*.parquet')")
    # rows not picked as identity form the population the sample was drawn from (same rule as classify_sweep)
    from atlas.label import SWEEP_MODES
    interesting = SWEEP_MODES[mode][2]
    pop = {}
    for layer, prompt, text in c.sql("select layer, prompt, text from steer").fetchall():
        text = text or ""
        if mode == "sample" or not (prompt == 0 and (not text.strip() or interesting(text))):
            pop[layer] = pop.get(layer, 0) + 1
    c.sql("create table pop (layer smallint, n bigint)")
    c.executemany("insert into pop values (?, ?)", list(pop.items()))
    c.sql("""create table w as
        with smp as (select layer, count(*) k from lab where picked = 'sample' group by layer)
        select layer, n::double / k as w from pop join smp using (layer)""")
    weight = "w.w" if mode == "sample" else "case when l.picked = 'identity' then 1 else w.w end"
    c.sql(f"""copy (
        select l.layer::smallint layer, l.prompt::tinyint prompt, sign(l.dose)::tinyint sign,
               coalesce(l.reply_kind, 'unlabeled') reply_kind,
               sum({weight}) n_est, count(*)::int n_labeled
        from lab l join w using (layer) group by all order by all
    ) to '{out}/sweep_stats.parquet' (format parquet, compression zstd)""")
    c.sql(f"""copy (
        select * from lab where reply_kind in ('persona', 'altered_assistant', 'other', 'user_identity', 'model_persona')
        order by layer, neuron, dose, prompt
    ) to '{out}/personas.parquet' (format parquet, compression zstd)""")
    if theme_cache:
        import pyarrow as pa, pyarrow.parquet as pq
        from atlas.themes import norm, themes
        path = f"{out}/personas.parquet"
        t = pq.read_table(path)
        rows = t.to_pylist()
        who = [norm(r.get("who")) for r in rows]
        relevant = [r.get("reply_kind") in ("persona", "altered_assistant", "user_identity", "model_persona") for r in rows]
        group = themes(sorted({w for w, ok in zip(who, relevant) if ok and w}), cache_path=theme_cache)
        col = [group.get(w, "") if ok and w else "" for w, ok in zip(who, relevant)]
        if "group" in t.schema.names:
            t = t.set_column(t.schema.get_field_index("group"), "group", pa.array(col, pa.string()))
        else:
            t = t.append_column("group", pa.array(col, pa.string()))
        tmp = path + ".tmp"
        pq.write_table(t, tmp, compression="zstd")
        os.replace(tmp, path)
        counts = {}
        for w, ok, g in zip(who, relevant, col):
            if ok and g:
                counts.setdefault(g, [0, set()])[0] += 1
                counts[g][1].add(w)
        for g, (n, names) in sorted(counts.items(), key=lambda kv: -kv[1][0]):
            print(f"theme {g}: {n} rows, {len(names)} distinct names")
    print(c.sql(f"""select reply_kind, round(sum(n_est)) n_est, sum(n_labeled) n_labeled
                    from '{out}/sweep_stats.parquet' group by 1 order by 2 desc"""))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("sweep")
    ap.add_argument("out")
    ap.add_argument("--mode", default="model", help="the classify_sweep mode the labels were made with (model, user or sample)")
    ap.add_argument("--themes", metavar="CACHE.json", help="group persona names into themes, caching in this file")
    a = ap.parse_args()
    build(a.sweep, a.out, a.themes, a.mode)
