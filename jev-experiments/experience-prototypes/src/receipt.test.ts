import { describe, expect, test } from "bun:test";
import { formatCost, formatDate, fromLive, receiptParts, USD_PER_INPUT_TOKEN } from "./receipt";

describe("receipt", () => {
  test("costs keep two significant figures and no false precision", () => {
    expect(formatCost(0)).toBe("$0");
    expect(formatCost(0.000012558)).toBe("$0.000013");
    expect(formatCost(0.0011)).toBe("$0.0011");
    expect(formatCost(0.0369)).toBe("$0.04");
    expect(formatCost(8.45)).toBe("$8.45");
  });

  test("dates read the same in every timezone", () => {
    expect(formatDate("2026-10-01T02:53:21.462Z")).toBe("1 Oct 2026");
    expect(formatDate("2026-09-30")).toBe("30 Sep 2026");
    expect(formatDate("yesterday")).toBeNull();
  });

  test("a recorded answer shows only what its record holds", () => {
    expect(
      receiptParts({ mode: "recorded", ms: 317, questions: 1, costUsd: 0.000012558, at: "2026-10-01T02:53:21Z", servedBy: "typesafe-ai" }),
    ).toEqual(["317 ms", "1 question", "$0.000013", "recorded", "1 Oct 2026", "typesafe-ai"]);
    expect(receiptParts({ mode: "recorded", questions: 2 })).toEqual(["2 questions", "recorded"]);
  });

  test("cost falls back to tokens at the list price, and browser runs are free", () => {
    expect(receiptParts({ mode: "live", inputTokens: 1000 })).toEqual([formatCost(1000 * USD_PER_INPUT_TOKEN), "live"]);
    expect(receiptParts({ mode: "browser", ms: 2.4, model: "Bramble mini" })).toEqual(["2 ms", "$0", "in your browser", "Bramble mini"]);
  });

  test("a live response becomes a receipt without inventing fields", () => {
    const r = fromLive({ latency_ms: 244, usage: { input_tokens: 300 }, served_by: "typesafe-ai", answers: { q: {}, changes: {} } }, { state: {} });

    expect(r.mode).toBe("live");
    expect(r.ms).toBe(244);
    expect(r.questions).toBe(2);
    expect(r.inputTokens).toBe(300);
    expect(r.servedBy).toBe("typesafe-ai");
    expect(fromLive({}).inputTokens).toBeNull();
  });
});
