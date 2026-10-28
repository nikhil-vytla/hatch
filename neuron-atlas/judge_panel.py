"""Compare LLM judges on the held-out detection task of atlas.label.

    python judge_panel.py --atlas out/<slug> --judges deepseek opencode/flint-40b-free --n 40 --workers 4

Each judge gets the same held-out items (top documents 6-7 plus two random windows, shuffled with seed 0) and a
null version where another neuron's label is shown against the same snippets. Writes {atlas}/judge_panel.parquet.
"""
import argparse, random, re, time, concurrent.futures as cf
from contextlib import nullcontext

from atlas import label
from atlas.judges import make_judge, opencode_server
import pyarrow as pa
import pyarrow.parquet as pq


def items(atlas, n, seed=0):
    """The same detection items label.py builds for n random labeled neurons, with fixed snippets."""
    at = label.Atlas(atlas)
    rows = at.con.sql(f"select layer, neuron, label, description from '{atlas}/labels.parquet'").fetchall()
    pick = random.Random(seed).sample(rows, min(n, len(rows)))
    snip_rng = random.Random(seed)
    out = []
    for L, n, lab, desc in pick:
        held = [at.window(doc, pos, mark=False) for s, r, _, doc, pos in at.examples(L, n)
                if s == 1 and r in label.HELD]
        if len(held) < 2:
            continue
        snips = [(h, True) for h in held] + [(at.random_window(snip_rng), False) for _ in range(2)]
        snip_rng.shuffle(snips)
        body = "\n".join(f"{j + 1}. {s}" for j, (s, _) in enumerate(snips))
        out.append(dict(layer=L, neuron=n, label=lab, description=desc,
                        truth=[t for _, t in snips], body=body))
    return out


def answer(r, L, n):
    """The true/false list for neuron L:n in a check reply, tolerating string ids."""
    for k, v in (r or {}).get("answers", {}).items():
        m = re.match(r"(\d+):(\d+)", str(k))
        if m and (int(m.group(1)), int(m.group(2))) == (L, n) and isinstance(v, list):
            return v
    return None


def main(atlas, specs, n=40, workers=4, seed=0):
    its = items(atlas, n, seed)
    ctx = opencode_server() if any(s.startswith("opencode/") for s in specs) else nullcontext(None)
    with ctx as server:
        judges = [make_judge(s, server) for s in specs]

        def job(task):
            judge, i, is_null = task
            it = its[i]
            other = its[(i + 1) % len(its)]
            lab, desc = (other["label"], other["description"]) if is_null else (it["label"], it["description"])
            user = f"### neuron id {it['layer']}:{it['neuron']}\nlabel: {lab} — {desc}\n{it['body']}"
            t0 = time.perf_counter()
            v = answer(judge.ask(label.CHECK, user), it["layer"], it["neuron"])
            dt = time.perf_counter() - t0
            correct = (sum(bool(a) == t for a, t in zip(v, it["truth"])) / len(it["truth"])
                       if v is not None and len(v) == len(it["truth"]) else None)
            return dict(judge=judge.name, layer=it["layer"], neuron=it["neuron"], null=is_null,
                        correct=correct, seconds=dt)

        tasks = [(j, i, null) for j in judges for i in range(len(its)) for null in (False, True)]
        rows = []
        with cf.ThreadPoolExecutor(workers) as ex:
            for r in ex.map(job, tasks):
                rows.append(r)
                if len(rows) % 20 == 0:
                    print(f"  {len(rows)}/{len(tasks)} calls", flush=True)

    tbl = pa.Table.from_pylist(rows, schema=pa.schema([
        ("judge", pa.string()), ("layer", pa.int16()), ("neuron", pa.int32()), ("null", pa.bool_()),
        ("correct", pa.float32()), ("seconds", pa.float32())]))
    pq.write_table(tbl, f"{atlas}/judge_panel.parquet", compression="zstd")

    print(f"\n{'judge':34s} {'n answered':>10s} {'accuracy':>9s} {'null acc':>9s} {'s/call':>7s}")
    for j in judges:
        mine = [r for r in rows if r["judge"] == j.name]
        ok = [r["correct"] for r in mine if not r["null"] and r["correct"] is not None]
        nul = [r["correct"] for r in mine if r["null"] and r["correct"] is not None]
        secs = [r["seconds"] for r in mine if r["seconds"] is not None]
        print(f"{j.name:34s} {len(ok):10d} {sum(ok) / max(1, len(ok)):9.3f} "
              f"{sum(nul) / max(1, len(nul)):9.3f} {sum(secs) / max(1, len(secs)):7.2f}")
    print(f"wrote {len(rows)} rows to {atlas}/judge_panel.parquet")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--atlas", required=True)
    ap.add_argument("--judges", nargs="+", default=["deepseek"])
    ap.add_argument("--n", type=int, default=40)
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()
    main(a.atlas, a.judges, a.n, a.workers)
