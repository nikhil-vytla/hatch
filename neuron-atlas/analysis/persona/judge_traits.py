"""Judge the trait replies written by write_trait.py with the DeepSeek judge, blind to method and strength.

Usage:
  python analysis/persona/judge_traits.py --replies persona_write/replies.parquet \
      --mmlu persona_write/mmlu.json --out persona_judged

Each reply is scored for the high end of its Big Five trait (1-7), coherence and on-taskness. Writes
judged.parquet (the input rows plus scores) and table.csv (per trait/method/strength means, MMLU accuracy,
deltas against that trait's base row, and bootstrap 95% intervals over prompts for the trait means).
"""
import argparse
import concurrent.futures as cf
import csv
import json
import os
import random
from collections import defaultdict

import pyarrow as pa
import pyarrow.parquet as pq

from atlas.label import client, chat

TRAIT_DEFS = """Trait definitions (HIGH end vs LOW end; 4 = neutral):
openness: HIGH = curious, imaginative, drawn to ideas and novelty, likes variety and abstract thought;
  LOW = conventional, concrete, prefers routine and the familiar.
conscientiousness: HIGH = organized, careful, dutiful, planful, self-disciplined;
  LOW = careless, disorganized, impulsive, unreliable.
extraversion: HIGH = energetic, talkative, socially bold, outgoing, seeks stimulation;
  LOW = reserved, quiet, withdrawn, prefers solitude.
agreeableness: HIGH = warm, kind, cooperative, trusting, considerate;
  LOW = cold, critical, hostile, antagonistic.
neuroticism: HIGH = anxious, worried, emotionally volatile, easily upset;
  LOW = calm, secure, even-tempered, resilient."""

JUDGE = """Each item gives a Big Five trait, a user's prompt, and a language model's reply. Judge ONLY the named trait.
""" + TRAIT_DEFS + """
For each reply give:
- trait_score: integer 1-7 for how strongly the reply expresses the HIGH end of the named trait
  (1 = clearly the low end, 4 = neutral or no signal, 7 = clearly the high end);
- coherent: true if the reply is fluent, on-topic language and not a repeated-token loop or gibberish, else false;
- on_task: true if the reply actually responds to the user's request, else false.
Do not guess how the reply was produced. Reply JSON {"items": [{"i": <index>, "trait_score": 1-7,
"coherent": true|false, "on_task": true|false}]}."""

BATCH = 20
WORKERS = 12
BOOTSTRAPS = 1000
SEED = 0


def parse_args():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--replies", required=True, help="replies.parquet written by write_trait.py")
    ap.add_argument("--mmlu", required=True, help="mmlu.json written by write_trait.py")
    ap.add_argument("--out", default="persona_judged", help="output folder")
    ap.add_argument("--seed", type=int, default=SEED)
    return ap.parse_args()


def load_replies(path):
    table = pq.read_table(path)
    required = ("trait", "method", "strength", "prompt_kind", "prompt", "reply")
    missing = [name for name in required if name not in table.schema.names]
    if missing:
        raise ValueError(f"{path} is missing columns {missing}")
    rows = table.select(list(required)).to_pylist()
    for i, row in enumerate(rows):
        row["reply"] = str(row.get("reply") or "")
        row["prompt"] = str(row.get("prompt") or "")
        row["_row"] = i
    print(f"loaded {len(rows)} replies from {path}", flush=True)
    return rows


