"""Replay a `script` capture of `text run` through the pyte terminal emulator
and save the final screen (half-block cells -> 2 pixels each) as a PNG.
   python3 replay-terminal.py capture.raw out.png [cols rows]"""
import sys, pyte
from PIL import Image

raw, out = sys.argv[1], sys.argv[2]
cols, rows = (int(sys.argv[3]), int(sys.argv[4])) if len(sys.argv) > 4 else (120, 46)
data = open(raw, "rb").read()
data = data[data.index(b"\n") + 1:]  # drop script's header line
screen = pyte.Screen(cols, rows)
stream = pyte.ByteStream(screen)
stream.feed(data)

def rgb(c, default):
    if c in ("default", None): return default
    try: return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))
    except Exception: return default

img = Image.new("RGB", (cols, rows * 2))
for y in range(rows):
    line = screen.buffer[y]
    for x in range(cols):
        ch = line[x]
        fg, bg = rgb(ch.fg, (200, 200, 200)), rgb(ch.bg, (0, 0, 0))
        t, b = (fg, bg) if ch.data == "▀" else (bg, fg) if ch.data == "▄" else (bg, bg) if ch.data == " " else (fg, fg)
        img.putpixel((x, 2 * y), t); img.putpixel((x, 2 * y + 1), b)
img.resize((cols * 4, rows * 8), Image.NEAREST).save(out)
print(out, "".join(screen.buffer[rows - 1][x].data for x in range(cols)).strip()[:100])
