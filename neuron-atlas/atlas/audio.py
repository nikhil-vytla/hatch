"""Hear a neuron: push one MLP neuron of MusicGen's decoder while it writes music from a text prompt.

    python -m atlas.audio music --per-layer 2 --doses -0.5 0.5 --seconds 5 --out mg --upload user/repo/music

One clip per (prompt, neuron, dose) plus a baseline per prompt, using the atlas rule: add
dose * median|resid after L| / |W_down[:, n]| to the neuron's activation at every position. MusicGen decodes
with classifier-free guidance, so the decoder batch is doubled internally; a row's push is applied to both its
conditional and unconditional copies.
"""
import argparse
import os
import random
import re

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import torch
from transformers import AutoProcessor, MusicgenForConditionalGeneration

from .steer import _Uploader

PROMPTS = ["lo-fi piano with soft drums",
           "an orchestra playing a heroic theme",
           "a solo acoustic guitar folk song"]
DOWN_RE = re.compile(r"(?:^|\.)decoder\.model\.decoder\.layers\.(\d+)\.fc2$")
FRAMES_PER_SECOND = 50
GUIDANCE = 3.0
AUDIO_SCHEMA = [("prompt", pa.string()), ("layer", pa.int16()), ("neuron", pa.int32()),
                ("dose", pa.float32()), ("file", pa.string()), ("rms", pa.float32()),
                ("centroid", pa.float32()), ("zcr", pa.float32()), ("dist", pa.float32())]


def pick_device():
    return "cuda" if torch.cuda.is_available() else "cpu"


class MusicNeurons:
    """MusicGen's music decoder with a pre-hook on each decoder-layer fc2 (the MLP down projection)."""

    def __init__(self, name="facebook/musicgen-small", device=None, dtype=None):
        self.name = name
        self.device = device or pick_device()
        if dtype is None:
            dtype = torch.float16 if str(self.device).startswith("cuda") else torch.float32
        self.processor = AutoProcessor.from_pretrained(name)
        self.model = MusicgenForConditionalGeneration.from_pretrained(name, dtype=dtype)
        self.model = self.model.to(self.device).eval()
        self.model.requires_grad_(False)

        found = []
        for mod_name, mod in self.model.named_modules():
            m = DOWN_RE.search(mod_name)
            if m:
                found.append((int(m.group(1)), mod_name, mod))
        if not found:
            raise ValueError(f"no music-decoder fc2 projections found in {name}")
        found.sort(key=lambda x: (x[0], x[1]))
        self.down_names = [n for _, n, _ in found]
        self.downs = [m for _, _, m in found]
        self.n_layers = len(self.downs)
        w = self.downs[0].weight
        self.d_model, self.d_mlp = w.shape[0], w.shape[1]
        self.layer_modules = []
        for name_i in self.down_names:
            path = name_i.rsplit(".fc2", 1)[0]
            try:
                self.layer_modules.append(self.model.get_submodule(path))
            except AttributeError:
                self.layer_modules.append(None)

        sr = getattr(self.processor, "sampling_rate", None)
        if sr is None:
            fe = getattr(self.processor, "feature_extractor", None)
            sr = getattr(fe, "sampling_rate", None) if fe is not None else None
        if sr is None:
            sr = self.model.config.audio_encoder.sampling_rate
        self.sr = int(sr)

        self.resid = None       # median residual norm per decoder layer, set by estimate_resid
        self._push = []         # one {layer: [(neuron, coeff)]} per source batch row
        self._norms = {}        # layer -> ||W_down[:, n]|| on CPU
        self._hooks = [d.register_forward_pre_hook(self._make_push_hook(i))
                       for i, d in enumerate(self.downs)]

    @torch.no_grad()
    def down_cols(self, layer):
        """(d_mlp, d_model): row n is the direction neuron n writes into the residual stream."""
        return self.downs[layer].weight.T.float()

    def _norm(self, layer):
        if layer not in self._norms:
            self._norms[layer] = self.down_cols(layer).norm(dim=1).detach().cpu()
        return self._norms[layer]

    def set_push(self, rows):
        """rows: one list of (layer, neuron, dose) per batch row. Doses are in units of median residual norm.

        A flat list of (layer, neuron, dose) triples is also accepted as one push per batch row."""
        rows = list(rows or [])
        if rows and all(isinstance(r, tuple) and len(r) == 3 for r in rows):
            rows = [[r] for r in rows]
        if self.resid is None:
            raise ValueError("call estimate_resid(mn, prompts) before set_push")
        push = []
        for row in rows:
            per_layer = {}
            for layer, neuron, dose in row:
                layer, neuron = int(layer), int(neuron)
                if not 0 <= layer < self.n_layers:
                    raise ValueError(f"layer {layer} out of range 0..{self.n_layers - 1}")
                if not 0 <= neuron < self.d_mlp:
                    raise ValueError(f"neuron {neuron} out of range 0..{self.d_mlp - 1}")
                coeff = float(dose) * float(self.resid[layer]) / float(self._norm(layer)[neuron])
                per_layer.setdefault(layer, []).append((neuron, coeff))
            push.append(per_layer)
        self._push = push

    def clear(self):
        self._push = []

    def _make_push_hook(self, layer):
        def hook(mod, args):
            rows = self._push
            if not rows or not args:
                return None
            x = args[0]
            if x.dim() != 3:
                return None
            B, T, _ = x.shape
            if B % len(rows) != 0:
                return None
            reps = B // len(rows)  # classifier-free guidance doubles (or otherwise tiles) the batch
            out = x.clone()
            for b, per_layer in enumerate(rows):
                for neuron, coeff in per_layer.get(layer, ()):
                    for copy in range(reps):
                        out[b + copy * len(rows), :, neuron] += coeff
            return (out,) + tuple(args[1:])
        return hook


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


