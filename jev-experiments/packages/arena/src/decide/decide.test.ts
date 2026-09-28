import { describe, expect, test } from "bun:test";
import { combine } from "./combine";
import { DECK, requestFor } from "./deck";
import { memoryStore, vote, VOTES_PER_HOUR } from "./tally";

const two = [
  { id: "a", label: "A" },
  { id: "b", label: "B" },
];

const three = [...two, { id: "c", label: "C" }];

describe("combine rules", () => {
  test("a yes/no gives P(yes) to the first option", () => {
    expect(
      combine({ rule: "yes", question: "q", yes: "a" }, two, {
        q: { value: 0.8, probabilities: null },
      }).b,
    ).toBeCloseTo(0.2);
  });

  test("a score's middle level is shared evenly", () => {
    const d = combine({ rule: "score", question: "q", levels: ["a", "", "b"] }, two, {
      q: { value: 1, probabilities: { "0": 0.2, "1": 0.6, "2": 0.2 } },
    });

    expect(d.a).toBeCloseTo(0.5);
  });

  test("all multiplies, any complements, and the rest share what is left", () => {
    const answers = {
      x: { value: 0.5, probabilities: null },
      y: { value: 0.5, probabilities: null },
    };

    expect(combine({ rule: "all", questions: ["x", "y"], yes: "a" }, three, answers)).toEqual({
      a: 0.25,
      b: 0.375,
      c: 0.375,
    });
    expect(combine({ rule: "any", questions: ["x", "y"], yes: "a" }, two, answers).a).toBeCloseTo(
      0.75,
    );
  });

  test("a missing answer is a shrug, never a crash", () => {
    expect(combine({ rule: "choice", question: "q" }, two, {})).toEqual({ a: 0.5, b: 0.5 });
  });
});

describe("the deck", () => {
  test("every setup's combine rule names only its own questions and the decision's options", () => {
    for (const d of DECK)
      for (const s of d.setups) {
        const qs = Object.keys(s.questions);
        const c = s.combine;

        const named =
          "question" in c
            ? [c.question]
            : Array.isArray(c.questions)
              ? c.questions
              : Object.values(c.questions);

        expect(named.every((q) => qs.includes(q))).toBe(true);

        if ("yes" in c) expect(d.options.map((o) => o.id)).toContain(c.yes);
      }
  });

  test("only the context setup sends context", () => {
    for (const d of DECK)
      for (const s of d.setups)
        expect(Object.keys(requestFor(d, s).state).length > Object.keys(d.state).length).toBe(
          s.withContext && Boolean(d.context),
        );
  });

  test("truths are options and never reach a request", () => {
    for (const d of DECK) {
      if (d.truth) expect(d.options.map((o) => o.id)).toContain(d.truth.option);

      for (const s of d.setups)
        expect(JSON.stringify(requestFor(d, s))).not.toContain(d.truth?.why ?? "\u0000");
    }
  });
});

describe("tally", () => {
  test("counts a visitor once per decision per day, and refuses unknown options", async () => {
    const store = memoryStore();
    const now = new Date("2026-10-01T12:00:00Z");

    expect((await vote(store, { id: "hot-dog", option: "yes" }, "1.2.3.4", "s", now)).counted).toBe(
      true,
    );
    const again = await vote(store, { id: "hot-dog", option: "no" }, "1.2.3.4", "s", now);

    expect(again.counted).toBe(false);
    expect(again.counts).toEqual({ yes: 1, no: 0 });
    expect(vote(store, { id: "hot-dog", option: "maybe" }, "1.2.3.4", "s", now)).rejects.toThrow(
      "Unknown option.",
    );
    expect(vote(store, { id: "nope", option: "yes" }, "1.2.3.4", "s", now)).rejects.toThrow(
      "Unknown decision.",
    );
  });

  test("turns away a visitor voting too often in an hour", async () => {
    const store = memoryStore();
    const now = new Date("2026-10-01T12:00:00Z");

    for (let i = 0; i < VOTES_PER_HOUR; i++)
      await vote(store, { id: "hot-dog", option: "yes" }, "9.9.9.9", "s", now);

    expect(vote(store, { id: "hot-dog", option: "yes" }, "9.9.9.9", "s", now)).rejects.toThrow(
      "Too many votes",
    );
  });
});
