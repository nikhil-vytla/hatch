"""Push vision-language and image-generation neurons and record what changes.

    python -m atlas.multimodal stimuli --out out/mm
    python -m atlas.multimodal vlm --model HuggingFaceTB/SmolVLM-256M-Instruct --stimuli out/mm --per-layer 8 --doses -0.8 0.8
    python -m atlas.multimodal gen --model deepseek-community/Janus-Pro-1B --per-layer 4 --out out/janus

VLM rows are baseline and pushed answers per (stimulus, neuron, dose); generation runs keep one image per
(prompt, neuron, dose) plus the baseline. Both use the atlas steering rule (dose x median|resid| / |W_down[:, n]|).
"""
import argparse
import json
import os
import random
import shutil
import time

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import torch
from PIL import Image

from .model import NeuronModel, parse_recipe
from .steer import _Uploader

ATLAS_REPO = "nikhilxvytla/neuron-atlas"
GEN_PROMPTS = ["a red apple on a wooden table", "a portrait of a person", "a cat",
               "a city street at night", "an arrow pointing right", "the word HELLO written on a sign"]
VLM_SCHEMA = [("id", pa.string()), ("kind", pa.string()), ("question", pa.string()), ("expected", pa.string()),
              ("layer", pa.int16()), ("neuron", pa.int32()), ("dose", pa.float32()), ("where", pa.string()),
              ("text", pa.string()), ("n_tokens", pa.int16()), ("stop", pa.string()), ("recipe", pa.string())]
GEN_SCHEMA = [("prompt", pa.string()), ("layer", pa.int16()), ("neuron", pa.int32()), ("dose", pa.float32()),
              ("file", pa.string()), ("recipe", pa.string())]


def pick(nm, per_layer=16, seed=0):
    """Random neurons per layer: {layer: {neuron: 'random'}}."""
    rng = random.Random(seed)
    k = min(per_layer, nm.d_mlp)
    return {L: {n: "random" for n in rng.sample(range(nm.d_mlp), k)} for L in range(nm.n_layers)}


def _load_stimuli(stimuli_dir, include_videos=True):
    items = json.load(open(os.path.join(stimuli_dir, "stimuli.json")))
    if include_videos:
        vpath = os.path.join(stimuli_dir, "videos.json")
        if os.path.exists(vpath):
            items += json.load(open(vpath))
    return [x for x in items if os.path.exists(os.path.join(stimuli_dir, x["file"]))]


def _published_resid(name):
    try:
        from huggingface_hub import hf_hub_download
        path = hf_hub_download(ATLAS_REPO, f"{name.replace('/', '__')}/meta.json", repo_type="dataset")
        vals = [float(x) for x in json.load(open(path)).get("resid_median", [])]
        return vals or None
    except Exception:
        return None


def _masked_norms(h, mask=None):
    h = h.float()
    if mask is not None:
        m = mask.bool()
        if m.shape == h.shape[:2]:
            h = h[m]
    return h.reshape(-1, h.shape[-1]).norm(dim=-1)


@torch.no_grad()
def _estimate_text_resid(nm, texts):
    if not texts:
        return None
    try:
        enc = nm.tok(list(texts), return_tensors="pt", padding=True,
                     add_special_tokens=False).to(nm.device)
        out = nm.model(**enc, output_hidden_states=True, use_cache=False)
        hs = getattr(out, "hidden_states", None)
        if not hs:
            return None
        vals = []
        for L in range(nm.n_layers):
            h = hs[L + 1] if L + 1 < len(hs) else hs[-1]
            vals.append(float(_masked_norms(h, enc.get("attention_mask")).median()))
        return vals
    except Exception as e:
        print(f"  text resid estimate failed: {e}", flush=True)
        return None


def _as_tensor(out):
    if torch.is_tensor(out):
        return out
    if isinstance(out, (tuple, list)) and out:
        return _as_tensor(out[0])
    for attr in ("last_hidden_state", "hidden_states"):
        v = getattr(out, attr, None)
        if v is not None:
            return _as_tensor(v)
    return None


