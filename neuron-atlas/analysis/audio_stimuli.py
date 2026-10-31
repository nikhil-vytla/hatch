"""Audio stimuli for pushing an audio-language model's audio-tower or LM neurons (atlas.multimodal vlm --where audio).

Synthetic sounds (tone, chord, chirp, noise, clicks, silence) plus one clip per chosen ESC-50 class (5 s, CC BY-NC,
from the ashraq/esc50 copy on the Hub). Writes WAVs and stimuli.json in the multimodal stimulus format.

  python analysis/audio_stimuli.py OUT_DIR
"""
import io, json, os, sys

import numpy as np
import soundfile as sf

SR = 16000
QUESTION = "What do you hear? Answer in a few words."
ESC = ["dog", "rooster", "rain", "siren", "church_bells", "crying_baby", "clock_tick", "door_wood_knock", "laughing",
       "engine", "cat", "thunderstorm", "sea_waves", "chirping_birds", "keyboard_typing", "car_horn"]


def synth():
    t = np.arange(SR * 3) / SR
    out = {
        "tone_440": (0.3 * np.sin(2 * np.pi * 440 * t), "tone"),
        "chord_c_major": (0.15 * sum(np.sin(2 * np.pi * f * t) for f in (261.6, 329.6, 392.0)), "chord"),
        "chirp_up": (0.3 * np.sin(2 * np.pi * (200 * t + 600 * t ** 2)), "rising"),
        "white_noise": (0.1 * np.random.default_rng(0).standard_normal(len(t)), "noise"),
        "clicks_2hz": (np.where((t * 2) % 1 < 0.004, 0.8, 0.0), "click"),
        "silence": (np.zeros(len(t)), "silence"),
    }
    return {k: (v.astype(np.float32), e) for k, (v, e) in out.items()}


def main(out):
    os.makedirs(out, exist_ok=True)
    items = []
    for sid, (x, exp) in synth().items():
        sf.write(os.path.join(out, f"{sid}.wav"), x, SR)
        items.append(dict(id=sid, file=f"{sid}.wav", question=QUESTION, kind="synthetic", expected=exp))
    try:
        import pyarrow.parquet as pq
        from huggingface_hub import hf_hub_download
        want = set(ESC)
        for shard in ("data/train-00000-of-00002-2f1ab7b824ec751f.parquet",):
            t = pq.read_table(hf_hub_download("ashraq/esc50", shard, repo_type="dataset"))
            for r in t.to_pylist():
                c = r.get("category")
                if c in want:
                    want.discard(c)
                    x, sr = sf.read(io.BytesIO(r["audio"]["bytes"]), dtype="float32", always_2d=True)
                    x = x.mean(1)
                    if sr != SR:
                        x = np.interp(np.linspace(0, len(x) - 1, int(len(x) * SR / sr)), np.arange(len(x)), x)
                    sf.write(os.path.join(out, f"esc_{c}.wav"), x.astype(np.float32), SR)
                    items.append(dict(id=f"esc_{c}", file=f"esc_{c}.wav", question=QUESTION, kind="esc50",
                                      expected=c.split("_")[0]))
        if want:
            print("ESC-50 classes not found:", sorted(want))
    except Exception as e:
        print("ESC-50 download failed:", e)
    json.dump(items, open(os.path.join(out, "stimuli.json"), "w"), indent=1)
    print(f"wrote {len(items)} audio stimuli to {out}")


if __name__ == "__main__":
    main(sys.argv[1])
