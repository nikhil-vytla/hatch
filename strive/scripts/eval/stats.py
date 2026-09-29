"""The eval's statistics and ADR-0021's pre-registered hypotheses, from a
results file. Standard library only.

Scored trials are the learnable families' test instances (not probes), paired
across arms by (sequence, family, instance): L and F share orderings, so
L/k pairs with F/k. O and placebo are compared as pooled rates.
"""

from __future__ import annotations

import math
import random
from collections import defaultdict
from statistics import mean

Z95 = 1.959963984540054


def wilson(passes: int, n: int, z: float = Z95) -> tuple[float, float]:
    if n == 0:
        return (math.nan, math.nan)
    p = passes / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, centre - half), min(1.0, centre + half))


def binom_two_sided(k: int, n: int) -> float:
    """Exact two-sided p for k successes in n fair trials."""
    if n == 0:
        return 1.0
    probs = [math.comb(n, i) / 2**n for i in range(n + 1)]
    observed = probs[k]
    return min(1.0, sum(p for p in probs if p <= observed * (1 + 1e-9)))


def mcnemar(pairs: list[tuple[bool, bool]]) -> dict:
    """Exact McNemar on (treatment, control) pass pairs."""
    b = sum(1 for t, c in pairs if t and not c)
    c = sum(1 for t, c_ in pairs if not t and c_)
    return {"treatment_only": b, "control_only": c, "p": binom_two_sided(b, b + c)}


def sign_test(diffs: list[float]) -> dict:
    pos = sum(1 for d in diffs if d > 0)
    neg = sum(1 for d in diffs if d < 0)
    return {"positive": pos, "negative": neg, "ties": len(diffs) - pos - neg, "p": binom_two_sided(pos, pos + neg)}


def wilcoxon(diffs: list[float]) -> dict:
    """Wilcoxon signed-rank, normal approximation with tie and continuity
    corrections; zero differences dropped."""
    d = [x for x in diffs if x != 0]
    n = len(d)
    if n == 0:
        return {"n": 0, "w_plus": 0.0, "z": 0.0, "p": 1.0}
    order = sorted(range(n), key=lambda i: abs(d[i]))
    ranks = [0.0] * n
    i = 0
    ties = 0.0
    while i < n:
        j = i
        while j + 1 < n and abs(d[order[j + 1]]) == abs(d[order[i]]):
            j += 1
        r = (i + j) / 2 + 1
        for k in range(i, j + 1):
            ranks[order[k]] = r
        t = j - i + 1
        ties += t**3 - t
        i = j + 1
    w_plus = sum(r for r, x in zip(ranks, d) if x > 0)
    mu = n * (n + 1) / 4
    var = n * (n + 1) * (2 * n + 1) / 24 - ties / 48
    if var <= 0:
        return {"n": n, "w_plus": w_plus, "z": 0.0, "p": 1.0}
    z = (w_plus - mu - math.copysign(0.5, w_plus - mu)) / math.sqrt(var) if w_plus != mu else 0.0
    p = math.erfc(abs(z) / math.sqrt(2))
    return {"n": n, "w_plus": w_plus, "z": z, "p": p}


def cluster_bootstrap(pairs: list[tuple[str, float]], reps: int = 10_000, seed: int = 0) -> tuple[float, float, float]:
    """Mean of paired differences and its 95% percentile interval,
    resampling whole clusters (family x ordering) with replacement."""
    clusters: dict[str, list[float]] = defaultdict(list)
    for cluster, diff in pairs:
        clusters[cluster].append(diff)
    keys = sorted(clusters)
    if not keys:
        return (math.nan, math.nan, math.nan)
    point = mean(d for _, d in pairs)
    rng = random.Random(seed)
    stats = []
    for _ in range(reps):
        sample = [d for _ in keys for d in clusters[keys[rng.randrange(len(keys))]]]
        stats.append(mean(sample))
    stats.sort()
    return (point, stats[int(0.025 * reps)], stats[min(reps - 1, int(0.975 * reps))])