@torch.no_grad()
def _estimate_vision_resid(nm, stimuli_dir, stimuli, max_items=8):
    buf = {L: [] for L in range(nm.n_layers)}
    handles = []

    def make_hook(L):
        def hook(mod, args, out):
            t = _as_tensor(out)
            if t is not None and t.numel():
                t = t.detach().float()
                if t.dim() == 1:
                    t = t.unsqueeze(0)
                buf[L].append(t.reshape(-1, t.shape[-1]).norm(dim=-1))
        return hook

    for L, mod in enumerate(nm.layer_modules):
        if mod is not None:
            handles.append(mod.register_forward_hook(make_hook(L)))
    nm.clear_steer()
    seen = 0
    try:
        for item in stimuli:
            if item.get("kind") == "video":
                continue
            try:
                inputs = _prepare_inputs(nm, stimuli_dir, item, item["question"], batch=1)
                nm.model(**inputs, use_cache=False)
            except Exception as e:
                print(f"  vision resid skipped {item['id']}: {e}", flush=True)
                continue
            seen += 1
            if seen >= max_items:
                break
    finally:
        for h in handles:
            h.remove()
    vals = []
    have = [float(torch.cat(v).median()) for v in buf.values() if v]
    fallback = float(torch.tensor(have).median()) if have else 1.0
    for L in range(nm.n_layers):
        vals.append(float(torch.cat(buf[L]).median()) if buf[L] else fallback)
    if seen == 0:
        print("  no images reached the vision tower; using fallback resid_median", flush=True)
    return vals


def _resid_median(nm, stimuli_dir, stimuli, where):
    if where == "llm":
        published = _published_resid(nm.name)
        if published and len(published) == nm.n_layers:
            print("  using the published atlas resid_median", flush=True)
            return published
        vals = _estimate_text_resid(nm, [_chat_prompt(nm, s["question"], None) for s in stimuli[:8]])
        if vals and len(vals) == nm.n_layers:
            print("  estimated resid_median from text stimuli", flush=True)
            return vals
    else:
        vals = _estimate_vision_resid(nm, stimuli_dir, stimuli)
        if vals:
            print("  estimated vision resid_median from image stimuli", flush=True)
            return vals
    print("  falling back to resid_median = 1.0 per layer", flush=True)
    return [1.0] * nm.n_layers


def _media(item):
    ext = os.path.splitext(item["file"])[1].lower()
    return "video" if ext in (".mp4", ".gif", ".webm", ".avi") else "image"


def _chat_prompt(nm, question, media):
    content = []
    if media in ("image", "video"):
        content.append({"type": media})
    content.append({"type": "text", "text": question})
    if nm.processor is not None and getattr(nm.processor, "chat_template", None):
        try:
            return nm.processor.apply_chat_template([{"role": "user", "content": content}],
                                                    add_generation_prompt=True, tokenize=False)
        except Exception:
            pass
    return nm.chat_prompt(question)


def _image(path):
    img = Image.open(path)
    if getattr(img, "n_frames", 1) > 1:
        img.seek(0)
    return img.convert("RGB")


def _prepare_inputs(nm, stimuli_dir, item, question, batch=1):
    if nm.processor is None:
        raise ValueError(f"{nm.name} has no processor; cannot build image-text inputs")
    media = _media(item)
    prompt = _chat_prompt(nm, question, media)
    path = os.path.join(stimuli_dir, item["file"])
    if media == "video":
        try:
            inputs = nm.processor(text=[prompt] * batch, videos=[path] * batch, return_tensors="pt")
        except Exception:
            media = "image"
            prompt = _chat_prompt(nm, question, media)
    if media == "image":
        inputs = nm.processor(text=[prompt] * batch, images=[_image(path)] * batch, return_tensors="pt")
    return {k: (v.to(nm.device) if torch.is_tensor(v) else v) for k, v in inputs.items()}


def _eos(nm):
    ids = {nm.tok.eos_token_id}
    try:
        ge = nm.model.generation_config.eos_token_id
        if isinstance(ge, int):
            ids.add(ge)
        elif ge:
            ids.update(ge)
    except Exception:
        pass
    return {i for i in ids if i is not None}


