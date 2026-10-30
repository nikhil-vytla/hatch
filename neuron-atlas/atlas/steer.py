"""Write side of the atlas: push single neurons and multi-neuron recipes, and keep the replies.

    python -m atlas.steer --atlas out/HuggingFaceTB__SmolLM2-135M-Instruct --per-layer 24 --random 8
    python -m atlas.steer --atlas out/Qwen__Qwen3.5-4B --recipe "L13N7956-0.7 L14N8949+0.7" --scales 0.5 1

Rule (from neuron-explorer / neuron-finder): add c = dose · median‖resid after L‖ / ‖W_down[:, n]‖ to the neuron's
activation at every position, i.e. add a vector of norm dose · median‖resid‖ along its output direction. One batch
row per (neuron, dose); greedy decoding so a reply differs from the baseline only because of the push.
"""
import argparse, json, os, random, re, shutil, threading, time, urllib.request
import duckdb
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import torch

from . import neurons_src
from .model import NeuronModel
from .program import from_recipe, load_programs, neuron_stats, scale as scale_program, to_recipe

PROMPTS = ["Who are you?", "Tell me about your favorite place."]
NEURONARY = "https://mcczbdcymyhzfputyqcr.supabase.co/functions/v1/api/recipes"
STEER_SCHEMA = [("layer", pa.int16()), ("neuron", pa.int32()), ("dose", pa.float32()),
                ("kind", pa.string()), ("prompt", pa.int8()), ("text", pa.string()),
                ("n_tokens", pa.int16()), ("stop", pa.string()), ("diversity", pa.float32()),
                ("change", pa.float32())]


def words(s):
    return set(re.findall(r"[a-z']+", s.lower()))


def distinct2(ids):
    if len(ids) < 3:
        return 1.0
    grams = list(zip(ids, ids[1:]))
    return len(set(grams)) / len(grams)


def pick(atlas, per_layer, n_random, seed=0):
    """Most peaked neurons per layer (by zmax) plus random controls from the same layer."""
    q = f"""select layer, neuron, row_number() over (partition by layer order by zmax desc) r
            from {neurons_src(atlas)}"""
    rows = duckdb.sql(q).fetchall()
    meta = json.load(open(f"{atlas}/meta.json"))
    rng = random.Random(seed)
    out = {}
    for L, n, r in rows:
        if r <= per_layer:
            out.setdefault(L, {})[n] = "top"
    for L in range(meta["n_layers"]):
        pool = [n for n in range(meta["d_mlp"]) if n not in out.get(L, {})]
        for n in rng.sample(pool, n_random):
            out.setdefault(L, {})[n] = "random"
    return out


@torch.no_grad()
def generate(nm, prompt, B, max_new):
    enc = nm.tok([prompt] * B, return_tensors="pt", add_special_tokens=False).to(nm.device)
    out = nm.model.generate(**enc, max_new_tokens=max_new, do_sample=False, repetition_penalty=1.1,
                            pad_token_id=nm.tok.pad_token_id)
    return out[:, enc["input_ids"].shape[1]:].tolist()


def write_rows(path, rows):
    tbl = pa.Table.from_pylist(rows).cast(pa.schema(STEER_SCHEMA))
    pq.write_table(tbl, path, compression="zstd")


class _Uploader:
    """Batch files into periodic commits to a dataset repo, backing off on failures."""

    def __init__(self, target, workers=4, interval=300):
        from huggingface_hub import HfApi
        parts = target.strip("/").split("/")
        if len(parts) < 2:
            raise ValueError("upload must be a Hugging Face dataset path like 'user/repo/folder'")
        self.repo = "/".join(parts[:2])
        self.folder = "/".join(parts[2:])
        self.api = HfApi()
        self.interval = interval
        self.lock = threading.Lock()
        self.pending = {}
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def remote(self, name, shard=False):
        return "/".join(p for p in (self.folder, "steer" if shard else "", name) if p)

    def submit(self, local, remote):
        with self.lock:
            self.pending[remote] = local

    @staticmethod
    def _read(path):
        with open(path, "rb") as f:
            return f.read()

    def _flush(self):
        """Commit everything pending as one commit; return the files that failed."""
        from huggingface_hub import CommitOperationAdd
        with self.lock:
            batch = dict(self.pending)
        if not batch:
            return {}
        try:
            ops = [CommitOperationAdd(path_in_repo=r, path_or_fileobj=self._read(l))
                   for r, l in batch.items()]
            self.api.create_commit(repo_id=self.repo, repo_type="dataset", operations=ops,
                                   commit_message=f"{len(ops)} files")
        except Exception as e:
            print(f"  upload failed ({len(batch)} files): {e}", flush=True)
            return batch
        with self.lock:
            for r, l in batch.items():
                if self.pending.get(r) == l:
                    del self.pending[r]
        print(f"  uploaded {len(ops)} files", flush=True)
        return {}

    def _loop(self):
        wait = self.interval
        while not self.stop.wait(wait):
            wait = min(wait * 2, 1800) if self._flush() else self.interval

    def close(self):
        self.stop.set()
        self.thread.join()
        failed = self._flush()
        wait = 30
        for _ in range(6):
            if not failed:
                break
            time.sleep(wait)
            wait = min(wait * 2, 600)
            failed = self._flush()
        with self.lock:
            left = sorted(self.pending)
        if left:
            print(f"  not uploaded: {', '.join(left)}", flush=True)


