# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "marimo",
#     "torch",
#     "transformers>=4.51",
#     "accelerate",
#     "datasets",
#     "duckdb",
#     "pyarrow",
#     "umap-learn",
#     "scikit-learn",
#     "huggingface_hub",
#     "openai",
#     "neuron-atlas @ git+https://github.com/nikhil-vytla/hatch@main#subdirectory=neuron-atlas",
# ]
# ///
"""Neuron Atlas on molab: build an atlas for a bigger open model on molab's free RTX Pro 6000 and publish it to the Hub.

Open: https://molab.marimo.io/github/nikhil-vytla/hatch/blob/main/neuron-atlas/molab_atlas.py
then attach a GPU from the notebook specs button in the header.
"""

import marimo

__generated_with = "0.25.2"
app = marimo.App(width="medium")


@app.cell
def _():
    import json, os, time
    import marimo as mo
    import torch
    return json, mo, os, time, torch


@app.cell
def _(mo, torch):
    gpu = torch.cuda.get_device_name(0) if torch.cuda.is_available() else None
    mem = torch.cuda.get_device_properties(0).total_memory / 2**30 if gpu else 0
    mo.md(f"""
    # Neuron Atlas · molab

    Records every MLP neuron of a model: what it fires on (top corpus documents with per-token activations),
    what it writes (logit lens), and what pushing it does (steered replies), then labels the clearest ones with an
    LLM and checks each label on held-out documents. Results go to a Hugging Face dataset that the
    [explorer](https://github.com/nikhil-vytla/hatch/tree/main/neuron-atlas) reads straight from the Hub.

    **GPU:** {f"`{gpu}` · {mem:.0f} GB" if gpu else "none attached. Open the notebook specs button in the header and toggle the GPU (RTX Pro 6000, 96 GB, free during the molab preview)."}
    """)
    return (gpu,)


@app.cell
def _(mo):
    model = mo.ui.dropdown(
        options=["Qwen/Qwen3-8B", "Qwen/Qwen3-4B", "Qwen/Qwen3-1.7B", "allenai/OLMo-2-1124-7B-Instruct",
                 "HuggingFaceTB/SmolLM3-3B", "mistralai/Mistral-7B-Instruct-v0.3", "microsoft/Phi-4-mini-instruct",
                 "meta-llama/Llama-3.1-8B-Instruct", "google/gemma-3-4b-it", "HuggingFaceTB/SmolLM2-135M-Instruct"],
        value="Qwen/Qwen3-4B", label="model (Llama and Gemma need a token with access)", allow_select_none=False)
    custom = mo.ui.text(label="or any HF id", placeholder="org/name")
    n_web = mo.ui.number(500, 50000, value=6000, label="web documents")
    n_chat = mo.ui.number(0, 50000, value=4000, label="chat documents")
    max_len = mo.ui.number(32, 1024, value=256, label="tokens per document")
    batch = mo.ui.number(1, 512, value=32, label="batch")
    steer_mode = mo.ui.radio(["top per layer", "every neuron"], value="top per layer", label="pushes")
    per_layer = mo.ui.number(0, 4096, value=64, label="top neurons per layer to push / label")
    repo = mo.ui.text(label="HF dataset repo", placeholder="you/neuron-atlas")
    token = mo.ui.text(label="HF token (write)", kind="password")
    label_key = mo.ui.text(label="labeler API key (OpenAI-compatible; blank = skip labels)", kind="password")
    label_base = mo.ui.text(value="https://api.deepseek.com", label="labeler base URL")
    label_model = mo.ui.text(value="deepseek-chat", label="labeler model")
    go = mo.ui.run_button(label="Build atlas")
    mo.vstack([
        mo.hstack([model, custom]), mo.hstack([n_web, n_chat, max_len, batch]),
        mo.hstack([steer_mode, per_layer]), mo.hstack([repo, token]),
        mo.hstack([label_key, label_base, label_model]), go])
    return (batch, custom, go, label_base, label_key, label_model, max_len, model, n_chat, n_web, per_layer, repo,
            steer_mode, token)


