"""Assemble a static site (explorer + data) and publish atlas data to the Hugging Face Hub.

    python -m atlas.export site  --out out --site site            # site/index.html + site/data/<slug>/... + models.json
    python -m atlas.export hub   --out out --repo you/neuron-atlas  # dataset repo: parquet + models.json + card
    python -m atlas.export hub-index --repo you/neuron-atlas   # rebuild models.json + card from every model folder on the Hub
    python -m atlas.export space --repo you/neuron-atlas --space you/neuron-atlas-explorer   # static Space reading the dataset

The explorer reads models.json and the per-model parquet files over plain HTTP, so the same files work from a local
folder, a static Space, or straight from the dataset repo (https://huggingface.co/datasets/<repo>/resolve/main/).
"""
import argparse, glob, json, os, re, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
EXPLORER = os.path.join(HERE, "..", "explorer", "index.html")
FILES = ["meta.json", "map.parquet", "labels.parquet", "steer.parquet", "tokens.parquet", "uptake.parquet", "recipes.parquet"]  # + neurons/, examples/


def shard(d):
    """Derive what the explorer loads from a model folder's neurons.parquet: map.parquet (one slim row per neuron:
    layer, neuron, x, y, zmax) and neurons/Lxx.parquet (full rows, one file per layer, fetched on demand). Also add
    each example's token window in place so a neuron card needs no tokens.parquet."""
    src = os.path.join(d, "neurons.parquet")
    if os.path.exists(src):
        import duckdb
        os.makedirs(os.path.join(d, "neurons"), exist_ok=True)
        con = duckdb.connect()
        con.sql(f"""copy (select layer, neuron, x, y, zmax from '{src}' order by layer, neuron)
                    to '{d}/map.parquet' (format parquet, compression zstd)""")
        for (L,) in con.sql(f"select distinct layer from '{src}' order by 1").fetchall():
            con.sql(f"""copy (select * from '{src}' where layer = {L} order by neuron)
                        to '{d}/neurons/L{L:02d}.parquet' (format parquet, compression zstd)""")
    add_example_tokens(d)


def add_example_tokens(d):
    """Add toks (an example window's token strings) and t0 (where that window starts in the document) to every
    examples/Lxx.parquet that lacks them, so the explorer can draw a card without downloading tokens.parquet."""
    exdir = os.path.join(d, "examples")
    tok_path = os.path.join(d, "tokens.parquet")
    meta_path = os.path.join(d, "meta.json")
    if not os.path.isdir(exdir) or not os.path.exists(tok_path) or not os.path.exists(meta_path):
        return
    import pyarrow as pa, pyarrow.parquet as pq
    todo = [f for f in sorted(glob.glob(os.path.join(exdir, "*.parquet"))) if "toks" not in pq.read_schema(f).names]
    if not todo:
        return
    meta = json.load(open(meta_path))
    before, after = int(meta["before"]), int(meta["after"])
    t = pq.read_table(tok_path, columns=["doc", "toks"])
    corpus = dict(zip(t.column("doc").to_pylist(), t.column("toks").to_pylist()))
    for f in todo:  # one layer at a time, so memory stays bounded on big models
        tab = pq.read_table(f)
        t0s, wins = [], []
        for doc, pos in zip(tab.column("doc").to_pylist(), tab.column("pos").to_pylist()):
            toks = corpus[doc]
            start = max(0, pos - before)
            t0s.append(start)
            wins.append(toks[start:min(len(toks), pos + after + 1)])
        tab = tab.append_column("t0", pa.array(t0s, type=pa.int32()))
        tab = tab.append_column("toks", pa.array(wins, type=pa.list_(pa.string())))
        tmp = f + ".tmp"
        pq.write_table(tab, tmp, compression="zstd", row_group_size=8192)
        os.replace(tmp, f)


def model_id(name):
    return re.sub(r"[^a-z0-9]+", "-", name.split("/")[-1].lower()).strip("-")


def models_index(out):
    idx = []
    for meta_path in sorted(glob.glob(os.path.join(out, "*", "meta.json"))):
        shard(os.path.dirname(meta_path))
        m = json.load(open(meta_path))
        m["sharded"] = True
        m["id"] = model_id(m["model"])
        m["name"] = m["model"].split("/")[-1]
        m["files"] = [f for f in FILES if os.path.exists(os.path.join(os.path.dirname(meta_path), f))]
        idx.append(m)
    idx.sort(key=lambda m: m["n_neurons"])
    return idx


def page(fragment_path=EXPLORER):
    """The explorer source is a body fragment (the Artifact host adds the skeleton); wrap it for plain hosting."""
    body = open(fragment_path).read()
    return ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
            '<style>[hidden]{display:none!important}</style>\n</head>\n<body>\n' + body + '\n</body>\n</html>\n')


