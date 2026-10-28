"""Per-layer reply-kind estimates for an all-neuron sweep, and the persona library file the explorer reads.

classify_sweep labels every "Who are you?" reply that drops the model's name (weight 1) plus a seeded random sample
of the rest (weight = rest rows / sampled rows), so weighted counts are unbiased estimates of how every push answers.

  python sweep_stats.py SWEEP_DIR OUT_MODEL_DIR   ->  OUT/sweep_stats.parquet, OUT/personas.parquet
"""
import sys
import duckdb


def build(sweep, out):
    c = duckdb.connect()
    c.sql(f"create view steer as select * from read_parquet('{sweep}/steer/L*.parquet')")
    c.sql(f"create view lab as select * from read_parquet('{sweep}/labels/L*.parquet')")
    # rows not picked as identity form the population the sample was drawn from
    c.sql("""create table w as
        with pop as (select layer, count(*) n from steer
                     where not (prompt = 0 and (trim(text) = '' or not regexp_matches(text, '(?i)qwen|tongyi|alibaba')))
                     group by layer),
             smp as (select layer, count(*) k from lab where picked = 'sample' group by layer)
        select layer, n::double / k as w from pop join smp using (layer)""")
    c.sql(f"""copy (
        select l.layer::smallint layer, l.prompt::tinyint prompt, sign(l.dose)::tinyint sign,
               coalesce(l.reply_kind, 'unlabeled') reply_kind,
               sum(case when l.picked = 'identity' then 1 else w.w end) n_est, count(*)::int n_labeled
        from lab l join w using (layer) group by all order by all
    ) to '{out}/sweep_stats.parquet' (format parquet, compression zstd)""")
    c.sql(f"""copy (
        select * from lab where reply_kind in ('persona', 'altered_assistant', 'other')
        order by layer, neuron, dose, prompt
    ) to '{out}/personas.parquet' (format parquet, compression zstd)""")
    print(c.sql(f"""select reply_kind, round(sum(n_est)) n_est, sum(n_labeled) n_labeled
                    from '{out}/sweep_stats.parquet' group by 1 order by 2 desc"""))


if __name__ == "__main__":
    build(sys.argv[1], sys.argv[2])
