"""Choose the Count with me images from COCO val2017 and write items.json plus thumbnails.

Ground truth is COCO's own instance annotations (CC BY 4.0), counted per image for one category.
A photo qualifies only when:
- its Flickr licence allows reuse with attribution and derivatives (COCO licence ids 1 BY-NC-SA,
  2 BY-NC, 4 BY, 5 BY-SA, 7 no known copyright restrictions, 8 US government work). No-derivative
  licences (3, 6) are excluded. Non-commercial ones are flagged per item; the site is
  non-commercial;
- the category has no "iscrowd" region, since a crowd region means some instances were never
  counted;
- every instance of the category is at least MIN_AREA pixels.

COCO never has 20 or more exactly counted instances of one category in a photo: annotators mark
crowds instead. So the two largest bins are composites, 2x2 grids of four real COCO photos of
the same category, labelled as composites, whose exact total is the sum of the tiles.

Deterministic: candidates are ordered by a hash of their image id and category.

    python live-worlds/count/choose.py --annotations instances_val2017.json --cache DIR
"""

import argparse
import hashlib
import io
import json
import os
import urllib.request
from collections import defaultdict

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))

# Count bins shared with model.ts (keep in sync; a test checks it).
BINS = [(1, 1), (2, 2), (3, 3), (4, 5), (6, 8), (9, 12), (13, 19), (20, 29), (30, 999)]
PHOTO_BINS = 7  # bins 0-6 are single photos; 7-8 are composites
PER_BIN = 12
COMPOSITES_PER_BIN = 8
MIN_AREA = 100  # px^2 at COCO's resolution (about 10 x 10)
LICENCES = {1, 2, 4, 5, 7, 8}
NONCOMMERCIAL = {1, 2}
CELL = 320
CATEGORIES = {
    "person": "people",
    "car": "cars",
    "bird": "birds",
    "sheep": "sheep",
    "cow": "cows",
    "chair": "chairs",
    "bottle": "bottles",
    "cup": "cups",
    "book": "books",
    "donut": "donuts",
    "banana": "bananas",
    "umbrella": "umbrellas",
    "kite": "kites",
    "boat": "boats",
    "zebra": "zebras",
    "elephant": "elephants",
    "horse": "horses",
    "orange": "oranges",
}


def bin_of(n):
    for i, (lo, hi) in enumerate(BINS):
        if lo <= n <= hi:
            return i
    raise ValueError(n)


def overlap_share(boxes):
    """Share of instances whose box overlaps another instance's box: a rough occlusion measure."""

    def inter(a, b):
        ax, ay, aw, ah = a
        bx, by, bw, bh = b
        return max(0, min(ax + aw, bx + bw) - max(ax, bx)) * max(0, min(ay + ah, by + bh) - max(ay, by))

    if len(boxes) < 2:
        return 0.0
    hit = sum(1 for i, a in enumerate(boxes) if any(inter(a, b) > 0 for j, b in enumerate(boxes) if j != i))
    return hit / len(boxes)


def fetch(url, path):
    if not os.path.exists(path):
        with urllib.request.urlopen(url, timeout=60) as r:
            open(path, "wb").write(r.read())
    return Image.open(path).convert("RGB")


