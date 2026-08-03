"""Aggregate a benchmark run's JSONL into markdown tables.

Usage: python3 report.py results/delivery_policies.jsonl [...]
Writes results/<name>.md next to each input.
"""

import json
import statistics
import sys


def load(path: str) -> list[dict]:
    with open(path) as f:
        return [json.loads(line) for line in f]


def fmt_mb(b: float) -> str:
    return f"{b/1e6:.1f} MB"


def mean_of(records: list[dict], phase: str) -> float | None:
    vals = [r["phases"][phase] for r in records if phase in r["phases"]]
    return statistics.mean(vals) if vals else None


def delivery_table(records: list[dict]) -> list[str]:
    lines = ["## Delivery policies: modeled fetch + measured phases", "",
             "| task | policy | upfront bytes | modeled fetch | lazy bytes "
             "| modeled lazy tail | measured task | reward |",
             "| --- | --- | --- | --- | --- | --- | --- | --- |"]
    keyfn = lambda r: (r["task"], r["delivery"])
    groups: dict = {}
    for r in records:
        if r["ok"]:
            groups.setdefault(keyfn(r), []).append(r)
    for (task, policy), rs in sorted(groups.items()):
        r0 = rs[0]
        lines.append(
            f"| {task} | {policy} | {fmt_mb(r0['bytes_upfront'])} "
            f"| {mean_of(rs, 'fetch_model_s'):.2f}s "
            f"| {fmt_mb(r0['bytes_lazy'])} "
            f"| {mean_of(rs, 'lazy_model_s'):.2f}s "
            f"| {mean_of(rs, 'task_s'):.2f}s "
            f"| {statistics.mean(x['reward'] for x in rs):.2f} |")
    return lines


def capture_table(records: list[dict]) -> list[str]:
    rs = [r for r in records if r["ok"] and "ckpt_bytes" in r]
    if not rs:
        return []
    lines = ["", "## Capture and decoupled re-grade", "",
             "| task | task time | capture time | checkpoint size "
             "| re-grade time | reward | re-grade reward |",
             "| --- | --- | --- | --- | --- | --- | --- |"]
    groups: dict = {}
    for r in rs:
        groups.setdefault(r["task"], []).append(r)
    for task, g in sorted(groups.items()):
        regrade = mean_of(g, "regrade_s")
        rr = [x.get("regrade_reward") for x in g if "regrade_reward" in x]
        lines.append(
            f"| {task} | {mean_of(g, 'task_s'):.2f}s "
            f"| {mean_of(g, 'capture_s'):.3f}s "
            f"| {fmt_mb(statistics.mean(x['ckpt_bytes'] for x in g))} "
            f"| {f'{regrade:.3f}s' if regrade else 'n/a'} "
            f"| {statistics.mean(x['reward'] for x in g):.2f} "
            f"| {statistics.mean(rr):.2f} |" if rr else
            f"| {task} | {mean_of(g, 'task_s'):.2f}s "
            f"| {mean_of(g, 'capture_s'):.3f}s "
            f"| {fmt_mb(statistics.mean(x['ckpt_bytes'] for x in g))} "
            f"| n/a | {statistics.mean(x['reward'] for x in g):.2f} | n/a |")
    return lines


def concurrency_table(records: list[dict]) -> list[str]:
    concs = sorted({r["concurrency"] for r in records})
    if len(concs) < 2:
        return []
    lines = ["", "## Concurrency sweep (same rollout set per level)", "",
             "| concurrency | batch wall clock | rollouts/min "
             "| task p50 | task p95 | mount p95 |",
             "| --- | --- | --- | --- | --- | --- |"]
    for c in concs:
        g = [r for r in records if r["concurrency"] == c and r["ok"]]
        walls = {r["batch_wall_s"] for r in g}
        wall = max(walls)
        tasks = sorted(r["phases"]["task_s"] for r in g)
        mounts = sorted(r["phases"]["mount_s"] for r in g)
        p = lambda xs, q: xs[min(len(xs) - 1, int(q * len(xs)))]
        lines.append(
            f"| {c} | {wall:.1f}s | {60 * len(g) / wall:.0f} "
            f"| {p(tasks, 0.5):.2f}s | {p(tasks, 0.95):.2f}s "
            f"| {p(mounts, 0.95):.3f}s |")
    return lines


def main() -> None:
    for path in sys.argv[1:]:
        records = load(path)
        name = path.rsplit("/", 1)[-1].removesuffix(".jsonl")
        ok = sum(r["ok"] for r in records)
        lines = [f"# Benchmark: {name}", "",
                 f"{len(records)} rollouts, {ok} succeeded."]
        lines += ["", *delivery_table(records)]
        lines += capture_table(records)
        lines += concurrency_table(records)
        out = path.removesuffix(".jsonl") + ".md"
        with open(out, "w") as f:
            f.write("\n".join(lines) + "\n")
        print(f"wrote {out}")


if __name__ == "__main__":
    main()
