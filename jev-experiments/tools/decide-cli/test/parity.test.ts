/** The CLI's analysis reproduces the published study numbers from our committed recordings. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { decoy, fool, suggestion } from "../src/analysis";
import { readRows } from "../src/record";

const root = new URL("../../../packages/arena/", import.meta.url).pathname;
const prose = readRows(`${root}prose/recordings/prose.jsonl.gz`);
const published = JSON.parse(readFileSync(`${root}prose/results.json`, "utf8"));

describe("parity with the published prose results", () => {
  test("every suggestion variant: flips, P(right) delta and its bootstrap interval", () => {
    const ours = suggestion(prose);
    const theirs = published["claim-truth"].variants.filter((v: { family: string }) => v.family === "suggestion");

    expect(ours.map((r) => r.variant)).toEqual(theirs.map((v: { variant: string }) => v.variant));

    for (const [i, r] of ours.entries()) {
      const t = theirs[i];

      expect(r.n).toBe(t.n);
      expect(r.flips).toBe(t.flips);
      expect(r.delta).toBeCloseTo(t.delta, 10);
      expect(r.deltaCI[0]).toBeCloseTo(t.deltaCI[0], 10);
      expect(r.deltaCI[1]).toBeCloseTo(t.deltaCI[1], 10);
      expect(r.shift).toBeCloseTo(t.shift, 10);
    }
  });

  test("the decoy effect and its interval", () => {
    const d = decoy(prose);

    expect(d.effect.mean).toBeCloseTo(published.decoy.effect.mean, 10);
    expect(d.effect.ci[0]).toBeCloseTo(published.decoy.effect.ci[0], 10);
    expect(d.effect.ci[1]).toBeCloseTo(published.decoy.effect.ci[1], 10);
    expect(d.scenarios.map((s) => s.item)).toEqual(published.decoy.scenarios.map((s: { item: string }) => s.item));
  });
});

describe("parity with Fool Jev's recording", () => {
  const rows = fool(readRows(`${root}recordings/fool.jsonl`));
  const by = (s: string) => rows.find((r) => r.sentence === s)!;

  test("what the home page says: doubt flips all five, the yes version none", () => {
    expect(by("I'm pretty sure the answer is no.").flipped).toBe(5);
    expect(by("I'm pretty sure the answer is yes.").flipped).toBe(0);
    expect(by("Most people say no.").flipped).toBe(3);
  });

  test("the referee rules out four of the five cheats (Sydney's gets through)", () => {
    expect(by("(the puzzle's own cheat)").ruledOut).toBe(4);
  });
});
