import { describe, expect, test } from "bun:test";
import { agreement, clusteredAgreement, keyAnswers, rank, topIndex } from "./model";

// Model a always matches the teacher; b, c and d agree with each other, never with the teacher.
const qs = [
  { target: [1, 0], predictions: { a: [0.9, 0.1], b: [0.2, 0.8], c: [0.1, 0.9], d: [0.2, 0.8] } },
  { target: [0, 1], predictions: { a: [0.1, 0.9], b: [0.8, 0.2], c: [0.7, 0.3], d: [0.8, 0.2] } },
];

const all = ["a", "b", "c", "d"];

describe("answer key", () => {
  test("against the teacher, the model that matches it wins", () => {
    expect(rank(qs, { kind: "teacher" }, all).map((r) => r.model)[0]).toBe("a");
    expect(agreement(qs, { kind: "teacher" }, "a")).toBe(1);
  });

  test("a consensus of the others can bury the model that was right", () => {
    const key = { kind: "consensus" as const, voters: all };

    // Grading a, the others (b, c, d) all disagree with it; grading b, c and d outvote a.
    expect(agreement(qs, key, "a")).toBe(0);
    expect(agreement(qs, key, "b")).toBe(1);
    expect(rank(qs, key, all).at(-1)?.model).toBe("a");
  });

  test("a consensus averages probabilities and never includes the model being graded", () => {
    // Grading b, the key averages a, c and d: c and d outweigh a on both questions.
    expect(keyAnswers(qs, { kind: "consensus", voters: all }, "b")).toEqual([1, 0]);
    // Grading a, only b, c and d vote, so a's own answers can't pull the key toward it.
    expect(keyAnswers(qs, { kind: "consensus", voters: all }, "a")).toEqual([1, 0]);
  });

  test("a model is not ranked against its own answers", () => {
    expect(
      rank(qs, { kind: "model", model: "a" }, all).map((r) => r.model),
    ).not.toContain("a");
  });

  test("clustered agreement matches the plain share and widens when cases disagree", () => {
    const teacher = { kind: "teacher" as const };

    // a matches the teacher everywhere: estimate 1, no spread.
    const sure = clusteredAgreement([qs, qs], teacher, "a");

    expect(sure.estimate).toBe(agreement([...qs, ...qs], teacher, "a"));
    expect([sure.low, sure.high, sure.clusters]).toEqual([1, 1, 2]);

    // One case all right, one all wrong: the estimate is a half and the interval is wide.
    const right = { target: [1, 0], predictions: { m: [0.9, 0.1] } };

    const wrong = { target: [1, 0], predictions: { m: [0.1, 0.9] } };

    const mixed = clusteredAgreement([[right, right], [wrong, wrong]], teacher, "m");

    expect(mixed.estimate).toBe(0.5);
    expect(mixed.high - mixed.low).toBeGreaterThan(0.5);
  });

  test("topIndex keeps the first of a tie", () => {
    expect(topIndex([0.5, 0.5])).toBe(0);
  });
});
