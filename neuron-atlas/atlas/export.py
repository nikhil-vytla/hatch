"""Assemble a static site (explorer + data) and publish atlas data to the Hugging Face Hub.

    python -m atlas.export site  --out out --site site            # site/index.html + site/data/<slug>/... + models.json
    python -m atlas.export hub   --out out --repo you/neuron-atlas  # dataset repo: parquet + models.json + card
    python -m atlas.export space --repo you/neuron-atlas --space you/neuron-atlas-explorer   # static Space reading the dataset

The explorer reads models.json and the per-model parquet files over plain HTTP, so the same files work from a local
folder, a static Space, or straight from the dataset repo (https://huggingface.co/datasets/<repo>/resolve/main/).
"""
import argparse, glob, json, os, re, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
EXPLORER = os.path.join(HERE, "..", "explorer", "index.html")
FILES = ["meta.json", "neurons.parquet", "labels.parquet", "steer.parquet", "tokens.parquet"]


def model_id(name):
    return re.sub(r"[^a-z0-9]+", "-", name.split("/")[-1].lower()).strip("-")


def models_index(out):
    idx = []
    for meta_path in sorted(glob.glob(os.path.join(out, "*", "meta.json"))):
        m = json.load(open(meta_path))
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

    def put(src, dst):
        if b64 and dst.endswith(".parquet"):
            import base64
            open(dst + ".b64.txt", "w").write(base64.b64encode(open(src, "rb").read()).decode())
        else:
            shutil.copy(src, dst)

    for m in idx:
        src, dst = os.path.join(out, m["slug"]), os.path.join(site, "data", m["slug"])
        os.makedirs(os.path.join(dst, "examples"), exist_ok=True)
        for f in m["files"]:
            put(os.path.join(src, f), os.path.join(dst, f))
        for f in glob.glob(os.path.join(src, "examples", "*.parquet")):
            put(f, os.path.join(dst, "examples", os.path.basename(f)))
        m["b64"] = b64
    json.dump(idx, open(os.path.join(site, "data", "models.json"), "w"), indent=1)
    open(os.path.join(site, "index.html"), "w").write(page())
    print(f"site with {len(idx)} models in {site}  (python -m http.server -d {site})")


def card(idx, repo):
    rows = "\n".join(f"| [{m['model']}](https://huggingface.co/{m['model']}) | {m['n_layers']} | {m['d_mlp']} | "
                     f"{m['n_neurons']:,} | {m['n_tokens']:,} | {'yes' if 'steer.parquet' in m['files'] else 'no'} | "
                     f"{'yes' if 'labels.parquet' in m['files'] else 'no'} |" for m in idx)
    configs = "\n".join(
        f"- config_name: {m['id']}-{t}\n  data_files: \"{m['slug']}/{t if t != 'examples' else 'examples/*'}{'' if t == 'examples' else '.parquet'}\""
        for m in idx for t in ["neurons", "labels", "steer", "examples"]
        if t == "examples" or f"{t}.parquet" in m["files"])
    return f"""---
license: apache-2.0
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

- `neurons.parquet`: one row per neuron. `layer, neuron, mean, std, max, min, frac_pos, zmax, zmin, w_norm, x, y`
  (2D UMAP of the down-projection column), `lens_up` / `lens_down` (logit lens top/bottom tokens), `peaks` (token at
  each top document's peak).
- `examples/Lxx.parquet`: top documents per neuron (`sign` 1 = most positive, -1 = most negative), peak `act`, `doc`,
  `pos`, and the activation window `q` (int8, x `scale`/127) for tokens `pos-before .. pos+after` (see `meta.json`).
- `tokens.parquet`: the corpus as token strings per `doc`.
- `steer.parquet`: greedy replies with one neuron pushed by `dose` x median residual norm (`layer = -1` rows are the
  unsteered baselines), plus `change` (1 - word Jaccard to baseline) and `diversity` (distinct bigram ratio).
- `labels.parquet`: `label, description, emoji, confidence, push, push_kind`, and `detect` / `detect_null` (held-out
  detection accuracy with the neuron's own label / a shuffled label; chance 0.5).

## Explore in the browser

Open the explorer with `?data={repo}`; it reads these files directly from
`https://huggingface.co/datasets/{repo}/resolve/main/`. DuckDB also works:

```sql
select * from 'hf://datasets/{repo}/{idx[0]['slug'] if idx else '<slug>'}/neurons.parquet' order by zmax desc limit 10;
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
                          path_in_repo=m["slug"], commit_message=f"atlas for {m['model']}")
    print(f"https://huggingface.co/datasets/{repo}")


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
    ap.add_argument("what", choices=["site", "hub", "space"])
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
    else:
        push_space(a.repo, a.space)
