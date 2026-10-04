/**
 * Records the detector lane of Count with me: DETR ResNet-50 (Xenova/detr-resnet-50, Apache-2.0,
 * via transformers.js) finds objects in each full-size image; its boxes of the asked category at
 * FACTS_THRESHOLD or above are kept. Local and free. DETR was trained on COCO train2017; these
 * images are from val2017, which it never trained on.
 *
 *   cd jev-experiments/experience-prototypes && bun scripts/count-detect.ts --cache DIR
 */
import { pipeline, RawImage } from "@huggingface/transformers";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FACTS_THRESHOLD, type Item } from "../../live-worlds/count/model";

export const DETECTOR = "Xenova/detr-resnet-50";

const i = process.argv.indexOf("--cache");
const cache = i > 0 ? process.argv[i + 1] : null;

if (!cache) throw Error("Pass --cache, the directory choose.py kept full-size images in.");

type Found = { score: number; label: string; box: { xmin: number; ymin: number; xmax: number; ymax: number } };

// SAFETY: transformers.js types the pipeline loosely; this is the object-detection call shape.
const detect = (await pipeline("object-detection", DETECTOR, { dtype: "fp32" })) as unknown as (
  image: RawImage,
  options: { threshold: number; percentage: boolean },
) => Promise<Found[]>;

const dir = new URL("../../live-worlds/count/recordings/", import.meta.url);

mkdirSync(dir, { recursive: true });

const out = new URL("detr.jsonl", dir);
const { items } = JSON.parse(readFileSync(new URL("../../live-worlds/count/items.json", import.meta.url), "utf8")) as { items: Item[] };
const done = new Set(
  existsSync(out)
    ? readFileSync(out, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l).id)
    : [],
);

for (const item of items) {
  if (done.has(item.id)) continue;

  const image = await RawImage.read(join(cache, item.file));
  const t = performance.now();
  const found = await detect(image, { threshold: FACTS_THRESHOLD, percentage: false });
  const ms = performance.now() - t;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const detections = found
    .filter((f) => f.label === item.category)
    .map((f) => ({
      score: Math.round(f.score * 1000) / 1000,
      box: [r1(f.box.xmin), r1(f.box.ymin), r1(f.box.xmax - f.box.xmin), r1(f.box.ymax - f.box.ymin)],
    }));

  appendFileSync(out, JSON.stringify({ id: item.id, model: DETECTOR, threshold: FACTS_THRESHOLD, ms: Math.round(ms), detections }) + "\n");
  console.log(`${item.id}: ${detections.length} (truth ${item.count}) in ${Math.round(ms)} ms`);
}
