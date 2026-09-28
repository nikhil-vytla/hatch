import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { buildArena } from "./build";
import { predsSchema, targetsSchema } from "./chunks";

const present = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`Missing ${what}`);

  return value;
};

const cafeScoresSchema = z.object({
  rows: z.array(
    z.object({
      score: z.object({
        exact: z.boolean(),
        feasibleSetExact: z.boolean(),
        guardedSuggestedHardViolation: z.boolean(),
      }),
    }),
  ),
});

describe("arena data build", () => {
  test("publishes a small index whose numbers match the recordings", async () => {
    const out = mkdtempSync(join(tmpdir(), "arena-"));
    const index = await buildArena(out);
    expect(readFileSync(join(out, "index.json")).length).toBeLessThan(120_000);

    const card = (id: string) =>
      present(
        index.cards.find((c) => c.id === id),
        `card ${id}`,
      );

    const turns = card("tetris-turns");
    expect(turns.results["jev.spot-clean"].lines.perItem?.map((p) => p.value)).toEqual([
      13, 14, 12, 12, 14, 8, 11,
    ]);
    expect(turns.results["jev.spot-score"].lines.coverage).toEqual({ covered: 3, of: 7 });
    const rt = card("tetris-realtime");
    // Default lanes never mix protocols.
    const defaults = rt.contestants.filter((c) => c.default && c.kind === "hosted");
    expect(new Set(defaults.flatMap((c) => c.runSets)).size).toBe(1);
    const study = card("typed-decisions");
    const jev = study.results.jev.agreement;
    expect(jev.value).toBeCloseTo(0.728, 3);
    expect(jev.lo).toBeLessThan(jev.value);
    expect(jev.hi).toBeGreaterThan(jev.value);

    // Code players make no model calls, so timing metrics are omitted rather than shown as 0 ms.
    expect(card("tetris-turns").results["code.planner"].decisionMs).toBeUndefined();
    expect(card("tetris-realtime").results["code.planner"].decisionMs).toBeUndefined();

    for (const c of index.cards)
      for (const m of c.metrics) expect(m.domain?.[1]).toBeGreaterThan(0);

    for (const c of index.cards)
      for (const ct of c.contestants) expect(c.results[ct.id]?.[c.primary]).toBeDefined();

    for (const c of index.cards)
      for (const [, perItem] of Object.entries(c.chunks.replay ?? {}))
        for (const path of Object.values(perItem))
          expect(() => readFileSync(join(out, path))).not.toThrow();
  }, 60_000);
});

describe("café card", () => {
  test("Jev's numbers match the recorded café evidence", async () => {
    const { readRecord } = await import("../../../../experience-prototypes/scripts/records");
    const { resolve } = await import("node:path");

    const doc = cafeScoresSchema.parse(
      readRecord(resolve(import.meta.dir, "../../../../cafe-jev/cafe.jsonl")).result,
    );

    const out = mkdtempSync(join(tmpdir(), "arena-cafe-"));
    const { cafeCard } = await import("./build");
    const card = cafeCard(out);
    const n = doc.rows.length;
    expect(n).toBe(102);
    const jev = card.results.jev;
    expect(jev.exact.value).toBeCloseTo(doc.rows.filter((r) => r.score.exact).length / n, 12);
    expect(jev.feasible.value).toBeCloseTo(
      doc.rows.filter((r) => r.score.feasibleSetExact).length / n,
      12,
    );
    expect(jev.violation.value).toBeCloseTo(
      doc.rows.filter((r) => r.score.guardedSuggestedHardViolation).length / n,
      12,
    );

    for (const m of ["exact", "fields", "feasible", "violation"]) {
      expect(jev[m].lo).toBeLessThanOrEqual(jev[m].value);
      expect(jev[m].hi).toBeGreaterThanOrEqual(jev[m].value);
    }

    // Chunks align: one prediction row per case × field.
    const read = (path: string) => JSON.parse(readFileSync(join(out, path), "utf8"));
    const targets = targetsSchema.parse(read(present(card.chunks.targets, "targets chunk")));

    for (const path of Object.values(present(card.chunks.preds, "prediction chunks")))
      expect(predsSchema.parse(read(path)).p.length).toBe(targets.rows.length);
    expect(card.provenance).toContain("not independently annotated");
  }, 60_000);
});
