import { expect, test } from "bun:test";
import { totalThrough } from "./sum";
test("inclusive total", () => { expect(totalThrough(0)).toBe(0); expect(totalThrough(1)).toBe(1); expect(totalThrough(4)).toBe(10); });

test("zero has an empty sum", () => {
  expect(totalThrough(0)).toBe(0);
});

test("one includes the first term", () => {
  expect(totalThrough(1)).toBe(1);
});

test("adjacent positive bounds include their final term", () => {
  expect(totalThrough(2)).toBe(3);
  expect(totalThrough(3)).toBe(6);
  expect(totalThrough(5)).toBe(15);
});
