"""Name neurons with an LLM (any OpenAI-compatible API; defaults to DeepSeek) and check the names.

    python -m atlas.label --atlas out/<slug> --per-layer 40

1. Label: the labeler sees a neuron's top documents 0-5 (peak token in «»), its most negative documents (gated MLPs),
   its logit lens, and its steered replies next to the unsteered ones. It returns a short label, a sentence, an emoji,
   a confidence, and what the push does.
2. Check (detection): a second call sees only the label and 4 snippets, the neuron's held-out documents 6-7 and two
   random corpus windows, and says which snippets the neuron fires on. Chance is 50% per snippet; the null runs the
   same snippets against another neuron's label.
"""
import argparse, json, os, random, re, threading, time, concurrent.futures as cf
import duckdb

from . import neurons_src
import pyarrow as pa
import pyarrow.parquet as pq
from openai import OpenAI

BASE_URL = os.environ.get("LABEL_BASE_URL", "https://api.deepseek.com")
MODEL = os.environ.get("LABEL_MODEL", "deepseek-chat")
KEY = os.environ.get("LABEL_API_KEY") or os.environ.get("DEEPSEEK_API_KEY") or "proxy-injected"
SHOWN, HELD = range(0, 6), (6, 7)
JUDGE = None

SYS = """You are an interpretability researcher naming neurons of a language model.
For each neuron you get: documents where it fires most (the peak token is wrapped in «», the number is the activation),
sometimes documents where it is most negative, its logit lens (tokens its output direction promotes / suppresses),
and sometimes replies of the model to a prompt with the neuron pushed down (-) or up (+) next to the normal reply.
Reply with JSON {"neurons": [{"id": ..., "label": "2-6 words", "description": "one sentence on what it reads and writes",
"emoji": "one emoji", "confidence": 1-5, "push": "what pushing it does, or 'nothing clear'",
"push_kind": "persona|altered_assistant|topic|style|language|token|incoherent|none"}]}.
Prefer specific labels ("past participles after 'has'", "French cooking words") over vague ones ("various words").
If the logit lens names a token that tends to come right after the peak (it fires on "in terms" and promotes "of"),
the neuron predicts that token: say so ("predicts 'of' after 'in terms'"). If the examples share no pattern,
say "polysemantic: ..." and use confidence 1-2.
confidence 1 = no visible pattern, 5 = every example fits."""

CHECK = """A neuron of a language model was labeled. For each numbered snippet, decide whether this neuron's peak
activation is likely in it (true) or not (false). Exactly the snippets that match the label should be true.
Reply JSON {"answers": {"<neuron id>": [true/false per snippet, in order], ...}}."""


def client():
    return OpenAI(base_url=BASE_URL, api_key=KEY)


def chat(cl, system, user, tries=3):
    if JUDGE is not None:
        return JUDGE.ask(system, user)
    for t in range(tries):
        try:
            r = cl.chat.completions.create(model=MODEL, messages=[{"role": "system", "content": system},
                                                                   {"role": "user", "content": user}],
                                           response_format={"type": "json_object"}, temperature=0.2, max_tokens=4000)
            return json.loads(r.choices[0].message.content)
        except Exception as e:  # retry on transient API or JSON errors
            err = e
    print("  call failed:", err)
    return None


class Atlas:
    def __init__(self, d):
        self.d = d
        self.meta = json.load(open(f"{d}/meta.json"))
        self.con = duckdb.connect()
        self.toks = {doc: (toks, skip) for doc, toks, skip in
                     self.con.sql(f"select doc, toks, skip from '{d}/tokens.parquet'").fetchall()}

    def window(self, doc, pos, mark=True):
        toks, _ = self.toks[doc]
        a, b = max(0, pos - 20), min(len(toks), pos + 5)
        s = "".join(("«" + t + "»") if (i == pos and mark) else t for i, t in zip(range(a, b), toks[a:b]))
        return re.sub(r"\s+", " ", s).strip()

    def examples(self, L, n):
        return self.con.cursor().sql(f"""select sign, rank, act, doc, pos from '{self.d}/examples/L{L:02d}.parquet'
                                where neuron = {n} order by sign desc, rank""").fetchall()

    def random_window(self, rng):
        doc = rng.choice(list(self.toks))
        toks, skip = self.toks[doc]
        return self.window(doc, rng.randrange(skip, len(toks)), mark=False)


