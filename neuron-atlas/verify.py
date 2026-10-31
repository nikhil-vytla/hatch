"""Recompute the README's headline numbers from the public Hub dataset alone, with 95% bootstrap intervals.

Anyone can run this on a laptop CPU (no GPU, no API keys); it downloads ~300 MB from
https://huggingface.co/datasets/nikhilxvytla/neuron-atlas and writes CLAIMS.md and claims_verified.json.

  pip install duckdb pyarrow huggingface_hub
  python verify.py            # everything
  python verify.py --quick    # skip the 1.1M-reply lens recomputation (uses every 4th layer instead)

A claim PASSES when the recomputed value matches the stated one within its tolerance. Judged claims (persona,
"became it", fusion outcome) recompute the counting from stored judge labels; the judge itself is audited separately
(second-judge audit, blind human audit).
"""
import argparse, json, random, re, sys
import duckdb
from huggingface_hub import HfApi, hf_hub_download

R = "nikhilxvytla/neuron-atlas"
WORD = re.compile(r"[a-z]{4,}")


def hub(path):
    return hf_hub_download(R, path, repo_type="dataset")


def files(prefix):
    return sorted(f for f in HfApi().list_repo_files(R, repo_type="dataset") if f.startswith(prefix))


def boot(groups, stat, n=1000, seed=0):
    """95% interval of stat over a resample of groups (each group = one neuron's records)."""
    rng = random.Random(seed)
    keys = list(groups)
    xs = sorted(stat([r for _ in keys for r in groups[keys[rng.randrange(len(keys))]]]) for _ in range(n))
    return [round(xs[int(0.025 * n)], 4), round(xs[int(0.975 * n)], 4)]


def norm(toks):
    return [t.strip().lower() for t in toks if len(t.strip()) >= 4 and t.strip().isalpha()]


# ---- claims -------------------------------------------------------------------------------------------------------

def says_vs_does(quick):
    """Finding 16: Qwen3.5-4B, J-lens tokens in pushed replies vs a random neuron's (chance)."""
    rng = random.Random(0)
    base = {p: set(WORD.findall((t or "").lower())) for p, t in duckdb.sql(
        f"select prompt, text from '{hub('Qwen__Qwen3.5-4B/sweep/steer/baseline.parquet')}' where layer < 0").fetchall()}
    groups = {}
    for L in range(0, 32, 4 if quick else 1):
        lens = duckdb.sql(f"select neuron, j_up, j_down from '{hub(f'Qwen__Qwen3.5-4B/jlens/L{L:02d}.parquet')}' order by neuron").fetchall()
        up, down = [norm(r[1]) for r in lens], [norm(r[2]) for r in lens]
        for n, d, p, text in duckdb.sql(f"select neuron, dose, prompt, text from '{hub(f'Qwen__Qwen3.5-4B/sweep/steer/L{L:02d}.parquet')}'").fetchall():
            words = set(WORD.findall((text or "").lower())) - base.get(p, set())
            if not words:
                continue
            own, other = (up, up) if d > 0 else (down, down)
            o = rng.randrange(len(own))
            groups.setdefault((L, n), []).append((any(w.startswith(t) for t in own[n] for w in words),
                                                 any(w.startswith(t) for t in other[o] for w in words)))
    hit = lambda rs: sum(a for a, _ in rs) / len(rs)
    chance = lambda rs: sum(b for _, b in rs) / len(rs)
    rs = [r for g in groups.values() for r in g]
    return [dict(id="16a", claim="J-lens tokens appear in the pushed reply", stated=0.095, value=hit(rs), tol=None if not quick else 0.04,
                 ci=boot(groups, hit, n=200), unit="share", source="Qwen__Qwen3.5-4B/jlens, sweep/steer"),
            dict(id="16b", claim="... another neuron's tokens (chance)", stated=0.0046, value=chance(rs), tol=0.002,
                 ci=boot(groups, chance, n=200), unit="share", source="same")]


