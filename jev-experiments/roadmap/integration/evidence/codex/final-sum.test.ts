import { expect, test } from "bun:test";
import { totalThrough } from "./sum";
test("inclusive total", () => { expect(totalThrough(0)).toBe(0); expect(totalThrough(1)).toBe(1); expect(totalThrough(4)).toBe(10); });

test("zero yields an empty sum", () => {
  expect(totalThrough(0)).toBe(0);
});

test("one includes the single term", () => {
  expect(totalThrough(1)).toBe(1);
});

test("two includes the upper bound", () => {
  expect(totalThrough(2)).toBe(3);
});

test("five includes every term through five", () => {
  expect(totalThrough(5)).toBe(15);
});

// Documents existing behavior outside the nonnegative integer contract.
test("negative inputs currently return zero", () => {
  expect(totalThrough(-1)).toBe(0);
  expect(totalThrough(-5)).toBe(0);
});