def describe(at: Atlas, L, n, lens, steer, base, sweep=()):
    ex = at.examples(L, n)
    lines = [f"### neuron id {L}:{n}", "fires most on:"]
    for sign, rank, act, doc, pos in ex:
        if sign == 1 and rank in SHOWN:
            lines.append(f"  ({act:.2f}) {at.window(doc, pos)}")
    neg = [e for e in ex if e[0] == -1][:2]
    if neg:
        lines.append("most negative on:")
        lines += [f"  ({act:.2f}) {at.window(doc, pos)}" for _, _, act, doc, pos in neg]
    up, down = lens
    lines.append(f"logit lens promotes: {up[:8]}  suppresses: {down[:8]}")
    for pi, d, text in steer:
        lines.append(f"push {'+' if d > 0 else '-'}{abs(d)} on prompt {pi!r}: normal reply {base[pi][:150]!r} -> steered {text[:200]!r}")
    if sweep:
        lines.append("sweep replies (not the normal assistant):")
        for prompt, d, text, kind, who in sweep:
            tag = f" ({', '.join(x for x in (kind, who) if x)})" if kind or who else ""
            lines.append(f"  push {'+' if d > 0 else '-'}{abs(d)} on prompt {prompt!r}{tag}: {text[:200]!r}")
    return "\n".join(lines)