def persona_rates():
    """Finding 20 / 9: share of 'Who are you?' pushes that give a persona, per model (weighted estimates)."""
    out = []
    for name, slug, stated in (("SmolLM2-135M", "HuggingFaceTB__SmolLM2-135M-Instruct", 0.37), ("Qwen3-0.6B", "Qwen__Qwen3-0.6B", 0.015),
                               ("Qwen3.5-4B", "Qwen__Qwen3.5-4B", 0.008), ("Qwen3-8B", "Qwen__Qwen3-8B", 0.021)):
        p = hub(f"{slug}/sweep_stats.parquet")
        cond = "prompt = 0" if name == "Qwen3.5-4B" else "true"
        tot, per = duckdb.sql(f"select sum(n_est), sum(n_est) filter (where reply_kind = 'persona') from '{p}' where {cond}").fetchall()[0]
        out.append(dict(id=f"20-{name}", claim=f"{name}: persona share of 'Who are you?' pushes", stated=stated, value=per / tot,
                        tol=None, unit="share", source=f"{slug}/sweep_stats.parquet"))
    p = hub("Qwen__Qwen3.5-4B/user_sweep_stats.parquet")
    tot, u = duckdb.sql(f"select sum(n_est), sum(n_est) filter (where reply_kind = 'user_identity') from '{p}'").fetchall()[0]
    out.append(dict(id="10", claim="Qwen3.5-4B: 'Who am I?' pushes that tell the user who they are", stated=0.13, value=u / tot,
                    tol=None, unit="share", source="Qwen__Qwen3.5-4B/user_sweep_stats.parquet"))
    return out


def lens_guided():
    """Finding 17: lens-picked neurons make the model become the word; random neurons don't."""
    out = []
    for name, slug, stated in (("Qwen3.5-4B", "Qwen__Qwen3.5-4B", 0.18), ("SmolLM2-135M", "HuggingFaceTB__SmolLM2-135M-Instruct", 0.22),
                               ("Qwen3-8B", "Qwen__Qwen3-8B", 0.22)):
        rows = duckdb.sql(f"select name, becomes from '{hub(f'{slug}/experiments/lens_guided.parquet')}'").fetchall()
        jrows = [b for nm, b in rows if nm.startswith("j:")]
        jgroups = {}
        for nm, b in rows:
            if nm.startswith("j:"):
                jgroups.setdefault(nm, []).append(bool(b))
        rate = lambda rs: sum(rs) / max(len(rs), 1)
        out.append(dict(id=f"17-{name}", claim=f"{name}: J-lens-picked pushes 'become' the word", stated=stated, value=rate(jrows), tol=None,
                        ci=boot(jgroups, rate, n=500), unit="share (DeepSeek judge)", source=f"{slug}/experiments/lens_guided.parquet"))
        rr = [b for nm, b in rows if nm.startswith("random")]
        out.append(dict(id=f"17r-{name}", claim=f"{name}: random-neuron pushes 'become' the word", stated={"Qwen3.5-4B": 0.0, "SmolLM2-135M": 0.027, "Qwen3-8B": 0.003}[name],
                        value=rate(rr), tol=None, unit="share (DeepSeek judge)", source="same"))
    return out


def fusion():
    """Finding 18: two persona neurons at 0.6x fuse into one identity."""
    d = json.load(open(hub("Qwen__Qwen3.5-4B/experiments/pairs_judged.json")))
    sub = [x for x in d if abs(x["scale"] - 0.6) < 1e-6 and x["outcome"]]
    groups = {i: [x["outcome"] == "fused"] for i, x in enumerate(sub)}
    rate = lambda rs: sum(rs) / len(rs)
    one = sum(x["outcome"] in ("a", "b") for x in sub) / len(sub)
    return [dict(id="18a", claim="persona pairs at 0.6x: fused identity", stated=0.33, value=rate([r for g in groups.values() for r in g]),
                 tol=None, ci=boot(groups, rate, n=1000), unit="share (DeepSeek judge)", source="Qwen__Qwen3.5-4B/experiments/pairs_judged.json"),
            dict(id="18b", claim="persona pairs at 0.6x: one persona wins", stated=0.069, value=one, tol=None, unit="share (DeepSeek judge)", source="same")]


