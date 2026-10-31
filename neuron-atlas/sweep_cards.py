"""Per-layer files that let a neuron card show its all-neuron sweep replies.

  python sweep_cards.py OUT_MODEL_DIR SWEEP_DIR[:PROMPT_OFFSET] ...
      ->  OUT/sweepcard/Lxx.parquet  (neuron, prompt, dose, text, reply_kind, who; sorted by neuron)
          OUT/sweepcard/baseline.parquet  (prompt, text)
          OUT/sweepcard/prompts.json

Each sweep folder holds steer/Lxx.parquet and (optionally) labels/Lxx.parquet from label.classify_sweep. Prompt ids
are offset per sweep so several sweeps share one numbering (e.g. "Who are you?"=0, story=1, "Who am I?"=2).
Row groups of 1,024 rows keep a card's read to one small range request.
"""
import json, os, sys
import duckdb


def build(out, sweeps):
    c = duckdb.connect()
    os.makedirs(f"{out}/sweepcard", exist_ok=True)
    prompts, base, parts = [], [], []
    for spec in sweeps:
        d, off = (spec.split(":") + ["0"])[:2]
        off = int(off)
        meta = json.load(open(f"{d}/meta.json")).get("steer", {}) if os.path.exists(f"{d}/meta.json") else {}
        ps = meta.get("prompts") or []
        for i, p in enumerate(ps):
            while len(prompts) <= off + i:
                prompts.append("")
            prompts[off + i] = p
        base.append(f"select prompt + {off} prompt, text from '{d}/steer/baseline.parquet' where layer < 0")
        lab = f"{d}/labels/L*.parquet"
        has_lab = bool([f for f in os.listdir(f"{d}/labels")]) if os.path.isdir(f"{d}/labels") else False
        parts.append((d, off, lab if has_lab else None))
    c.sql(f"copy ({' union all '.join(base)} order by prompt) to '{out}/sweepcard/baseline.parquet' (format parquet)")
    json.dump(prompts, open(f"{out}/sweepcard/prompts.json", "w"))
    layers = sorted(int(f[1:3]) for f in os.listdir(f"{parts[0][0]}/steer") if f.startswith("L") and f.endswith(".parquet"))
    for L in layers:
        q = []
        for d, off, lab in parts:
            j = (f"left join (select neuron, dose, prompt, reply_kind, who from read_parquet('{d}/labels/L{L:02d}.parquet')) l "
                 "using (neuron, dose, prompt)") if lab and os.path.exists(f"{d}/labels/L{L:02d}.parquet") else ""
            kind = "l.reply_kind" if j else "null::varchar"
            who = "l.who" if j else "null::varchar"
            q.append(f"""select s.neuron::int neuron, (s.prompt + {off})::tinyint prompt, s.dose::float dose, s.text,
                         {kind} reply_kind, {who} who
                         from read_parquet('{d}/steer/L{L:02d}.parquet') s {j}""")
        c.sql(f"""copy ({' union all '.join(q)} order by neuron, prompt, dose)
                  to '{out}/sweepcard/L{L:02d}.parquet' (format parquet, compression zstd, row_group_size 1024)""")
    n = c.sql(f"select count(*), count(reply_kind) from read_parquet('{out}/sweepcard/L*.parquet')").fetchall()[0]
    print(f"{len(layers)} layers, {n[0]} replies, {n[1]} labeled; prompts {prompts}")


if __name__ == "__main__":
    build(sys.argv[1], sys.argv[2:])
