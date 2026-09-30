import { describe, expect, test } from "bun:test";
import { agreement, keyAnswers, rank, topIndex } from "./model";

// Model a always matches the teacher; b and c agree with each other, not the teacher.
const qs = [
  { target: [1, 0], predictions: { a: [0.9, 0.1], b: [0.2, 0.8], c: [0.1, 0.9] } },
  { target: [0, 1], predictions: { a: [0.1, 0.9], b: [0.8, 0.2], c: [0.7, 0.3] } },
];

describe("answer key", () => {
  test("against the teacher, the model that matches it wins", () => {
    expect(rank(qs, { kind: "teacher" }, ["a", "b", "c"]).map((r) => r.model)[0]).toBe("a");
    expect(agreement(qs, { kind: "teacher" }, "a")).toBe(1);
  });

  test("a consensus of the others can bury the model that was right", () => {
    const key = { kind: "consensus" as const, voters: ["a", "b", "c"] };

    // Grading a, the others (b, c) both disagree with it.
    expect(agreement(qs, key, "a")).toBe(0);
    expect(rank(qs, key, ["a", "b", "c"]).at(-1)?.model).toBe("a");
  });

  test("a consensus averages probabilities and never includes the model being graded", () => {
    expect(keyAnswers(qs, { kind: "consensus", voters: ["a", "b", "c"] }, "b")).toEqual([1, 0]);
  });

  test("a model is not ranked against its own answers", () => {
    expect(
      rank(qs, { kind: "model", model: "a" }, ["a", "b", "c"]).map((r) => r.model),
    ).not.toContain("a");
  });

  test("topIndex keeps the first of a tie", () => {
    expect(topIndex([0.5, 0.5])).toBe(0);
  });
});