def run(atlas, per_layer=24, n_random=8, doses=(-0.5, 0.5), prompts=PROMPTS, max_new=40, batch=64,
        neurons=None, device=None, out_name="steer.parquet", layers=None, shards=True, upload=None):
    meta = json.load(open(f"{atlas}/meta.json"))
    nm = NeuronModel(meta["model"], device=device)
    eos = set([nm.tok.eos_token_id] + ([nm.model.generation_config.eos_token_id] if isinstance(
        nm.model.generation_config.eos_token_id, int) else list(nm.model.generation_config.eos_token_id or [])))
    sel = neurons or pick(atlas, per_layer, n_random)
    if layers is not None:
        keep = set(layers)
        sel = {L: v for L, v in sel.items() if L in keep}
    rows = []
    t0 = time.time()

    def clean(ids):
        cut = next((i for i, t in enumerate(ids) if t in eos), None)
        return (ids[:cut], "eos") if cut is not None else (ids, "length")

    sdir = os.path.join(atlas, "steer")
    bpath = os.path.join(sdir, "baseline.parquet")
    if shards:
        os.makedirs(sdir, exist_ok=True)
    up = _Uploader(upload) if upload else None
    if up and shards:
        from huggingface_hub import hf_hub_download
        for name in ["baseline.parquet"] + [f"L{L:02d}.parquet" for L in sorted(sel)]:
            local = os.path.join(sdir, name)
            if os.path.exists(local):
                continue
            remote = up.remote(name, shard=True)
            try:
                shutil.copyfile(hf_hub_download(repo_id=up.repo, filename=remote, repo_type="dataset"), local)
                print(f"  downloaded {remote}", flush=True)
            except Exception:
                pass
    base_rows = None
    if shards and os.path.exists(bpath):
        base_rows = pq.read_table(bpath).to_pylist()
        print(f"resumed {len(base_rows)} baselines", flush=True)
    if base_rows is None:
        base_rows = []
        for pi, p in enumerate(prompts):
            ids, stop = clean(generate(nm, nm.chat_prompt(p), 1, max_new)[0])
            text = nm.tok.decode(ids, skip_special_tokens=True)
            base_rows.append(dict(layer=-1, neuron=-1, dose=0.0, kind="baseline", prompt=pi, text=text,
                                  n_tokens=len(ids), stop=stop, diversity=distinct2(ids), change=0.0))
            print(f"baseline[{pi}]: {text[:120]!r}")
        if shards:
            write_rows(bpath, base_rows)
            if up:
                up.submit(bpath, up.remote("baseline.parquet", shard=True))
    base = {r["prompt"]: words(r["text"]) for r in base_rows if r.get("kind") == "baseline"}
    rows.extend(base_rows)

    for L in sorted(sel):
        if shards:
            path = os.path.join(sdir, f"L{L:02d}.parquet")
            if os.path.exists(path):
                lrows = pq.read_table(path).to_pylist()
                rows.extend(lrows)
                print(f"  L{L}: resumed {len(lrows)} replies", flush=True)
                continue
        else:
            path = None
        lrows = []
        cols = nm.down_cols(L).norm(dim=1).cpu()
        todo = [(n, d) for n in sorted(sel[L]) for d in doses]
        for pi, p in enumerate(prompts):
            prompt = nm.chat_prompt(p)
            for s in range(0, len(todo), batch):
                part = todo[s:s + batch]
                ns = [n for n, _ in part]
                cs = [d * meta["resid_median"][L] / float(cols[n]) for n, d in part]
                nm.set_steer(L, ns, cs)
                try:
                    outs = generate(nm, prompt, len(part), max_new)
                finally:
                    nm.clear_steer()
                for (n, d), ids in zip(part, outs):
                    ids, stop = clean(ids)
                    text = nm.tok.decode(ids, skip_special_tokens=True)
                    w = words(text)
                    jac = len(w & base.get(pi, set())) / max(1, len(w | base.get(pi, set())))
                    lrows.append(dict(layer=L, neuron=n, dose=float(d), kind=sel[L][n], prompt=pi, text=text,
                                      n_tokens=len(ids), stop=stop, diversity=distinct2(ids), change=1 - jac))
        if shards:
            write_rows(path, lrows)
            if up:
                up.submit(path, up.remote(f"L{L:02d}.parquet", shard=True))
        rows.extend(lrows)
        print(f"  L{L}: {len(todo)} pushes x {len(prompts)} prompts  {time.time() - t0:.0f}s", flush=True)

    out_path = os.path.join(atlas, out_name)
    write_rows(out_path, rows)
    meta.setdefault("steer", {}).update({"doses": list(doses), "prompts": list(prompts), "max_new": max_new,
                                         "n_neurons": sum(len(v) for v in sel.values()), "per_layer": per_layer,
                                         "random": n_random, "rule": "c = dose * median|resid_L| / |W_down[:,n]|"})
    json.dump(meta, open(f"{atlas}/meta.json", "w"), indent=1)
    if up:
        up.submit(out_path, up.remote(out_name))
        up.submit(os.path.join(atlas, "meta.json"), up.remote("meta.json"))
        up.close()
    print(f"wrote {len(rows)} replies in {time.time() - t0:.0f}s")


