import { describe, expect, test } from "bun:test";
import { USD_PER_INPUT_TOKEN } from "./receipt";
import { addCall, EMPTY_USAGE } from "./session-meter";

describe("session meter", () => {
  test("counts answered calls with their reported input tokens at the list price", () => {
    const u = addCall(addCall(EMPTY_USAGE, true, { usage: { input_tokens: 300 } }), true, { usage: { input_tokens: 100 } });

    expect(u.calls).toBe(2);
    expect(u.failed).toBe(0);
    expect(u.inputTokens).toBe(400);
    expect(u.costUsd).toBeCloseTo(400 * USD_PER_INPUT_TOKEN, 12);
  });

  test("a failed call counts as a call but adds no tokens or cost", () => {
    const u = addCall(EMPTY_USAGE, false, { usage: { input_tokens: 999 } });

    expect(u).toEqual({ calls: 1, failed: 1, inputTokens: 0, costUsd: 0 });
  });

  test("a response without usage adds a call and nothing else", () => {
    expect(addCall(EMPTY_USAGE, true, { answers: {} })).toEqual({ calls: 1, failed: 0, inputTokens: 0, costUsd: 0 });
    expect(addCall(EMPTY_USAGE, true, { usage: { input_tokens: "lots" } }).inputTokens).toBe(0);
  });
});
