import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { readRecord } from "../experience-prototypes/scripts/records";
import { initial, step } from "./arcade/engine";
test("Every recorded game has a reproducible trajectory and terminal outcome", () => {
  const r = readRecord(new URL("./arcade/results.jsonl", import.meta.url));
  expect(r.result.episodes).toHaveLength(12);
  for (const e of r.result.episodes) {
    let state = initial(e.game, e.seed);
    expect(e.completed).toBe(true);
    for (const t of e.trace) {
      expect(t.state).toEqual(state);
      state = step(state, t.action);
    }
    expect(state).toEqual(e.state);
    expect(state.status).not.toBe("playing");
  }
});
test("All local-model evidence aligns on 400 complete original cases", () => {
  const r = readRecord(
    new URL("./apple/results.jsonl", import.meta.url),
  ).result;
  expect(r.cases).toHaveLength(400);
  expect(r.models).toHaveLength(10);
  expect(r.coreml.passed).toBe(true);
  for (const c of r.cases) {
    expect(c.state).toBeTruthy();
    expect(c.questions).toHaveLength(5);
    for (const q of c.questions) {
      expect(q.instructions.length).toBeGreaterThan(0);
      expect(q.options.length).toBe(q.keys.length);
      for (const m of r.models) {
        const p = q.predictions[m.id];
        expect(p.length).toBe(q.keys.length);
        expect(
          p.every((n: number) => Number.isFinite(n) && n >= 0 && n <= 1.00001),
        ).toBe(true);
        expect(p.reduce((a: number, b: number) => a + b, 0)).toBeCloseTo(1, 5);
      }
    }
  }
});
test("Training, validation, and test share neither IDs nor exact states", () => {
  const rows = readFileSync(
    new URL("./apple/split-manifest.jsonl", import.meta.url),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s));
  const parts = ["train", "validation", "test"].map((split) =>
    rows.filter((r) => r.split === split),
  );
  expect(parts.map((p) => p.length)).toEqual([960, 240, 400]);
  for (let a = 0; a < 3; a++)
    for (let b = a + 1; b < 3; b++) {
      const ids = new Set(parts[a].map((r) => r.id)),
        states = new Set(parts[a].map((r) => r.state_sha256));
      expect(parts[b].some((r) => ids.has(r.id))).toBe(false);
      expect(parts[b].some((r) => states.has(r.state_sha256))).toBe(false);
    }
});
