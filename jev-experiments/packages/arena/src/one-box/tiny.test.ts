import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { toReading } from "./adapter";
import { QUESTION_IDS, QUESTIONS } from "./questions";
import { features, head, tinyAnswers } from "./tiny";
import parityJson from "./tiny/parity.json";

const parity = z
  .array(z.object({ text: z.string(), probabilities: z.record(z.string(), z.array(z.number())) }))
  .parse(parityJson);

describe("tiny model", () => {
  test("reproduces the exported model's probabilities as computed in sklearn, on 200 dev prefixes", () => {
    let worst = 0;

    for (const row of parity)
      for (const id of QUESTION_IDS) {
        const ts = Object.values(head(id, features(row.text)));
        const py = row.probabilities[id];

        expect(ts).toHaveLength(py.length);
        ts.forEach((p, i) => (worst = Math.max(worst, Math.abs(p - py[i]))));
      }

    expect(worst).toBeLessThan(1e-9);
  });

  test("answers all 14 questions in a shape the adapter reads", () => {
    const { reading, dropped } = toReading(tinyAnswers("dinner with sam fri 7pm on zoom"));

    expect(dropped).toEqual([]);
    expect(Object.keys(QUESTIONS.intent.criteria)).toContain(reading.intent.value);
    expect(reading.isQuestion).toBeGreaterThanOrEqual(0);
    expect(reading.urgency.score).toBeGreaterThanOrEqual(0);
    expect(reading.urgency.score).toBeLessThanOrEqual(2);
  });
});
