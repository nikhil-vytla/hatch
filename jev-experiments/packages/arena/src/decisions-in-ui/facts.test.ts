import { describe, expect, test } from "bun:test";
import type { Card, CardContestant, Estimate } from "../data/schema";
import { ece, heldOutN, heldOutRows, intentFacts, jevPolicies } from "./facts";

const est = (value: number, n = 50): Estimate => ({ value, n, lo: value, hi: value, method: "bootstrap-case" });

const rules = (right: number, wrong: number) => ({ right: est(right), wrong: est(wrong), changes: est(1), timeToRight: est(2000) });

const row = (right: number, wrong: number) => ({ ...rules(right, wrong), latency: est(300) });

const who = (id: string, name: string, kind: CardContestant["kind"] = "hosted"): CardContestant => ({ id, name, short: name, kind, default: true, runSets: [] });

const card: Pick<Card, "contestants" | "slices" | "results"> = {
  contestants: [
    who("jev@cancel", "Jev"),
    who("laya@cancel", "Laya", "local"),
    who("sglang-l4.qwen3-4b@cancel", "Qwen3-4B"),
    who("code.keyword", "Keyword rules", "code"),
  ],
  results: { "jev@cancel": row(0.9, 0.05), "jev@latest": row(0.9, 0.2) },
  slices: {
    workflow: {
      "held-out": {
        "jev@cancel": row(0.94, 0.02),
        "laya@cancel": row(0.8, 0.3),
        "sglang-l4.qwen3-4b@cancel": row(0.96, 0.62),
        "code.keyword": rules(0.94, 0.5),
        "not-in-lineup": row(1, 0),
      },
    },
  },
};

describe("decisions in an interface", () => {
  test("held-out rows keep the lineup, best right first, fewer wrong cards breaking ties", () => {
    const rows = heldOutRows(card);

    expect(rows.map((r) => r.id)).toEqual(["sglang-l4.qwen3-4b@cancel", "jev@cancel", "code.keyword", "laya@cancel"]);
    expect(rows.find((r) => r.id === "code.keyword")?.latency).toBeNull();
    expect(heldOutN(card)).toBe(50);
  });

  test("both Jev request policies come from the all-phrase results", () => {
    expect(jevPolicies(card).map((p) => [p.policy, p.wrong])).toEqual([
      ["cancel", 0.05],
      ["latest", 0.2],
    ]);
  });

  test("calibration error is the size-weighted gap between confidence and accuracy", () => {
    // Bin (0.9, 1]: confidence 0.95, accuracy 0.5. Bin (0.5, 0.6]: confidence 0.6, accuracy 1.
    const d = [
      { confidence: 0.95, right: true },
      { confidence: 0.95, right: false },
      { confidence: 0.6, right: true },
      { confidence: 0.6, right: true },
    ];

    expect(ece(d)).toBeCloseTo(0.5 * 0.45 + 0.5 * 0.4, 10);
    expect(ece([])).toBe(0);
  });

  test("intent facts count what Jev handles alone at the threshold", () => {
    const rows = [
      { probabilities: { a: 0.95, b: 0.05 }, prediction: "a", target: "a" },
      { probabilities: { a: 0.92, b: 0.08 }, prediction: "a", target: "b" },
      { probabilities: { a: 0.6, b: 0.4 }, prediction: "a", target: "a" },
      { error: "timeout", probabilities: null },
    ];

    const f = intentFacts(rows);

    expect(f).toMatchObject({ total: 3, mistakes: 1 });
    expect(f?.handled).toBeCloseTo(2 / 3, 10);
    expect(f?.right).toBe(0.5);
    expect(f?.accuracy).toBeCloseTo(2 / 3, 10);
    expect(f?.confidence).toBeCloseTo((0.95 + 0.92 + 0.6) / 3, 10);
    expect(intentFacts(rows, 0.99)).toBeNull();
  });
});
