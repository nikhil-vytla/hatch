import { describe, it, expect } from "bun:test";
import { topCredit, tiesMetrics, summarize } from "./metrics";
import { pack, payload, batches, batchPayload, type Case } from "./protocol";

function row(
  id: string,
  scores: number[],
  correct = 1,
  subset = "Focus",
): Case {
  return {
    id,
    subset,
    prompt: "fixture",
    input_hash: "fixture",
    status: "completed",
    num_correct: correct,
    num_incorrect: scores.length - correct,
    candidates: scores.map((score, i) => ({
      label: String(i),
      text: "fixture",
      model: "fixture",
      chosen: i < correct,
      score,
    })),
  };
}
describe("RewardBench 2 scoring", () => {
  it("splits credit for score ties rather than favoring the original first answer", () => {
    expect(topCredit(row("a", [8, 8, 6, 4]))).toBe(0.5);
    expect(topCredit(row("b", [7, 8, 8, 4]))).toBe(0);
    expect(topCredit(row("c", [8, 7, 6, 4]))).toBe(1);
    expect(topCredit(row("d", [5, 5, 5, 5]))).toBe(0.25);
  });
  it("does not turn an unavailable request into an incorrect judgment", () => {
    const missing = { ...row("a", [8, 7, 6, 4]), status: "unavailable" };
    expect(topCredit(missing)).toBeNull();
    expect(summarize([missing]).macro_score).toBeNull();
    expect(summarize([missing]).subsets.Focus.completed).toBe(0);
  });
  it("implements the paired Ties margins and the upstream one-percent bonus", () => {
    const r = tiesMetrics([
      row("ref:0", [9, 2, 1], 1, "Ties"),
      row("tied:0", [9, 8, 1], 2, "Ties"),
    ]);
    expect(r.complete_pairs).toBe(1);
    expect(r.score).toBeCloseTo(1 + 0.01 * Math.tanh(6), 12);
  });
  it("handles zero spread and equality exactly as the upstream formula", () => {
    const perfect = tiesMetrics([
      row("ref:0", [9, 1], 1, "Ties"),
      row("tied:0", [9, 9, 1], 2, "Ties"),
    ]);
    expect(perfect.score).toBeCloseTo(1.01, 12);
    const equal = tiesMetrics([
      row("ref:0", [5, 5], 1, "Ties"),
      row("tied:0", [5, 5, 5], 2, "Ties"),
    ]);
    expect(equal.score).toBe(0);
  });
  it("requires both prompts before scoring a Ties pair", () => {
    const r = tiesMetrics([row("ref:0", [9, 1], 1, "Ties")]);
    expect(r.score).toBeNull();
    expect(r.total_pairs).toBe(1);
    expect(r.complete_pairs).toBe(0);
  });
  it("keeps labels and model identity out of the request", () => {
    const r = pack({
      id: "private-id",
      subset: "Focus",
      prompt: "Question",
      chosen: ["Answer one"],
      rejected: ["Answer two", "Answer three", "Answer four"],
      models: ["secret-model"],
    });
    expect(
      pack({
        id: "private-id",
        subset: "Focus",
        prompt: "Question",
        chosen: ["Answer one"],
        rejected: ["Answer two", "Answer three", "Answer four"],
        models: ["secret-model"],
      }),
    ).toEqual(r);
    const p = JSON.stringify(payload(r));
    expect(p).not.toContain("secret-model");
    expect(p).not.toContain("private-id");
    expect(p).not.toContain('"chosen"');
    expect(p).not.toContain('"rejected"');
    expect(Object.keys(payload(r).questions)).toHaveLength(4);
  });
  it("keeps each candidate isolated when questions from different cases share a request", () => {
    const rows = [
      pack({
        id: "same-id",
        subset: "Focus",
        prompt: "first prompt",
        chosen: ["unique first answer"],
        rejected: [],
        models: ["hidden"],
      }),
      pack({
        id: "same-id",
        subset: "Math",
        prompt: "second prompt",
        chosen: ["unique second answer"],
        rejected: [],
        models: ["hidden"],
      }),
    ];
    const b = batchPayload(batches(rows)[0]);
    expect(JSON.stringify(b.state)).not.toContain("first prompt");
    expect(JSON.stringify(b.state)).not.toContain("second prompt");
    expect(b.questions.q0.instructions).toContain("unique first answer");
    expect(b.questions.q0.instructions).not.toContain("unique second answer");
    expect(b.questions.q1.instructions).not.toContain("first prompt");
    expect(b.questions.q1).toEqual(
      Object.values(payload(rows[1]).questions)[0],
    );
  });
  it("resumes missing candidate scores and splits requests without losing questions", () => {
    const r = pack({
      id: "a",
      subset: "Focus",
      prompt: "Question",
      chosen: ["one"],
      rejected: ["two", "three", "four"],
      models: ["hidden"],
    });
    r.candidates[0].score = 8;
    const groups = batches([r], 90000, 2);
    expect(groups.map((g) => g.length)).toEqual([2, 1]);
    expect(groups.flat().some((j) => j.candidate === r.candidates[0])).toBe(
      false,
    );
    expect(new Set(groups.flat().map((j) => j.candidate)).size).toBe(3);
  });
});