def _clean(ids, eos):
    cut = next((i for i, t in enumerate(ids) if t in eos), None)
    return (ids[:cut], "eos") if cut is not None else (ids, "length")


@torch.no_grad()
def _generate(nm, inputs, max_new):
    out = nm.model.generate(**inputs, max_new_tokens=max_new, do_sample=False, repetition_penalty=1.1,
                            pad_token_id=nm.tok.pad_token_id)
    return out[:, inputs["input_ids"].shape[1]:].tolist()


def _normalize_neurons(neurons):
    if isinstance(neurons, dict):
        out = []
        for L, v in neurons.items():
            if isinstance(v, dict):
                out += [(int(L), int(n)) for n in v]
            elif isinstance(v, (list, tuple, set)):
                out += [(int(L), int(n)) for n in v]
            else:
                out.append((int(L), int(v)))
        return out
    if isinstance(neurons, tuple) and len(neurons) == 2 and all(isinstance(x, (int,)) for x in neurons):
        return [(int(neurons[0]), int(neurons[1]))]
    return [(int(L), int(n)) for L, n in neurons]


def _recipe_terms(rec):
    return parse_recipe(rec) if isinstance(rec, str) else list(rec)


def _jobs(neurons=None, recipes=None, doses=(-0.8, 0.8)):
    jobs = []
    if neurons:
        for L, n in _normalize_neurons(neurons):
            for d in doses:
                jobs.append({"key": f"L{L:02d}", "layer": L, "neuron": n, "dose": float(d),
                             "terms": [(L, n, "add", float(d))], "recipe": ""})
    if recipes:
        for idx, rec in enumerate(recipes):
            terms = _recipe_terms(rec)
            label = rec if isinstance(rec, str) else ""
            for d in doses:
                scaled = []
                for t in terms:
                    L, n, op, v = t
                    v = 1 + (v - 1) * d if op == "mul" else v * d
                    scaled.append((L, n, op, v))
                layer = terms[0][0] if terms else -1
                neuron = terms[0][1] if terms else -1
                jobs.append({"key": f"R{idx:02d}", "layer": layer, "neuron": neuron, "dose": float(d),
                             "terms": scaled, "recipe": label})
    return jobs


def _out_dir(out, stimuli_dir=None, default_name="multimodal"):
    if out is None:
        return stimuli_dir or default_name, "vlm.parquet"
    if out.endswith(".parquet"):
        return os.path.dirname(out) or ".", os.path.basename(out)
    return out, "vlm.parquet"


def _write(path, rows, schema):
    pq.write_table(pa.Table.from_pylist(rows).cast(pa.schema(schema)), path, compression="zstd")


def _resume(up, local, remote):
    if os.path.exists(local) or up is None:
        return
    try:
        from huggingface_hub import hf_hub_download
        shutil.copyfile(hf_hub_download(repo_id=up.repo, filename=remote, repo_type="dataset"), local)
        print(f"  downloaded {remote}", flush=True)
    except Exception:
        pass


