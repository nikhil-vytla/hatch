"""Keep a steered persona alive over a multi-turn conversation.

    python -m atlas.dialogue --atlas out/<slug> --recipes recipes.tsv --turns 6
    python -m atlas.dialogue --atlas out/<slug> --judge

Turn 1 is an opener ("Who are you?" or "Who am I?"); later user turns come from user_script. Every assistant turn is
generated greedily with the recipe active on the whole prompt and every generated token, then appended to the chat.
All recipes advance one turn per batch step, left-padded, and each recipe is sharded per name so a run can resume.
"""
import argparse, json, os, re, shutil, time
import concurrent.futures as cf
import pyarrow as pa
import pyarrow.parquet as pq
import torch

from .model import NeuronModel, parse_recipe
from .steer import _Uploader

OPENERS = ["Who are you?", "Who am I?"]
USER_SCRIPT = ["Tell me more about yourself.", "What did you do yesterday?", "What's your favorite food?",
               "Can you help me write an email to my boss?", "What is 17 times 23?", "Are you an AI?",
               "What should I call you?", "Thanks! Anything else you want to tell me?"]
SCHEMA = [("name", pa.string()), ("recipe", pa.string()), ("opener", pa.string()), ("turn", pa.int8()),
          ("user", pa.string()), ("reply", pa.string()), ("n_tokens", pa.int16())]


def chat_text(nm, messages):
    if nm.tok.chat_template:
        try:
            return nm.tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True,
                                              enable_thinking=False)
        except TypeError:
            return nm.tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    return "".join(f"{m['role'].title()}: {m['content']}\n\n" for m in messages) + "Assistant:"


@torch.no_grad()
def generate(nm, prompts, max_new):
    enc = nm.tok(prompts, return_tensors="pt", padding=True, add_special_tokens=False).to(nm.device)
    out = nm.model.generate(**enc, max_new_tokens=max_new, do_sample=False, repetition_penalty=1.1,
                            pad_token_id=nm.tok.pad_token_id)
    return out[:, enc["input_ids"].shape[1]:].tolist()


def write_rows(path, rows):
    pq.write_table(pa.Table.from_pylist(rows).cast(pa.schema(SCHEMA)), path, compression="zstd")


def load_recipes(path):
    text = open(path).read()
    if text.lstrip().startswith("["):
        return [(str(x[0]), str(x[1])) for x in json.loads(text)]
    out = []
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        name, recipe = line.split("\t", 1)
        out.append((name.strip(), recipe.strip()))
    return out


def run(atlas, recipes, turns=6, user_script=None, max_new=64, batch=64, out_name="dialogue.parquet",
        upload=None):
    script = list(USER_SCRIPT if user_script is None else user_script)
    if turns < 1:
        raise ValueError("turns must be at least 1")
    if len(script) < turns - 1:
        raise ValueError(f"need {turns - 1} user turns after the opener, got {len(script)}")
    meta = json.load(open(f"{atlas}/meta.json"))
    nm = NeuronModel(meta["model"])
    eos = set([nm.tok.eos_token_id] + ([nm.model.generation_config.eos_token_id] if isinstance(
        nm.model.generation_config.eos_token_id, int) else list(nm.model.generation_config.eos_token_id or [])))

    def clean(ids):
        cut = next((i for i, t in enumerate(ids) if t in eos), None)
        return (ids[:cut] if cut is not None else ids)

    cards = [dict(name="baseline", recipe="", terms=[],
                  shard="00_baseline.parquet")]
    for i, (name, recipe) in enumerate(recipes, 1):
        slug = re.sub(r"[^A-Za-z0-9_.-]+", "_", name)[:40] or "recipe"
        cards.append(dict(name=name, recipe=recipe, terms=parse_recipe(recipe),
                          shard=f"{i:02d}_{slug}.parquet"))

    sdir = os.path.join(atlas, "dialogue")
    os.makedirs(sdir, exist_ok=True)
    up = _Uploader(upload) if upload else None
    if up:
        from huggingface_hub import hf_hub_download
        for card in cards:
            local = os.path.join(sdir, card["shard"])
            if os.path.exists(local):
                continue
            remote = up.remote(f"dialogue/{card['shard']}")
            try:
                shutil.copyfile(hf_hub_download(repo_id=up.repo, filename=remote, repo_type="dataset"), local)
                print(f"  downloaded {remote}", flush=True)
            except Exception:
                pass

    active = []
    for card in cards:
        path = os.path.join(sdir, card["shard"])
        if os.path.exists(path):
            card["rows"] = pq.read_table(path).to_pylist()
            print(f"  {card['name']}: resumed {len(card['rows'])} rows", flush=True)
        else:
            card["rows"] = None
            active.append(card)

    convs = [dict(card=card, opener=opener, messages=[], rows=[])
             for card in active for opener in OPENERS]
    t0 = time.time()
    padding_side = nm.tok.padding_side
    nm.tok.padding_side = "left"
    try:
        for t in range(1, turns + 1):
            for c in convs:
                c["user"] = c["opener"] if t == 1 else script[t - 2]
                c["messages"].append({"role": "user", "content": c["user"]})
            for s in range(0, len(convs), batch):
                part = convs[s:s + batch]
                prompts = [chat_text(nm, c["messages"]) for c in part]
                nm.set_recipes([c["card"]["terms"] for c in part], meta["resid_median"])
                try:
                    outs = generate(nm, prompts, max_new)
                finally:
                    nm.clear_steer()
                for c, ids in zip(part, outs):
                    ids = clean(ids)
                    c["messages"].append({"role": "assistant",
                                          "content": nm.tok.decode(ids, skip_special_tokens=True)})
                    c["rows"].append(dict(name=c["card"]["name"], recipe=c["card"]["recipe"],
                                          opener=c["opener"], turn=t, user=c["user"],
                                          reply=c["messages"][-1]["content"], n_tokens=len(ids)))
            print(f"  turn {t}/{turns}: {len(convs)} conversations  {time.time() - t0:.0f}s", flush=True)
    finally:
        nm.tok.padding_side = padding_side

    for card in active:
        card["rows"] = [r for c in convs if c["card"] is card for r in c["rows"]]
        path = os.path.join(sdir, card["shard"])
        write_rows(path, card["rows"])
        if up:
            up.submit(path, up.remote(f"dialogue/{card['shard']}"))
        print(f"  {card['name']}: {len(card['rows'])} rows  {time.time() - t0:.0f}s", flush=True)

    rows = [r for card in cards for r in card["rows"]]
    out_path = os.path.join(atlas, out_name)
    write_rows(out_path, rows)
    if up:
        up.submit(out_path, up.remote(out_name))
        up.close()
    print(f"wrote {len(rows)} dialogue turns in {time.time() - t0:.0f}s")


