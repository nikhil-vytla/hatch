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
    expect(turns.results["jev.spot-clean"].lines.perItem!.map((p) => p.value)).toEqual([13, 14, 12, 12, 14, 8, 11]);
    expect(turns.results["jev.spot-score"].lines.coverage).toEqual({ covered: 3, of: 7 });
    const rt = card("tetris-realtime");
    // Default lanes never mix protocols.
    const defaults = rt.contestants.filter((c) => c.default && c.kind === "hosted");
    expect(new Set(defaults.flatMap((c) => c.runSets)).size).toBe(1);
    const study = card("typed-decisions");
    const jev = study.results.jev.agreement;
    expect(jev.value).toBeCloseTo(0.728, 3);
    expect(jev.lo! < jev.value && jev.value < jev.hi!).toBe(true);
    for (const c of index.cards) for (const ct of c.contestants) expect(c.results[ct.id]?.[c.primary]).toBeDefined();
    for (const c of index.cards) for (const [, perItem] of Object.entries(c.chunks.replay ?? {})) for (const path of Object.values(perItem)) expect(() => readFileSync(join(out, path))).not.toThrow();
  }, 60_000);
});