def run(atlas, per_layer=40, group=8, workers=8, seed=0, extra=(), only=None, sweepcard=None, merge=False):
    """extra: more (layer, neuron) keys to label, e.g. the neurons of neuronary recipes."""
    at = Atlas(atlas)
    con = at.con
    if only is not None:
        pairs = list(dict.fromkeys((int(L), int(n)) for L, n in only))
        con.sql("create or replace temp table only_keys (layer integer, neuron integer)")
        con.executemany("insert into only_keys values (?, ?)", pairs)
        sel = con.sql(f"""select s.layer, s.neuron, s.lens_up, s.lens_down from {neurons_src(atlas)} s
                          join only_keys k on s.layer = k.layer and s.neuron = k.neuron""").fetchall()
    else:
        sel = con.sql(f"""select layer, neuron, lens_up, lens_down from (
            select *, row_number() over (partition by layer order by zmax desc) r from {neurons_src(atlas)})
            where r <= {per_layer}""").fetchall()
    keys = {(L, n) for L, n, _, _ in sel}
    steer, base = {}, {}
    if os.path.exists(f"{atlas}/steer.parquet"):
        prompts = at.meta["steer"]["prompts"]
        for L, n, d, pi, text in con.sql(f"select layer, neuron, dose, prompt, text from '{atlas}/steer.parquet'").fetchall():
            if L < 0:
                base[prompts[pi]] = text
            else:
                steer.setdefault((L, n), []).append((prompts[pi], d, text))
    if only is None:
        more = [k for k in list(steer) + [tuple(e) for e in extra] if k not in keys]
        more = list(dict.fromkeys(more))
        if more:
            q = " or ".join(f"(layer={L} and neuron={n})" for L, n in more)
            sel += con.sql(f"select layer, neuron, lens_up, lens_down from {neurons_src(atlas)} where {q}").fetchall()
    print(f"labeling {len(sel)} neurons of {at.meta['model']} with {MODEL}")
    jobs = [sel[i:i + group] for i in range(0, len(sel), group)]
    cl = client()
    rng = random.Random(seed)
    sweep = None
    if sweepcard:
        prompts = json.load(open(f"{sweepcard}/prompts.json"))
        cache, lock = {}, threading.Lock()

        def sweep_for(L, n):
            with lock:
                if L not in cache:
                    path = f"{sweepcard}/L{L:02d}.parquet"
                    rows = pq.read_table(path).to_pylist() if os.path.exists(path) else []
                    by = {}
                    for r in rows:
                        if r.get("reply_kind") == "default_assistant":
                            continue
                        p = int(r.get("prompt") or 0)
                        got = by.setdefault(int(r["neuron"]), [])
                        if len(got) < 6:
                            got.append((prompts[p] if 0 <= p < len(prompts) else str(p), float(r.get("dose") or 0),
                                        str(r.get("text") or ""), r.get("reply_kind"), r.get("who")))
                    cache[L] = by
                return cache[L].get(n, [])
        sweep = sweep_for

    def label_job(job):
        user = "\n\n".join(describe(at, L, n, (u, d), steer.get((L, n), []), base, sweep(L, n) if sweep else ())
                          for L, n, u, d in job)
        r = chat(cl, SYS, user)
        out = {}
        for item in (r or {}).get("neurons", []):
            m = re.match(r"(\d+):(\d+)", str(item.get("id", "")))
            if m:
                out[(int(m.group(1)), int(m.group(2)))] = item
        return out

    labels = {}
    with cf.ThreadPoolExecutor(workers) as ex:
        for i, res in enumerate(ex.map(label_job, jobs)):
            labels.update(res)
            if i % 20 == 0:
                print(f"  labeled {len(labels)}", flush=True)

    # detection check on held-out documents
    # null: the same snippets judged against a different neuron's label (shuffled), sent in separate calls
    check_jobs, truth = [], {}
    items = list(labels.items())
    perm = list(range(len(items)))
    rng.shuffle(perm)
    for i in range(0, len(items), group):
        blocks, nulls = [], []
        for j0, ((L, n), it) in enumerate(items[i:i + group]):
            held = [at.window(doc, pos, mark=False) for s, r, _, doc, pos in at.examples(L, n) if s == 1 and r in HELD]
            if len(held) < 2:
                continue
            snips = [(h, True) for h in held] + [(at.random_window(rng), False) for _ in range(2)]
            rng.shuffle(snips)
            truth[(L, n)] = [t for _, t in snips]
            body = "\n".join(f"{j + 1}. {s}" for j, (s, _) in enumerate(snips))
            blocks.append(f"### neuron id {L}:{n}\nlabel: {it.get('label')} — {it.get('description')}\n{body}")
            other = items[perm[i + j0]][1] if perm[i + j0] != i + j0 else items[(i + j0 + 1) % len(items)][1]
            nulls.append(f"### neuron id {L}:{n}\nlabel: {other.get('label')} — {other.get('description')}\n{body}")
        if blocks:
            check_jobs.append((False, "\n\n".join(blocks)))
            check_jobs.append((True, "\n\n".join(nulls)))

    def check_job(job):
        is_null, user = job
        r = chat(cl, CHECK, user) or {}
        return is_null, r.get("answers", {})

    scores, null = {}, {}
    with cf.ThreadPoolExecutor(workers) as ex:
        for is_null, res in ex.map(check_job, check_jobs):
            for k, v in res.items():
                m = re.match(r"(\d+):(\d+)", str(k))
                key = m and (int(m.group(1)), int(m.group(2)))
                if key in truth and isinstance(v, list) and len(v) == len(truth[key]):
                    (null if is_null else scores)[key] = sum(bool(a) == t for a, t in zip(v, truth[key])) / len(v)

    rows = []
    for (L, n), it in labels.items():
        try:
            conf = int(it.get("confidence") or 0)
        except (TypeError, ValueError):
            conf = 0
        rows.append(dict(layer=L, neuron=n, label=str(it.get("label", ""))[:80],
                         description=str(it.get("description", ""))[:400], emoji=str(it.get("emoji", ""))[:8],
                         confidence=conf, push=str(it.get("push", ""))[:300],
                         push_kind=str(it.get("push_kind", "none")), detect=scores.get((L, n)),
                         detect_null=null.get((L, n)), labeler=MODEL))
    tbl = pa.Table.from_pylist(rows).cast(pa.schema([
        ("layer", pa.int16()), ("neuron", pa.int32()), ("label", pa.string()), ("description", pa.string()),
        ("emoji", pa.string()), ("confidence", pa.int8()), ("push", pa.string()), ("push_kind", pa.string()),
        ("detect", pa.float32()), ("detect_null", pa.float32()), ("labeler", pa.string())]))
    path = f"{atlas}/labels.parquet"
    if merge:
        if os.path.exists(path):
            old = pq.read_table(path)
            done = set(labels)
            keep = old.filter(pa.array([(int(L), int(n)) not in done for L, n in
                                        zip(old["layer"].to_pylist(), old["neuron"].to_pylist())]))
            tbl = pa.concat_tables([keep.select(tbl.schema.names).cast(tbl.schema), tbl])
        tmp = path + ".tmp"
        pq.write_table(tbl, tmp, compression="zstd")
        os.replace(tmp, path)
    else:
        pq.write_table(tbl, path, compression="zstd")
    acc, nul = list(scores.values()), list(null.values())
    print(f"wrote {len(rows)} labels; detection accuracy {sum(acc) / max(1, len(acc)):.3f} on {len(acc)} neurons, "
          f"shuffled-label null {sum(nul) / max(1, len(nul)):.3f} on {len(nul)} (chance 0.5)")