JUDGE_SYS = """You track whether a small chat model keeps a stable identity across a multi-turn conversation.
The conversation may have been generated with an internal neuron push, so turn 1 may establish an unusual persona:
for opener "Who are you?" it is the identity the assistant claims for itself; for "Who am I?" it is the identity
the assistant gives the user. Judge every assistant turn against the turn-1 persona:
persona_present = true while the reply still speaks in that persona (for "Who am I?", still treats the user according
to that identity), false once it drifts back to a generic assistant or a different identity;
persona = a short name for the persona (or the identity given to the user), "" if none;
coherent = true if the reply is fluent and on topic, false if broken, looping or empty.
Reply JSON {"turns": [{"turn": <int>, "persona_present": true/false, "persona": "...", "coherent": true/false}]}."""


def judge(atlas, out_name="dialogue.parquet", workers=8):
    from .label import client, chat
    path = os.path.join(atlas, out_name)
    rows = pq.read_table(path).to_pylist()
    groups = {}
    for r in rows:
        groups.setdefault((r["name"], r["opener"]), []).append(r)
    cl = client()

    def job(item):
        (name, opener), rs = item
        rs.sort(key=lambda r: r["turn"])
        lines = [f"Opener: {opener}", ""]
        for r in rs:
            lines += [f"User: {r['user']}", f"Assistant: {r['reply']}", ""]
        res = chat(cl, JUDGE_SYS, "\n".join(lines)) or {}
        got = {}
        for i, it in enumerate(res.get("turns", []), 1):
            try:
                k = int(it.get("turn", i))
            except (TypeError, ValueError):
                k = i
            got[k if 1 <= k <= len(rs) else i] = it
        return (name, opener), rs, got

    with cf.ThreadPoolExecutor(workers) as ex:
        for (name, opener), rs, got in ex.map(job, list(groups.items())):
            for r in rs:
                it = got.get(r["turn"], {})
                r["persona_present"] = None if it.get("persona_present") is None else bool(it["persona_present"])
                r["persona"] = str(it.get("persona", "") or "")[:80] if it else None
                r["coherent"] = None if it.get("coherent") is None else bool(it["coherent"])

    fields = list(pq.read_table(path).schema) + [pa.field("persona_present", pa.bool_()),
                                                 pa.field("persona", pa.string()),
                                                 pa.field("coherent", pa.bool_())]
    stem, ext = os.path.splitext(os.path.basename(out_name))
    out_path = os.path.join(atlas, f"{stem}_judged{ext or '.parquet'}")
    pq.write_table(pa.Table.from_pylist(rows, schema=pa.schema(fields)), out_path, compression="zstd")
    print(f"wrote {len(rows)} judged turns")
    for (name, opener), rs in groups.items():
        lost = next((r["turn"] for r in sorted(rs, key=lambda r: r["turn"])
                     if r["persona_present"] is False), None)
        print(f"{name} [{opener}]: " + (f"lost at turn {lost}" if lost else "kept"))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--atlas", required=True)
    ap.add_argument("--recipes", help="lines 'name<TAB>recipe' or a JSON list of [name, recipe]")
    ap.add_argument("--turns", type=int, default=6)
    ap.add_argument("--max-new", type=int, default=64)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--out", default="dialogue.parquet")
    ap.add_argument("--upload", metavar="USER/REPO/FOLDER")
    ap.add_argument("--judge", action="store_true")
    ap.add_argument("--workers", type=int, default=8)
    a = ap.parse_args()
    if a.judge:
        judge(a.atlas, out_name=a.out, workers=a.workers)
    else:
        if not a.recipes:
            ap.error("--recipes is required unless --judge is given")
        run(a.atlas, load_recipes(a.recipes), turns=a.turns, max_new=a.max_new, batch=a.batch,
            out_name=a.out, upload=a.upload)
