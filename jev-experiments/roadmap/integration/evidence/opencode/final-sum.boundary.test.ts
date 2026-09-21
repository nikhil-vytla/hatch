import { expect, test, describe } from "bun:test";
import { totalThrough } from "./sum";

describe("totalThrough boundary cases", () => {
  test("n = 0 returns 0", () => {
    expect(totalThrough(0)).toBe(0);
  });

  test("n = 1 returns 1", () => {
    expect(totalThrough(1)).toBe(1);
  });

  test("n = 2 returns 3", () => {
    expect(totalThrough(2)).toBe(3);
  });

  test("negative n returns 0 because the loop never runs", () => {
    expect(totalThrough(-1)).toBe(0);
    expect(totalThrough(-5)).toBe(0);
    expect(totalThrough(-1000)).toBe(0);
  });

  test("n = 100 returns 5050", () => {
    expect(totalThrough(100)).toBe(5050);
  });

  test("n = 1000 returns 500500", () => {
    expect(totalThrough(1000)).toBe(500500);
  });

  test("matches closed form n*(n+1)/2 for a handful of values", () => {
    const values = [0, 1, 2, 3, 5, 10, 17, 50, 99, 100, 255, 1000];
    for (const n of values) {
      expect(totalThrough(n)).toBe((n * (n + 1)) / 2);
    }
  });

  test("each step adds exactly n to the previous total", () => {
    for (let n = 1; n <= 20; n++) {
      expect(totalThrough(n)).toBe(totalThrough(n - 1) + n);
    }
  });

  test("result is always a non-negative integer", () => {
    for (const n of [-3, 0, 1, 7, 42, 1000]) {
      const result = totalThrough(n);
      expect(Number.isInteger(result)).toBe(true);
      expect(result).toBeGreaterThanOrEqual(0);
    }
  });
});