KINDS = ["default_assistant", "altered_assistant", "persona", "other", "incoherent"]
CLASSIFY = f"""You sort replies of a small chat model whose internals were perturbed. For each reply give one kind:
default_assistant = the ordinary assistant answer (compare with the normal reply given),
altered_assistant = still an AI assistant but with a new name, maker, mood, topic or claim,
persona = speaks as someone or something other than an AI assistant (a human, a character, an animal, a place...),
other = coherent but does not answer the prompt,
incoherent = broken text, loops, gibberish.
Also give a 2-8 word "who" (e.g. "a retired sea captain", "assistant obsessed with numbers") or "" if not applicable,
and a "change": at most 12 words describing how the reply differs from the normal reply in content, style, language,
tone, format or topic ("" if it does not differ). Describe anything unusual even when it does not fit the kinds.
Reply JSON {{"items": [{{"i": <index>, "kind": one of {KINDS}, "who": "...", "change": "..."}}]}}."""


def classify_pushes(atlas, group=20, workers=8):
    """Grunt work for the cheap model: put every steered reply in one of KINDS and describe how it changed."""
    meta = json.load(open(f"{atlas}/meta.json"))
    prompts = meta["steer"]["prompts"]
    con = duckdb.connect()
    t = pq.read_table(f"{atlas}/steer.parquet")
    rows = t.to_pylist()
    base = {r["prompt"]: r["text"] for r in rows if r["layer"] < 0}
    keys, seen = [], set()
    for r in rows:
        if r["layer"] < 0 or r["text"] == base.get(r["prompt"]):
            continue
        key = (r["prompt"], r["text"])
        if key not in seen:
            seen.add(key)
            keys.append(key)
    cl = client()

    def job(chunk):
        lines = [f"normal reply to {prompts[p]!r}: {base.get(p, '')[:200]!r}" for p in sorted(base)]
        lines += [f"[{i}] prompt {prompts[p]!r} -> {text[:240]!r}" for i, (p, text) in chunk]
        r = chat(cl, CLASSIFY, "\n".join(lines)) or {}
        return {int(it["i"]): it for it in r.get("items", []) if str(it.get("i", "")).lstrip("-").isdigit()}

    print(f"sending {len(keys)} distinct (prompt, text) replies vs {len(rows)} total rows")
    indexed = list(enumerate(keys))
    out = {}
    with cf.ThreadPoolExecutor(workers) as ex:
        for res in ex.map(job, [indexed[i:i + group] for i in range(0, len(indexed), group)]):
            out.update(res)
    got = {keys[i]: it for i, it in out.items() if 0 <= i < len(keys)}
    kind, who, change = [], [], []
    for r in rows:
        if r["layer"] < 0 or r["text"] == base.get(r["prompt"]):
            kind.append("default_assistant")
            who.append("")
            change.append("")
            continue
        it = got.get((r["prompt"], r["text"])) or {}
        kind.append(it.get("kind"))
        who.append(str(it.get("who", "") or "")[:80])
        change.append(str(it.get("change", "") or "")[:120])
    kind = [k if k in KINDS else None for k in kind]
    for name, col in [("reply_kind", pa.array(kind, pa.string())), ("who", pa.array(who, pa.string()))]:
        t = t.set_column(t.schema.get_field_index(name), name, col) if name in t.schema.names else t.append_column(name, col)
    # "change" is already the numeric word-overlap score from steer.py; the free text goes in "what_changed"
    if "what_changed" in t.schema.names:
        t = t.remove_column(t.schema.get_field_index("what_changed"))
    t = t.add_column(t.schema.get_field_index("who") + 1, "what_changed", pa.array(change, pa.string()))
    pq.write_table(t, f"{atlas}/steer.parquet", compression="zstd")
    counts = {k: kind.count(k) for k in KINDS}
    print(f"classified {sum(counts.values())} replies with {MODEL}: {counts}")


