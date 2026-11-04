"""Contact sheets and a dose-response number for Janus image-generation pushes.

  python analysis/janus_sheet.py GEN_DIR OUT_PREFIX [--every 4]
GEN_DIR has index.parquet and images/. For each prompt: one sheet, rows = neurons (every Nth layer), columns = doses
around the baseline. Also prints mean absolute pixel change from the baseline (64x64 grayscale, 0-1) by |dose| and layer.
"""
import os, sys
import numpy as np
import pyarrow.parquet as pq
from PIL import Image, ImageDraw


def small(path, s=64):
    return np.asarray(Image.open(path).convert("L").resize((s, s)), dtype=np.float32) / 255


def main(d, prefix, every=4, cell=112):
    rows = pq.read_table(os.path.join(d, "index.parquet")).to_pylist()
    for pi, prompt in enumerate(dict.fromkeys(r["prompt"] for r in rows)):
        sub = [r for r in rows if r["prompt"] == prompt]
        base = next(r for r in sub if r["layer"] < 0)
        b = small(os.path.join(d, base["file"]))
        doses = sorted({r["dose"] for r in sub if r["layer"] >= 0})
        neurons = sorted({(r["layer"], r["neuron"]) for r in sub if r["layer"] >= 0})
        change = {}
        for r in sub:
            if r["layer"] >= 0:
                change[(r["layer"], r["neuron"], r["dose"])] = float(np.abs(small(os.path.join(d, r["file"])) - b).mean())
        print(f"\n{prompt!r}")
        for ad in sorted({abs(x) for x in doses}):
            v = [c for (L, n, x), c in change.items() if abs(x) == ad]
            print(f"  |dose| {ad}: mean pixel change {np.mean(v):.3f}  (n={len(v)})")
        nL = max(L for L, _ in neurons) + 1
        for lo in range(0, nL, nL // 4):
            v = [c for (L, n, x), c in change.items() if lo <= L < lo + nL // 4 and abs(x) == max(abs(y) for y in doses)]
            if v:
                print(f"  layers {lo}-{lo + nL // 4 - 1} at max dose: {np.mean(v):.3f}")
        pick = [k for k in neurons if k[0] % every == 0]
        pick = list(dict.fromkeys([min((k for k in neurons if k[0] == L), default=None) for L in range(0, nL, every)]))
        pick = [k for k in pick if k]
        cols = [x for x in doses if x < 0] + [0.0] + [x for x in doses if x > 0]
        W, H = 90 + cell * len(cols), 24 + cell * len(pick)
        sheet = Image.new("RGB", (W, H), "white")
        dr = ImageDraw.Draw(sheet)
        for j, x in enumerate(cols):
            dr.text((90 + j * cell + 4, 6), "baseline" if x == 0 else f"{x:+g}", fill="black")
        files = {(r["layer"], r["neuron"], r["dose"]): r["file"] for r in sub}
        for i, (L, n) in enumerate(pick):
            dr.text((4, 24 + i * cell + cell // 2 - 6), f"L{L} N{n}", fill="black")
            for j, x in enumerate(cols):
                f = base["file"] if x == 0 else files.get((L, n, x))
                if f:
                    sheet.paste(Image.open(os.path.join(d, f)).convert("RGB").resize((cell - 4, cell - 4)), (90 + j * cell, 24 + i * cell))
        out = f"{prefix}_p{pi}.png"
        sheet.save(out, optimize=True)
        print("  sheet", out, sheet.size)


if __name__ == "__main__":
    a = sys.argv[1:]
    main(a[0], a[1], int(a[a.index("--every") + 1]) if "--every" in a else 4)
