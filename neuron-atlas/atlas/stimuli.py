"""Small labeled stimulus set for probing vision-language and image-generation models.

    python -m atlas.multimodal stimuli --out out/mm
"""
import json
import math
import os
import urllib.request

from PIL import Image, ImageDraw, ImageFont, ImageOps

W = H = 384
UA = {"User-Agent": "neuron-atlas-stimuli/0.1 (research; mailto:noreply@example.com)"}


def _font(size):
    for path in ("DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
                 "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            pass
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def _canvas(w=W, h=H, color="white"):
    return Image.new("RGB", (w, h), color)


def _text_center(draw, box, text, font, fill="black"):
    x0, y0, x1, y1 = box
    l, t, r, b = draw.textbbox((0, 0), text, font=font)
    draw.text((x0 + (x1 - x0 - (r - l)) / 2 - l, y0 + (y1 - y0 - (b - t)) / 2 - t), text, font=font, fill=fill)


def _arrow(direction):
    img = _canvas()
    draw = ImageDraw.Draw(img)
    vec = {"up": (0, -1), "down": (0, 1), "left": (-1, 0), "right": (1, 0),
           "up-left": (-1, -1), "up-right": (1, -1), "down-left": (-1, 1), "down-right": (1, 1)}[direction]
    n = math.hypot(*vec)
    vx, vy = vec[0] / n, vec[1] / n
    cx = cy = W // 2
    length, head = 118, 46
    start = (cx - vx * length, cy - vy * length)
    end = (cx + vx * length, cy + vy * length)
    draw.line([start, end], fill="black", width=16)
    px, py = -vy, vx
    base = (end[0] - vx * head, end[1] - vy * head)
    draw.polygon([end, (base[0] + px * head * 0.65, base[1] + py * head * 0.65),
                  (base[0] - px * head * 0.65, base[1] - py * head * 0.65)], fill="black")
    return img


def _clock(hour, minute=0):
    img = _canvas()
    draw = ImageDraw.Draw(img)
    cx = cy = W // 2
    r = 148
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), outline="black", width=8)
    for i in range(60):
        ang = math.radians(i * 6 - 90)
        inner = r - (24 if i % 5 == 0 else 13)
        draw.line((cx + inner * math.cos(ang), cy + inner * math.sin(ang),
                   cx + (r - 5) * math.cos(ang), cy + (r - 5) * math.sin(ang)),
                  fill="black", width=5 if i % 5 == 0 else 2)
    font = _font(30)
    for num, ang in ((12, -90), (3, 0), (6, 90), (9, 180)):
        a = math.radians(ang)
        x, y = cx + (r - 52) * math.cos(a), cy + (r - 52) * math.sin(a)
        _text_center(draw, (x - 20, y - 20, x + 20, y + 20), str(num), font)
    ha = math.radians((hour % 12 + minute / 60) * 30 - 90)
    ma = math.radians(minute * 6 - 90)
    draw.line((cx, cy, cx + 78 * math.cos(ha), cy + 78 * math.sin(ha)), fill="black", width=13)
    draw.line((cx, cy, cx + 114 * math.cos(ma), cy + 114 * math.sin(ma)), fill="black", width=7)
    draw.ellipse((cx - 10, cy - 10, cx + 10, cy + 10), fill="black")
    return img


def _text(text, mode="normal"):
    img = _canvas(W, 256)
    draw = ImageDraw.Draw(img)
    _text_center(draw, (0, 0, W, 256), text, _font(96))
    if mode == "mirrored":
        img = ImageOps.mirror(img)
    elif mode == "rotated":
        img = img.rotate(90, expand=True, fillcolor="white")
    return img


def _spatial(position):
    img = _canvas()
    draw = ImageDraw.Draw(img)
    box = (170, 142, 274, 246)
    ball = {"left": (84, 194), "right": (304, 194), "above": (222, 66)}[position]
    draw.rectangle(box, outline="black", width=7)
    draw.ellipse((ball[0] - 34, ball[1] - 34, ball[0] + 34, ball[1] + 34), fill="black")
    return img


