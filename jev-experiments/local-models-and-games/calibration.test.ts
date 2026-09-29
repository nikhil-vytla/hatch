import { describe, expect, test } from "bun:test";
import { calibration } from "./calibration";

describe("calibration", () => {
  test("a model that copies the teacher is perfectly calibrated against it", () => {
    const qs = [
      { target: [0.8, 0.2], predictions: { m: [0.8, 0.2] } },
      { target: [0.3, 0.7], predictions: { m: [0.3, 0.7] } },
    ];

    const c = calibration(qs, "m");

    expect(c.agreement).toBe(1);
    expect(c.brierPerOption).toBe(0);
    expect(c.kl[0].value).toBeCloseTo(0);
  });

  test("Brier per question is Brier per option times the option count", () => {
    const c = calibration([{ target: [1, 0, 0], predictions: { m: [0.4, 0.3, 0.3] } }], "m");

    expect(c.brierPerQuestion).toBeCloseTo(c.brierPerOption * 3);
  });

  test("an exact zero where the teacher has mass is priced by the floor", () => {
    const qs = [{ target: [0.9, 0.1], predictions: { m: [1, 0] } }];
    const [tiny, , loose] = calibration(qs, "m").kl;

    expect(tiny.value).toBeGreaterThan(loose.value * 3);
    expect(calibration(qs, "m").exactZeros).toBe(0.5);
  });

  test("reliability bins by stated confidence and counts agreement with the teacher's top option", () => {
    const qs = [
      { target: [1, 0], predictions: { m: [0.95, 0.05] } },
      { target: [0, 1], predictions: { m: [0.92, 0.08] } },
    ];

    const [bin] = calibration(qs, "m").reliability;

    expect(bin).toMatchObject({ lo: 0.9, n: 2, agreement: 0.5 });
    expect(bin.confidence).toBeCloseTo(0.935);
  });
});

describe("the published study", () => {
  test("reproduces every model's published agreement, Brier, KL and ECE", async () => {
    const { readRecord } = await import("../experience-prototypes/scripts/records");
    const { result } = readRecord(new URL("./apple/results.jsonl", import.meta.url));
    const questions = result.cases.flatMap((c: { questions: unknown[] }) => c.questions);

    for (const m of result.models) {
      const c = calibration(questions, m.id);

      expect(c.agreement).toBeCloseTo(m.metrics.accuracy, 6);
      expect(c.brierPerOption).toBeCloseTo(m.metrics.brier, 6);
      expect(c.kl[0].value).toBeCloseTo(m.metrics.kl, 6);
      expect(c.ece).toBeCloseTo(m.metrics.ece, 6);
    }
  });
});