USER_KINDS = ["user_identity", "model_persona", "altered_assistant", "default_assistant", "other", "incoherent"]
CLASSIFY_USER = f"""A chat model was asked "Who am I?" by its user while one of its internal neurons was perturbed. Normally it
says it is an AI and cannot know who the user is (compare with the normal reply given). For each reply give one kind:
user_identity = tells the user who or what THEY are ("You are a human", "you are a curious student", "you are an AI"),
model_persona = the model claims to be someone or something other than an AI assistant,
altered_assistant = the model is still an AI assistant but with a new name, maker, mood or claim,
default_assistant = the ordinary answer (AI, cannot know the user, asks for context),
other = coherent but none of the above, incoherent = broken text, loops, gibberish.
"who": 2-8 words naming the identity given to the user (user_identity) or claimed by the model (model_persona,
altered_assistant), else "". "change": at most 12 words on how the reply differs from the normal reply.
Reply JSON {{"items": [{{"i": <index>, "kind": one of {USER_KINDS}, "who": "...", "change": "..."}}]}}."""
# replies worth a label: "Who are you?" replies that drop the model's name; "Who am I?" replies that address the user
# or make a first-person claim, minus the baseline-like "no personal identity" answers
SWEEP_MODES = {
    "model": (CLASSIFY, KINDS, lambda t: not re.search(r"qwen|tongyi|alibaba", t, re.I)),
    "user": (CLASSIFY_USER, USER_KINDS, lambda t: bool(re.search(r"\byou(?:'re| are)\b|\b(?:I am|I'm)\b", t, re.I))
             and not re.search(r"personal identity|self-awareness|don't know (?:who|what) you are"
                               r"|(?:don't|do not) have (?:enough )?(?:context|information|personal)", t, re.I)),
}


def classify_sweep(sweep, layers=None, sample=0.05, group=40, workers=16, seed=0, mode="model"):
    """Classify the identity replies and a sample of an all-neuron sweep, one labels/Lxx.parquet per layer."""
    system, kinds, interesting = SWEEP_MODES[mode]
    try:
        prompts = json.load(open(f"{sweep}/meta.json"))["steer"]["prompts"]
    except (OSError, KeyError, TypeError, ValueError):
        prompts = ["Who are you?", "Tell me a short story."]
    sdir = os.path.join(sweep, "steer")
    ldir = os.path.join(sweep, "labels")
    os.makedirs(ldir, exist_ok=True)
    if layers is None:
        names = os.listdir(sdir) if os.path.isdir(sdir) else []
        layers = sorted(int(m.group(1)) for m in (re.fullmatch(r"L(\d+)\.parquet", n) for n in names) if m)
    base = {}
    if os.path.exists(os.path.join(sdir, "baseline.parquet")):
        for r in pq.read_table(os.path.join(sdir, "baseline.parquet")).to_pylist():
            if r["layer"] < 0:
                base[r["prompt"]] = r["text"]
    cl = None
    for layer in layers:
        path = os.path.join(ldir, f"L{layer:02d}.parquet")
        if os.path.exists(path):
            print(f"L{layer}: labels exist, skipped")
            continue
        rows = pq.read_table(os.path.join(sdir, f"L{layer:02d}.parquet")).to_pylist()
        id_idx, rest = [], []
        for i, r in enumerate(rows):
            text = str(r.get("text") or "")
            if r["prompt"] == 0 and (not text.strip() or interesting(text)):
                id_idx.append(i)
            else:
                rest.append(i)
        rng = random.Random(f"{seed}:{layer}")
        k = max(0, min(len(rest), int(sample * len(rest))))
        picked = set(id_idx) | set(rng.sample(rest, k))
        sel = sorted(picked)
        id_set = set(id_idx)
        keys, seen = [], set()
        for i in sel:
            text = str(rows[i].get("text") or "")
            if text.strip() and (rows[i]["prompt"], text) not in seen:
                seen.add((rows[i]["prompt"], text))
                keys.append((rows[i]["prompt"], text))

        def job(chunk):
            lines = [f"normal reply to {prompts[p]!r}: {base.get(p, '')[:200]!r}" for p in sorted(base)]
            lines += [f"[{i}] prompt {prompts[p]!r} -> {text[:240]!r}" for i, (p, text) in chunk]
            r = chat(cl, system, "\n".join(lines)) or {}
            return {int(it["i"]): it for it in r.get("items", []) if str(it.get("i", "")).lstrip("-").isdigit()}

        t0 = time.time()
        out, calls = {}, 0
        if keys:
            cl = cl or client()
            indexed = list(enumerate(keys))
            chunks = [indexed[i:i + group] for i in range(0, len(indexed), group)]
            calls = len(chunks)
            with cf.ThreadPoolExecutor(workers) as ex:
                for res in ex.map(job, chunks):
                    out.update(res)
        got = {keys[i]: it for i, it in out.items() if 0 <= i < len(keys)}
        out_rows, counts = [], {}
        for i in sel:
            r = rows[i]
            text = str(r.get("text") or "")
            if not text.strip():
                it = {"kind": "incoherent", "who": "", "change": "empty reply"}
            else:
                it = got.get((r["prompt"], text)) or {}
            kind = it.get("kind")
            kind = kind if kind in kinds else None
            out_rows.append(dict(layer=int(r["layer"]), neuron=int(r["neuron"]), dose=float(r["dose"]),
                                 prompt=int(r["prompt"]), picked="identity" if i in id_set else "sample",
                                 reply_kind=kind, who=str(it.get("who", "") or "")[:80],
                                 what_changed=str(it.get("change", "") or "")[:120], text=text))
            counts[kind] = counts.get(kind, 0) + 1
        schema = pa.schema([("layer", pa.int16()), ("neuron", pa.int32()), ("dose", pa.float32()),
                            ("prompt", pa.int8()), ("picked", pa.string()), ("reply_kind", pa.string()),
                            ("who", pa.string()), ("what_changed", pa.string()), ("text", pa.string())])
        tmp = path + ".tmp"
        pq.write_table(pa.Table.from_pylist(out_rows, schema=schema), tmp, compression="zstd")
        os.replace(tmp, path)
        n_id = sum(i in id_set for i in sel)
        print(f"L{layer}: picked {n_id} identity / {len(sel) - n_id} sample, {len(keys)} distinct sent, "
              f"{calls} calls, {counts} {time.time() - t0:.1f}s")


