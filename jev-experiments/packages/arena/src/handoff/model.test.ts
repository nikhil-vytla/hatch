import { describe, expect, test } from "bun:test";
import { cheapest, curve, split, thresholds, top } from "./model";

const d = [
  { confidence: 0.95, right: true },
  { confidence: 0.9, right: true },
  { confidence: 0.7, right: false },
  { confidence: 0.6, right: true },
  { confidence: 0.4, right: false },
];

describe("handoff", () => {
  test("a threshold splits decisions into handled (with mistakes) and reviewed", () => {
    expect(split(d, 0.65)).toEqual({
      threshold: 0.65,
      handled: 3,
      mistakes: 1,
      reviewed: 2,
      total: 5,
    });
    expect(split(d, 0)).toMatchObject({ handled: 5, mistakes: 2, reviewed: 0 });
    expect(split(d, 1.0001)).toMatchObject({ handled: 0, mistakes: 0, reviewed: 5 });
  });

  test("thresholds cover act-on-everything and review-everything", () => {
    expect(thresholds(d)[0]).toBe(0);
    expect(thresholds(d).at(-1)).toBeGreaterThan(1);
  });

  test("the cheapest threshold moves up as mistakes get dearer", () => {
    // Mistakes as cheap as reviews: act on everything (2 mistakes beats 5 reviews).
    expect(cheapest(d, 1)?.split.threshold).toBe(0);
    // Mistakes very dear: review anything below 0.9, where no handled answer is wrong.
    expect(cheapest(d, 100)?.split).toMatchObject({ threshold: 0.9, mistakes: 0, reviewed: 3 });
  });

  test("the curve runs from full coverage to none", () => {
    const c = curve(d);

    expect(c[0]).toMatchObject({ coverage: 1, errorRate: 0.4 });
    expect(c.at(-1)).toMatchObject({ coverage: 0, errorRate: 0 });
  });

  test("top normalises and picks the largest option", () => {
    expect(top({ a: 0.2, b: 0.6, c: 0.2 })).toEqual({ key: "b", confidence: 0.6 });
    expect(top([1, 3]).key).toBe("1");
    expect(top([1, 3]).confidence).toBeCloseTo(0.75);
  });
});