def run_vlm(model, stimuli_dir, neurons=None, recipes=None, doses=(-0.8, 0.8), where="llm",
            max_new=48, batch=8, out=None, upload=None, device=None, seed=0):
    nm = model if isinstance(model, NeuronModel) else NeuronModel(model, device=device, where=where)
    where = nm.where
    stimuli = _load_stimuli(stimuli_dir)
    if not stimuli:
        raise ValueError(f"no stimuli found in {stimuli_dir}; run `python -m atlas.multimodal stimuli` first")
    jobs = _jobs(neurons, recipes, doses)
    if not jobs:
        raise ValueError("give neurons or recipes")
    out_dir, final_name = _out_dir(out, stimuli_dir)
    vdir = os.path.join(out_dir, "vlm")
    os.makedirs(vdir, exist_ok=True)
    up = _Uploader(upload) if upload else None
    resid = _resid_median(nm, stimuli_dir, stimuli, where)

    groups = {}
    for job in jobs:
        groups.setdefault(job["key"], []).append(job)
    names = ["baseline.parquet"] + [f"{k}.parquet" for k in sorted(groups)]
    for name in names:
        local = os.path.join(vdir, name)
        if up:
            _resume(up, local, up.remote(f"vlm/{name}"))

    rows = []
    base_path = os.path.join(vdir, "baseline.parquet")
    if os.path.exists(base_path):
        base_rows = pq.read_table(base_path).to_pylist()
        print(f"  resumed {len(base_rows)} baselines", flush=True)
    else:
        base_rows = []
        for item in stimuli:
            nm.clear_steer()
            ids = _generate(nm, _prepare_inputs(nm, stimuli_dir, item, item["question"], batch=1), max_new)[0]
            ids, stop = _clean(ids, _eos(nm))
            text = nm.tok.decode(ids, skip_special_tokens=True)
            base_rows.append(dict(id=item["id"], kind=item["kind"], question=item["question"],
                                  expected=item["expected"], layer=-1, neuron=-1, dose=0.0, where=where,
                                  text=text, n_tokens=len(ids), stop=stop, recipe=""))
            print(f"  baseline[{item['id']}]: {text[:100]!r}", flush=True)
        _write(base_path, base_rows, VLM_SCHEMA)
        if up:
            up.submit(base_path, up.remote("vlm/baseline.parquet"))
    base = {r["id"]: r["text"] for r in base_rows}
    rows.extend(base_rows)

    t0 = time.time()
    for key in sorted(groups):
        path = os.path.join(vdir, f"{key}.parquet")
        if os.path.exists(path):
            part = pq.read_table(path).to_pylist()
            rows.extend(part)
            print(f"  {key}: resumed {len(part)} replies", flush=True)
            continue
        part = []
        gjobs = groups[key]
        for item in stimuli:
            s = 0
            while s < len(gjobs):
                step = 1 if where == "vision" and getattr(nm, "vision_2d", False) else batch
                chunk = gjobs[s:s + step]
                nm.set_recipes([j["terms"] for j in chunk], resid)
                try:
                    outs = _generate(nm, _prepare_inputs(nm, stimuli_dir, item, item["question"],
                                                         batch=len(chunk)), max_new)
                finally:
                    nm.clear_steer()
                for job, ids in zip(chunk, outs):
                    ids, stop = _clean(ids, _eos(nm))
                    text = nm.tok.decode(ids, skip_special_tokens=True)
                    part.append(dict(id=item["id"], kind=item["kind"], question=item["question"],
                                     expected=item["expected"], layer=job["layer"], neuron=job["neuron"],
                                     dose=job["dose"], where=where, text=text, n_tokens=len(ids),
                                     stop=stop, recipe=job["recipe"]))
                s += len(chunk)
        _write(path, part, VLM_SCHEMA)
        if up:
            up.submit(path, up.remote(f"vlm/{key}.parquet"))
        rows.extend(part)
        print(f"  {key}: {len(gjobs)} pushes x {len(stimuli)} stimuli  {time.time() - t0:.0f}s", flush=True)

    final = os.path.join(out_dir, final_name)
    _write(final, rows, VLM_SCHEMA)
    if up:
        up.submit(final, up.remote(final_name))
        up.close()
    print(f"wrote {len(rows)} rows to {final}")
    return rows, base


def _supports_images(proc):
    return proc is not None and (getattr(proc, "image_processor", None) is not None
                                 or "pixel_values" in getattr(proc, "model_input_names", []))


def _janus_prompt(nm, prompt):
    if nm.processor is not None and getattr(nm.processor, "chat_template", None):
        try:
            return nm.processor.apply_chat_template([{"role": "user", "content": [{"type": "text", "text": prompt}]}],
                                                    add_generation_prompt=True, tokenize=False)
        except Exception:
            pass
    return prompt