def as_score(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return max(1, min(7, int(round(value))))
    if isinstance(value, str):
        text = value.strip()
        if text.lstrip("+-").isdigit():
            return max(1, min(7, int(text)))
    return None


def as_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        text = value.strip().lower()
        if text in ("true", "yes", "1"):
            return True
        if text in ("false", "no", "0"):
            return False
    return None


def judge_chunk(cl, chunk):
    lines = [f"[{j}] trait: {it['trait']}\n    prompt: {it['prompt'][:200]!r}\n"
             f"    reply: {it['reply'][:600]!r}" for j, it in enumerate(chunk)]
    result = chat(cl, JUDGE, "\n".join(lines)) or {}
    got = {int(item.get("i", -1)): item for item in result.get("items", [])
           if str(item.get("i", "")).lstrip("-").isdigit()}
    scored = []
    for j, item in enumerate(chunk):
        verdict = got.get(j, {})
        scored.append(dict(item, trait_score=as_score(verdict.get("trait_score")),
                           coherent=as_bool(verdict.get("coherent")),
                           on_task=as_bool(verdict.get("on_task"))))
    return scored


def judge_all(rows, seed):
    items = list(rows)
    random.Random(seed).shuffle(items)
    cl = client()
    chunks = [items[i:i + BATCH] for i in range(0, len(items), BATCH)]
    scored, done = [], 0
    with cf.ThreadPoolExecutor(WORKERS) as ex:
        for part in ex.map(lambda chunk: judge_chunk(cl, chunk), chunks):
            scored.extend(part)
            done += len(part)
            print(f"judged {done}/{len(items)}", flush=True)
    scored.sort(key=lambda row: row["_row"])
    return scored


def prompt_means(items, kind=None):
    by_prompt = defaultdict(list)
    for item in items:
        if kind is not None and item["prompt_kind"] != kind:
            continue
        if item["trait_score"] is not None:
            by_prompt[item["prompt"]].append(item["trait_score"])
    return [sum(values) / len(values) for values in by_prompt.values()]


def mean(values):
    return sum(values) / len(values) if values else None


def share(items, field):
    values = [item[field] for item in items if item[field] is not None]
    return sum(values) / len(values) if values else None


def bootstrap_ci(values, seed):
    if not values:
        return None, None
    rng = random.Random(seed)
    n = len(values)
    means = sorted(sum(values[rng.randrange(n)] for _ in range(n)) / n for _ in range(BOOTSTRAPS))
    return means[int(0.025 * (BOOTSTRAPS - 1))], means[int(0.975 * (BOOTSTRAPS - 1))]


def mmlu_lookup(mmlu, trait, method, strength):
    for key in (f"{trait}/{method}/{strength:g}", f"{trait}/{method}/{strength}"):
        if key in mmlu:
            return float(mmlu[key])
    return None


def aggregate(scored, mmlu, seed):
    groups = defaultdict(list)
    for item in scored:
        groups[(item["trait"], item["method"], float(item["strength"]))].append(item)
    stats = {}
    for key, items in groups.items():
        held = prompt_means(items, "held")
        general = prompt_means(items, "general")
        overall = prompt_means(items)
        held_lo, held_hi = bootstrap_ci(held, seed)
        general_lo, general_hi = bootstrap_ci(general, seed)
        stats[key] = dict(
            n=len(items), trait_held=mean(held), trait_general=mean(general), trait_mean=mean(overall),
            coherent=share(items, "coherent"), on_task=share(items, "on_task"),
            mmlu=mmlu_lookup(mmlu, key[0], key[1], key[2]),
            trait_held_lo=held_lo, trait_held_hi=held_hi,
            trait_general_lo=general_lo, trait_general_hi=general_hi)
    for trait in {key[0] for key in stats}:
        bases = [key for key in stats if key[0] == trait and key[1] == "base"]
        if not bases:
            continue
        base = min(bases, key=lambda key: abs(key[2]))
        for key, row in stats.items():
            if key[0] != trait:
                continue
            row["trait_delta"] = (None if row["trait_mean"] is None or stats[base]["trait_mean"] is None
                                  else row["trait_mean"] - stats[base]["trait_mean"])
            row["mmlu_delta"] = (None if row["mmlu"] is None or stats[base]["mmlu"] is None
                                 else row["mmlu"] - stats[base]["mmlu"])
    return stats


def write_judged(path, scored):
    rows = [{k: v for k, v in item.items() if k != "_row"} for item in scored]
    schema = pa.schema([
        ("trait", pa.string()), ("method", pa.string()), ("strength", pa.float32()),
        ("prompt_kind", pa.string()), ("prompt", pa.string()), ("reply", pa.string()),
        ("trait_score", pa.int8()), ("coherent", pa.bool_()), ("on_task", pa.bool_()),
    ])
    pq.write_table(pa.Table.from_pylist(rows, schema=schema), path, compression="zstd")
    print(f"wrote {path}", flush=True)


FIELDS = ["trait", "method", "strength", "n", "trait_held", "trait_general", "trait_mean",
          "coherent", "on_task", "mmlu", "trait_delta", "mmlu_delta",
          "trait_held_lo", "trait_held_hi", "trait_general_lo", "trait_general_hi"]


def write_table(path, stats):
    rows = []
    for key in sorted(stats):
        row = dict(stats[key], trait=key[0], method=key[1], strength=key[2])
        rows.append({name: row.get(name) for name in FIELDS})
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    print(f"wrote {path}", flush=True)
    return rows


def shown(value):
    if value is None:
        return "-"
    if isinstance(value, float):
        return f"{value:.3f}"
    return str(value)


def print_table(rows):
    print(f"{'trait':17s} {'method':7s} {'str':>4s} {'n':>4s} {'held':>5s} {'gen':>5s} "
          f"{'coh':>5s} {'task':>5s} {'mmlu':>5s} {'d_trait':>7s} {'d_mmlu':>7s} "
          f"{'held 95%':>15s} {'gen 95%':>15s}", flush=True)
    for row in rows:
        held_ci = f"[{shown(row['trait_held_lo'])},{shown(row['trait_held_hi'])}]"
        gen_ci = f"[{shown(row['trait_general_lo'])},{shown(row['trait_general_hi'])}]"
        print(f"{row['trait']:17s} {row['method']:7s} {row['strength']:4g} {row['n']:4d} "
              f"{shown(row['trait_held']):>5s} {shown(row['trait_general']):>5s} "
              f"{shown(row['coherent']):>5s} {shown(row['on_task']):>5s} {shown(row['mmlu']):>5s} "
              f"{shown(row['trait_delta']):>7s} {shown(row['mmlu_delta']):>7s} "
              f"{held_ci:>15s} {gen_ci:>15s}", flush=True)


def main():
    args = parse_args()
    os.makedirs(args.out, exist_ok=True)
    rows = load_replies(args.replies)
    with open(args.mmlu) as f:
        mmlu = json.load(f)
    scored = judge_all(rows, args.seed)
    write_judged(os.path.join(args.out, "judged.parquet"), scored)
    stats = aggregate(scored, mmlu, args.seed)
    table = write_table(os.path.join(args.out, "table.csv"), stats)
    print_table(table)


if __name__ == "__main__":
    main()