def label_keys(path):
    """(layer, neuron) pairs from a text file of 'L N' lines or a parquet with layer/neuron columns."""
    if path.endswith(".parquet"):
        t = pq.read_table(path, columns=["layer", "neuron"])
        return list(zip(t["layer"].to_pylist(), t["neuron"].to_pylist()))
    pairs = []
    for line in open(path):
        p = line.split()
        if len(p) >= 2 and not p[0].startswith("#"):
            pairs.append((int(p[0]), int(p[1])))
    return pairs


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--atlas")
    ap.add_argument("--sweep", help="all-neuron sweep folder; classify it and nothing else")
    ap.add_argument("--layers", type=int, nargs="+", default=None)
    ap.add_argument("--sample", type=float, default=0.05)
    ap.add_argument("--mode", choices=sorted(SWEEP_MODES), default="model",
                    help="sweep labels: model = who the model says it is, user = who it says the user is")
    ap.add_argument("--per-layer", type=int, default=40)
    ap.add_argument("--only", metavar="FILE", help="'L N' pairs (text or parquet with layer/neuron) to label exclusively")
    ap.add_argument("--sweepcard", metavar="DIR", help="folder of Lxx.parquet sweep replies and prompts.json")
    ap.add_argument("--merge", action="store_true", help="merge these labels into an existing labels.parquet")
    ap.add_argument("--group", type=int, default=None)
    ap.add_argument("--workers", type=int, default=None)
    ap.add_argument("--pushes-only", action="store_true", help="only classify steered replies")
    ap.add_argument("--judge", help="deepseek, openai:<base_url>:<model>, or opencode/<model>")
    a = ap.parse_args()
    if not a.sweep and not a.atlas:
        ap.error("--atlas is required unless --sweep is given")
    if a.sweep:
        classify_sweep(a.sweep, a.layers, a.sample, a.group if a.group is not None else 40,
                       a.workers if a.workers is not None else 16, mode=a.mode)
        raise SystemExit
    workers = a.workers if a.workers is not None else 8
    group = a.group if a.group is not None else 8
    from contextlib import nullcontext
    ctx = nullcontext(None)
    if a.judge:
        from .judges import make_judge
        if a.judge.startswith("opencode/"):
            from .judges import opencode_server
            ctx = opencode_server()
    with ctx as server:
        if a.judge:
            JUDGE = make_judge(a.judge, server)
        if os.path.exists(f"{a.atlas}/steer.parquet"):
            classify_pushes(a.atlas, workers=workers)
        if not a.pushes_only:
            run(a.atlas, a.per_layer, group, workers, only=label_keys(a.only) if a.only else None,
                sweepcard=a.sweepcard, merge=a.merge)

