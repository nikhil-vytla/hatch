/**
 * Builds public/count/count.json for Count with me: every image with its truth and the three
 * deciders' recorded answers, each decider's summary (overall, by count bin, by crowd size and
 * by crowding), and the thumbnails copied to public/count/images. Runs in prepare.ts. A missing
 * recording leaves its decider out, never invented.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jevCostUsd, JEV_PRICE_TEXT } from "../../packages/jev-client/src/price";
import {
  BIN_LABELS,
  DETECTOR_THRESHOLD,
  detectorAnswer,
  estimate,
  FACTS_THRESHOLD,
  GROUPS,
  jevAnswer,
  summarize,
  THRESHOLDS,
  vlmAnswer,
  vlmQuestions,
  type Answer,
  type Detection,
  type Item,
} from "./model";

function lines<T>(path: string): T[] {
  if (!existsSync(path)) return [];

  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

type VlmRow = { id: string; question: string; model: string; probabilities: Record<string, number>; ms: number };
type DetRow = { id: string; model: string; ms: number; detections: Detection[] };
type JevRow = { id: string; status: string; model: string; at: string; servedBy: string; latencyMs: number; inputTokens: number | null; answers: Parameters<typeof jevAnswer>[0] };

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);

  return s.length ? s[Math.floor(s.length / 2)] : null;
};

/** Overlap terciles: how crowded the objects are, by share of boxes touching another box. */
const CROWDING = [
  { id: "apart", label: "Apart (no boxes touch)", test: (x: number) => x === 0 },
  { id: "touching", label: "Some touch", test: (x: number) => x > 0 && x < 0.6 },
  { id: "packed", label: "Packed (most touch)", test: (x: number) => x >= 0.6 },
];

export function countData(lab: string) {
  const dir = join(lab, "live-worlds/count");
  const doc = JSON.parse(readFileSync(join(dir, "items.json"), "utf8")) as { source: string; minArea: number; items: Item[] };
  const items = doc.items;
  const vlmRows = lines<VlmRow>(join(dir, "recordings/qwen3-vl-4b.jsonl"));
  const detRows = lines<DetRow>(join(dir, "recordings/detr.jsonl"));
  const jevRows = lines<JevRow>(join(dir, "recordings/jev.jsonl")).filter((r) => r.status === "ok");

  const lanes: { id: string; label: string; sees: string; model: string; answers: Map<string, Answer> }[] = [];

  if (vlmRows.length) {
    const answers = new Map<string, Answer>();

    for (const it of items) {
      const a = vlmAnswer(vlmRows.filter((r) => r.id === it.id));

      if (a) answers.set(it.id, a);
    }

    lanes.push({ id: "vlm", label: "Qwen3-VL-4B", sees: "the photo", model: vlmRows[0].model, answers });
  }

  if (detRows.length)
    lanes.push({
      id: "detector",
      label: "DETR detector",
      sees: "the photo",
      model: detRows[0].model,
      answers: new Map(detRows.map((r) => [r.id, detectorAnswer(r.detections, r.ms)])),
    });

  if (jevRows.length && detRows.length)
    lanes.push({
      id: "jev",
      label: "Jev on the boxes",
      sees: "the detector's boxes, as text",
      model: jevRows[0].model,
      answers: new Map(jevRows.flatMap((r) => (jevAnswer(r.answers, r.latencyMs) ? [[r.id, jevAnswer(r.answers, r.latencyMs)!]] : []))),
    });

  const subset = (pick: (it: Item) => boolean) => items.filter(pick);
  const summaries = lanes.map((l) => {
    const s = summarize(items, l.answers);
    const ms = [...l.answers.values()].flatMap((a) => (a.ms === null ? [] : [a.ms]));

    return {
      id: l.id,
      label: l.label,
      sees: l.sees,
      model: l.model,
      ...s,
      medianMs: median(ms),
      groups: GROUPS.map((g) => ({ id: g.id, label: g.label, ...pickStats(summarize(subset((it) => (g.bins as readonly number[]).includes(it.bin)), l.answers)) })),
      crowding: CROWDING.map((c) => ({ id: c.id, label: c.label, ...pickStats(summarize(subset((it) => c.test(it.overlapShare)), l.answers)) })),
    };
  });

  const jevById = new Map(jevRows.map((r) => [r.id, r]));
  const detections = new Map(detRows.map((r) => [r.id, r.detections]));
  const jevTokens = jevRows.reduce((s, r) => s + (r.inputTokens ?? 0), 0);

  return {
    source: doc.source,
    minArea: doc.minArea,
    bins: BIN_LABELS,
    thresholds: THRESHOLDS,
    detectorThreshold: DETECTOR_THRESHOLD,
    factsThreshold: FACTS_THRESHOLD,
    prompts: vlmQuestions({ plural: "{objects}" }),
    jev: jevRows.length
      ? { requests: jevRows.length, inputTokens: jevTokens, costUsd: Math.round(jevCostUsd(jevTokens) * 1e5) / 1e5, price: JEV_PRICE_TEXT }
      : null,
    lanes: summaries,
    items: items.map((it) => ({
      id: it.id,
      kind: it.kind,
      category: it.category,
      plural: it.plural,
      count: it.count,
      bin: it.bin,
      thumb: it.thumb,
      width: it.width,
      height: it.height,
      thumbWidth: it.thumbWidth,
      thumbHeight: it.thumbHeight,
      overlapShare: it.overlapShare,
      boxes: it.boxes,
      jev: jevById.has(it.id) ? { inputTokens: jevById.get(it.id)!.inputTokens, at: jevById.get(it.id)!.at, servedBy: jevById.get(it.id)!.servedBy } : null,
      detections: (detections.get(it.id) ?? []).map((d) => ({ score: d.score, box: d.box })),
      licence: it.licence,
      credit: it.sources.map((s) => ({ cocoId: s.cocoId, licence: s.licence.name, licenceUrl: s.licence.url, noncommercial: s.noncommercial, flickr: s.flickr ?? null, coco: s.coco })),
      answers: Object.fromEntries(
        lanes.flatMap((l) => {
          const a = l.answers.get(it.id);

          if (!a) return [];

          return [
            [
              l.id,
              {
                bins: Object.fromEntries(Object.entries(a.bins).map(([k, v]) => [k, r3(v)])),
                more: Object.fromEntries(Object.entries(a.more).map(([k, v]) => [k, r3(v)])),
                even: a.even === null ? null : r3(a.even),
                exact: a.exact,
                estimate: estimate(a),
                ms: a.ms === null ? null : Math.round(a.ms),
              },
            ],
          ];
        }),
      ),
    })),
  };
}

function pickStats(s: ReturnType<typeof summarize>) {
  return { n: s.n, exactBin: s.exactBin, withinOne: s.withinOne, absError: s.absError, signed: s.signed };
}

export type CountData = ReturnType<typeof countData>;

export function buildCount(lab: string, outDir: string) {
  const data = countData(lab);

  mkdirSync(join(outDir, "images"), { recursive: true });

  for (const it of data.items) copyFileSync(join(lab, "live-worlds/count", it.thumb), join(outDir, it.thumb));

  writeFileSync(join(outDir, "count.json"), JSON.stringify(data) + "\n");

  return data.lanes.length;
}