def _generate(mn, prompts, max_new_tokens, seed=0):
    inputs = mn.processor(text=list(prompts), padding=True, return_tensors="pt")
    inputs = {k: (v.to(mn.device) if torch.is_tensor(v) else v) for k, v in inputs.items()}
    torch.manual_seed(seed)
    with torch.no_grad():
        audio = mn.model.generate(**inputs, do_sample=True, guidance_scale=GUIDANCE,
                                  max_new_tokens=max_new_tokens)
    return audio.float().cpu().numpy()


@torch.no_grad()
def estimate_resid(mn, prompts):
    """Median L2 norm of each decoder layer's residual output over a short generation, for the dose unit."""
    prompts = list(prompts or PROMPTS)
    buf = {L: [] for L in range(mn.n_layers)}
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

    for L, mod in enumerate(mn.layer_modules):
        if mod is not None:
            handles.append(mod.register_forward_hook(make_hook(L)))
    try:
        mn.clear()
        _generate(mn, prompts, max_new_tokens=8, seed=0)
    finally:
        for h in handles:
            h.remove()
    vals = []
    for L in range(mn.n_layers):
        vals.append(float(torch.cat(buf[L]).median()) if buf[L] else 1.0)
    mn.resid = vals
    return vals


def _mono(x):
    x = np.asarray(x, dtype=np.float32)
    x = np.squeeze(x)
    if x.ndim == 0:
        x = x.reshape(1)
    if x.ndim > 1:
        x = x.mean(axis=0)
    return x


def _stft_mag(x, n_fft=2048, hop=512):
    x = np.asarray(x, dtype=np.float32)
    if len(x) < n_fft:
        x = np.pad(x, (0, n_fft - len(x)))
    n = 1 + (len(x) - n_fft) // hop
    idx = np.arange(n_fft)[None, :] + hop * np.arange(n)[:, None]
    frames = x[idx] * np.hanning(n_fft).astype(np.float32)[None, :]
    return np.abs(np.fft.rfft(frames, axis=1))


def _mean_log_spec(x, n_fft=2048, hop=512):
    return np.log(_stft_mag(x, n_fft, hop) + 1e-8).mean(axis=0)


def _features(x, sr, baseline_spec=None):
    x = np.asarray(x, dtype=np.float32)
    mag = _stft_mag(x)
    freqs = np.fft.rfftfreq(2048, 1.0 / sr)
    mean_mag = mag.mean(axis=0)
    spec = np.log(mag + 1e-8).mean(axis=0)
    dist = 0.0
    if baseline_spec is not None:
        na, nb = np.linalg.norm(spec), np.linalg.norm(baseline_spec)
        dist = 1.0 if na == 0 or nb == 0 else 1.0 - float(np.dot(spec, baseline_spec) / (na * nb))
    return {"rms": float(np.sqrt(np.mean(x * x))),
            "centroid": float(np.sum(mean_mag * freqs) / (np.sum(mean_mag) + 1e-8)),
            "zcr": float(np.mean(np.abs(np.diff(np.signbit(x).astype(np.int8))))),
            "dist": float(dist)}, spec


