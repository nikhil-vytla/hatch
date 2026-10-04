import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { countData } from "./build";
import {
  BINS,
  binOf,
  detectorAnswer,
  DETECTOR_THRESHOLD,
  estimate,
  FACTS_THRESHOLD,
  jevRequest,
  LETTERS,
  summarize,
  vlmQuestions,
  type Answer,
  type Item,
} from "./model";

const dir = import.meta.dir;
const doc = JSON.parse(readFileSync(join(dir, "items.json"), "utf8")) as { bins: number[][]; items: Item[] };

describe("the image set", () => {
  test("bins match choose.py and items.json", () => {
    const py = readFileSync(join(dir, "choose.py"), "utf8").match(/^BINS = (\[.*\])$/m)![1];

    expect(JSON.parse(py.replaceAll("(", "[").replaceAll(")", "]"))).toEqual(BINS);
    expect(doc.bins).toEqual(BINS);
  });

  test("every truth is its box count, in its bin, with a thumbnail and a reusable licence", () => {
    for (const it of doc.items) {
      expect(it.boxes.length).toBe(it.count);
      expect(it.bin).toBe(binOf(it.count));
      expect(existsSync(join(dir, it.thumb))).toBe(true);

      for (const s of it.sources) expect(s.licence.name).not.toMatch(/NoDerivs/);
    }
  });

  test("a composite's truth is the sum of its four photos", () => {
    const grids = doc.items.filter((it) => it.kind === "composite");

    expect(grids.length).toBeGreaterThan(0);

    for (const g of grids) {
      expect(g.sources).toHaveLength(4);
      expect(g.sources.reduce((s, x) => s + x.count, 0)).toBe(g.count);
    }
  });

  test("every bin has images, and counts reach 30 or more", () => {
    for (let b = 0; b < BINS.length; b++) expect(doc.items.some((it) => it.bin === b)).toBe(true);
  });
});

describe("questions and answers", () => {
  test("the vision model's labels are one letter or Yes/No, one per bin for the count", () => {
    const qs = vlmQuestions({ plural: "cups" });

    expect(qs[0].labels).toEqual([...LETTERS]);
    expect(LETTERS).toHaveLength(BINS.length);

    for (const q of qs.slice(1)) expect(q.labels).toEqual(["Yes", "No"]);
  });

  test("the detector counts only confident boxes; Jev is shown every box over the facts threshold", () => {
    const dets = [0.95, 0.8, DETECTOR_THRESHOLD, 0.5, FACTS_THRESHOLD, 0.1].map((score) => ({ score, box: [0, 0, 10, 10] as [number, number, number, number] }));
    const a = detectorAnswer(dets);

    expect(a.exact).toBe(3);
    expect(a.more.more2).toBe(1);
    expect(a.even).toBe(0);

    const req = jevRequest({ plural: "cups", width: 100, height: 100 }, dets);

    expect(req.state.Boxes).toHaveLength(5);
    expect(Object.keys(req.questions.count.criteria)).toEqual([...LETTERS]);
  });

  test("summaries: a perfect decider scores 1 and a one-bin-low decider 0", () => {
    const items = doc.items.slice(0, 20);
    const at = (bin: number): Answer => ({ bins: Object.fromEntries(LETTERS.map((l, i) => [l, Number(i === bin)])), more: {}, even: null, exact: null, ms: null });
    const perfect = summarize(items, new Map(items.map((it) => [it.id, at(it.bin)])));
    const low = summarize(items.filter((it) => it.bin > 0), new Map(items.map((it) => [it.id, at(it.bin - 1)])));

    expect(perfect.exactBin.mean).toBe(1);
    expect(perfect.withinOne.mean).toBe(1);
    expect(low.exactBin.mean).toBe(0);
    expect(low.withinOne.mean).toBe(1);
    expect(low.signed.mean).toBeLessThan(0);
    expect(estimate({ ...at(0), exact: 7 })).toBe(7);
  });
});

describe("the published file", () => {
  test("has every image and a lane per recording, none invented", () => {
    const d = countData(join(dir, "../.."));
    const recorded = ["qwen3-vl-4b.jsonl", "detr.jsonl", "jev.jsonl"].filter((f) => existsSync(join(dir, "recordings", f))).length;

    expect(d.items).toHaveLength(doc.items.length);
    expect(d.lanes).toHaveLength(recorded);

    for (const l of d.lanes) expect(l.n).toBe(doc.items.length);
  });
});
