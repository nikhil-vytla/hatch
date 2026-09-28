/**
 * The port must behave exactly like Shapeshift 5e24166. The fixtures were captured from the
 * upstream code before it was removed: its 14 questions, and a hash of its keyword
 * classifier's output and of the calm rules' visible state on every prefix of 429 texts.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { z } from "zod";
import { calm, START } from "./calm";
import behaviour from "./fixtures/upstream-behaviour.json";
import upstreamQuestions from "./fixtures/upstream-questions.json";
import { keyword } from "./keyword";
import { INTENTS, QUESTIONS, type Choice, type Reading } from "./questions";

const fixture = z
  .object({ rows: z.array(z.object({ text: z.string(), keyword: z.string(), calm: z.string() })) })
  .parse(behaviour);

const r9 = (x: number) => Math.round(x * 1e9) / 1e9;

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

const answer = <T extends string>(a: Choice<T>) => [
  a.value,
  r9(a.confidence),
  Object.entries<number | undefined>(a.probabilities)
    .sort(([x], [y]) => (x < y ? -1 : 1))
    .map(([k, p]) => [k, r9(p ?? 0)]),
];

/** The same projection the fixture was hashed with. Readiness is not part of it. */
const canon = (r: Reading) =>
  JSON.stringify([
    INTENTS.map((k) => r9(r.intent.probabilities[k] ?? 0)),
    r.intent.value,
    r9(r.intent.confidence),
    r9(r.isQuestion),
    r9(r.recurring),
    [r9(r.urgency.score), r9(r.urgency.confidence)],
    answer(r.tone),
    answer(r.eventMode),
    answer(r.transport),
    answer(r.tripType),
    answer(r.expenseCategory),
    answer(r.colorMood),
    answer(r.timerKind),
    r9(r.hasExplicitOptions),
    r9(r.isShoppingList),
  ]);

const prefixes = (text: string) =>
  Array.from({ length: text.length }, (_, i) => text.slice(0, i + 1));

describe("the port matches upstream", () => {
  test("the questions Jev is asked are upstream's, word for word", () => {
    expect(JSON.parse(JSON.stringify(QUESTIONS))).toEqual(upstreamQuestions);
  });

  test(`the keyword classifier, on every prefix of ${fixture.rows.length} texts`, () => {
    const wrong = fixture.rows.filter(
      (row) =>
        hash(
          prefixes(row.text)
            .map((p) => canon(keyword(p)))
            .join("\n"),
        ) !== row.keyword,
    );

    expect(wrong.map((r) => r.text)).toEqual([]);
  });

  test("the calm rules, fed the keyword classifier on every prefix", () => {
    const wrong = fixture.rows.filter((row) => {
      let state = START;

      const shown = prefixes(row.text).map((p) => {
        state = calm(state, keyword(p), p);

        return JSON.stringify(state.shown);
      });

      return hash(shown.join("\n")) !== row.calm;
    });

    expect(wrong.map((r) => r.text)).toEqual([]);
  });
});