def _write_wav(path, x, sr):
    pcm = np.clip(np.rint(np.asarray(x, dtype=np.float32) * 32767.0), -32768, 32767).astype(np.int16)
    try:
        from scipy.io import wavfile
        wavfile.write(path, int(sr), pcm)
        return
    except ImportError:
        pass
    try:
        import soundfile as sf
        sf.write(path, pcm, int(sr), subtype="PCM_16")
        return
    except ImportError:
        pass
    import wave
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sr))
        w.writeframes(pcm.tobytes())


def run_music(model="facebook/musicgen-small", prompts=None, per_layer=2, doses=(-0.5, 0.5), seconds=5,
              out=None, upload=None, seed=0, neurons=None):
    prompts = list(prompts or PROMPTS)
    mn = model if isinstance(model, MusicNeurons) else MusicNeurons(model)
    if neurons is None:
        rng = random.Random(seed)
        pairs = [(L, n) for L in range(mn.n_layers)
                 for n in rng.sample(range(mn.d_mlp), min(per_layer, mn.d_mlp))]
    else:
        pairs = [(int(L), int(n)) for L, n in neurons]
    if not pairs:
        raise ValueError("give per_layer neurons or a list of (layer, neuron)")
    jobs = [(L, n, float(d)) for L, n in pairs for d in doses]

    out_dir = out or "music"
    audio_dir = os.path.join(out_dir, "audio")
    os.makedirs(audio_dir, exist_ok=True)
    uid = _Uploader(upload) if upload else None
    if mn.resid is None:
        mn.resid = estimate_resid(mn, prompts)
    max_new = max(1, int(round(seconds * FRAMES_PER_SECOND)))
    index = []

    def save(clip, name, prompt, layer, neuron, dose, base_spec):
        rel = os.path.join("audio", name)
        feats, _ = _features(clip, mn.sr, base_spec)
        _write_wav(os.path.join(out_dir, rel), clip, mn.sr)
        row = dict(prompt=prompt, layer=layer, neuron=neuron, dose=float(dose), file=rel, **feats)
        index.append(row)
        if uid:
            uid.submit(os.path.join(out_dir, rel), uid.remote(rel))
        return feats

    for pi, prompt in enumerate(prompts):
        mn.clear()
        audio = _generate(mn, [prompt], max_new, seed=seed + pi)
        clip = _mono(audio[0])
        base_feats, base_spec = _features(clip, mn.sr)
        save(clip, f"p{pi:02d}_baseline.wav", prompt, -1, -1, 0.0, None)
        print(f"  p{pi:02d} baseline  rms={base_feats['rms']:.4f}", flush=True)

        for start in range(0, len(jobs), 8):
            part = jobs[start:start + 8]
            mn.set_push([[(L, n, d)] for L, n, d in part])
            try:
                audio = _generate(mn, [prompt] * len(part), max_new, seed=seed + pi)
            finally:
                mn.clear()
            for (L, n, d), clip in zip(part, audio[:len(part)]):
                name = f"p{pi:02d}_L{L:02d}N{n}_{d:+g}.wav"
                save(_mono(clip), name, prompt, L, n, d, base_spec)
            print(f"  p{pi:02d} {len(part)} pushes {start + len(part)}/{len(jobs)}", flush=True)

    idx = os.path.join(out_dir, "index.parquet")
    pq.write_table(pa.Table.from_pylist(index).cast(pa.schema(AUDIO_SCHEMA)), idx, compression="zstd")
    if uid:
        uid.submit(idx, uid.remote("audio/index.parquet"))
        uid.close()
    print(f"wrote {len(index)} clips to {audio_dir}")
    return index


def main(argv=None):
    ap = argparse.ArgumentParser(description="Push MusicGen decoder neurons and save baseline vs pushed audio.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    mp = sub.add_parser("music", help="generate baseline and neuron-pushed music clips")
    mp.add_argument("--model", default="facebook/musicgen-small")
    mp.add_argument("--prompt", action="append", default=[], metavar="STRING")
    mp.add_argument("--per-layer", type=int, default=2)
    mp.add_argument("--doses", type=float, nargs="+", default=[-0.5, 0.5])
    mp.add_argument("--seconds", type=float, default=5.0)
    mp.add_argument("--out")
    mp.add_argument("--upload", metavar="USER/REPO/FOLDER")
    mp.add_argument("--seed", type=int, default=0)
    a = ap.parse_args(argv)
    if a.cmd == "music":
        run_music(model=a.model, prompts=tuple(a.prompt) if a.prompt else None, per_layer=a.per_layer,
                  doses=tuple(a.doses), seconds=a.seconds, out=a.out, upload=a.upload, seed=a.seed)


if __name__ == "__main__":
    main()
