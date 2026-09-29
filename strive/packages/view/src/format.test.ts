import { expect, test } from "bun:test";
import { formatUsd, offerText } from "./format";

test("the offer to learn says what the session had and what a run costs, in cents rounded up", () => {
  const offer = (estimateUsdMicros?: number) =>
    offerText("This session", { signals: [], summary: "2 corrections", ask: true, estimateUsdMicros });

  expect(offer(61_200)).toBe("This session had 2 corrections. Learn from it? It costs a learner run, about $0.07.");
  expect(offer(40)).toBe("This session had 2 corrections. Learn from it? It costs a learner run, about $0.01.");
  expect(offer(1_250_000)).toBe("This session had 2 corrections. Learn from it? It costs a learner run, about $1.25.");
  expect(offer()).toBe("This session had 2 corrections. Learn from it? It costs a learner run.");
});

test("dollars format like the daemon's, rounding up to four places", () => {
  expect(formatUsd(0)).toBe("$0.0000");
  expect(formatUsd(3500)).toBe("$0.0035");
  expect(formatUsd(5_000_000)).toBe("$5.0000");
  expect(formatUsd(12_345_678)).toBe("$12.3457");
  expect(formatUsd(49)).toBe("$0.0001");
});
