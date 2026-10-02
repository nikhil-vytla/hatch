import { describe, expect, test } from "bun:test";
import { experiments } from "./catalog";
import { DIAGRAMS, diagramText } from "./scene-diagrams";

describe("collection card diagrams", () => {
  test("every catalog scene says how it asks Jev", () => {
    expect(experiments.filter((e) => !DIAGRAMS[e.id]).map((e) => e.id)).toEqual([]);
  });

  test("each diagram has a short input, an answer and a text equivalent", () => {
    for (const [id, d] of Object.entries(DIAGRAMS)) {
      expect(d.from.length, id).toBeGreaterThan(0);
      expect(d.to.length, id).toBeGreaterThan(0);
      expect(diagramText(d)).toContain("→");
      // Labels stay short enough for a card a third of a page wide.
      expect([...d.from, d.to].every((s) => s.length <= 22), id).toBe(true);
    }
  });
});