def _pixels_to_pil(proc, decoded):
    decoded = decoded.float()
    if decoded.ndim == 4 and decoded.shape[-1] in (1, 3) and decoded.shape[1] not in (1, 3):
        decoded = decoded.permute(0, 3, 1, 2)
    frames = list(decoded)
    try:
        pixel_values = proc.postprocess(frames, return_tensors="np")["pixel_values"]
    except (TypeError, ValueError, AttributeError):
        pixel_values = proc.postprocess(frames, return_tensors=None)["pixel_values"]
    if torch.is_tensor(pixel_values):
        pixel_values = pixel_values.detach().cpu().numpy()
    if isinstance(pixel_values, np.ndarray) and pixel_values.ndim == 4:
        pixel_values = list(pixel_values)
    images = []
    for x in pixel_values:
        if isinstance(x, Image.Image):
            images.append(x.convert("RGB"))
            continue
        if torch.is_tensor(x):
            x = x.detach().cpu().numpy()
        x = np.asarray(x)
        if x.ndim == 2:
            x = x[..., None]
        if x.shape[0] in (1, 3, 4) and x.shape[-1] not in (1, 3, 4):
            x = np.moveaxis(x, 0, -1)
        if x.shape[-1] == 1:
            x = np.repeat(x, 3, axis=-1)
        elif x.shape[-1] == 4:
            x = x[..., :3]
        if np.issubdtype(x.dtype, np.floating):
            if x.size and x.max() <= 1.0:
                x = x * 255.0
            x = np.clip(np.rint(x), 0, 255).astype(np.uint8)
        elif x.dtype != np.uint8:
            x = np.clip(x, 0, 255).astype(np.uint8)
        images.append(Image.fromarray(x, mode="RGB"))
    return images


def _janus_generate(nm, prompts, seed=0):
    inputs = nm.processor(text=list(prompts), generation_mode="image", return_tensors="pt")
    inputs = {k: (v.to(nm.device) if torch.is_tensor(v) else v) for k, v in inputs.items()}
    torch.manual_seed(seed)
    with torch.no_grad():
        outs = nm.model.generate(**inputs, generation_mode="image", do_sample=True,
                                 max_new_tokens=nm.processor.num_image_tokens, guidance_scale=5.0,
                                 pad_token_id=nm.tok.pad_token_id)
        decoded = nm.model.decode_image_tokens(outs)
    return _pixels_to_pil(nm.processor, decoded)


def run_gen(model="deepseek-community/Janus-Pro-1B", prompts=None, neurons=None, recipes=None,
            doses=(-0.8, 0.8), out=None, upload=None, device=None, seed=0):
    from transformers import JanusForConditionalGeneration  # lazy: image generation is GPU work

    prompts = list(prompts or GEN_PROMPTS)
    nm = model if isinstance(model, NeuronModel) else NeuronModel(model, device=device, where="llm")
    if not isinstance(nm.model, JanusForConditionalGeneration):
        raise ValueError(f"{nm.name} did not load as JanusForConditionalGeneration")
    jobs = _jobs(neurons, recipes, doses)
    if not jobs:
        raise ValueError("give neurons or recipes")
    out_dir = out or "janus"
    images_dir = os.path.join(out_dir, "images")
    os.makedirs(images_dir, exist_ok=True)
    uid = _Uploader(upload) if upload else None
    published = _published_resid(nm.name)
    resid = published if published and len(published) == nm.n_layers else \
        _estimate_text_resid(nm, [_janus_prompt(nm, p) for p in prompts[:4]])
    if not resid:
        resid = [1.0] * nm.n_layers
    index = []

    def save(img, name, prompt, layer, neuron, dose, recipe=""):
        rel = os.path.join("images", name)
        img.convert("RGB").save(os.path.join(out_dir, rel))
        index.append(dict(prompt=prompt, layer=layer, neuron=neuron, dose=float(dose), file=rel, recipe=recipe))
        if uid:
            uid.submit(os.path.join(out_dir, rel), uid.remote(f"gen/{rel}"))

    for pi, prompt in enumerate(prompts):
        text = _janus_prompt(nm, prompt)
        nm.clear_steer()
        img = _janus_generate(nm, [text], seed=seed + pi)[0]
        save(img, f"p{pi:02d}_baseline.png", prompt, -1, -1, 0.0)
        print(f"  baseline[{pi}] {prompt!r}", flush=True)
        for job in jobs:
            nm.set_recipes([job["terms"]], resid)
            try:
                img = _janus_generate(nm, [text], seed=seed + pi)[0]
            finally:
                nm.clear_steer()
            tag = f"R{abs(job['neuron']):04d}" if job["recipe"] else f"L{job['layer']:02d}N{job['neuron']}"
            name = f"p{pi:02d}_{tag}_{job['dose']:+g}.png"
            save(img, name, prompt, job["layer"], job["neuron"], job["dose"], job["recipe"])
    idx = os.path.join(out_dir, "index.parquet")
    _write(idx, index, GEN_SCHEMA)
    if uid:
        uid.submit(idx, uid.remote("gen/index.parquet"))
        uid.close()
    print(f"wrote {len(index)} images to {images_dir}")
    return index


