"""Second-judge audit: re-judge samples of every DeepSeek-judged result with judges from other model families, using
the exact same instructions, and report raw agreement and Cohen's kappa with the stored DeepSeek labels.

  python analysis/second_judge.py OUT.json --judges opencode/glm-5.3-flash-free opencode/nemotron-3.5-lightning-free --n 120
"""
import argparse, concurrent.futures as cf, json, random, sys
from collections import Counter
import duckdb
from huggingface_hub import hf_hub_download
from atlas import label
from atlas.judges import make_judge, opencode_server
from analysis.lens_guided_eval import JUDGE as BECOME_SYS
from analysis.judge_experiments import PAIR_SYS
from analysis.label_agreement import SYS as AGREE_SYS

R = "nikhilxvytla/neuron-atlas"


def hub(p):
    return hf_hub_download(R, p, repo_type="dataset")


def kappa(a, b):
    pairs = [(x, y) for x, y in zip(a, b) if x is not None and y is not None]
    if not pairs:
        return None, 0, None
    n = len(pairs); po = sum(x == y for x, y in pairs) / n
    ca, cb = Counter(x for x, _ in pairs), Counter(y for _, y in pairs)
    pe = sum(ca[k] * cb[k] for k in set(ca) | set(cb)) / n / n
    return (round((po - pe) / (1 - pe), 3) if pe < 1 else 1.0), n, round(po, 3)


def tasks(n, rng):
    """Each task: (name, system prompt, items with 'prompt line' and stored DeepSeek label, parse function)."""
    out = []
    # 1. lens-guided "became it"
    rows = duckdb.sql(f"select name, text, becomes from '{hub('Qwen__Qwen3.5-4B/experiments/lens_guided.parquet')}'").fetchall()
    rows = [r for r in rows if not r[0].startswith("random")]
    sample = rng.sample(rows, min(n, len(rows)))
    out.append(("became", BECOME_SYS,
                [dict(line=f"concept: {nm.split(':')[1]}\n    reply: {t[:260]!r}", ds=bool(b)) for nm, t, b in sample],
                lambda x: None if x.get("becomes") is None else bool(x["becomes"])))
    # 2. fusion outcomes
    pj = json.load(open(hub("Qwen__Qwen3.5-4B/experiments/pairs_judged.json")))
    sample = rng.sample([x for x in pj if x["outcome"]], min(n, len(pj)))
    out.append(("fusion", PAIR_SYS,
                [dict(line=f"A = {x['a']} (alone: {x['alone_a'][:160]!r})\n    B = {x['b']} (alone: {x['alone_b'][:160]!r})\n    combined reply: {x['reply'][:300]!r}",
                      ds=x["outcome"]) for x in sample],
                lambda x: x.get("outcome")))
    # 3. persona / reply-kind labels of the all-neuron sweep
    base = duckdb.sql(f"select text from '{hub('Qwen__Qwen3.5-4B/sweep/steer/baseline.parquet')}' where layer < 0 and prompt = 0").fetchall()[0][0]
    lab = []
    for L in rng.sample(range(32), 8):
        lab += duckdb.sql(f"select text, reply_kind from '{hub(f'Qwen__Qwen3.5-4B/sweep/labels/L{L:02d}.parquet')}' where prompt = 0 and reply_kind is not null").fetchall()
    # stratify so personas are not drowned out: half persona, half everything else
    pers = [r for r in lab if r[1] == "persona"]; rest = [r for r in lab if r[1] != "persona"]
    sample = rng.sample(pers, min(n // 2, len(pers))) + rng.sample(rest, min(n - n // 2, len(rest)))
    out.append(("reply_kind", label.CLASSIFY,
                [dict(line=f"prompt 'Who are you?' -> {t[:240]!r}", ds=k, head=f"normal reply to 'Who are you?': {base[:200]!r}") for t, k in sample],
                lambda x: x.get("kind")))
    # 4. our labels vs neuron-lens labels
    la = json.load(open(hub("Qwen__Qwen3-8B/experiments/label_agreement_neuronlens.json")))["items"]
    sample = rng.sample([x for x in la if x["kind"] == "matched" and x["verdict"]], min(n, len(la)))
    out.append(("label_agreement", AGREE_SYS,
                [dict(line=f"A: {x['ours']!r}\n    B: {x['theirs']!r}", ds=x["verdict"]) for x in sample],
                lambda x: x.get("verdict")))
    return out


def run_task(judge, system, items, parse, group=10):
    got = [None] * len(items)
    for k in range(0, len(items), group):
        chunk = items[k:k + group]
        head = [chunk[0]["head"]] if "head" in chunk[0] else []
        user = "\n".join(head + [f"[{j}] {x['line']}" for j, x in enumerate(chunk)])
        try:
            res = judge.ask(system, user) or {}
        except Exception as e:
            print("  judge error:", str(e)[:120], flush=True)
            continue
        for x in res.get("items", []):
            try:
                j = int(x.get("i"))
            except (TypeError, ValueError):
                continue
            if 0 <= j < len(chunk):
                got[k + j] = parse(x)
    return got


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out"); ap.add_argument("--judges", nargs="+", required=True); ap.add_argument("--n", type=int, default=120)
    a = ap.parse_args()
    rng = random.Random(0)
    ts = tasks(a.n, rng)
    results = {}
    with opencode_server() as server:
        for spec in a.judges:
            judge = make_judge(spec, server)
            for name, system, items, parse in ts:
                labels = run_task(judge, system, items, parse)
                k, n, po = kappa([x["ds"] for x in items], labels)
                results.setdefault(name, {})[spec] = dict(kappa=k, agreement=po, n=n, of=len(items), labels=labels)
                print(f"{name:16s} {spec:40s} agreement {po} kappa {k} (n={n}/{len(items)})", flush=True)
                json.dump(dict(results=results, items={nm: [x["ds"] for x in it] for nm, _, it, _ in ts}), open(a.out, "w"), indent=0)
    # judge vs judge, for the ceiling on agreement
    for name in results:
        specs = list(results[name])
        if len(specs) == 2:
            k, n, po = kappa(results[name][specs[0]]["labels"], results[name][specs[1]]["labels"])
            results[name]["second_vs_third"] = dict(kappa=k, agreement=po, n=n)
            print(f"{name:16s} {'(the two other judges)':40s} agreement {po} kappa {k} (n={n})")
    json.dump(dict(results=results, items={nm: [x["ds"] for x in it] for nm, _, it, _ in ts}), open(a.out, "w"), indent=0)


if __name__ == "__main__":
    main()
