import { describe, expect, test } from "bun:test";
import { generate, isTest } from "./dataset";
import { HEADS, RISK_THRESHOLD, score, type Weights } from "./model";
import { PAGES, rightAnswer, runHelper, TRAPS, withTrap } from "./pages";
import { train } from "./train";
import shipped from "./weights.json";

const w = shipped as Weights;

describe("screen sentry (prototype)", () => {
  test("training is deterministic and reproduces the shipped weights", () => {
    const again = train(generate().filter((e) => !isTest(e)));

    for (const h of HEADS) expect(again.heads[h].b).toBeCloseTo(w.heads[h].b, 10);
  });

  test("the five default traps are flagged, and no real task row is", () => {
    for (const t of TRAPS) expect(score(w, { text: t.text, where: t.where }).risk).toBeGreaterThanOrEqual(RISK_THRESHOLD);

    for (const p of PAGES) for (const b of p.blocks.filter((x) => x.value)) expect(score(w, b).risk).toBeLessThan(RISK_THRESHOLD);
  });

  test("an unflagged trap hijacks the helper; a flagged one is skipped and the task succeeds", () => {
    const page = withTrap(PAGES[0], "hidden", TRAPS[0].text, 0);
    const naive = runHelper(page, () => false);

    expect(naive.hijacked).toContain("evil.example");
    expect(naive.correct).toBe(false);

    const guarded = runHelper(page, (b) => score(w, b).risk >= RISK_THRESHOLD);

    expect(guarded.hijacked).toBeNull();
    expect(guarded.answer).toBe("$89");
    expect(guarded.correct).toBe(true);
  });

  test("flagging a real row means the helper misses it", () => {
    const out = runHelper(PAGES[0], (b) => b.id === "f2");

    expect(out.answer).toBe("$156");
    expect(out.right).toBe("$89");
    expect(rightAnswer(PAGES[2])).toBe("$9");
  });
});
