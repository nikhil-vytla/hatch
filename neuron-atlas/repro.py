"""Check replayed neuronary recipes against their descriptions.

    python repro.py --atlas out/Qwen__Qwen3.5-4B --workers 8

Reads the replies written by `atlas.steer --neuronary` (recipes.parquet, with baseline rows per prompt), fetches each
recipe's description from neuronary.org, and asks a judge once per (recipe, scale) whether the steered replies
reproduce the described effect and stay coherent. Writes repro.parquet and prints the yes/partial/no rates.
"""
import argparse, json, re, urllib.request, concurrent.futures as cf
import pyarrow as pa
import pyarrow.parquet as pq

from atlas import label, steer

SYSTEM = """You judge whether replaying a neuron-steering recipe reproduces its described effect.
You get a recipe's name and description, then for each prompt the unsteered baseline reply and the steered reply.
Reply with JSON {"reproduces": "yes"|"partial"|"no", "coherent": true|false, "note": "<= 20 words"}.
"yes" = the steered replies clearly show the described effect and the baselines do not.
"partial" = the effect is present but weak, mixed, or only on some prompts.
"no" = the steered replies do not show the effect, or the baselines already show it.
coherent = the steered replies are fluent text rather than loops or gibberish."""
SCHEMA = [("name", pa.string()), ("recipe", pa.string()), ("url", pa.string()), ("scale", pa.float32()),
          ("reproduces", pa.string()), ("coherent", pa.bool_()), ("note", pa.string()), ("n_neurons", pa.int16())]


def neuronary_meta(model, limit=200):
    """recipe string -> {name, recipe, description, tags, url} for `model`, paging until a short page."""
    out, offset = {}, 0
    while True:
        url = f"{steer.NEURONARY}?limit={limit}&offset={offset}"
        with urllib.request.urlopen(url, timeout=60) as r:
            data = json.load(r)
        page = data.get("recipes", []) if isinstance(data, dict) else data
        for x in page:
            if x.get("model") == model:
                out[x.get("recipe", "")] = {k: x.get(k) for k in ("name", "recipe", "description", "tags", "url")}
        if len(page) < limit:
            return out
        offset += limit


def user_message(name, info, base, prompts, group):
    by_prompt = {r["prompt"]: r["text"] for r in group}
    lines = [f"recipe: {name}", f"description: {info.get('description') or '(none)'}"]
    if info.get("tags"):
        lines.append(f"tags: {info['tags']}")
    for p in prompts:
        if p not in base and p not in by_prompt:
            continue
        lines += [f"prompt: {p!r}",
                  f"  baseline: {str(base.get(p, '(missing)'))[:300]!r}",
                  f"  steered: {str(by_prompt.get(p, '(missing)'))[:300]!r}"]
    return "\n".join(lines)


def as_bool(v):
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().lower() in ("true", "yes", "1")
    return None


def judge(job):
    name, recipe, scale, group, info, base, prompts = job
    r = label.chat(label.client(), SYSTEM, user_message(name, info, base, prompts, group)) or {}
    reproduces = str(r.get("reproduces", "")).strip().lower()
    return dict(name=name, recipe=recipe, url=str(info.get("url") or ""), scale=float(scale),
                reproduces=reproduces if reproduces in ("yes", "partial", "no") else None,
                coherent=as_bool(r.get("coherent")), note=str(r.get("note", "") or "")[:160],
                n_neurons=len(re.findall(r"L\d+N\d+", recipe)))


def report(rows):
    def shares(sel):
        n = len(sel)
        return "  ".join(f"{k} {sel.count(k)}/{n} ({sel.count(k) / n:.0%})" if n else f"{k} 0"
                         for k in ("yes", "partial", "no"))

    scales = sorted({r["scale"] for r in rows})
    for s in scales:
        print(f"scale {s:g}: {shares([r['reproduces'] for r in rows if r['scale'] == s])}")
    for name, keep in [("1", lambda n: n == 1), ("2", lambda n: n == 2), ("3+", lambda n: n >= 3)]:
        print(f"n_neurons {name}: {shares([r['reproduces'] for r in rows if keep(r['n_neurons'])])}")
    if not scales:
        return
    top = max(scales)
    yes = list(dict.fromkeys(r["name"] for r in rows if r["scale"] == top and r["reproduces"] == "yes"))
    print(f"yes at scale {top:g} ({len(yes)} recipes):")
    for name in yes[:10]:
        print(f"  {name}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--atlas", required=True)
    ap.add_argument("--workers", type=int, default=8)
    a = ap.parse_args()
    meta = json.load(open(f"{a.atlas}/meta.json"))
    rows = pq.read_table(f"{a.atlas}/recipes.parquet").to_pylist()
    info = neuronary_meta(meta["model"])
    base = {r["prompt"]: r["text"] for r in rows if r.get("name") == "baseline"}
    prompts = list(base) + [r["prompt"] for r in rows if r["prompt"] not in base]
    prompts = list(dict.fromkeys(prompts))
    grouped = {}
    for r in rows:
        if r.get("name") != "baseline":
            grouped.setdefault((r["recipe"], float(r["scale"])), []).append(r)

    jobs = []
    for (recipe, scale), group in grouped.items():
        md = info.get(recipe, {})
        name = md.get("name") or group[0].get("name") or recipe
        jobs.append((name, recipe, scale, group, md, base, prompts))
    print(f"judging {len(jobs)} (recipe, scale) pairs for {meta['model']} with {label.MODEL}")
    with cf.ThreadPoolExecutor(a.workers) as ex:
        out = list(ex.map(judge, jobs))

    pq.write_table(pa.Table.from_pylist(out, schema=pa.schema(SCHEMA)),
                   f"{a.atlas}/repro.parquet", compression="zstd")
    print(f"wrote {len(out)} rows to {a.atlas}/repro.parquet")
    report(out)


if __name__ == "__main__":
    main()