def rate(trials: list[dict]) -> dict:
    n = len(trials)
    k = sum(1 for t in trials if t["passed"])
    lo, hi = wilson(k, n)
    return {"n": n, "passes": k, "rate": k / n if n else math.nan, "ci": [lo, hi]}


def summarize(trials: list[dict], kinds: dict[str, str]) -> dict:
    """Everything the summary reports, from trial records."""
    scored = [t for t in trials if t["role"] == "test" and not t["probe"]]
    by_arm: dict[str, list[dict]] = defaultdict(list)
    for t in scored:
        by_arm[t["arm"]].append(t)

    def of_kind(arm: str, kind: str) -> list[dict]:
        return [t for t in by_arm.get(arm, []) if kinds.get(t["family"]) == kind]

    out: dict = {"arms": {}, "hypotheses": {}}
    for arm, ts in sorted(by_arm.items()):
        out["arms"][arm] = {
            "learnable": rate(of_kind(arm, "learnable")),
            "generic": rate(of_kind(arm, "generic")),
            "conflict": rate(of_kind(arm, "conflict")),
            "turns_mean": mean(t["turns"] for t in ts) if ts else math.nan,
            "cost_usd": sum(t["cost_usd"] for t in trials if t["arm"] == arm),
            "memory_loaded": sum(1 for t in ts if t["memory_loaded"]) / len(ts) if ts else math.nan,
            "followed": _followed_rate(of_kind(arm, "learnable")),
            "leaks": sum(1 for t in trials if t["arm"] == arm and t.get("leaked")),
        }

    def paired(a: str, b: str, kind: str) -> list[tuple[dict, dict]]:
        index = {(t["sequence"], t["family"], t["instance"]): t for t in of_kind(b, kind)}
        return [(t, index[k]) for t in of_kind(a, kind) if (k := (t["sequence"], t["family"], t["instance"])) in index]

    lf = paired("L", "F", "learnable")
    if lf:
        diffs = [(f"{t['family']}#{t['sequence']}", float(t["passed"]) - float(u["passed"])) for t, u in lf]
        point, lo, hi = cluster_bootstrap(diffs)
        per_family: dict[str, list[float]] = defaultdict(list)
        for t, u in lf:
            per_family[t["family"]].append(float(t["passed"]) - float(u["passed"]))
        out["L_minus_F"] = {
            "pairs": len(lf),
            "diff": point,
            "cluster_ci": [lo, hi],
            "mcnemar": mcnemar([(t["passed"], u["passed"]) for t, u in lf]),
            "family_sign_test": sign_test([mean(v) for v in per_family.values()]),
            "turns_wilcoxon": wilcoxon([float(t["turns"] - u["turns"]) for t, u in lf]),
            "turns_ratio": _ratio([t["turns"] for t, _ in lf], [u["turns"] for _, u in lf]),
        }
    out["hypotheses"] = hypotheses(out, of_kind, paired, trials)
    out["forgetting"] = forgetting(trials)
    return out


def _followed_rate(ts: list[dict]) -> float:
    known = [t["followed"] for t in ts if t.get("followed") is not None]
    return sum(1 for f in known if f) / len(known) if known else math.nan


def _ratio(a: list[float], b: list[float]) -> float:
    return mean(a) / mean(b) if b and mean(b) else math.nan


def _r(of_kind, arm: str, kind: str = "learnable") -> float | None:
    ts = of_kind(arm, kind)
    return sum(1 for t in ts if t["passed"]) / len(ts) if ts else None


