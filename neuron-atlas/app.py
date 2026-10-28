"""Live companion to the static explorer: run your own text, see which neurons fire, push one and chat.

    python app.py --atlas out/HuggingFaceTB__SmolLM2-135M-Instruct            # local atlas folder
    python app.py --repo you/neuron-atlas --slug HuggingFaceTB__SmolLM2-135M-Instruct   # from the Hub

On a Hugging Face Space set ATLAS_REPO and ATLAS_SLUG instead of flags. A 135M model runs on the free CPU tier.
"""
import argparse, json, os
import duckdb
import gradio as gr
import torch

from atlas import neurons_src
from atlas.model import NeuronModel


def fetch_atlas(atlas=None, repo=None, slug=None):
    if atlas:
        return atlas
    from huggingface_hub import snapshot_download
    root = snapshot_download(repo, repo_type="dataset", allow_patterns=[f"{slug}/*.json", f"{slug}/labels.parquet",
                                                                                      f"{slug}/neurons/*.parquet"])
    return os.path.join(root, slug)


class Live:
    def __init__(self, atlas):
        self.atlas = atlas
        self.meta = json.load(open(f"{atlas}/meta.json"))
        self.nm = NeuronModel(self.meta["model"])
        con = duckdb.connect()
        st = con.sql(f"select layer, neuron, mean, std, lens_up from {neurons_src(atlas)} order by layer, neuron").fetchall()
        L, d = self.meta["n_layers"], self.meta["d_mlp"]
        self.mean = torch.tensor([r[2] for r in st]).view(L, d)
        self.std = torch.tensor([r[3] for r in st]).view(L, d).clamp(min=1e-4)
        self.lens = {(r[0], r[1]): r[4] for r in st}
        self.labels = {}
        if os.path.exists(f"{atlas}/labels.parquet"):
            for l, n, lab, emo in con.sql(f"select layer, neuron, label, emoji from '{atlas}/labels.parquet'").fetchall():
                self.labels[(l, n)] = f"{emo} {lab}"

    def name(self, L, n):
        return self.labels.get((L, n)) or "promotes " + " ".join(repr(t) for t in self.lens[(L, n)][:3])

    @torch.no_grad()
    def acts(self, text):
        nm = self.nm
        ids = nm.tok(text, return_tensors="pt").to(nm.device)
        cap = {}
        hooks = [d.register_forward_pre_hook(lambda m, a, L=L: cap.__setitem__(L, a[0][0].float().cpu()))
                 for L, d in enumerate(nm.downs)]
        try:
            nm.model(**ids)
        finally:
            for h in hooks:
                h.remove()
        A = torch.stack([cap[L] for L in range(nm.n_layers)])           # (L, T, d)
        Z = (A - self.mean[:, None]) / self.std[:, None]
        return nm.token_strings(ids["input_ids"][0].tolist()), A, Z

    def fires(self, text, k=25):
        toks, A, Z = self.acts(text)
        Z[:, :2] = 0                                                      # attention-sink positions
        zmax, pos = Z.max(1)                                              # (L, d)
        top = zmax.flatten().topk(k)
        rows = []
        for v, i in zip(top.values.tolist(), top.indices.tolist()):
            L, n = divmod(i, self.meta["d_mlp"])
            rows.append([f"{L}:{n}", self.name(L, n), round(v, 1), toks[pos[L, n]]])
        return rows, toks, A

    def highlight(self, toks, A, key):
        L, n = map(int, key.split(":"))
        a = A[L, :, n]
        m = float(a.abs().max()) or 1.0
        return [(t, float(x) / m) for t, x in zip(toks, a.tolist())]

    @torch.no_grad()
    def chat(self, prompt, key, dose, max_new=80):
        nm = self.nm
        L, n = map(int, key.split(":"))
        c = dose * self.meta["resid_median"][L] / float(nm.down_cols(L)[n].norm())
        enc = nm.tok([nm.chat_prompt(prompt)] * 2, return_tensors="pt", add_special_tokens=False).to(nm.device)
        nm.set_steer(L, [n, n], [0.0, c])
        try:
            out = nm.model.generate(**enc, max_new_tokens=max_new, do_sample=False, repetition_penalty=1.1,
                                    pad_token_id=nm.tok.pad_token_id)
        finally:
            nm.clear_steer()
        cut = enc["input_ids"].shape[1]
        return [nm.tok.decode(o[cut:], skip_special_tokens=True) for o in out]


def build(live: Live):
    m = live.meta
    with gr.Blocks(title="Neuron Atlas live") as demo:
        gr.Markdown(f"## Neuron Atlas · live\n`{m['model']}`: {m['n_layers']} layers × {m['d_mlp']} neurons. "
                    "Scores are z = (activation − mean) / std from the atlas corpus.")
        state = gr.State()
        with gr.Tab("What fires?"):
            txt = gr.Textbox("The Eiffel Tower is in Paris, and it was finished in 1889.", label="Your text", lines=3)
            go = gr.Button("Run", variant="primary")
            table = gr.Dataframe(headers=["neuron", "label", "peak z", "peak token"], interactive=False)
            pick = gr.Textbox(label="Highlight neuron (layer:neuron, or click a row)")
            hl = gr.HighlightedText(label="Activation per token", combine_adjacent=False, show_legend=False,
                                    color_map=None)

            def run(text):
                rows, toks, A = live.fires(text)
                return rows, (toks, A), rows[0][0], live.highlight(toks, A, rows[0][0])

            def on_row(s, evt: gr.SelectData):
                k = evt.row_value[0]
                return k, live.highlight(*s, k)

            go.click(run, txt, [table, state, pick, hl])
            table.select(on_row, [state], [pick, hl])
            pick.submit(lambda s, k: live.highlight(*s, k), [state, pick], hl)
        with gr.Tab("Push a neuron"):
            with gr.Row():
                key = gr.Textbox("10:100", label="layer:neuron")
                dose = gr.Slider(-3, 3, value=1.0, step=0.1, label="dose (× median residual norm)")
            prompt = gr.Textbox("Who are you?", label="Prompt")
            push = gr.Button("Generate", variant="primary")
            with gr.Row():
                normal = gr.Textbox(label="normal", lines=6)
                steered = gr.Textbox(label="pushed", lines=6)
            push.click(lambda p, k, d: live.chat(p, k, d), [prompt, key, dose], [normal, steered])
    return demo


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--atlas", default=os.environ.get("ATLAS_DIR"))
    ap.add_argument("--repo", default=os.environ.get("ATLAS_REPO"))
    ap.add_argument("--slug", default=os.environ.get("ATLAS_SLUG", "HuggingFaceTB__SmolLM2-135M-Instruct"))
    ap.add_argument("--port", type=int, default=7860)
    a = ap.parse_args()
    build(Live(fetch_atlas(a.atlas, a.repo, a.slug))).launch(server_name="0.0.0.0", server_port=a.port)
