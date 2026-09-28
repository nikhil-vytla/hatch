import { describe, expect, test } from "bun:test";
import { toReading, type WireAnswers } from "./adapter";
import { keystrokes, outcome, replay, TYPING, type AnswerFor } from "./replay";
import { keyword as classify } from "./keyword";
import { QUESTIONS, type Intent } from "./questions";

const keyword =
  (latencyMs: number): AnswerFor =>
  (key) => ({ reading: classify(key), latencyMs });

describe("keystrokes", () => {
  test("an emoji is one keystroke, never half a character", () => {
    expect(keystrokes("🏈 go").map((k) => k.text)).toEqual(["🏈", "🏈 ", "🏈 g", "🏈 go"]);
  });

  test("a steady typist who pauses after each word", () => {
    const keys = keystrokes("hi yo");

    expect(keys.map((k) => k.text)).toEqual(["h", "hi", "hi ", "hi y", "hi yo"]);
    expect(keys.map((k) => k.at)).toEqual([0, 160, 320, 720, 880]);
  });
});

describe("replay", () => {
  const phrase = "dinner with sam fri 7pm on zoom";

  test("an instant classifier lands every debounced request under either policy", () => {
    for (const policy of ["cancel", "latest"] as const) {
      const r = replay(phrase, keyword(1), policy);

      expect(r.failed).toBe(0);
      expect(r.landed).toBe(r.requests);
      expect(outcome(r, { intent: "event" }).finalRight).toBe(true);
    }
  });

  test("with slow answers, cancelling on each keystroke lands only after the typing stops", () => {
    const cancel = replay(phrase, keyword(600), "cancel");
    const latest = replay(phrase, keyword(600), "latest");

    expect(cancel.landed).toBe(1);
    expect(cancel.frames.every((f) => f.at === 0 || f.at > cancel.lastKeyAt)).toBe(true);
    expect(latest.landed).toBeGreaterThan(3);
    expect(latest.frames.some((f) => f.at > 0 && f.at < latest.lastKeyAt)).toBe(true);
  });

  test("a failed request leaves the box as it was", () => {
    const r = replay(phrase, () => undefined, "cancel");

    expect(r.frames).toHaveLength(1);
    expect(outcome(r, { intent: "event" })).toMatchObject({ finalRight: false, changes: 0 });
  });

  test("a wrong commit on the way counts even when the final card is right", () => {
    // Commits "reminder" for every prefix until the last word, then "event".
    const answerFor: AnswerFor = (key) => {
      const intent: Intent = key.endsWith("zoom") ? "event" : key.length > 8 ? "reminder" : "none";

      return {
        reading: {
          ...classify(key),
          intent: { value: intent, confidence: 0.9, probabilities: { [intent]: 0.9 } },
        },
        latencyMs: 1,
      };
    };

    const o = outcome(replay(phrase, answerFor, "cancel"), { intent: "event" });

    expect(o.finalRight).toBe(true);
    expect(o.wrongCommits).toBe(1);
    expect(o.timeToRight).toBeGreaterThan(0);
  });

  test("the typing model is frozen", () => {
    expect(TYPING).toEqual({ msPerKey: 160, wordPauseMs: 240, debounceMs: 120, settleMs: 4000 });
  });
});

describe("adapter", () => {
  const wire = (drop: string[] = []): WireAnswers =>
    Object.fromEntries(
      Object.entries(QUESTIONS).flatMap(([key, q]): [string, WireAnswers[string]][] => {
        if (drop.includes(key)) return [];

        if (q.type === "noul")
          return [[key, { value: 0.2, probabilities: null, confidence: null }]];

        if (q.type === "score") return [[key, { value: 1, probabilities: null, confidence: 0.6 }]];
        const [first] = Object.keys(q.criteria);

        return [[key, { value: first, probabilities: { [first]: 0.7 }, confidence: 0.7 }]];
      }),
    );

  test("maps the 14 answers onto a reading", () => {
    const { reading, dropped } = toReading(wire());

    expect(reading.intent).toEqual({
      value: "event",
      confidence: 0.7,
      probabilities: { event: 0.7 },
    });
    expect(reading.readiness).toEqual({ score: 1, confidence: 0.6 });
    expect(reading.isQuestion).toBe(0.2);
    expect(dropped).toEqual([]);
  });

  test("names a Score the gateway dropped instead of hiding it", () => {
    const { reading, dropped } = toReading(wire(["urgency"]));

    expect(dropped).toEqual(["urgency"]);
    expect(reading.urgency).toEqual({ score: 0, confidence: 0 });
  });

  test("rejects a choice that is not one of the question's options", () => {
    const answers = { ...wire(), tone: { value: "grumpy", probabilities: null, confidence: 0.9 } };

    expect(() => toReading(answers)).toThrow('tone: "grumpy" is not an option.');
  });
});
