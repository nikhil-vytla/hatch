import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildArena } from "./build";

describe("arena data build", () => {
  test("publishes a small index whose numbers match the recordings", async () => {
    const out = mkdtempSync(join(tmpdir(), "arena-"));
    const index = await buildArena(out);
    expect(readFileSync(join(out, "index.json")).length).toBeLessThan(120_000);
    const card = (id: string) => index.cards.find((c) => c.id === id)!;
    const turns = card("tetris-turns");
    expect(turns.results["jev.spot-clean"].lines.perItem!.map((p) => p.value)).toEqual([
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
    expect(jev.lo! < jev.value && jev.value < jev.hi!).toBe(true);

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
    const doc = readRecord(resolve(import.meta.dir, "../../../../cafe-jev/cafe.jsonl")).result;
    const out = mkdtempSync(join(tmpdir(), "arena-cafe-"));
    const { cafeCard } = await import("./build");
    const card = cafeCard(out);
    const n = doc.rows.length;
    expect(n).toBe(102);
    const jev = card.results.jev;
    expect(jev.exact.value).toBeCloseTo(doc.rows.filter((r: any) => r.score.exact).length / n, 12);
    expect(jev.feasible.value).toBeCloseTo(
      doc.rows.filter((r: any) => r.score.feasibleSetExact).length / n,
      12,
    );
    expect(jev.violation.value).toBeCloseTo(
      doc.rows.filter((r: any) => r.score.guardedSuggestedHardViolation).length / n,
      12,
    );

    for (const m of ["exact", "fields", "feasible", "violation"])
      expect(jev[m].lo! <= jev[m].value && jev[m].value <= jev[m].hi!).toBe(true);
    // Chunks align: one prediction row per case × field.
    const targets = JSON.parse(readFileSync(join(out, card.chunks.targets!), "utf8"));

    for (const id of Object.keys(card.chunks.preds!))
      expect(JSON.parse(readFileSync(join(out, card.chunks.preds![id]), "utf8")).p.length).toBe(
        targets.rows.length,
      );
    expect(card.provenance).toContain("not independently annotated");
  }, 60_000);
});