def _cat_dog():
    img = _canvas()
    draw = ImageDraw.Draw(img)
    grey = (60, 60, 60)
    draw.ellipse((108, 168, 262, 314), fill=grey)
    draw.ellipse((142, 106, 228, 192), fill=grey)
    draw.polygon([(150, 124), (158, 76), (184, 110)], fill=grey)
    draw.polygon([(220, 124), (212, 76), (186, 110)], fill=grey)
    draw.line((248, 286, 292, 242), fill=grey, width=14)
    draw.rectangle((132, 272, 148, 326), fill=grey)
    draw.rectangle((222, 272, 238, 326), fill=grey)
    draw.ellipse((154, 136, 170, 152), fill="white")
    draw.ellipse((200, 136, 216, 152), fill="white")
    draw.text((148, 326), "DOG", font=_font(52), fill="black")
    return img


def _red_blue():
    img = _canvas()
    draw = ImageDraw.Draw(img)
    draw.rectangle((92, 74, 292, 274), fill=(220, 30, 30))
    _text_center(draw, (92, 74, 292, 274), "BLUE", _font(54), fill="white")
    return img


def _arrow_word():
    img = _arrow("left")
    draw = ImageDraw.Draw(img)
    _text_center(draw, (0, 282, W, 352), "RIGHT", _font(56))
    return img


def _dots(n):
    img = _canvas()
    draw = ImageDraw.Draw(img)
    spots = [(192, 192), (110, 192), (274, 192), (192, 110), (192, 274), (110, 110), (274, 274)]
    for x, y in spots[:n]:
        draw.ellipse((x - 24, y - 24, x + 24, y + 24), fill="black")
    return img


def _color(name):
    rgb = {"red": (220, 30, 30), "green": (30, 160, 60), "blue": (30, 70, 220),
           "yellow": (240, 200, 20)}[name]
    img = _canvas()
    draw = ImageDraw.Draw(img)
    draw.ellipse((92, 92, 292, 292), fill=rgb)
    return img


def _shape(name):
    img = _canvas()
    draw = ImageDraw.Draw(img)
    if name == "circle":
        draw.ellipse((92, 92, 292, 292), fill=(90, 90, 90))
    elif name == "square":
        draw.rectangle((92, 92, 292, 292), fill=(90, 90, 90))
    else:
        draw.polygon([(192, 76), (308, 292), (76, 292)], fill=(90, 90, 90))
    return img


PHOTOS = [
    ("photo_cat", "https://huggingface.co/datasets/huggingface/documentation-images/resolve/main/"
                  "pipeline-cat-chonk.jpeg", "What animal is this?", "cat"),
    ("photo_coco", "https://huggingface.co/datasets/huggingface/documentation-images/resolve/main/"
                   "coco_sample.png", "Describe this image.", "scene"),
    ("photo_bee", "https://huggingface.co/datasets/huggingface/documentation-images/resolve/main/"
                  "bee.jpg", "What animal is this?", "bee"),
    ("photo_candy", "https://huggingface.co/datasets/huggingface/documentation-images/resolve/main/"
                    "p-blog/candy.JPG", "Describe this image.", "candy"),
    ("photo_car", "https://huggingface.co/datasets/huggingface/documentation-images/resolve/main/"
                  "transformers/tasks/car.jpg", "What is in this image?", "car"),
]


def _download(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return True
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=20) as r:
            data = r.read()
        if not data:
            return False
        from io import BytesIO
        img = Image.open(BytesIO(data)).convert("RGB")
        img.thumbnail((640, 640))
        img.save(path)
        return True
    except Exception as e:
        print(f"  skipped {os.path.basename(path)}: {e}", flush=True)
        return False


