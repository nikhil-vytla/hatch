import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { experiments, retired } from "./catalog";
import { experimentNotes } from "./notes/manifest";

const live = new Set(experiments.map((e) => e.id));

describe("catalog links", () => {
  test("a retired scene's replacement is a live scene, not another retired one", () => {
    for (const [id, r] of Object.entries(retired)) {
      const href = r.instead?.href;

      if (!href?.startsWith("#experiment/")) continue;

      expect({ id, target: href.slice("#experiment/".length), live: live.has(href.slice("#experiment/".length)) }).toEqual({
        id,
        target: href.slice("#experiment/".length),
        live: true,
      });
    }
  });

  test("every note's scene exists, live or retired", () => {
    for (const note of experimentNotes) expect(live.has(note.scene) || Object.hasOwn(retired, note.scene)).toBe(true);
  });

  test("every live scene has a view", () => {
    const page = readFileSync(new URL("./pages/experiment.tsx", import.meta.url), "utf8");

    for (const id of live) expect(page.includes(`case "${id}":`)).toBe(true);
  });

  test("no scene is both live and retired", () => {
    for (const id of live) expect(Object.hasOwn(retired, id)).toBe(false);
  });
});