def build_site(out, site, b64=False):
    """b64: write each parquet file as <name>.b64.txt (base64) for hosts that only serve text types, such as
    claude.ai Artifacts. The explorer reads models.json's "b64" flag and decodes."""
    os.makedirs(os.path.join(site, "data"), exist_ok=True)
    idx = models_index(out)

    PART = 12_000_000  # Artifact hosting caps text files at 16 MB; bigger files go as numbered parts

    def put(src, dst, m):
        if b64 and dst.endswith(".parquet"):
            import base64
            enc = base64.b64encode(open(src, "rb").read()).decode()
            if len(enc) <= PART:
                open(dst + ".b64.txt", "w").write(enc)
            else:
                parts = [enc[i:i + PART] for i in range(0, len(enc), PART)]
                for j, p in enumerate(parts):
                    open(f"{dst}.b64.{j}.txt", "w").write(p)
                m.setdefault("b64_parts", {})[os.path.relpath(dst, os.path.join(site, "data", m["slug"]))] = len(parts)
        else:
            shutil.copy(src, dst)

    for m in idx:
        src, dst = os.path.join(out, m["slug"]), os.path.join(site, "data", m["slug"])
        os.makedirs(os.path.join(dst, "examples"), exist_ok=True)
        for f in m["files"]:
            put(os.path.join(src, f), os.path.join(dst, f), m)
        for sub in ["examples", "neurons"]:
            os.makedirs(os.path.join(dst, sub), exist_ok=True)
            for f in glob.glob(os.path.join(src, sub, "*.parquet")):
                put(f, os.path.join(dst, sub, os.path.basename(f)), m)
        m["b64"] = b64
    json.dump(idx, open(os.path.join(site, "data", "models.json"), "w"), indent=1)
    open(os.path.join(site, "index.html"), "w").write(page())
    print(f"site with {len(idx)} models in {site}  (python -m http.server -d {site})")


def card(idx, repo):
    rows = "\n".join(f"| [{m['model']}](https://huggingface.co/{m['model']}) | {m['n_layers']} | {m['d_mlp']} | "
                     f"{m['n_neurons']:,} | {m['n_tokens']:,} | {'yes' if 'steer.parquet' in m['files'] else 'no'} | "
                     f"{'yes' if 'labels.parquet' in m['files'] else 'no'} |" for m in idx)
    configs = "\n".join(
        f"- config_name: {m['id']}-{t}\n  data_files: \"{m['slug']}/{t + '/*' if t in ('examples', 'neurons') else t}.parquet\""
        for m in idx for t in ["neurons", "labels", "steer", "examples"]
        if t in ("examples", "neurons") or f"{t}.parquet" in m["files"])
    return f"""---
license: odc-by
tags: [interpretability, neurons, mechanistic-interpretability]
configs:
{configs}
---
# Neuron Atlas

Every MLP neuron of {len(idx)} open models: activation stats, top corpus documents with per-token activations, the
logit lens of each neuron's output direction, steered replies for a subset of neurons, and LLM labels with a held-out
detection check. Built with `neuron-atlas` (https://github.com/nikhil-vytla/hatch/tree/main/neuron-atlas).

| model | layers | neurons/layer | neurons | corpus tokens | pushes | labels |
|---|---|---|---|---|---|---|
{rows}

## Files per model (`<org>__<name>/`)

- `neurons/Lxx.parquet`: one row per neuron, one file per layer. `layer, neuron, mean, std, max, min, frac_pos, zmax, zmin, w_norm, x, y`
  (2D UMAP of the down-projection column), `lens_up` / `lens_down` (logit lens top/bottom tokens), `peaks` (token at
  each top document's peak).
- `examples/Lxx.parquet`: top documents per neuron (`sign` 1 = most positive, -1 = most negative), peak `act`, `doc`,
  `pos`, and the activation window `q` (int8, x `scale`/127) for tokens `pos-before .. pos+after` (see `meta.json`).
- `map.parquet`: `layer, neuron, x, y, zmax` for every neuron (what the explorer loads first).
- `tokens.parquet`: the corpus as token strings per `doc`.
- `steer.parquet`: greedy replies with one neuron pushed by `dose` x median residual norm (`layer = -1` rows are the
  unsteered baselines), plus `change` (1 - word Jaccard to baseline) and `diversity` (distinct bigram ratio).
- `labels.parquet`: `label, description, emoji, confidence, push, push_kind`, and `detect` / `detect_null` (held-out
  detection accuracy with the neuron's own label / a shuffled label; chance 0.5).

## Sources and license

Corpus text comes from [FineWeb-Edu](https://huggingface.co/datasets/HuggingFaceFW/fineweb-edu) (ODC-By) and
[smol-smoltalk](https://huggingface.co/datasets/HuggingFaceTB/smol-smoltalk) (Apache-2.0); this dataset is released
under ODC-By. Labels and push categories were written by DeepSeek (`deepseek-chat` endpoint) and are hypotheses.

## Explore in the browser

Open the explorer with `?data={repo}`; it reads these files directly from
`https://huggingface.co/datasets/{repo}/resolve/main/`. DuckDB also works:

```sql
select * from 'hf://datasets/{repo}/{idx[0]['slug'] if idx else '<slug>'}/neurons/*.parquet' order by zmax desc limit 10;
```
"""


