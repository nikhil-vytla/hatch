import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createScene, step, WIDTH } from "./engine";
import {
  inspectWindow,
  materialSourceMarkers,
  placeContactPair,
} from "./mechanism";
import { sourceExcerpt } from "../../experience-prototypes/src/components/source-code/source";

test("the authored pair changes only its bounded patch, keeping the active rule and seed", () => {
  const scene = createScene();
  const before = structuredClone(scene);
  const point = placeContactPair(scene);
  expect(scene.rule).toEqual(before.rule);
  expect(scene.seed).toBe(before.seed);
  expect(scene.tick).toBe(before.tick);
  for (let y = 0; y < scene.height; y++)
    for (let x = 0; x < scene.width; x++) {
      if (x >= 45 && x <= 52 && y >= 28 && y <= 34) continue;
      const i = y * WIDTH + x;
      expect(scene.cells[i]).toBe(before.cells[i]);
      expect(scene.ages[i]).toBe(before.ages[i]);
    }
  expect(inspectWindow(scene, point).cells[4]).toBe(7);
});

test("one step of the default pair transforms purple dust while its water neighbor remains", () => {
  for (const tick of [0, 1]) {
    const scene = createScene("empty");
    scene.tick = tick;
    const point = placeContactPair(scene);
    const before = inspectWindow(scene, point);
    step(scene);
    const after = inspectWindow(scene, point);
    expect(before.cells[4]).toBe(7);
    expect(after.cells[4]).toBe(4);
    expect(before.cells[5]).toBe(2);
    expect(after.cells[5]).toBe(2);
    expect(after.tick).toBe(before.tick + 1);
    expect(before.cells[4]).toBe(7);
  }
});

test("a changed contact rule produces a different local result from the same pair", () => {
  const scene = createScene("empty");
  const point = placeContactPair(scene);
  scene.rule.contact = "none";
  step(scene);
  expect(inspectWindow(scene, point).cells[4]).toBe(7);
});

test("edge neighborhoods retain grid positions and mark missing neighbors", () => {
  const scene = createScene("empty");
  expect(inspectWindow(scene, { x: 0, y: 0 }).cells).toEqual([
    null,
    null,
    null,
    null,
    0,
    0,
    null,
    0,
    0,
  ]);
});

test("mechanism excerpts have exact bounds in the actual engine", () => {
  const text = readFileSync(new URL("./engine.ts", import.meta.url), "utf8");
  const source = { text, path: "jev-experiments/roadmap/materials/engine.ts" };
  for (const markers of Object.values(materialSourceMarkers)) {
    const excerpt = sourceExcerpt(source, markers);
    expect(excerpt).not.toBeNull();
    expect(
      text
        .split("\n")
        .slice(excerpt!.startLine - 1, excerpt!.endLine)
        .join("\n")
        .trimEnd(),
    ).toBe(excerpt!.text);
    expect(
      sourceExcerpt({ ...source, text: "Source moved" }, markers),
    ).toBeNull();
  }
});