def thumbnail(img, path):
    t = img.copy()
    t.thumbnail((480, 480))
    buf = io.BytesIO()
    t.save(buf, "JPEG", quality=72, optimize=True)
    open(path, "wb").write(buf.getvalue())
    return t.width, t.height


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--annotations", required=True)
    p.add_argument("--cache", required=True, help="where full-size images are kept (not committed)")
    args = p.parse_args()

    coco = json.load(open(args.annotations))
    licences = {l["id"]: l for l in coco["licenses"]}
    cats = {c["id"]: c["name"] for c in coco["categories"] if c["name"] in CATEGORIES}
    images = {im["id"]: im for im in coco["images"]}

    per = defaultdict(list)
    crowd = set()
    for a in coco["annotations"]:
        if a["category_id"] not in cats:
            continue
        key = (a["image_id"], cats[a["category_id"]])
        if a["iscrowd"]:
            crowd.add(key)
        else:
            per[key].append(a)

    cands = []
    for (image_id, cat), anns in per.items():
        im = images[image_id]
        if (image_id, cat) in crowd or im["license"] not in LICENCES:
            continue
        if any(a["area"] < MIN_AREA for a in anns):
            continue
        cands.append({
            "order": hashlib.sha256(f"{image_id}:{cat}".encode()).hexdigest(),
            "cocoId": image_id,
            "category": cat,
            "count": len(anns),
            "image": im,
            "boxes": [a["bbox"] for a in anns],
        })
    cands.sort(key=lambda c: c["order"])

    used = set()
    chosen = []
    for b in range(PHOTO_BINS):
        by_cat = defaultdict(list)
        for c in cands:
            if bin_of(c["count"]) == b:
                by_cat[c["category"]].append(c)
        order = sorted(by_cat, key=lambda c: (-len(by_cat[c]), c))
        picked = []
        while len(picked) < PER_BIN and any(by_cat[c] for c in order):
            for cat in order:
                while by_cat[cat] and by_cat[cat][0]["cocoId"] in used:
                    by_cat[cat].pop(0)
                if by_cat[cat] and len(picked) < PER_BIN:
                    c = by_cat[cat].pop(0)
                    used.add(c["cocoId"])
                    picked.append({"kind": "photo", "tiles": [c], "category": cat, "count": c["count"]})
        print(f"bin {BINS[b]}: {len(picked)} photos")
        chosen += picked

    # Composites: four unused photos of one category whose counts sum to the target.
    targets = {7: [20, 21, 23, 24, 25, 26, 27, 29], 8: [30, 32, 34, 36, 38, 40, 43, 46]}
    tile_pool = defaultdict(list)
    for c in cands:
        if c["cocoId"] not in used and 3 <= c["count"] <= 19:
            tile_pool[c["category"]].append(c)
    rotation = sorted((cat for cat in tile_pool if len(tile_pool[cat]) >= 8), key=lambda c: (-len(tile_pool[c]), c))

    def four_summing(pool, total):
        # Deterministic search over the first 60 candidates, in hash order.
        pool = [c for c in pool if c["cocoId"] not in used][:60]
        n = len(pool)
        for i in range(n):
            for j in range(i + 1, n):
                for k in range(j + 1, n):
                    rest = total - pool[i]["count"] - pool[j]["count"] - pool[k]["count"]
                    for m in range(k + 1, n):
                        if pool[m]["count"] == rest:
                            return [pool[i], pool[j], pool[k], pool[m]]
        return None

    turn = 0
    for b, totals in targets.items():
        made = 0
        for total in totals:
            for attempt in range(len(rotation)):
                cat = rotation[(turn + attempt) % len(rotation)]
                tiles = four_summing(tile_pool[cat], total)
                if tiles:
                    for t in tiles:
                        used.add(t["cocoId"])
                    chosen.append({"kind": "composite", "tiles": tiles, "category": cat, "count": total})
                    turn += attempt + 1
                    made += 1
                    break
        print(f"bin {BINS[b]}: {made} composites")

    os.makedirs(args.cache, exist_ok=True)
    thumbs = os.path.join(HERE, "images")
    os.makedirs(thumbs, exist_ok=True)
    items = []
    for c in sorted(chosen, key=lambda c: (c["count"], c["tiles"][0]["order"])):
        tiles = c["tiles"]
        sources = []
        for t in tiles:
            im = t["image"]
            lic = licences[im["license"]]
            sources.append({
                "cocoId": t["cocoId"],
                "count": t["count"],
                "licence": {"name": lic["name"], "url": lic["url"]},
                "noncommercial": im["license"] in NONCOMMERCIAL,
                "flickr": im.get("flickr_url"),
                "coco": im["coco_url"],
            })
        if c["kind"] == "photo":
            t = tiles[0]
            img = fetch(t["image"]["coco_url"], os.path.join(args.cache, f"{t['cocoId']:012d}.jpg"))
            boxes = t["boxes"]
            tid = f"{c['category']}-{t['cocoId']}"
        else:
            img = Image.new("RGB", (CELL * 2, CELL * 2), (244, 236, 222))
            boxes = []
            for i, t in enumerate(tiles):
                src = fetch(t["image"]["coco_url"], os.path.join(args.cache, f"{t['cocoId']:012d}.jpg"))
                s = min(CELL / src.width, CELL / src.height)
                w, h = round(src.width * s), round(src.height * s)
                ox, oy = (i % 2) * CELL + (CELL - w) // 2, (i // 2) * CELL + (CELL - h) // 2
                img.paste(src.resize((w, h), Image.LANCZOS), (ox, oy))
                boxes += [[ox + x * s, oy + y * s, bw * s, bh * s] for x, y, bw, bh in t["boxes"]]
            tid = f"{c['category']}-grid-" + "-".join(str(t["cocoId"]) for t in tiles)
            tid = f"{c['category']}-grid-{hashlib.sha256(tid.encode()).hexdigest()[:8]}"
            img.save(os.path.join(args.cache, f"{tid}.jpg"), "JPEG", quality=92)
        tw, th = thumbnail(img, os.path.join(thumbs, f"{tid}.jpg"))
        area = img.width * img.height
        areas = sorted(b[2] * b[3] for b in boxes)
        items.append({
            "id": tid,
            "kind": c["kind"],
            "category": c["category"],
            "plural": CATEGORIES[c["category"]],
            "count": c["count"],
            "bin": bin_of(c["count"]),
            "width": img.width,
            "height": img.height,
            "file": f"{tiles[0]['cocoId']:012d}.jpg" if c["kind"] == "photo" else f"{tid}.jpg",
            "thumb": f"images/{tid}.jpg",
            "thumbWidth": tw,
            "thumbHeight": th,
            # Ground-truth boxes in this image's pixel coordinates, so the page can show the answer.
            "boxes": [[round(v, 1) for v in b] for b in boxes],
            "overlapShare": round(overlap_share(boxes), 3),
            "medianAreaPct": round(areas[len(areas) // 2] / area * 100, 3),
            "sources": sources,
        })

    json.dump(
        {
            "source": "COCO 2017 validation set (cocodataset.org). Annotations CC BY 4.0; each photo under its own Flickr licence, listed per item. Composites are 2x2 grids of four COCO photos.",
            "bins": [list(b) for b in BINS],
            "minArea": MIN_AREA,
            "items": items,
        },
        open(os.path.join(HERE, "items.json"), "w"),
        indent=1,
    )
    total = sum(os.path.getsize(os.path.join(thumbs, f)) for f in os.listdir(thumbs))
    print(f"{len(items)} items, thumbnails {total / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
