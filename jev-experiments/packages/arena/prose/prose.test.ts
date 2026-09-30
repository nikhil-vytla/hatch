import { describe, expect, test } from "bun:test";
import { validate } from "../../../experience-prototypes/server/gateway";
import { analyse, type Recorded } from "./analyze";
import { CHOICE_ITEMS, TRUTH_ITEMS } from "./items";
import { bootstrap, calibration, dist, pClaim, tv, type Answers } from "./metrics";
import { intWords, numbersAsWords, ordinalWords, typos } from "./text";
import { LANGUAGES, TRANSLATIONS } from "./translations";
import { allJobs, placeCorrect, type Job } from "./variants";

const jobs = allJobs();

describe("items", () => {
  test("truth items are balanced and translated", () => {
    expect(TRUTH_ITEMS.filter((i) => i.truth).length).toBe(10);
    expect(TRUTH_ITEMS.filter((i) => i.truth === false).length).toBe(10);
    for (const it of TRUTH_ITEMS)
      for (const lang of LANGUAGES) {
        expect(TRANSLATIONS[it.id]?.[lang]?.question.length).toBeGreaterThan(3);
        expect(TRANSLATIONS[it.id]?.[lang]?.prose.length).toBeGreaterThan(10);
      }
  });

  test("the right choice sits at each position equally often", () => {
    const at = [0, 0, 0, 0];

    for (const it of CHOICE_ITEMS) at[it.options.findIndex(([k]) => k === it.correct)]!++;
    expect(at).toEqual([4, 4, 4, 4]);
    for (const it of CHOICE_ITEMS) {
      const keys = [...it.options, ...it.extras].map(([k]) => k);

      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe("variants", () => {
  test("every request is valid, unique and carries no truth", () => {
    expect(new Set(jobs.map((j) => j.id)).size).toBe(jobs.length);
    for (const j of jobs) {
      validate(j.request);
      expect(JSON.stringify(j.request)).not.toContain('"truth"');
    }
  });

  test("counts are as frozen in the README", () => {
    const count = (study: string) => jobs.filter((j) => j.study === study).length;

    expect(jobs.length).toBe(2626);
    expect(count("claim-truth")).toBe(20 * 78);
    expect(count("claim-ambiguous")).toBe(10 * 49);
    expect(count("choice")).toBe(16 * 21);
    expect(count("framing")).toBe(40);
    expect(count("attribute")).toBe(12);
    expect(count("anchor")).toBe(60);
    expect(count("decoy")).toBe(48);
    expect(count("likert")).toBe(80);
  });

  test("placeCorrect moves only the right option", () => {
    const opts: [string, string][] = [["a", "A"], ["b", "B"], ["c", "C"], ["d", "D"]];

    expect(placeCorrect(opts, "c", 0).map(([k]) => k)).toEqual(["c", "a", "b", "d"]);
    expect(placeCorrect(opts, "a", 3).map(([k]) => k)).toEqual(["b", "c", "d", "a"]);
  });
});

describe("text", () => {
  test("numbers as words", () => {
    expect(intWords(0)).toBe("zero");
    expect(intWords(45)).toBe("forty-five");
    expect(intWords(8849)).toBe("eight thousand eight hundred forty-nine");
    expect(ordinalWords(2)).toBe("second");
    expect(ordinalWords(20)).toBe("twentieth");
    expect(ordinalWords(23)).toBe("twenty-third");
    expect(numbersAsWords("$160")).toBe("one hundred sixty dollars");
    expect(numbersAsWords("3.2 kg")).toBe("three point two kg");
    expect(numbersAsWords("70%")).toBe("seventy percent");
    expect(numbersAsWords("2026-08-02")).toBe("August second, twenty twenty-six");
    expect(numbersAsWords("Saturday 10:30")).toBe("Saturday ten thirty");
    expect(numbersAsWords("sunflower88")).toBe("sunflower88");
    expect(numbersAsWords("HB-44817")).toBe("HB-44817");
    expect(numbersAsWords("at least 12 characters")).toBe("at least twelve characters");
  });

  test("typos are deterministic and leave short text mostly readable", () => {
    const q = "Is the parcel within the standard shipping weight limit?";

    expect(typos(q, 0.05, 3)).toBe(typos(q, 0.05, 3));
    expect(typos(q, 0, 3)).toBe(q);
    expect(typos(q, 0.2, 3)).not.toBe(q);
  });
});

describe("metrics", () => {
  test("readers", () => {
    const yes = (v: number): Answers => ({ q: { type: "noul", value: v, probabilities: null } });

    expect(pClaim({ kind: "noul", polarity: 1 }, yes(0.8))).toBeCloseTo(0.8);
    expect(pClaim({ kind: "noul", polarity: -1 }, yes(0.8))).toBeCloseTo(0.2);
    expect(
      pClaim({ kind: "score-yes", weights: [0, 0, 0.5, 1, 1] }, {
        q: { type: "score", value: 3, probabilities: { 0: 0.1, 1: 0.1, 2: 0.2, 3: 0.3, 4: 0.3 } },
      }),
    ).toBeCloseTo(0.7);
    expect(
      dist({ kind: "dist", from: "choice", keyMap: { A: "x", B: "y" } }, {
        q: { type: "choice", value: "A", probabilities: { A: 0.75, B: 0.25 } },
      }),
    ).toEqual({ x: 0.75, y: 0.25 });
    expect(
      dist({ kind: "dist", from: "each", keyMap: { x: "x", y: "y" } }, {
        x: { type: "noul", value: 0.6, probabilities: null },
        y: { type: "noul", value: 0.2, probabilities: null },
      }).x,
    ).toBeCloseTo(0.75);
    expect(tv({ a: 1 }, { b: 1 })).toBe(1);
  });

  test("bootstrap is seeded and brackets the mean", () => {
    const xs = [0, 0.1, 0.2, 0.3, 0.4];
    const [lo, hi] = bootstrap(xs, 5);

    expect(bootstrap(xs, 5)).toEqual([lo, hi]);
    expect(lo).toBeLessThan(0.2);
    expect(hi).toBeGreaterThan(0.2);
  });

  test("calibration of a perfectly calibrated set is near zero", () => {
    const pts = Array.from({ length: 100 }, (_, i) => ({ confidence: 0.75, correct: i < 75 ? 1 : 0 }));

    expect(calibration(pts).ece).toBeCloseTo(0, 6);
  });
});

/** A fake Jev that always leans the right way, to check readers and polarity end to end. */
function oracle(job: Job): Answers {
  const q = job.request.questions;
  const r = job.read;

  if (r.kind === "noul") {
    const truth = job.truth === undefined ? true : (job.truth as boolean);
    const yes = r.polarity === 1 ? truth : !truth;

    return { q: { type: "noul", value: yes ? 0.9 : 0.1, probabilities: null } };
  }
  if (r.kind === "choice-yes") {
    const truth = job.truth === undefined ? true : (job.truth as boolean);
    const keys = Object.keys((q.q as { criteria: Record<string, string> }).criteria);
    const probabilities = Object.fromEntries(keys.map((k) => [k, (k === r.yes) === truth ? 0.9 : 0.1]));

    return { q: { type: "choice", value: keys[0]!, probabilities } };
  }
  if (r.kind === "score-yes") {
    const truth = job.truth === undefined ? true : (job.truth as boolean);
    const target = r.weights.findIndex((w) => w === (truth ? 1 : 0));

    return { q: { type: "score", value: target, probabilities: Object.fromEntries(r.weights.map((_, i) => [String(i), i === target ? 1 : 0])) } };
  }
  if (r.from === "each") {
    return Object.fromEntries(
      Object.entries(r.keyMap).map(([wire, key]) => [wire, { type: "noul", value: key === job.truth ? 0.9 : 0.1, probabilities: null }]),
    );
  }

  const wires = Object.keys(r.keyMap);
  const right = wires.find((w) => r.keyMap[w] === String(job.truth));
  const probabilities = Object.fromEntries(wires.map((w) => [w, right ? (w === right ? 0.85 : 0.15 / (wires.length - 1)) : 1 / wires.length]));

  return { q: { type: r.from, value: r.from === "score" ? 0 : wires[0]!, probabilities } };
}

describe("analysis on an oracle recording", () => {
  const rows: Recorded[] = jobs.map((j) => ({ id: j.id, status: "ok", answers: oracle(j), latencyMs: 300, servedBy: "test", costUsd: 0.00001, inputTokens: 300, at: "2026-09-29T00:00:00Z" }));
  const { json } = analyse(rows) as { json: Record<string, any> };

  test("every truth-claim variant is scored right and nothing flips", () => {
    for (const v of json["claim-truth"].variants) {
      expect(v.accuracy).toBe(1);
      expect(v.flips).toBe(0);
    }
  });

  test("complementary pairs sum to one", () => {
    for (const p of json["claim-truth"].invariance) expect(p.bias).toBeCloseTo(0, 6);
  });

  test("choices and anchors are read in canonical keys", () => {
    for (const v of json.choice.variants) expect(v.accuracy).toBe(1);
    for (const v of json.anchor.summary) expect(v.accuracy).toBe(1);
  });
});
