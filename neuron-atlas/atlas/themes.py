"""Group free-text persona names into themes with an LLM.

    from atlas.themes import themes
    theme = themes(names, cache_path="out/themes.json")
"""
import concurrent.futures as cf, json, os, random, re

from .label import chat, client

SYS_THEMES = """You are an interpretability researcher sorting the identities a language model claimed after one of
its neurons was perturbed. Each name is a short free-text persona ("a retired sea captain", "assistant obsessed with
numbers"). Propose about {n} short theme labels (1-3 words, lowercase) that together cover the names: specific enough
to be interesting, broad enough to cover many names. Examples: "children", "software engineers", "animals",
"rebranded assistant: google", "rebranded assistant: other company", "mystic / cryptic". Always include "other".
Reply JSON {{"themes": ["...", ...]}}."""

SYS_ASSIGN = """You sort persona names into themes. Use only themes from the given list.
Reply JSON {"items": [{"i": <index>, "theme": "<one theme from the list>"}]} for every numbered name."""


def norm(s):
    return re.sub(r"\s+", " ", str(s or "").strip().lower())


def _clean(t):
    return norm(t)


def _taxonomy(r):
    ts = r.get("themes") if isinstance(r, dict) else r
    out = []
    for t in ts or []:
        t = _clean(t)
        if t and t not in out:
            out.append(t)
    if "other" not in out:
        out.append("other")
    return out


def themes(names, n_themes=24, sample=600, batch=150, workers=8, seed=0, cache_path=None):
    names = list(dict.fromkeys(n for n in map(norm, names) if n))
    cache = json.load(open(cache_path)) if cache_path and os.path.exists(cache_path) else {}
    done = {n: cache[n] for n in names if isinstance(cache.get(n), str)}
    todo = [n for n in names if n not in done]
    raw = cache.get("__themes__")
    tax = [_clean(t) for t in raw if _clean(t)] if isinstance(raw, list) else []
    have_tax = bool(tax)
    if "other" not in tax:
        tax.append("other")
    cl = client() if todo else None
    if not have_tax and todo:
        rng = random.Random(seed)
        picked = rng.sample(todo, min(sample, len(todo)))
        r = chat(cl, SYS_THEMES.format(n=n_themes), "\n".join(f"- {x}" for x in picked))
        tax = _taxonomy(r)
    if todo:
        known = set(tax)
        chunks = [todo[i:i + batch] for i in range(0, len(todo), batch)]

        def job(chunk):
            user = "themes:\n" + "\n".join(f"- {t}" for t in tax)
            user += "\n\nnames:\n" + "\n".join(f"[{i}] {x}" for i, x in enumerate(chunk))
            r = chat(cl, SYS_ASSIGN, user)
            r = r if isinstance(r, dict) else {}
            out = {}
            for it in r.get("items", []):
                try:
                    i = int(it.get("i"))
                except (TypeError, ValueError, AttributeError):
                    continue
                if 0 <= i < len(chunk):
                    t = _clean(it.get("theme"))
                    out[chunk[i]] = t if t in known else "other"
            return out

        with cf.ThreadPoolExecutor(workers) as ex:
            for res in ex.map(job, chunks):
                done.update(res)
    out = {n: done.get(n, "other") for n in names}
    if cache_path:
        cache.update(done)  # only real answers, so names from failed batches are retried next time
        cache["__themes__"] = tax
        json.dump(cache, open(cache_path, "w"), indent=0, sort_keys=True)
    return out
