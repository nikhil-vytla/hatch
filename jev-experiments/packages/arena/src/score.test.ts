import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { score } from "./score";

const study = JSON.parse(
  readFileSync(
    new URL("../../../experience-prototypes/public/data/local-models.json", import.meta.url),
    "utf8",
  ),
).result;

describe("scorer", () => {
  test("counts confident disagreements and bins confidence", () => {
    const card = score([
      { prediction: [0.9, 0.1], reference: [0, 1] },
      { prediction: [0.6, 0.4], reference: [1, 0] },
    ]);

    expect(card.agreement).toBe(0.5);
    expect(card.confidentButWrong).toBe(1);
    expect(card.reliability.map((b) => b.count)).toEqual([1, 1]);
    expect(card.ece).toBeCloseTo(0.5 * 0.4 + 0.5 * 0.9, 12);
  });

  test("reproduces every recorded model metric in the local-model study", () => {
    for (const model of study.models) {
      const answers = study.cases.flatMap((c: any) =>
        c.questions.map((q: any) => ({ prediction: q.predictions[model.id], reference: q.target })),
      );

      const card = score(answers);
      expect(card.decisions).toBe(model.metrics.decisions);
      expect(card.agreement).toBeCloseTo(model.metrics.accuracy, 9);
      expect(card.brier).toBeCloseTo(model.metrics.brier, 9);
      expect(card.ece).toBeCloseTo(model.metrics.ece, 9);
    }
  });
});