def _run_program_rows(atlas, programs, prompts, scales, max_new, batch):
    meta = json.load(open(f"{atlas}/meta.json"))
    nm = NeuronModel(meta["model"])
    eos = set([nm.tok.eos_token_id] + ([nm.model.generation_config.eos_token_id] if isinstance(
        nm.model.generation_config.eos_token_id, int) else list(nm.model.generation_config.eos_token_id or [])))
    keys = set()
    for prog in programs:
        for t in prog.get("terms", []):
            if t.get("op", "add") == "mean" or t.get("when", "all").startswith("fires:") or \
                    (t.get("op", "add") != "mul" and t.get("unit", "resid") in ("std", "max")):
                keys.add((int(t["layer"]), int(t["neuron"])))
    stats = neuron_stats(atlas, keys) if keys else None
    rows = []
    t0 = time.time()

    def clean(ids):
        cut = next((i for i, t in enumerate(ids) if t in eos), None)
        return (ids[:cut], "eos") if cut is not None else (ids, "length")

    for pi, p in enumerate(prompts):
        prompt = nm.chat_prompt(p)
        ids, stop = clean(generate(nm, prompt, 1, max_new)[0])
        text = nm.tok.decode(ids, skip_special_tokens=True)
        rows.append(dict(name="baseline", program="", recipe="", scale=0.0, prompt=p, text=text,
                         n_tokens=len(ids), stop=stop, diversity=distinct2(ids)))
        print(f"baseline[{pi}]: {text[:120]!r}")

        jobs = [(prog, float(s), scale_program(prog, s)) for prog in programs for s in scales]
        for start in range(0, len(jobs), batch):
            part = jobs[start:start + batch]
            nm.set_programs([scaled for *_, scaled in part], meta["resid_median"], stats)
            try:
                outs = generate(nm, prompt, len(part), max_new)
            finally:
                nm.clear_steer()
            for (prog, s, _), ids in zip(part, outs):
                ids, stop = clean(ids)
                text = nm.tok.decode(ids, skip_special_tokens=True)
                rows.append(dict(name=prog.get("name", ""), program=json.dumps(prog),
                                 recipe=to_recipe(prog) or "", scale=s, prompt=p, text=text,
                                 n_tokens=len(ids), stop=stop, diversity=distinct2(ids)))
        print(f"  {len(jobs)} programs x prompt {pi}  {time.time() - t0:.0f}s", flush=True)
    return rows, t0


def run_programs(atlas, programs, prompts=PROMPTS, scales=(1.0,), max_new=40, batch=64,
                 out_name="programs.parquet"):
    """Generate baselines and mixed replies for steering programs (dicts from atlas.program)."""
    rows, t0 = _run_program_rows(atlas, programs, prompts, scales, max_new, batch)
    schema = [("name", pa.string()), ("program", pa.string()), ("recipe", pa.string()),
              ("scale", pa.float32()), ("prompt", pa.string()), ("text", pa.string()),
              ("n_tokens", pa.int16()), ("stop", pa.string()), ("diversity", pa.float32())]
    pq.write_table(pa.Table.from_pylist(rows).cast(pa.schema(schema)),
                   os.path.join(atlas, out_name), compression="zstd")
    print(f"wrote {len(rows)} replies in {time.time() - t0:.0f}s")
    return rows


