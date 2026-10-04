import { describe, expect, test } from "bun:test";
import { experiments, retiredScene } from "./catalog";
import { START_PATHS } from "./start-here";

describe("start here", () => {
  test("three paths, each with three to five cards", () => {
    expect(START_PATHS.map((p) => p.id)).toEqual(["check", "play", "build"]);

    for (const p of START_PATHS) {
      expect(p.cards.length).toBeGreaterThanOrEqual(3);
      expect(p.cards.length).toBeLessThanOrEqual(5);
    }
  });

  test("every scene card points at a live catalog scene", () => {
    const ids = new Set(experiments.map((e) => e.id));

    for (const c of START_PATHS.flatMap((p) => p.cards)) {
      if (!c.scene) continue;

      expect(ids.has(c.scene)).toBe(true);
      expect(retiredScene(c.scene)).toBeUndefined();
      expect(c.href).toBe(`#experiment/${c.scene}`);
    }
  });
});
