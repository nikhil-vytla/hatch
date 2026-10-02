import { describe, expect, test } from "bun:test";
import { formatCost, formatDate, fromLive, fromLiveBatches, fromRecorded, receiptParts, USD_PER_INPUT_TOKEN } from "./receipt";

describe("recorded receipts", () => {
  test("reads each record's own field names, and nothing it doesn't have", () => {
    const row = { latency_ms: 412, cost_usd: 0.000021, answers: { a: {}, b: {}, c: {} }, attempts: [] };

    expect(receiptParts(fromRecorded(row, { at: "2026-09-20T05:19:11Z" }))).toEqual(["412 ms", "3 questions", "$0.000021", "recorded", "20 Sep 2026"]);
    expect(receiptParts(fromRecorded({ latencyMs: 240, batchQuestions: 14 }))).toEqual(["240 ms", "14 questions", "recorded"]);
    expect(receiptParts(fromRecorded({ question_count: 4, at: "2026-09-25T10:00:00Z", served_by: "typesafe-ai" }))).toEqual(["4 questions", "recorded", "25 Sep 2026", "typesafe-ai"]);
    expect(receiptParts(fromRecorded({}))).toEqual(["recorded"]);
    // Early recordings logged cost 0 because the gateway didn't report it; that's unknown, not free.
    expect(receiptParts(fromRecorded({ latency_ms: 534, cost_usd: 0 }))).toEqual(["534 ms", "recorded"]);
  });

  test("a batched live run sums its requests", () => {
    const r = fromLiveBatches(
      [
        { latency_ms: 200, usage: { input_tokens: 300 }, served_by: "typesafe-ai", answers: { a: {}, b: {} } },
        { latency_ms: 150, answers: { c: {} } },
      ],
      { state: {} },
    );

    expect([r.ms, r.questions, r.inputTokens, r.servedBy, r.mode]).toEqual([350, 3, 300, "typesafe-ai", "live"]);
    expect(fromLiveBatches([{}]).ms).toBeNull();
  });

  test("keeps the raw object and lets the scene override", () => {
    const row = { latency_ms: 1, usage: { input_tokens: 500 } };
    const r = fromRecorded(row, { questions: 12 });

    expect(r.raw?.response).toBe(row);
    expect(r.inputTokens).toBe(500);
    expect(r.questions).toBe(12);
  });
});

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
