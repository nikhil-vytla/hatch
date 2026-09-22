import { describe, expect, test } from "bun:test";
import { summarizeScore } from "../../experience-prototypes/src/notes/score-mechanism";

describe("the authored Score figure", () => {
  test("the same expectation can conceal opposite modal conclusions", () => {
    const split = summarizeScore(10, 50);
    const middle = summarizeScore(100, 50);
    expect(split.expected).toBe(1);
    expect(middle.expected).toBe(1);
    expect(split.modes).toEqual([0, 2]);
    expect(middle.modes).toEqual([1]);
  });
  test("an asymmetric distribution has a fractional expectation and one mode", () => {
    const result = summarizeScore(20, 87.5);
    expect(result.expected).toBeCloseTo(1.6);
    expect(result.modes).toEqual([2]);
  });
  test("every slider setting preserves a valid complete distribution", () => {
    for (let middle = 0; middle <= 100; middle++) {
      for (let high = 0; high <= 100; high += 0.5) {
        const result = summarizeScore(middle, high);
        expect(
          result.distribution.every(
            (p) => p.probability >= 0 && p.probability <= 1,
          ),
        ).toBe(true);
        expect(
          result.distribution.reduce((sum, p) => sum + p.probability, 0),
        ).toBeCloseTo(1, 12);
        expect(result.expected >= 0 && result.expected <= 2).toBe(true);
      }
    }
  });
  test("invalid external control values cannot produce a plausible score", () => {
    for (const value of [NaN, Infinity, -1, 101]) {
      expect(() => summarizeScore(value, 50)).toThrow(RangeError);
      expect(() => summarizeScore(50, value)).toThrow(RangeError);
    }
  });
});