def hypotheses(out: dict, of_kind, paired, trials: list[dict]) -> dict:
    h: dict[str, dict] = {}
    F, L, O, P, PL = (_r(of_kind, a) for a in ("F", "L", "O", "P", "placebo"))

    def verdict(name: str, needs: list, passed, text: str) -> None:
        if any(x is None for x in needs):
            h[name] = {"result": "not run", "text": text}
        else:
            h[name] = {"result": "pass" if passed() else "fail", "text": text}

    lf = out.get("L_minus_F")
    verdict("H1", [lf], lambda: lf["diff"] >= 0.15 and lf["cluster_ci"][0] > 0,
            "L - F on learnable families >= 15 pp, with the cluster CI's lower bound above 0")
    verdict("H2", [L, F, O], lambda: (O - F) > 0 and (L - F) / (O - F) >= 0.5,
            "learning efficiency (L - F) / (O - F) >= 0.5")
    gl = paired("L", "F", "generic")
    g = mean(float(t["passed"]) - float(u["passed"]) for t, u in gl) if gl else None
    verdict("H3", [g], lambda: g > -0.10, "on generic families, L - F > -10 pp")
    pf = paired("P", "F", "learnable")
    p_minus_f = mean(float(t["passed"]) - float(u["passed"]) for t, u in pf) if pf else None
    conflict = [t for t in trials if t["arm"] in ("L", "P") and t["family"] in
                {f for f, k in _kinds_of(trials).items() if k == "conflict"} and t["role"] == "test"]
    cross = sum(1 for t in conflict if t.get("signals", {}).get("cross_applied"))
    verdict("H4", [p_minus_f, conflict or None], lambda: p_minus_f > -0.10 and cross == 0,
            "P > F - 10 pp, and no cross-application in the conflicting family")
    lf_turns = lf["turns_ratio"] if lf else None
    verdict("H5", [lf_turns], lambda: lf_turns <= 0.85, "turns in L <= 0.85 x turns in F")
    verdict("H6", [O, PL], lambda: O - PL >= 0.20, "O - placebo >= 20 pp")
    h["_values"] = {"F": F, "L": L, "O": O, "P": P, "placebo": PL, "P_minus_F_paired": p_minus_f,
                    "generic_L_minus_F": g, "conflict_cross_applied": cross, "turns_ratio_L_F": lf_turns}
    return h


def _kinds_of(trials: list[dict]) -> dict[str, str]:
    return {t["family"]: t["kind"] for t in trials}


def forgetting(trials: list[dict]) -> dict:
    """Each probe (an early family's first test, run again at the end)
    against the same task's first run in that sequence."""
    first = {(t["arm"], t["sequence"], t["family"], t["instance"]): t["passed"]
             for t in trials if not t["probe"]}
    out: dict[str, dict] = {}
    for t in trials:
        if t["probe"]:
            before = first.get((t["arm"], t["sequence"], t["family"], t["instance"]))
            o = out.setdefault(t["arm"], {"probes": 0, "passed_then_failed": 0, "failed_then_passed": 0})
            o["probes"] += 1
            if before and not t["passed"]:
                o["passed_then_failed"] += 1
            if before is False and t["passed"]:
                o["failed_then_passed"] += 1
    return out


def screen(trials: list[dict], kinds: dict[str, str]) -> dict:
    """ADR-0021's headroom screen on calibration instances: keep a learnable
    family only if F passes at most 50% and O at least 70%."""
    fams: dict[str, dict] = {}
    for fam in sorted({t["family"] for t in trials}):
        f = [t["passed"] for t in trials if t["family"] == fam and t["arm"] == "F"]
        o = [t["passed"] for t in trials if t["family"] == fam and t["arm"] == "O"]
        fr = sum(f) / len(f) if f else math.nan
        orr = sum(o) / len(o) if o else math.nan
        screened = kinds.get(fam) == "learnable"
        fams[fam] = {"kind": kinds.get(fam), "F": fr, "O": orr, "n": [len(f), len(o)],
                     "keep": (fr <= 0.5 and orr >= 0.7) if screened else True,
                     "why": "screened" if screened else "not screened: kept to measure harm or over-generalization"}
    return fams


def fmt(x: float | None, pct: bool = True) -> str:
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return "-"
    return f"{100 * x:.0f}%" if pct else f"{x:.2f}"