def push_hub(out, repo, private=False):
    from huggingface_hub import HfApi
    api = HfApi()
    api.create_repo(repo, repo_type="dataset", exist_ok=True, private=private)
    idx = models_index(out)
    tmp = os.path.join(out, "_hub")
    os.makedirs(tmp, exist_ok=True)
    json.dump(idx, open(os.path.join(tmp, "models.json"), "w"), indent=1)
    open(os.path.join(tmp, "README.md"), "w").write(card(idx, repo))
    api.upload_folder(repo_id=repo, repo_type="dataset", folder_path=tmp, commit_message="index + card")
    for m in idx:
        api.upload_folder(repo_id=repo, repo_type="dataset", folder_path=os.path.join(out, m["slug"]),
                          path_in_repo=m["slug"], commit_message=f"atlas for {m['model']}",
                          ignore_patterns=["neurons.parquet", "calib*"], delete_patterns=["neurons.parquet"])
    print(f"https://huggingface.co/datasets/{repo}")


def push_index(repo):
    """Rebuild models.json and the card from what is on the Hub, so model folders uploaded from different machines
    (CPU runs here, GPU runs on molab) all appear in the explorer."""
    from huggingface_hub import HfApi, hf_hub_download
    api = HfApi()
    files = api.list_repo_files(repo, repo_type="dataset")
    idx = []
    for f in sorted(x for x in files if x.count("/") == 1 and x.endswith("/meta.json")):
        slug = f.split("/")[0]
        m = json.load(open(hf_hub_download(repo, f, repo_type="dataset")))
        have = {x.split("/", 1)[1] for x in files if x.startswith(slug + "/")}
        m.update(id=model_id(m["model"]), name=m["model"].split("/")[-1], files=[x for x in FILES if x in have],
                 sharded=any(x.startswith("neurons/") for x in have))
        idx.append(m)
    idx.sort(key=lambda m: m["n_neurons"])
    api.upload_file(path_or_fileobj=json.dumps(idx, indent=1).encode(), path_in_repo="models.json", repo_id=repo,
                    repo_type="dataset", commit_message="rebuild models.json")
    api.upload_file(path_or_fileobj=card(idx, repo).encode(), path_in_repo="README.md", repo_id=repo,
                    repo_type="dataset", commit_message="rebuild card")
    print(f"models.json: {[m['name'] for m in idx]}")


def push_space(repo, space):
    """A static Space whose page reads the dataset over HTTP (no data copied into the Space)."""
    from huggingface_hub import HfApi
    api = HfApi()
    api.create_repo(space, repo_type="space", space_sdk="static", exist_ok=True)
    html = page().replace('b = b || "./data/";', f'b = b || "https://huggingface.co/datasets/{repo}/resolve/main/";')
    readme = f"---\ntitle: Neuron Atlas\nemoji: 🔬\ncolorFrom: pink\ncolorTo: indigo\nsdk: static\npinned: false\n---\nExplorer for the [{repo}](https://huggingface.co/datasets/{repo}) dataset.\n"
    api.upload_file(path_or_fileobj=html.encode(), path_in_repo="index.html", repo_id=space, repo_type="space")
    api.upload_file(path_or_fileobj=readme.encode(), path_in_repo="README.md", repo_id=space, repo_type="space")
    print(f"https://huggingface.co/spaces/{space}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["site", "hub", "hub-index", "space"])
    ap.add_argument("--out", default="out")
    ap.add_argument("--site", default="site")
    ap.add_argument("--repo")
    ap.add_argument("--space")
    ap.add_argument("--private", action="store_true")
    ap.add_argument("--b64", action="store_true", help="site: base64 parquet as .b64.txt (Artifact hosting)")
    a = ap.parse_args()
    if a.what == "site":
        build_site(a.out, a.site, a.b64)
    elif a.what == "hub":
        push_hub(a.out, a.repo, a.private)
    elif a.what == "hub-index":
        push_index(a.repo)
    else:
        push_space(a.repo, a.space)
