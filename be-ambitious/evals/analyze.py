"""Summarise eval results into results/summary.md."""

import json
import math
import random
from collections import Counter, defaultdict
from pathlib import Path

from cases import RUBRIC, RUBRIC_EXTRA, TASKS

R = Path(__file__).parent / "results"


def load(name):
    p = R / name
    return [json.loads(l) for l in p.read_text().splitlines() if l.strip()] if p.exists() else []


def boot_ci(xs, n=2000, seed=0):
    if not xs:
        return (float("nan"),) * 2
    rng = random.Random(seed)
    means = sorted(sum(rng.choice(xs) for _ in xs) / len(xs) for _ in range(n))
    return means[int(0.025 * n)], means[int(0.975 * n)]


def main():
    out = []
    gens, rub, pw, trig = load("gen.jsonl"), load("rubric.jsonl"), load("pairwise.jsonl"), load("trigger.jsonl")
    conds = list(dict.fromkeys(g["cond"] for g in gens))

    out.append("# be-ambitious eval results\n")
    out.append(f"Model (generator and judge): `opencode/deepseek-v4.1-flash-free`. "
               f"Generations: {len(gens)}; rubric grades: {len(rub)}; pairwise judgements: {len(pw)}; trigger calls: {len(trig)}. "
               f"Total reported cost: {sum(g.get('cost', 0) for g in gens)}.\n")

    # length
    out.append("## Response length (words)\n")
    out.append("| Condition | mean | min | max |\n|---|---|---|---|")
    for c in conds:
        w = [g["words"] for g in gens if g["cond"] == c]
        out.append(f"| {c} | {sum(w)/len(w):.0f} | {min(w)} | {max(w)} |")
    out.append("")

    # rubric
    if rub:
        by = defaultdict(list)
        for r in rub:
            by[r["cond"]].append(r)
        out.append("## Rubric (fraction of responses meeting each criterion)\n")
        out.append("| Criterion | " + " | ".join(conds) + " |")
        out.append("|---|" + "---|" * len(conds))
        for k in RUBRIC:
            row = [f"{sum(r['scores'][k] for r in by[c]) / len(by[c]):.2f}" if by[c] else "-" for c in conds]
            out.append(f"| {k} | " + " | ".join(row) + " |")
        tot = []
        for c in conds:
            xs = [sum(r["scores"].values()) / len(RUBRIC) for r in by[c]]
            if xs:
                lo, hi = boot_ci(xs)
                tot.append(f"{sum(xs)/len(xs):.2f} [{lo:.2f}, {hi:.2f}]")
            else:
                tot.append("-")
        out.append("| **overall (95% bootstrap CI)** | " + " | ".join(tot) + " |\n")

        out.append("### Overall rubric score per task\n")
        out.append("| Task | " + " | ".join(conds) + " |\n|---|" + "---|" * len(conds))
        for t in TASKS:
            row = []
            for c in conds:
                xs = [sum(r["scores"].values()) / len(RUBRIC) for r in by[c] if r["task"] == t]
                row.append(f"{sum(xs)/len(xs):.2f}" if xs else "-")
            out.append(f"| {t} | " + " | ".join(row) + " |")
        out.append("")

    rx = load("rubric_extra.jsonl")
    if rx:
        by = defaultdict(list)
        for r in rx:
            by[r["cond"]].append(r)
        out.append("## Post-hoc criteria (added after reading v1 losses)\n")
        out.append("| Criterion | " + " | ".join(conds) + " |\n|---|" + "---|" * len(conds))
        for k in RUBRIC_EXTRA:
            row = [f"{sum(r['scores'][k] for r in by[c]) / len(by[c]):.2f}" if by[c] else "-" for c in conds]
            out.append(f"| {k} | " + " | ".join(row) + " |")
        out.append("")

    # pairwise
    if pw:
        out.append("## Pairwise preference (blind, both presentation orders)\n")
        out.append("| Comparison | judgements | skill wins | base wins | ties | skill win rate (ties=½) | position-consistent pairs |")
        out.append("|---|---|---|---|---|---|---|")
        groups = defaultdict(list)
        for r in pw:
            groups[(r.get("base", "baseline"), r["cond_b"])].append(r)
        for (base, cb), rs in sorted(groups.items()):
            c = Counter(r["winner"] for r in rs)
            rate = (c[cb] + 0.5 * c["tie"]) / len(rs)
            pairs = defaultdict(dict)
            for r in rs:
                pairs[(r["task"], r["sample"])][r["order"]] = r["winner"]
            full = [p for p in pairs.values() if len(p) == 2]
            consistent = sum(1 for p in full if p["base_first"] == p["skill_first"])
            out.append(f"| {cb} vs {base} | {len(rs)} | {c[cb]} | {c[base]} | {c['tie']} | {rate:.2f} | {consistent}/{len(full)} |")
        out.append("")

    # trigger
    if trig:
        tp = sum(1 for r in trig if r["expected"] and r["fired"])
        fn = sum(1 for r in trig if r["expected"] and not r["fired"])
        fp = sum(1 for r in trig if not r["expected"] and r["fired"])
        tn = sum(1 for r in trig if not r["expected"] and not r["fired"])
        prec = tp / (tp + fp) if tp + fp else float("nan")
        rec = tp / (tp + fn) if tp + fn else float("nan")
        out.append("## Trigger accuracy\n")
        out.append(f"Calls: {len(trig)}. TP {tp}, FN {fn}, FP {fp}, TN {tn}. "
                   f"Precision {prec:.2f}, recall {rec:.2f}, accuracy {(tp+tn)/len(trig):.2f}.\n")
        out.append("| Query | expected | fired / samples | chosen instead |\n|---|---|---|---|")
        byq = defaultdict(list)
        for r in trig:
            byq[r["qi"]].append(r)
        for qi in sorted(byq):
            rs = byq[qi]
            other = Counter(r["chose"] for r in rs if not r["fired"])
            mark = "" if all(r["fired"] == r["expected"] for r in rs) else " ⚠"
            out.append(f"| {rs[0]['query']}{mark} | {'yes' if rs[0]['expected'] else 'no'} | "
                       f"{sum(r['fired'] for r in rs)}/{len(rs)} | {', '.join(f'{k}×{v}' for k, v in other.items())} |")
        out.append("")

    (R / "summary.md").write_text("\n".join(out))
    print("\n".join(out))


if __name__ == "__main__":
    main()