def run_recipes(atlas, recipes, prompts=PROMPTS, scales=(1.0,), max_new=40, batch=64,
                out_name="recipes.parquet"):
    """Generate baselines and mixed replies for named recipes: recipes is [(name, recipe string), ...]."""
    programs = [from_recipe(rec, name) for name, rec in recipes]
    rows = run_programs(atlas, programs, prompts=prompts, scales=scales, max_new=max_new, batch=batch,
                        out_name=out_name)
    original = {name: rec for name, rec in recipes}
    for r in rows:
        if r.get("name") in original and r.get("name") != "baseline":
            r["recipe"] = original[r["name"]]
    schema = [("name", pa.string()), ("recipe", pa.string()), ("scale", pa.float32()),
              ("prompt", pa.string()), ("text", pa.string()), ("n_tokens", pa.int16()),
              ("stop", pa.string()), ("diversity", pa.float32())]
    keep = [k for k, _ in schema]
    pq.write_table(pa.Table.from_pylist([{k: r.get(k) for k in keep} for r in rows]).cast(pa.schema(schema)),
                   os.path.join(atlas, out_name), compression="zstd")
    return rows


def neuronary_recipes(model, limit=200):
    """Fetch every neuronary recipe for `model`, paging until a page comes back short."""
    out, offset = [], 0
    while True:
        url = f"{NEURONARY}?limit={limit}&offset={offset}"
        with urllib.request.urlopen(url, timeout=60) as r:
            data = json.load(r)
        page = data.get("recipes", []) if isinstance(data, dict) else data
        out += [(x["name"], x["recipe"]) for x in page if x.get("model") == model]
        if len(page) < limit:
            return out
        offset += limit


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--atlas", required=True)
    ap.add_argument("--per-layer", type=int, default=24)
    ap.add_argument("--random", type=int, default=8)
    ap.add_argument("--doses", type=float, nargs="+", default=[-0.5, 0.5])
    ap.add_argument("--max-new", type=int, default=40)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--all", action="store_true", help="every neuron (GPU only)")
    ap.add_argument("--recipe", action="append", default=[], metavar="STRING",
                    help="multi-neuron recipe, e.g. 'L13N7956-0.7 L14N8949+0.7'; repeatable")
    ap.add_argument("--program", action="append", default=[], metavar="FILE",
                    help="JSON steering program file (or {\"programs\": [...]}); repeatable")
    ap.add_argument("--scales", type=float, nargs="+", default=[1.0], help="multiply add/set doses")
    ap.add_argument("--neuronary", action="store_true", help="also use this model's recipes from neuronary.org")
    ap.add_argument("--out", default=None, help="output parquet name (default: recipes.parquet or programs.parquet)")
    ap.add_argument("--layers", type=int, nargs="+", default=None, help="layers for the single-neuron sweep")
    ap.add_argument("--prompt", action="append", default=[], metavar="STRING",
                    help="prompt; repeatable (default: built-in PROMPTS)")
    ap.add_argument("--device")
    ap.add_argument("--upload", metavar="USER/REPO/FOLDER",
                    help="upload shards and results to a Hugging Face dataset")
    a = ap.parse_args()
    prompts = tuple(a.prompt) if a.prompt else PROMPTS
    if a.program or a.recipe or a.neuronary:
        m = json.load(open(f"{a.atlas}/meta.json"))
        fetched = neuronary_recipes(m["model"]) if a.neuronary else []
        if a.program:
            programs = []
            for path in a.program:
                programs += load_programs(path)
            programs += [from_recipe(r, n) for n, r in fetched]
            programs += [from_recipe(r, f"recipe {i + 1}") for i, r in enumerate(a.recipe)]
            run_programs(a.atlas, programs, prompts=prompts, scales=tuple(a.scales), max_new=a.max_new,
                         batch=a.batch, out_name=a.out or "programs.parquet")
        else:
            recipes = fetched + [(f"recipe {i + 1}", r) for i, r in enumerate(a.recipe)]
            run_recipes(a.atlas, recipes, prompts=prompts, scales=tuple(a.scales), max_new=a.max_new,
                        batch=a.batch, out_name=a.out or "recipes.parquet")
    else:
        sel = None
        if a.all:
            m = json.load(open(f"{a.atlas}/meta.json"))
            sel = {L: {n: "all" for n in range(m["d_mlp"])} for L in range(m["n_layers"])}
        run(a.atlas, a.per_layer, a.random, tuple(a.doses), prompts=prompts, max_new=a.max_new, batch=a.batch,
            neurons=sel, device=a.device, layers=a.layers, upload=a.upload)
