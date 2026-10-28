"""Name neurons with an LLM (any OpenAI-compatible API; defaults to DeepSeek) and check the names.

    python -m atlas.label --atlas out/<slug> --per-layer 40

1. Label: the labeler sees a neuron's top documents 0-5 (peak token in «»), its most negative documents (gated MLPs),
   its logit lens, and its steered replies next to the unsteered ones. It returns a short label, a sentence, an emoji,
   a confidence, and what the push does.
2. Check (detection): a second call sees only the label and 4 snippets, the neuron's held-out documents 6-7 and two
   random corpus windows, and says which snippets the neuron fires on. Chance is 50% per snippet; the null runs the
   same snippets against another neuron's label.
"""
import argparse, json, os, random, re, concurrent.futures as cf
import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
from openai import OpenAI

BASE_URL = os.environ.get("LABEL_BASE_URL", "https://api.deepseek.com")
MODEL = os.environ.get("LABEL_MODEL", "deepseek-chat")
KEY = os.environ.get("LABEL_API_KEY") or os.environ.get("DEEPSEEK_API_KEY") or "proxy-injected"
SHOWN, HELD = range(0, 6), (6, 7)

SYS = """You are an interpretability researcher naming neurons of a language model.
For each neuron you get: documents where it fires most (the peak token is wrapped in «», the number is the activation),
sometimes documents where it is most negative, its logit lens (tokens its output direction promotes / suppresses),
and sometimes replies of the model to a prompt with the neuron pushed down (-) or up (+) next to the normal reply.
Reply with JSON {"neurons": [{"id": ..., "label": "2-6 words", "description": "one sentence on what it reads and writes",
"emoji": "one emoji", "confidence": 1-5, "push": "what pushing it does, or 'nothing clear'",
"push_kind": "persona|altered_assistant|topic|style|language|token|incoherent|none"}]}.
Prefer specific labels ("past participles after 'has'", "French cooking words") over vague ones ("various words").
confidence 1 = no visible pattern, 5 = every example fits."""

CHECK = """A neuron of a language model was labeled. For each numbered snippet, decide whether this neuron's peak
activation is likely in it (true) or not (false). Exactly the snippets that match the label should be true.
Reply JSON {"answers": {"<neuron id>": [true/false per snippet, in order], ...}}."""


def client():
    return OpenAI(base_url=BASE_URL, api_key=KEY)


def chat(cl, system, user, tries=3):
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


def describe(at: Atlas, L, n, lens, steer, base):
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
    return "\n".join(lines)


def run(atlas, per_layer=40, group=8, workers=8, seed=0):
    at = Atlas(atlas)
    con = at.con
    sel = con.sql(f"""select layer, neuron, lens_up, lens_down from (
        select *, row_number() over (partition by layer order by zmax desc) r from '{atlas}/neurons.parquet')
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
        extra = [k for k in steer if k not in keys]
        if extra:
            q = " or ".join(f"(layer={L} and neuron={n})" for L, n in extra)
            sel += con.sql(f"select layer, neuron, lens_up, lens_down from '{atlas}/neurons.parquet' where {q}").fetchall()
    print(f"labeling {len(sel)} neurons of {at.meta['model']} with {MODEL}")
    jobs = [sel[i:i + group] for i in range(0, len(sel), group)]
    cl = client()
    rng = random.Random(seed)

    def label_job(job):
        user = "\n\n".join(describe(at, L, n, (u, d), steer.get((L, n), []), base) for L, n, u, d in job)
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
    pq.write_table(tbl, f"{atlas}/labels.parquet", compression="zstd")
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
Also give a 2-8 word "who" (e.g. "a retired sea captain", "assistant obsessed with numbers") or "" if not applicable.
Reply JSON {{"items": [{{"i": <index>, "kind": one of {KINDS}, "who": "..."}}]}}."""


def classify_pushes(atlas, group=20, workers=8):
    """Grunt work for the cheap model: put every steered reply in one of KINDS (like qwen-neurons-site's library)."""
    meta = json.load(open(f"{atlas}/meta.json"))
    prompts = meta["steer"]["prompts"]
    con = duckdb.connect()
    t = con.sql(f"select * from '{atlas}/steer.parquet'").arrow()
    rows = t.to_pylist()
    base = {r["prompt"]: r["text"] for r in rows if r["layer"] < 0}
    todo = [i for i, r in enumerate(rows) if r["layer"] >= 0]
    cl = client()

    def job(chunk):
        lines = [f"normal reply to {prompts[p]!r}: {base.get(p, '')[:200]!r}" for p in sorted(base)]
        lines += [f"[{i}] prompt {prompts[rows[i]['prompt']]!r} -> {rows[i]['text'][:240]!r}" for i in chunk]
        r = chat(cl, CLASSIFY, "\n".join(lines)) or {}
        return {int(it["i"]): it for it in r.get("items", []) if str(it.get("i", "")).lstrip("-").isdigit()}

    out = {}
    with cf.ThreadPoolExecutor(workers) as ex:
        for res in ex.map(job, [todo[i:i + group] for i in range(0, len(todo), group)]):
            out.update(res)
    kind = [("default_assistant" if r["layer"] < 0 else out.get(i, {}).get("kind")) for i, r in enumerate(rows)]
    kind = [k if k in KINDS else None for k in kind]
    who = [str(out.get(i, {}).get("who", "") or "")[:80] for i in range(len(rows))]
    for name, col in [("reply_kind", pa.array(kind, pa.string())), ("who", pa.array(who, pa.string()))]:
        t = t.set_column(t.schema.get_field_index(name), name, col) if name in t.schema.names else t.append_column(name, col)
    pq.write_table(t, f"{atlas}/steer.parquet", compression="zstd")
    counts = {k: kind.count(k) for k in KINDS}
    print(f"classified {sum(counts.values())} replies with {MODEL}: {counts}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--atlas", required=True)
    ap.add_argument("--per-layer", type=int, default=40)
    ap.add_argument("--group", type=int, default=8)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--pushes-only", action="store_true", help="only classify steered replies")
    a = ap.parse_args()
    if os.path.exists(f"{a.atlas}/steer.parquet"):
        classify_pushes(a.atlas, workers=a.workers)
    if not a.pushes_only:
        run(a.atlas, a.per_layer, a.group, a.workers)

