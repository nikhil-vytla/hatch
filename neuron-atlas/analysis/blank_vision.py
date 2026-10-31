"""Self-describing vision neurons: push one vision-tower neuron while the model looks at a blank gray image, ask it
what it sees, and compare the answer with what that neuron actually responds to.

For each picked neuron we store
  - the pushed answers on the blank image ("Describe this image in a few words."), at each dose;
  - the neuron's mean activation (input of the vision MLP down projection, averaged over image patches) on every
    synthetic and photo stimulus of `atlas.multimodal stimuli`, so a judge can later ask whether the blank-image
    answer names what the neuron's top stimulus shows (vs a random stimulus).

  python analysis/blank_vision.py --model Qwen/Qwen2.5-VL-3B-Instruct --per-layer 12 --out bv --upload nikhilxvytla/neuron-atlas/Qwen__Qwen2.5-VL-3B-Instruct/blank
"""
import argparse, json, os, random

import pyarrow as pa, pyarrow.parquet as pq
import torch
from PIL import Image

from atlas import multimodal as mm, stimuli as st
from atlas.model import NeuronModel
from atlas.steer import _Uploader

QUESTION = "Describe this image in a few words."
BLANKS = {"gray": (128, 128, 128), "black": (0, 0, 0), "white": (255, 255, 255)}


@torch.no_grad()
def activations(nm, sdir, items, picks):
    """{(L, n): [mean activation per item]} for the picked neurons."""
    want = {}
    for L, n in picks:
        want.setdefault(L, []).append(n)
    cur = {}

    def hook(L):
        idx = torch.tensor(want[L])

        def f(mod, args):
            x = args[0].detach().float()
            x = x.reshape(-1, x.shape[-1])
            cur[L] = x[:, idx.to(x.device)].mean(0).cpu()
        return f

    hs = [nm.downs[L].register_forward_pre_hook(hook(L)) for L in want]
    out = {p: [] for p in picks}
    try:
        nm.clear_steer()
        for it in items:
            cur.clear()
            nm.model(**mm._prepare_inputs(nm, sdir, it, it["question"]), use_cache=False)
            for L, ns in want.items():
                for j, n in enumerate(ns):
                    out[(L, n)].append(float(cur[L][j]) if L in cur else float("nan"))
    finally:
        for h in hs:
            h.remove()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Qwen/Qwen2.5-VL-3B-Instruct")
    ap.add_argument("--per-layer", type=int, default=12)
    ap.add_argument("--doses", type=float, nargs="+", default=[-1.0, 1.0, 2.0])
    ap.add_argument("--max-new", type=int, default=24)
    ap.add_argument("--out", default="bv")
    ap.add_argument("--upload")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    sdir = os.path.join(a.out, "stimuli")
    if not os.path.exists(os.path.join(sdir, "stimuli.json")):
        st.build(sdir)
    items = [x for x in mm._load_stimuli(sdir, include_videos=False)]
    bdir = os.path.join(a.out, "blank")
    os.makedirs(bdir, exist_ok=True)
    blanks = []
    for name, rgb in BLANKS.items():
        Image.new("RGB", (336, 336), rgb).save(os.path.join(bdir, f"{name}.png"))
        blanks.append(dict(id=name, file=f"{name}.png", question=QUESTION, kind="blank", expected=""))
    json.dump(blanks, open(os.path.join(bdir, "stimuli.json"), "w"))

    nm = NeuronModel(a.model, where="vision")
    resid = mm._estimate_vision_resid(nm, sdir, items, max_items=16)  # real images, not the blank one
    rng = random.Random(0)
    picks = sorted((L, n) for L in range(nm.n_layers) for n in rng.sample(range(nm.d_mlp), a.per_layer))
    up = _Uploader(a.upload) if a.upload else None

    acts = activations(nm, sdir, items, picks)
    pq.write_table(pa.Table.from_pylist([dict(layer=L, neuron=n, acts=v) for (L, n), v in acts.items()]),
                   os.path.join(a.out, "acts.parquet"))
    json.dump(dict(model=a.model, question=QUESTION, doses=a.doses, resid_median=resid,
                   stimuli=[dict(id=x["id"], kind=x["kind"], expected=x["expected"]) for x in items]),
              open(os.path.join(a.out, "meta.json"), "w"), indent=1)
    if up:
        up.submit(os.path.join(a.out, "acts.parquet"), up.remote("acts.parquet"))
        up.submit(os.path.join(a.out, "meta.json"), up.remote("meta.json"))
    print(f"activations: {len(picks)} neurons x {len(items)} stimuli", flush=True)

    mm._resid_median = lambda *args: resid
    neurons = {}
    for L, n in picks:
        neurons.setdefault(L, {})[n] = "random"
    mm.run_vlm(nm, bdir, neurons=neurons, doses=a.doses, where="vision", max_new=a.max_new,
               out=os.path.join(a.out, "push"), upload=a.upload)


if __name__ == "__main__":
    main()
