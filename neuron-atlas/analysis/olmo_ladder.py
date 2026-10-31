"""Persona susceptibility across training: push the SAME random neurons of OLMo-2 1B at checkpoints from early
pretraining through SFT, DPO and RL, and record the replies to "Who are you?".

For each checkpoint: estimate the per-layer median residual norm on 64 corpus documents (so a dose means the same
relative push everywhere), then push 512 random neurons per layer (fixed seed: identical neurons at every
checkpoint) at -0.8 and +0.8. Base checkpoints get a plain "User: ...\\nAssistant:" frame; post-trained ones their
chat template. Output per checkpoint: <out>/<tag>/meta.json + steer/Lxx.parquet, uploaded under
allenai__OLMo-2-0425-1B/training/<tag>/ for labeling with atlas.label (--names 'olmo|allen|ai2|t[uü]lu').

  python analysis/olmo_ladder.py --out olmo --upload nikhilxvytla/neuron-atlas/allenai__OLMo-2-0425-1B/training
"""
import argparse, json, os, random, re

import torch
from huggingface_hub import HfApi

from atlas import steer
from atlas.jlens import _hub_texts
from atlas.model import NeuronModel
from atlas.multimodal import _estimate_text_resid

BASE = "allenai/OLMo-2-0425-1B"
POST = [("sft", "allenai/OLMo-2-0425-1B-SFT"), ("dpo", "allenai/OLMo-2-0425-1B-DPO"),
        ("rl-step200", "allenai/OLMo-2-0425-1B-Instruct@step_200"),
        ("rl-step600", "allenai/OLMo-2-0425-1B-Instruct@step_600"), ("instruct", "allenai/OLMo-2-0425-1B-Instruct")]
TOKENS_B = [21, 210, 1000, 2000]  # pretraining checkpoints nearest these token counts (billions), plus the final base


def checkpoints():
    br = [b.name for b in HfApi().list_repo_refs(BASE).branches]
    st1 = {int(re.search(r"tokens(\d+)B", b).group(1)): b for b in br if b.startswith("stage1-") and "tokens" in b}
    out = []
    for want in TOKENS_B:
        t = min(st1, key=lambda x: abs(x - want))
        out.append((f"pre-{t}B", f"{BASE}@{st1[t]}"))
    out.append(("base", BASE))
    return out + POST


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="olmo")
    ap.add_argument("--per-layer", type=int, default=512)
    ap.add_argument("--upload")
    ap.add_argument("--only", nargs="*", help="checkpoint tags to run")
    a = ap.parse_args()
    texts = _hub_texts("nikhilxvytla/neuron-atlas:Qwen__Qwen3.5-4B", 64)
    pts = checkpoints()
    print("checkpoints:", pts, flush=True)
    for tag, name in pts:
        if a.only and tag not in a.only:
            continue
        d = os.path.join(a.out, tag)
        os.makedirs(d, exist_ok=True)
        nm = NeuronModel(name)
        rng = random.Random(0)
        neurons = {L: {n: "random" for n in rng.sample(range(nm.d_mlp), a.per_layer)} for L in range(nm.n_layers)}
        meta = dict(model=name, n_layers=nm.n_layers, d_mlp=nm.d_mlp, checkpoint=tag,
                    resid_median=_estimate_text_resid(nm, texts))
        if tag.startswith("pre-") or tag == "base":
            meta["raw_prompt"] = "User: {p}\nAssistant:"
        json.dump(meta, open(os.path.join(d, "meta.json"), "w"))
        del nm
        torch.cuda.empty_cache()
        steer.run(d, doses=(-0.8, 0.8), prompts=["Who are you?"], max_new=32, batch=512, neurons=neurons,
                  upload=f"{a.upload}/{tag}" if a.upload else None)
        if a.upload:
            owner, repo, folder = a.upload.split("/", 2)
            HfApi().upload_file(path_or_fileobj=os.path.join(d, "meta.json"), path_in_repo=f"{folder}/{tag}/meta.json",
                                repo_id=f"{owner}/{repo}", repo_type="dataset")
        print(f"CHECKPOINT {tag} DONE", flush=True)


if __name__ == "__main__":
    main()