def run_janus_understanding(model="deepseek-community/Janus-Pro-1B", stimuli_dir=None, **kwargs):
    nm = model if isinstance(model, NeuronModel) else NeuronModel(model, where=kwargs.get("where", "llm"))
    if not _supports_images(nm.processor):
        raise ValueError(f"{nm.name} processor does not accept images")
    return run_vlm(nm, stimuli_dir, **kwargs)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Probe multimodal neurons with labeled stimuli and image generation.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("stimuli", help="write the labeled PNG stimulus set")
    sp.add_argument("--out", required=True)
    sp.add_argument("--videos", action="store_true", help="also write tiny GIF clips when imageio is installed")

    def common(p, model):
        p.add_argument("--model", default=model)
        p.add_argument("--where", choices=["llm", "vision"], default="llm")
        p.add_argument("--per-layer", type=int, default=16)
        p.add_argument("--all", action="store_true", help="every neuron of the selected stack (very large)")
        p.add_argument("--recipe", action="append", default=[], metavar="STRING")
        p.add_argument("--doses", type=float, nargs="+", default=[-0.8, 0.8])
        p.add_argument("--out")
        p.add_argument("--upload", metavar="USER/REPO/FOLDER")
        p.add_argument("--device")
        p.add_argument("--seed", type=int, default=0)

    vp = sub.add_parser("vlm", help="push vision/language neurons while the model answers about stimuli")
    vp.add_argument("--stimuli", required=True)
    vp.add_argument("--max-new", type=int, default=48)
    vp.add_argument("--batch", type=int, default=8)
    common(vp, "HuggingFaceTB/SmolVLM-256M-Instruct")

    gp = sub.add_parser("gen", help="push language neurons while Janus generates images")
    gp.add_argument("--prompt", action="append", default=[], metavar="STRING")
    common(gp, "deepseek-community/Janus-Pro-1B")

    a = ap.parse_args(argv)
    if a.cmd == "stimuli":
        from .stimuli import build, build_video
        build(a.out)
        if a.videos:
            build_video(a.out)
        return
    if a.recipe:
        neurons, recipes = None, a.recipe
    else:
        nm = NeuronModel(a.model, device=a.device, where=a.where)
        if a.all:
            n = nm.n_layers * nm.d_mlp
            print(f"warning: pushing all {n} neurons of {a.model} ({a.where}); this is very large", flush=True)
            neurons = {L: {i: "all" for i in range(nm.d_mlp)} for L in range(nm.n_layers)}
        else:
            neurons = pick(nm, a.per_layer, a.seed)
        recipes = None
        a.model = nm
    if a.cmd == "vlm":
        run_vlm(a.model, a.stimuli, neurons=neurons, recipes=recipes, doses=tuple(a.doses), where=a.where,
                max_new=a.max_new, batch=a.batch, out=a.out, upload=a.upload,
                device=a.device, seed=a.seed)
    else:
        prompts = tuple(a.prompt) if a.prompt else GEN_PROMPTS
        run_gen(a.model, prompts, neurons=neurons, recipes=recipes, doses=tuple(a.doses), out=a.out,
                upload=a.upload, device=a.device, seed=a.seed)


if __name__ == "__main__":
    main()
