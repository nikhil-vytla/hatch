import { expect, test } from "bun:test";
import { totalThrough } from "./sum";
test("inclusive total", () => { expect(totalThrough(0)).toBe(0); expect(totalThrough(1)).toBe(1); expect(totalThrough(4)).toBe(10); });

test("small n values", () => {
  expect(totalThrough(2)).toBe(3);
  expect(totalThrough(5)).toBe(15);
});

test("large n", () => {
  expect(totalThrough(100)).toBe(5050);
});

test("negative n returns 0", () => {
  expect(totalThrough(-1)).toBe(0);
  expect(totalThrough(-100)).toBe(0);
});

test("zero returns 0", () => {
  expect(totalThrough(0)).toBe(0);
});
