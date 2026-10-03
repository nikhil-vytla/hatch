import { describe, expect, test } from "bun:test";
import { percent, percent1 } from "./api";

describe("shared percent formatting", () => {
  test("whole percents round like the old local helpers (Math.round(n * 100))", () => {
    for (const n of [0, 0.004, 0.005, 0.135, 0.4734, 0.995, 1]) expect(percent(n)).toBe(`${Math.round(n * 100)}%`);

    expect(percent(0.473)).toBe("47%");
  });

  test("one-decimal percents match the old (n * 100).toFixed(1) and (100 * n).toFixed(1)", () => {
    for (const n of [0, 0.0005, 0.12345, 0.4734, 0.7275, 0.9999, 1]) {
      expect(percent1(n)).toBe(`${(n * 100).toFixed(1)}%`);
      expect(percent1(n)).toBe(`${(100 * n).toFixed(1)}%`);
    }

    expect(percent1(0.4734)).toBe("47.3%");
  });
});
