import { describe, expect, test } from "bun:test";
import { GAME_PAGES, gameEvidence } from "./game-evidence";
import { experiments } from "../catalog";

describe("game evidence drawers", () => {
  test("every game page is a live catalog scene", () => {
    const live = new Set(experiments.map((e) => e.id));

    for (const id of GAME_PAGES) expect(live.has(id)).toBe(true);
  });

  test("every game page has caveats, data and the About material", () => {
    for (const id of GAME_PAGES) {
      const tabs = gameEvidence(id, "about", "download").map((t) => t.id);

      expect(tabs).toContain("caveats");
      expect(tabs).toContain("data");
      expect(tabs.at(-1)).toBe("about");
    }
  });

  test("an unknown page still gets its About material", () => {
    expect(gameEvidence("nowhere", "about", null).map((t) => t.id)).toEqual(["about"]);
  });
});
