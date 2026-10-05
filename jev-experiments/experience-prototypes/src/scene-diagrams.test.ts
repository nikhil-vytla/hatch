import { describe, expect, test } from "bun:test";
import { scenes } from "./scenes";
import { diagramText } from "./scene-diagrams";

describe("collection card diagrams", () => {
  test("each diagram has a short input, an answer and a text equivalent", () => {
    for (const { id, diagram: d } of scenes) {
      expect(d.from.length, id).toBeGreaterThan(0);
      expect(d.to.length, id).toBeGreaterThan(0);
      expect(diagramText(d)).toContain("→");
      // Labels stay short enough for a card a third of a page wide.
      expect([...d.from, d.to].every((s) => s.length <= 22), id).toBe(true);
    }
  });
});
