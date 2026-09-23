import { expect, test } from "bun:test";
import { formatUsd } from "./format";

test("dollars format like the daemon's, rounding up to four places", () => {
  expect(formatUsd(0)).toBe("$0.0000");
  expect(formatUsd(3500)).toBe("$0.0035");
  expect(formatUsd(5_000_000)).toBe("$5.0000");
  expect(formatUsd(12_345_678)).toBe("$12.3457");
  expect(formatUsd(49)).toBe("$0.0001");
});
