"""Render a truecolor-ANSI frame of half-block cells (as produced by Text.js
`app.toAnsi()` or `text run`) to a PNG, one cell = 1x2 pixels, then upscale."""
import re, sys
from PIL import Image

def parse(text):
    rows, fg, bg = [], (200, 200, 200), (0, 0, 0)
    for line in text.split("\n"):
        row, i = [], 0
        while i < len(line):
            m = re.match(r"\x1b\[([0-9;]*)m", line[i:])
            if m:
                p = [int(x) if x else 0 for x in m.group(1).split(";")]
                j = 0
                while j < len(p):
                    if p[j] == 0: fg, bg = (200, 200, 200), (0, 0, 0)
                    elif p[j] == 38 and p[j+1] == 2: fg = tuple(p[j+2:j+5]); j += 4
                    elif p[j] == 48 and p[j+1] == 2: bg = tuple(p[j+2:j+5]); j += 4
                    elif p[j] == 39: fg = (200, 200, 200)
                    elif p[j] == 49: bg = (0, 0, 0)
                    j += 1
                i += len(m.group(0)); continue
            if line[i] == "\x1b":  # other escape: skip
                m = re.match(r"\x1b\[[0-9;?]*[A-Za-z]", line[i:]); i += len(m.group(0)) if m else 1; continue
            ch = line[i]
            top, bot = (fg, bg) if ch == "▀" else (bg, fg) if ch == "▄" else (bg, bg) if ch == " " else (fg, fg)
            row.append((top, bot)); i += 1
        rows.append(row)
    return rows

src, dst = sys.argv[1], sys.argv[2]
rows = parse(open(src, encoding="utf-8").read())
w, h = max(len(r) for r in rows), len(rows)
img = Image.new("RGB", (w, h * 2))
for y, r in enumerate(rows):
    for x, (t, b) in enumerate(r):
        img.putpixel((x, 2 * y), t); img.putpixel((x, 2 * y + 1), b)
img.resize((w * 4, h * 8), Image.NEAREST).save(dst)
print(dst, w, "x", h)