def markdown(s: dict, meta: dict) -> str:
    lines = [f"# strive learning eval: {meta.get('label', '')}", ""]
    lines += [f"- model: {meta.get('model')}", f"- trials: {meta.get('trials')}  total cost: ${meta.get('cost_usd', 0):.2f}",
              f"- results: {meta.get('results')}", ""]
    lines += ["## Pass rates on test instances (Wilson 95% CI)", "",
              "| arm | learnable | generic | conflict | turns | memory loaded | lesson followed | leaks | cost |",
              "|---|---|---|---|---|---|---|---|---|"]
    for arm, a in s["arms"].items():
        cell = lambda r: f"{fmt(r['rate'])} ({r['passes']}/{r['n']}, {fmt(r['ci'][0])}-{fmt(r['ci'][1])})"  # noqa: E731
        lines.append(f"| {arm} | {cell(a['learnable'])} | {cell(a['generic'])} | {cell(a['conflict'])} | "
                     f"{fmt(a['turns_mean'], False)} | {fmt(a['memory_loaded'])} | {fmt(a['followed'])} | {a['leaks']} | "
                     f"${a['cost_usd']:.4f} |")
    lf = s.get("L_minus_F")
    if lf:
        m, st, w = lf["mcnemar"], lf["family_sign_test"], lf["turns_wilcoxon"]
        lines += ["", "## L - F, paired on learnable test instances", "",
                  f"- {lf['pairs']} pairs; L - F = {fmt(lf['diff'])}, cluster bootstrap 95% CI "
                  f"{fmt(lf['cluster_ci'][0])} to {fmt(lf['cluster_ci'][1])} (clusters: family x ordering)",
                  f"- McNemar: L only {m['treatment_only']}, F only {m['control_only']}, exact p = {m['p']:.3g}",
                  f"- family sign test: {st['positive']} up, {st['negative']} down, {st['ties']} tied, p = {st['p']:.3g}",
                  f"- turns: L/F = {fmt(lf['turns_ratio'], False)}; Wilcoxon n = {w['n']}, z = {w['z']:.2f}, p = {w['p']:.3g}"]
    lines += ["", "## Pre-registered hypotheses", ""]
    for name in ("H1", "H2", "H3", "H4", "H5", "H6"):
        hh = s["hypotheses"][name]
        lines.append(f"- **{name}** {hh['result'].upper()}: {hh['text']}")
    v = s["hypotheses"]["_values"]
    lines += ["", "Values: " + ", ".join(f"{k} {fmt(x) if k not in ('conflict_cross_applied', 'turns_ratio_L_F') else x}"
                                         for k, x in v.items())]
    if s.get("forgetting"):
        lines += ["", "## Forgetting probes", ""]
        for arm, f in s["forgetting"].items():
            lines.append(f"- {arm}: {f['probes']} probes, {f['passed_then_failed']} passed first and failed later, "
                         f"{f['failed_then_passed']} the reverse")
    lines += ["", "Power (ADR-0021): with 81 pairs and F near 30%, about 0.8-0.96 to detect a 30-point lift and "
              "about 0.4 for 15 points. This run detects large effects only.", ""]
    return "\n".join(lines)


def screen_markdown(fams: dict, meta: dict) -> str:
    lines = [f"# Headroom screen: {meta.get('label', '')}", "", f"- model: {meta.get('model')}",
             f"- cost: ${meta.get('cost_usd', 0):.2f} over {meta.get('trials')} tasks", "",
             "Keep a learnable family only if F passes at most 50% and O at least 70% of its calibration instances.",
             "", "| family | kind | F | O | keep |", "|---|---|---|---|---|"]
    for fam, f in fams.items():
        lines.append(f"| {fam} | {f['kind']} | {fmt(f['F'])} | {fmt(f['O'])} | {'yes' if f['keep'] else 'no'} |")
    return "\n".join(lines) + "\n"