@app.cell
def _(batch, custom, go, json, label_base, label_key, label_model, max_len, mo, model, n_chat, n_web, os,
      per_layer, repo, steer_mode, time, token):
    mo.stop(not go.value, mo.md("Set the options and press **Build atlas**."))
    if token.value:
        os.environ["HF_TOKEN"] = token.value
    if label_key.value:
        os.environ.update(LABEL_API_KEY=label_key.value, LABEL_BASE_URL=label_base.value, LABEL_MODEL=label_model.value)
    from atlas import corpus, collect, steer, export
    name = custom.value.strip() or model.value
    out = "/tmp/atlas-out"
    os.makedirs(out, exist_ok=True)
    log = []
    t0 = time.time()
    cpath = f"{out}/corpus.jsonl"
    with mo.status.spinner(title="corpus") as sp:
        rows = corpus.build(int(n_web.value), int(n_chat.value))
        with open(cpath, "w") as f:
            f.writelines(json.dumps(r) + "\n" for r in rows)
        sp.update(title=f"collect {name}")
        atlas_dir = collect.run(name, cpath, out, max_len=int(max_len.value), bs=int(batch.value))
        log.append(f"collect: {time.time() - t0:.0f}s")
        sp.update(title="steer")
        meta = json.load(open(f"{atlas_dir}/meta.json"))
        sel = ({L: {n: "all" for n in range(meta["d_mlp"])} for L in range(meta["n_layers"])}
               if steer_mode.value == "every neuron" else None)
        steer.run(atlas_dir, per_layer=int(per_layer.value), n_random=16, neurons=sel, batch=256)
        log.append(f"steer: {time.time() - t0:.0f}s")
        if label_key.value:
            sp.update(title="label")
            from atlas import label
            label.MODEL, label.BASE_URL, label.KEY = label_model.value, label_base.value, label_key.value
            label.run(atlas_dir, per_layer=int(per_layer.value), workers=16)
            log.append(f"label: {time.time() - t0:.0f}s")
        if repo.value:
            sp.update(title="push to hub")
            export.push_hub(out, repo.value)
            log.append(f"published https://huggingface.co/datasets/{repo.value}")
    mo.md("**Done.**\n\n" + "\n".join(f"- {l}" for l in log))
    return (atlas_dir,)


@app.cell
def _(atlas_dir, mo):
    import duckdb
    con = duckdb.connect()
    top = con.sql(f"""select layer, neuron, round(zmax, 1) z, peaks[1:5] fires_on, lens_up[1:6] promotes
                      from '{atlas_dir}/neurons.parquet' order by zmax desc limit 300""").df()
    table = mo.ui.table(top, selection="single", label="Most peaked neurons: pick one")
    table
    return con, table


@app.cell
def _(atlas_dir, con, json, mo, table):
    import html
    mo.stop(table.value is None or len(table.value) == 0, mo.md("Pick a row to see where it fires."))
    L, n = int(table.value.iloc[0]["layer"]), int(table.value.iloc[0]["neuron"])
    before = json.load(open(f"{atlas_dir}/meta.json"))["before"]
    ex = con.sql(f"""select e.sign, e.act, e.pos, e.q, e.scale, t.toks
                     from '{atlas_dir}/examples/L{L:02d}.parquet' e join '{atlas_dir}/tokens.parquet' t using (doc)
                     where neuron = {n} order by sign desc, rank""").fetchall()
    def row(sign, act, pos, q, scale, toks):
        start = pos - before
        cells = []
        for i, v in enumerate(q):
            p = start + i
            if 0 <= p < len(toks):
                a = abs(v) / 127
                col = "214,51,108" if (v > 0) == (sign > 0) else "75,63,168"
                box = "outline:1px solid #000;" if p == pos else ""
                cells.append(f"<span style='background:rgba({col},{a:.2f});{box}'>{html.escape(toks[p])}</span>")
        return f"<div style='font-family:monospace;white-space:pre-wrap;margin:4px 0'><small>{act:.2f}</small> {''.join(cells)}</div>"
    mo.Html(f"<h3>L{L} · N{n}</h3>" + "".join(row(*r) for r in ex))
    return


if __name__ == "__main__":
    app.run()