def build(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    items = []

    def add(sid, image, question, kind, expected, ext="png"):
        name = f"{sid}.{ext}"
        image.save(os.path.join(out_dir, name))
        items.append({"id": sid, "file": name, "question": question, "kind": kind, "expected": expected})

    for d in ("up", "down", "left", "right", "up-left", "up-right", "down-left", "down-right"):
        add(f"arrow_{d.replace('-', '_')}", _arrow(d), "Which way does the arrow point?", "direction", d)
    for h, m in ((12, 0), (3, 0), (6, 0), (9, 0), (1, 30), (10, 10)):
        add(f"clock_{h:02d}_{m:02d}", _clock(h, m), "What time does the clock show?", "clock",
            f"{h}:{m:02d}")
    for word in ("STOP", "LEFT"):
        for mode in ("normal", "mirrored", "rotated"):
            add(f"text_{word.lower()}_{mode}", _text(word, mode), "What is written here?", "text", word)
    for pos in ("left", "right", "above"):
        add(f"ball_{pos}_box", _spatial(pos), "Is the ball left or right of the box?", "spatial", pos)

    add("typo_cat_dog", _cat_dog(), "What animal is this?", "typographic", "cat")
    add("typo_red_blue", _red_blue(), "What color is the square?", "typographic", "red")
    add("typo_left_right", _arrow_word(), "Which way does the arrow point?", "typographic", "left")

    for n in range(1, 8):
        add(f"dots_{n}", _dots(n), "How many dots?", "count", str(n))
    for c in ("red", "green", "blue", "yellow"):
        add(f"color_{c}", _color(c), "What color is the shape?", "color", c)
    for s in ("circle", "square", "triangle"):
        add(f"shape_{s}", _shape(s), "What shape is this?", "shape", s)

    for sid, url, question, expected in PHOTOS:
        path = os.path.join(out_dir, f"{sid}.png")
        if _download(url, path):
            items.append({"id": sid, "file": f"{sid}.png", "question": question,
                          "kind": "photo", "expected": expected})

    with open(os.path.join(out_dir, "stimuli.json"), "w") as f:
        json.dump(items, f, indent=1)
    print(f"wrote {len(items)} stimuli to {out_dir}")
    return items


def build_video(out_dir):
    try:
        import imageio.v2 as imageio
    except Exception:
        print("imageio not available; skipping videos")
        return []
    os.makedirs(out_dir, exist_ok=True)
    items = []

    def frames_dot(lr):
        out = []
        for i in range(8):
            img = _canvas(160, 120)
            draw = ImageDraw.Draw(img)
            x = 20 + i * (120 / 7) if lr else 140 - i * (120 / 7)
            draw.ellipse((x - 12, 48, x + 12, 72), fill="black")
            out.append(img)
        return out

    def frames_arrow():
        out = []
        for i in range(8):
            img = _canvas(160, 120)
            draw = ImageDraw.Draw(img)
            ang = math.radians(i * 45)
            cx, cy = 80, 60
            ex, ey = cx + 42 * math.cos(ang), cy + 42 * math.sin(ang)
            draw.line((cx, cy, ex, ey), fill="black", width=9)
            px, py = -math.sin(ang), math.cos(ang)
            base = (ex - 16 * math.cos(ang), ey - 16 * math.sin(ang))
            draw.polygon([(ex, ey), (base[0] + px * 10, base[1] + py * 10),
                          (base[0] - px * 10, base[1] - py * 10)], fill="black")
            out.append(img)
        return out

    for sid, frames, expected in (("video_dot_left_to_right", frames_dot(True), "left to right"),
                                  ("video_dot_right_to_left", frames_dot(False), "right to left"),
                                  ("video_arrow_rotating", frames_arrow(), "rotating")):
        path = os.path.join(out_dir, f"{sid}.gif")
        try:
            imageio.mimsave(path, frames, duration=0.125, loop=0)
        except Exception as e:
            print(f"  skipped {sid}: {e}", flush=True)
            continue
        items.append({"id": sid, "file": f"{sid}.gif", "question": "Describe this video.",
                      "kind": "video", "expected": expected})
    if items:
        with open(os.path.join(out_dir, "videos.json"), "w") as f:
            json.dump(items, f, indent=1)
        print(f"wrote {len(items)} videos to {out_dir}")
    return items
