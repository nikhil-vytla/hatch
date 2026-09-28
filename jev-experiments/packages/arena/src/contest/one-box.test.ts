import { describe, expect, test } from "bun:test";
import { QUESTIONS } from "../one-box/questions";
import { asEntry, BUDGET_MS, logScore, pairedGain, repair, runEntry } from "./one-box";

const phrases = [
  { id: "a", text: "remind me to call mom", intent: "reminder" },
  { id: "b", text: "dinner with sam fri 7pm", intent: "event" },
];

const rule = asEntry(({ text }) => ({
  intent: text.includes("remind") ? { reminder: 9, note: 1 } : { event: 3, note: 1 },
  isQuestion: 0.1,
}));

describe("repair", () => {
  test("missing answers become uniform, probabilities are floored and renormalised", () => {
    const { answers, repaired } = repair({ intent: { kind: "w", w: { event: 1 } } });

    expect(repaired).toBe(13);
    expect(answers.intent.value).toBe("event");
    expect(answers.intent.probabilities?.note).toBeCloseTo(0.001, 4);
    expect(answers.tone.confidence).toBeCloseTo(1 / 5, 5);
    expect(answers.isQuestion.value).toBe(0.5);
  });

  test("nonsense is repaired, never trusted", () => {
    const junk = asEntry(() => ({ intent: "event" }));

    expect(junk({ text: "x" }, QUESTIONS)).toBeNull();
    expect(repair(null).repaired).toBe(14);
  });
});

describe("runEntry", () => {
  test("replays an entry under the calm rules and scores its final answer", () => {
    const run = runEntry(rule, phrases, "cancel", () => 0);

    expect(run.errors).toBe(0);
    expect(run.phrases.map((p) => p.outcome.finalRight)).toEqual([true, true]);
    expect(logScore(run.phrases[0].final, phrases[0])).toBeGreaterThan(Math.log(0.5));
  });

  test("an answer slower than the budget never lands; a throw counts as an error", () => {
    let t = 0;
    const slow = runEntry(rule, phrases, "cancel", () => (t += BUDGET_MS + 1));

    expect(slow.late).toBe(slow.calls);
    expect(slow.phrases.every((p) => p.outcome.changes === 0)).toBe(true);

    const broken = runEntry(
      asEntry(() => {
        throw new Error("no");
      }),
      phrases,
      "cancel",
      () => 0,
    );

    expect(broken.errors).toBe(broken.calls);
  });

  test("paired gain is the mean difference with an interval", () => {
    expect(pairedGain([0, 0], [-1, -1])).toEqual({ mean: 1, half: 0 });
  });
});
