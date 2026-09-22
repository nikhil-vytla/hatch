import { expect, test } from "bun:test";
import { createScene, paint, step } from "./engine";
import { inspectWindow, placeContactPair } from "./mechanism";
import { readContact } from "./contact-reading";

test("the bounded pair's frame explains the custom cell before and after contact", () => {
  const scene = createScene("empty");
  const point = placeContactPair(scene);
  const before = readContact(inspectWindow(scene, point), scene.rule);
  expect(before.custom).toBe(true);
  expect(before.enabled).toBe(true);
  expect(before.matchingSides.map((side) => side.name)).toEqual(["right"]);
  step(scene);
  expect(readContact(inspectWindow(scene, point), scene.rule).custom).toBe(false);
  expect(before.custom).toBe(true);
});

test("all four side neighbors match, while diagonals do not", () => {
  const scene = createScene("empty");
  const point = { x: 10, y: 10 };
  paint(scene, 10, 10, 7, 0);
  for (const [x, y] of [[9, 9], [11, 9], [9, 11], [11, 11]])
    paint(scene, x, y, 2, 0);
  expect(readContact(inspectWindow(scene, point), scene.rule).matchingSides).toEqual([]);
  for (const [x, y] of [[9, 10], [11, 10], [10, 9], [10, 11]])
    paint(scene, x, y, 2, 0);
  expect(readContact(inspectWindow(scene, point), scene.rule).matchingSides.map((side) => side.name))
    .toEqual(["left", "right", "above", "below"]);
});

test("outside cells and disabled contact cannot appear as a matching material", () => {
  const scene = createScene("empty");
  paint(scene, 0, 0, 7, 0);
  paint(scene, scene.width - 1, 0, 2, 0);
  const window = inspectWindow(scene, { x: 0, y: 0 });
  expect(readContact(window, scene.rule).matchingSides).toEqual([]);
  scene.rule.contact = "none";
  expect(readContact(window, scene.rule)).toEqual({ custom: true, enabled: false, matchingSides: [] });
});

test("manual rule edits are reflected without retaining an old contact answer", () => {
  const scene = createScene("empty");
  const point = placeContactPair(scene);
  const window = inspectWindow(scene, point);
  scene.rule.contact = "fire";
  expect(readContact(window, scene.rule).matchingSides).toEqual([]);
  scene.rule.contact = "water";
  expect(readContact(window, scene.rule).matchingSides.map((side) => side.name)).toEqual(["right"]);
});