def imitation():
    """Finding 19: a blind judge picks the pushed reply only modestly above chance."""
    d = json.load(open(hub("Qwen__Qwen3.5-4B/experiments/prompt_imitation_judged.json")))
    out = []
    for v, stated in (("you_are", 0.646), ("roleplay", 0.566)):
        sub = [x for x in d if x["variant"] == v and x["steered"] in ("1", "2")]
        groups = {i: [x["steered"] == x["truth"]] for i, x in enumerate(sub)}
        rate = lambda rs: sum(rs) / len(rs)
        out.append(dict(id=f"19-{v}", claim=f"judge picks the pushed reply vs '{v}' prompt", stated=stated,
                        value=rate([r for g in groups.values() for r in g]), tol=None, ci=boot(groups, rate, n=1000),
                        unit="accuracy (chance 0.5)", source="Qwen__Qwen3.5-4B/experiments/prompt_imitation_judged.json"))
    return out


def era():
    """Finding 21: pushes move the model's year forward."""
    years, n = {}, 0
    for f in files("Qwen__Qwen3.5-4B/battery_era/steer/L"):
        for (t,) in duckdb.sql(f"select text from '{hub(f)}' where prompt = 0").fetchall():
            m = re.search(r"\b(1[0-9]{3}|20[0-9]{2}|2[1-9][0-9]{2})\b", t or "")
            y = int(m.group(1)) if m else None
            years[y] = years.get(y, 0) + 1; n += 1
    fwd = (years.get(2025, 0) + years.get(2026, 0)) / n
    return [dict(id="21", claim="'What year is it?': pushes answer 2025 or 2026 (unpushed 2024)", stated=0.333, value=fwd, tol=None,
                 unit="share", source="Qwen__Qwen3.5-4B/battery_era/steer")]


def reasoning():
    """Finding 14: R1-Distill solves the bat-and-ball under ±0.3 pushes but not ±0.8 (640-token budget)."""
    out = []
    rows = []
    for f in files("deepseek-ai__DeepSeek-R1-Distill-Qwen-1.5B/reasoning_long/steer/L"):
        rows += duckdb.sql(f"select dose, prompt, text from '{hub(f)}'").fetchall()
    ok = lambda t: bool(re.search(r"(\$\s?0?\.05\b|\b5 cents|five cents)", t.split("</think>", 1)[1] if "</think>" in t else t[-300:], re.I))
    for dose, stated in ((0.3, 0.82), (0.8, 0.30)):
        sub = [ok(t or "") for d, p, t in rows if p == 0 and abs(abs(d) - dose) < 1e-3]
        out.append(dict(id=f"14-{dose}", claim=f"R1-Distill bat-and-ball correct under ±{dose} pushes", stated=stated,
                        value=sum(sub) / len(sub), tol=None, unit="share", source="deepseek-ai__DeepSeek-R1-Distill-Qwen-1.5B/reasoning_long/steer"))
    return out


def label_agreement():
    """neuron-lens cross-check: our labels vs theirs, judged."""
    d = json.load(open(hub("Qwen__Qwen3-8B/experiments/label_agreement_neuronlens.json")))
    m = [x for x in d["items"] if x["kind"] == "matched" and x["verdict"]]
    s = [x for x in d["items"] if x["kind"] == "shuffled" and x["verdict"]]
    return [dict(id="NL-a", claim="Qwen3-8B labels: ours vs neuron-lens judged 'same'", stated=0.331, value=sum(x["verdict"] == "same" for x in m) / len(m),
                 tol=0.005, unit="share (DeepSeek judge)", source="Qwen__Qwen3-8B/experiments/label_agreement_neuronlens.json"),
            dict(id="NL-b", claim="... shuffled pairs judged 'same' (chance)", stated=0.001, value=sum(x["verdict"] == "same" for x in s) / len(s),
                 tol=0.005, unit="share (DeepSeek judge)", source="same")]


