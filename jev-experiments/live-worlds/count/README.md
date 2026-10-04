# Count with me

How well do models count, and where does it break as the crowd grows? Recent benchmarks of spatial competence ([arXiv 2604.09594](https://arxiv.org/abs/2604.09594)) and of visual blind spots (Blind-Spots-Bench, [arXiv 2607.08317](https://arxiv.org/abs/2607.08317)) find frontier models miscount crowds. This scene checks the same thing on a small, open set where every answer is known, and lets a visitor guess first.

Three deciders answer the same typed questions about each image:

| Decider | Sees | How it answers |
| --- | --- | --- |
| Qwen3-VL-4B-Instruct, 4-bit (Apache-2.0), MLX-VLM on an M4 Max | the full-size image | one prefill per question; softmax over the answer labels' logits at the answer position (SGLang-style decisions); nothing generated |
| DETR ResNet-50, `Xenova/detr-resnet-50` (Apache-2.0), transformers.js | the full-size image | its count is the number of boxes of the category at 70% confidence or more |
| Jev (text-only) | the detector's boxes at 30%+ confidence, as text: confidence and position of each | one request with the six typed questions; it judges which boxes to believe |

The questions:

- **count**, a choice over nine bins: 1, 2, 3, 4–5, 6–8, 9–12, 13–19, 20–29, 30 or more (letters A–I);
- **more than N?** as yes/no, for N = 2, 5, 10, 20;
- **is the count even?** as yes/no.

No model here was trained on Jev's outputs.

## Results (98 images)

Overall, with 95% bootstrap intervals over images:

| Decider | Right bin | Within one bin | Mean error (objects) | "More than N?" right | "Even?" right |
| --- | --- | --- | --- | --- | --- |
| Qwen3-VL-4B | 39% (30–48) | 68% | 4.6 (3.4–6.0) | 87% | 47% (37–57) |
| DETR | 43% (33–53) | 81% | 3.4 (2.6–4.3) | 87% | 58% (48–68) |
| Jev on the boxes | 45% (35–55) | 79% | 3.8 (2.8–4.9) | 87% | 58% (48–68) |

By crowd size (right bin):

| True count | Images | Qwen3-VL-4B | DETR | Jev on the boxes |
| --- | --- | --- | --- | --- |
| 1 to 3 | 36 | 67% | 56% | 58% |
| 4 to 12 | 36 | 33% | 39% | 42% |
| 13 or more | 26 | 8% | 31% | 31% |

- The vision model was right on all 12 single-object photos, and wrong on every image with 13–29 objects. On the 30+ composites it said too few by about 16 on average (using the middle of its chosen bin).
- The detector and Jev degrade more slowly. Jev can only count what the detector reports, so it shares the detector's misses. On the crowds it pulled the count back toward the truth when the detector over-boxed: its mean error on 30+ was 4.4, against the detector's 8.5.
- "Is the count even?" sits at chance for all three. The detector's and Jev's parity is no better than their counts.

The per-bin table with intervals is in the page's evidence drawer and in `public/count/count.json` after a build. Bins hold about a dozen images, so their intervals are wide.

Latency (median, one M4 Max, warm; the vision and detector runs overlapped, so both are a little slow):
- **Vision model:** 3.8 s per image for six prefills, about 0.6 s each. Peak server memory was 4.3 GB.
- **DETR:** 2.3 s per image, in transformers.js on the CPU.
- **Jev:** 255 ms per request, as reported by the gateway.

Jev cost $0.0048 at list price for all 98 requests, about 114k input tokens ($0.042 per million).

## The images

The images are 98 items from the [COCO 2017](https://cocodataset.org) validation set, across 18 categories (people, cars, chairs, books, cups, bottles, animals, fruit and more). There are 12 per bin for bins 1 to 13–19, 8 at 20–29 and 6 at 30+. `choose.py` picks them deterministically (in hash order) from `instances_val2017.json`. An image qualifies only if:

- its Flickr licence allows reuse with attribution and changes: BY, BY-SA, BY-NC, BY-NC-SA or no known copyright restrictions. No-derivatives licences are excluded, because the page shows resized photos and grids;
- that category has no `iscrowd` region, since a crowd region means some instances were never counted one by one;
- every instance is at least 100 px² at COCO's resolution.

**Composites.** COCO never outlines 20 or more of one category individually; annotators mark a crowd instead. So the 20–29 and 30+ bins are 2×2 grids of four real COCO photos of the same category, whose truth is the sum of the four. The page and every prompt say so ("If the image is a grid of photos, count across all of them"). They test counting across a busy image, not one dense crowd.

**Licences and attribution.** The annotations are CC BY 4.0 (COCO Consortium). The 98 items use 140 source photos:

| Licence | Photos |
| --- | --- |
| BY-NC-SA 2.0 | 64 |
| BY 2.0 | 38 |
| BY-NC 2.0 | 19 |
| BY-SA 2.0 | 18 |
| No known copyright restrictions | 1 |

Every item in `items.json` lists each source photo's COCO id, licence and URL, and its Flickr and COCO links, and the page credits each photo under it. 63 items include a non-commercial photo; the site is non-commercial.

The committed thumbnails (`images/`, 480 px JPEG) total 3.2 MB. Full-size originals are fetched from COCO into a local cache and are not committed.

## Files

- `choose.py` picks the images and writes `items.json` and `images/`. It needs Pillow and COCO's annotations zip (241 MB, not committed).
- `model.ts` holds the bins, prompts, Jev's request, the answer readers and the metrics. It uses the seeded bootstrap from `packages/arena/prose/metrics.ts`.
- `record-vlm.ts` records the vision model against `eyes/vlm_server.py` to `recordings/qwen3-vl-4b.jsonl` (588 rows: 98 images × 6 questions).
- `../../experience-prototypes/scripts/count-detect.ts` records DETR's boxes to `recordings/detr.jsonl`.
- `record-jev.ts` records Jev to `recordings/jev.jsonl`, with a hard cap of $0.10 at list price.
- `build.ts` writes `public/count/count.json` and copies the thumbnails; `prepare.ts` runs it.
- `count.test.ts` checks the bins, truths, licences, composites and metrics.

To reproduce:

```sh
python live-worlds/count/choose.py --annotations instances_val2017.json --cache ORIGINALS
python live-worlds/eyes/vlm_server.py --port 30110   # Qwen3-VL-4B by default; stop it by PID afterwards
bun live-worlds/count/record-vlm.ts --cache ORIGINALS
(cd experience-prototypes && bun scripts/count-detect.ts --cache ORIGINALS)
bun live-worlds/count/record-jev.ts --pilot && bun live-worlds/count/record-jev.ts
```

## Caveats

- Each decider ran once, on about a dozen images per bin.
- COCO's outlines are the truth, and annotators sometimes miss small or distant objects.
- The vision model and Jev answer in bins. Their mean error uses the bin's middle (38 for "30 or more"), so it is approximate.
- Qwen3-VL-4B is small, quantised and zero-shot. Larger models count better, though the papers above find they still miss crowds.
- DETR was trained on COCO train2017. These are val2017 images, but the detector knows COCO's style and categories.
- Crowding (the share of true boxes touching another) is tangled with count, because packed images also hold more objects.
