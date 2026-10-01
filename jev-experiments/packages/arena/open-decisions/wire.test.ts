import { describe, expect, test } from "bun:test";
import { answersSchema, toReading } from "../src/one-box/adapter";
import { QUESTIONS } from "../src/one-box/questions";
import { toWire, type Raw } from "./wire";

describe("System One answers in our wire shape", () => {
  test("a noul's value is P(true), with both sides as probabilities", () => {
    expect(toWire({ q: { type: "noul", noul: 0.8, x_label_mass: 0.9 } }).q).toEqual({
      type: "noul",
      value: 0.8,
      probabilities: { false: 0.19999999999999996, true: 0.8 },
      labelMass: 0.9,
    });
  });

  test("a choice keeps its option names; a score its level probabilities", () => {
    const w = toWire({
      c: { type: "choice", choice: "b", confidence: 0.5, probabilities: { a: 0.25, b: 0.75 } },
      s: { type: "score", score: 1.5, confidence: 0.2, probabilities: { "0": 0.25, "1": 0, "2": 0.75 } },
    });

    expect(w.c.value).toBe("b");
    expect(w.c.probabilities).toEqual({ a: 0.25, b: 0.75 });
    expect(w.s.value).toBe(1.5);
  });

  test("the One box card reads the converted answers like Jev's", () => {
    // One System One answer per One box question, each picking its first option or level.
    const raw = Object.fromEntries(
      Object.entries(QUESTIONS).map(([id, q]): [string, Raw] => {
        if (q.type === "noul") return [id, { type: "noul", noul: 0.1 }];

        const names = q.type === "choice" ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
        const probabilities = Object.fromEntries(names.map((n, i) => [n, i === 0 ? 1 : 0]));

        return [id, q.type === "choice" ? { type: "choice", choice: names[0], confidence: 1, probabilities } : { type: "score", score: 0, confidence: 1, probabilities }];
      }),
    );

    expect(() => toReading(answersSchema.parse(toWire(raw)))).not.toThrow();
  });
});
