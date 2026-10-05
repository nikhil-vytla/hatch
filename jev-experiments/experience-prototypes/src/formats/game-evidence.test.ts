import { describe, expect, test } from "bun:test";
import { gameEvidence } from "./game-evidence";
import { scenes } from "../scenes";

describe("game evidence drawers", () => {
  test("every game page has caveats, data and the About material", () => {
    for (const s of scenes.filter((s) => s.format === "game")) {
      const tabs = gameEvidence(s.id, "about", "download").map((t) => t.id);

      expect(tabs).toContain("caveats");
      expect(tabs).toContain("data");
      expect(tabs.at(-1)).toBe("about");
    }
  });

  test("an unknown page still gets its About material", () => {
    expect(gameEvidence("nowhere", "about", null).map((t) => t.id)).toEqual(["about"]);
  });
});