def new_models():
    """Findings 23-26: Qwen3.5-0.8B personas, blank-canvas vision, TinyStories casting, MusicGen."""
    out = []
    p = hub("Qwen__Qwen3.5-0.8B/sweep_stats.parquet")
    tot, per = duckdb.sql(f"select sum(n_est), sum(n_est) filter (where reply_kind = 'persona') from '{p}'").fetchall()[0]
    out.append(dict(id="23", claim="Qwen3.5-0.8B: persona share of 'Who are you?' pushes", stated=0.047, value=per / tot,
                    tol=None, unit="share", source="Qwen__Qwen3.5-0.8B/sweep_stats.parquet"))
    p = hub("Qwen__Qwen3.5-2B/sweep_stats.parquet")
    tot, per = duckdb.sql(f"select sum(n_est), sum(n_est) filter (where reply_kind = 'persona') from '{p}'").fetchall()[0]
    out.append(dict(id="23b", claim="Qwen3.5-2B: persona share of 'Who are you?' pushes", stated=0.021, value=per / tot,
                    tol=None, unit="share", source="Qwen__Qwen3.5-2B/sweep_stats.parquet"))
    p = hub("Qwen__Qwen3.5-0.8B/user_sweep_stats.parquet")
    tot, u = duckdb.sql(f"select sum(n_est), sum(n_est) filter (where reply_kind = 'user_identity') from '{p}'").fetchall()[0]
    out.append(dict(id="23u", claim="Qwen3.5-0.8B: 'Who am I?' pushes that tell the user who they are", stated=0.11, value=u / tot,
                    tol=0.006, unit="share", source="Qwen__Qwen3.5-0.8B/user_sweep_stats.parquet"))
    # 24: count hallucinations from the raw replies (string rule), consistency from stored judge labels
    blank = re.compile(r"blank|no visible|empty|plain|solid|uniform|nothing|no (?:discernible|distinct|objects|content|details)"
                       r"|completely|entirely|cannot|sorry|unable", re.I)
    rows = duckdb.sql(f"select text from '{hub('Qwen__Qwen2.5-VL-3B-Instruct/blank/vlm.parquet')}' where layer >= 0").fetchall()
    out.append(dict(id="24", claim="Qwen2.5-VL-3B: blank-image pushes that describe something (of 3,456)", stated=285,
                    value=sum(not blank.search(t) for (t,) in rows), tol=0, unit="count", source="Qwen__Qwen2.5-VL-3B-Instruct/blank/vlm.parquet"))
    j = json.load(open(hub("Qwen__Qwen2.5-VL-3B-Instruct/blank/blank_judge.json")))
    out.append(dict(id="24c", claim="same neuron draws the same thing on different blanks (judged)", stated=0.41,
                    value=j["n_shared"] / j["n_multi"], tol=0.01, unit="share", source="…/blank/blank_judge.json"))
    out.append(dict(id="24s", claim="… for hallucinations shuffled across neurons", stated=0.10,
                    value=j["control_shared"] / j["control_judged"], tol=0.01, unit="share", source="same"))
    # 25: TinyStories character parse, recomputed from the raw continuations
    sys.path.insert(0, "analysis")
    from ts_characters import character
    base = {p: character(t)[0] for p, t in duckdb.sql(f"select prompt, text from '{hub('roneneldan__TinyStories-33M/sweep/steer/baseline.parquet')}'").fetchall()}
    rate = {}
    for L in range(4):
        for p, t in duckdb.sql(f"select prompt, text from '{hub(f'roneneldan__TinyStories-33M/sweep/steer/L{L:02d}.parquet')}'").fetchall():
            c = rate.setdefault((L, p), [0, 0]); c[0] += character(t)[0] != base[p]; c[1] += 1
    r = {k: a / b for k, (a, b) in rate.items()}
    out.append(dict(id="25a", claim="TinyStories '…met a': lowest per-layer recast rate", stated=0.45, value=min(r[(L, 1)] for L in range(4)),
                    tol=0.005, unit="share", source="roneneldan__TinyStories-33M/sweep/steer/"))
    out.append(dict(id="25b", claim="TinyStories '…met a': highest per-layer recast rate", stated=0.73, value=max(r[(L, 1)] for L in range(4)),
                    tol=0.005, unit="share", source="same"))
    out.append(dict(id="25c", claim="TinyStories 'there was a': recast rate, worst of layers 0-2", stated=0.02, value=max(r[(L, 0)] for L in range(3)),
                    tol=0.005, unit="share", source="same"))
    out.append(dict(id="25d", claim="TinyStories 'there was a': recast rate at layer 3", stated=0.34, value=r[(3, 0)], tol=0.005, unit="share", source="same"))
    from ts_says import toks, hit, WORD as TW
    bw = {p: set(TW.findall(t.lower())) for p, t in duckdb.sql(f"select prompt, text from '{hub('roneneldan__TinyStories-33M/sweep/steer/baseline.parquet')}'").fetchall()}
    ln = {n: (toks(u), toks(d)) for n, u, d in duckdb.sql(f"select neuron, j_up, j_down from '{hub('roneneldan__TinyStories-33M/jlens/L03.parquet')}'").fetchall()}
    hs = [hit(t, bw[p], ln[n][0 if d > 0 else 1]) for n, d, p, t in duckdb.sql(f"select neuron, dose, prompt, text from '{hub('roneneldan__TinyStories-33M/sweep/steer/L03.parquet')}'").fetchall()]
    out.append(dict(id="25e", claim="TinyStories layer 3: pushes that add a word the neuron's lens names", stated=0.445, value=sum(hs) / len(hs),
                    tol=0.012, unit="share", source="roneneldan__TinyStories-33M/jlens/L03.parquet + sweep"))
    # 26: music
    m = json.load(open(hub("site/music.json")))["rows"]
    dist = {}
    for p, L, n, d, f, rms, cen, zcr, ds in m:
        if L >= 0:
            dist.setdefault((L, n, d), []).append(ds)
    top = max(dist, key=lambda k: sum(dist[k]) / len(dist[k]))
    out.append(dict(id="26", claim="MusicGen: L14 N510 +0.5 is the largest mean change (1 = yes)", stated=1,
                    value=int(top == (14, 510, 0.5)), tol=0, unit="", source="site/music.json"))
    l0 = [ds for p, L, n, d, f, rms, cen, zcr, ds in m if L == 0]
    out.append(dict(id="26b", claim="MusicGen: layer 0 mean spectral distance", stated=0.36, value=sum(l0) / len(l0), tol=0.005, unit="cosine", source="same"))
    # 27: SmolLM3 thinking on/off, explicit-wrong rule on the raw replies
    from smol_think import FACT, WRONG
    for mode, stated in (("think", 0.016), ("nothink", 0.112)):
        rows = [t for L in range(6, 17) for (t,) in duckdb.sql(
            f"select text from '{hub(f'HuggingFaceTB__SmolLM3-3B/sweep_{mode}/steer/L{L:02d}.parquet')}' where prompt = 1").fetchall()]
        wrong = sum(not FACT.search(t) and bool(WRONG.search(t)) for t in rows)
        out.append(dict(id=f"27-{mode}", claim=f"SmolLM3 layers 6-16, thinking {'on' if mode == 'think' else 'off'}: pushes that call 1001 prime",
                        stated=stated, value=wrong / len(rows), tol=0.002, unit="share", source=f"HuggingFaceTB__SmolLM3-3B/sweep_{mode}/steer/"))
    # 28: OLMo training ladder (stored labels, weighted like finding 20)
    for tag, stated in (("sft", 0.065), ("dpo", 0.059), ("instruct", 0.055)):
        p = hub(f"allenai__OLMo-2-0425-1B/training/{tag}/sweep_stats.parquet")
        tot, per = duckdb.sql(f"select sum(n_est), sum(n_est) filter (where reply_kind = 'persona') from '{p}'").fetchall()[0]
        out.append(dict(id=f"28-{tag}", claim=f"OLMo-2 1B {tag}: persona share of pushes", stated=stated, value=per / tot, tol=0.003,
                        unit="share", source=f"allenai__OLMo-2-0425-1B/training/{tag}/sweep_stats.parquet"))
    # 30: says -> does on LFM2-350M (smallest of the three), recomputed with finding 16's metric
    sys.path.insert(0, "analysis")
    from lens_vs_push import norm_tokens, hit as lhit
    LW = re.compile(r"[a-z]{4,}")
    lb = set(LW.findall(duckdb.sql(f"select text from '{hub('LiquidAI__LFM2-350M/sweep/steer/baseline.parquet')}'").fetchall()[0][0].lower()))
    hits = n = 0
    for L in range(16):
        ln = {nn: (norm_tokens(u), norm_tokens(d)) for nn, u, d in duckdb.sql(f"select neuron, j_up, j_down from '{hub(f'LiquidAI__LFM2-350M/jlens/L{L:02d}.parquet')}'").fetchall()}
        for nn, d, t in duckdb.sql(f"select neuron, dose, text from '{hub(f'LiquidAI__LFM2-350M/sweep/steer/L{L:02d}.parquet')}' where prompt = 0").fetchall():
            words = [w for w in LW.findall((t or '').lower()) if w not in lb]
            if not words:
                continue
            hits += bool(lhit(ln[nn][0 if d > 0 else 1], words)); n += 1
    out.append(dict(id="30", claim="LFM2-350M: pushes adding a word the neuron's fitted J-lens names", stated=0.167, value=hits / n, tol=0.004,
                    unit="share", source="LiquidAI__LFM2-350M/jlens + sweep/steer"))
    # 29: Gemma 4 audio
    h = json.load(open(hub("google__gemma-4-E4B-it/audio/hear_summary.json")))
    out.append(dict(id="29", claim="Gemma 4 audio: pushes that change what it hears", stated=0.36, value=h["changed"] / h["n_pushes"], tol=0.005,
                    unit="share", source="google__gemma-4-E4B-it/audio/hear_summary.json"))
    out.append(dict(id="29f", claim="… pushes that turn a misheard ESC-50 clip right", stated=176, value=h["esc"]["fixed"], tol=0, unit="count", source="same"))
    out.append(dict(id="29b", claim="… pushes that turn a correctly heard clip wrong", stated=277, value=h["esc"]["broke"], tol=0, unit="count", source="same"))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true")
    a = ap.parse_args()
    claims = []
    for fn in (persona_rates, lens_guided, fusion, imitation, era, reasoning, label_agreement, new_models, lambda: says_vs_does(a.quick)):
        try:
            claims += fn()
        except Exception as e:  # a missing file is a failed claim, not a crash
            claims.append(dict(id=getattr(fn, "__name__", "?"), claim=f"could not recompute: {e}", stated=None, value=None, tol=0, unit="", source=""))
        print(f"done {getattr(fn, '__name__', 'says_vs_does')}", flush=True)
    for c in claims:  # default tolerance: the stated number's rounding (5% relative, at least 0.002 absolute)
        if c.get("tol") is None and c["stated"] is not None:
            c["tol"] = max(0.002, 0.05 * abs(c["stated"]))
        c["status"] = "PASS" if c["value"] is not None and c["stated"] is not None and abs(c["value"] - c["stated"]) <= c["tol"] else "FAIL"
    json.dump(claims, open("claims_verified.json", "w"), indent=1)
    lines = ["# Claims, recomputed", "",
             "Generated by `python verify.py` from the public dataset alone. *Stated* is the number in the README; *recomputed*",
             "is what the data gives; the interval is a 95% bootstrap over neurons (or items). Judged claims count stored",
             "judge labels; the judges are audited in `AUDIT.md`.", "",
             "| id | claim | stated | recomputed | 95% interval | status | source |", "|---|---|---|---|---|---|---|"]
    for c in claims:
        fmt = lambda v: "–" if v is None else f"{v:.3f}"
        ci = f"{c['ci'][0]:.3f}–{c['ci'][1]:.3f}" if c.get("ci") else ""
        lines.append(f"| {c['id']} | {c['claim']} | {fmt(c['stated'])} | {fmt(c['value'])} | {ci} | {c['status']} | `{c['source']}` |")
    n_pass = sum(c["status"] == "PASS" for c in claims)
    lines += ["", f"{n_pass} of {len(claims)} claims pass."]
    open("CLAIMS.md", "w").write("\n".join(lines) + "\n")
    print("\n".join(lines[-len(claims) - 3:]))
    sys.exit(0 if n_pass == len(claims) else 1)


if __name__ == "__main__":
    main()
