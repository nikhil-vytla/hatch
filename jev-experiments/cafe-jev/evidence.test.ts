import { test, expect } from "bun:test";
import { readRecord } from "../experience-prototypes/scripts/records";
import { CASES, comparePreferences } from "./cases";
import {
  CONTRACT_VERSION,
  MENU_REVISION,
  constraintErrors,
  interpret,
  recordingPayload,
} from "./engine";

const document = readRecord(new URL("./cafe.jsonl", import.meta.url));
const { result } = document;
test("published cafe evidence covers the declared set once, without relabeling provider failures", () => {
  expect(document.manifest.status).toBe("complete");
  expect(result.coverage.planned).toBe(102);
  expect(result.rows).toHaveLength(CASES.length);
  expect(new Set(result.rows.map((r: any) => r.id)).size).toBe(CASES.length);
  expect(result.coverage.missing).toEqual([]);
  expect(
    result.providerFailures.every(
      (f: any) => !Object.hasOwn(f, "score") && Array.isArray(f.attempts),
    ),
  ).toBe(true);
  expect(result.metrics.extractionExact.denominator).toBe(CASES.length);
});
test("recorded answers replay through the current shared contract with honest scores", () => {
  let exact = 0,
    violationsAgainstGold = 0;
  for (const c of CASES) {
    const row = result.rows.find((r: any) => r.id === c.id);
    expect(row.contractVersion).toBe(CONTRACT_VERSION);
    expect(row.menuRevision).toBe(MENU_REVISION);
    expect(row.source).toBe("recorded");
    expect(row.response.source).toBe("live");
    expect(row.input).toEqual(c.input);
    expect(row.expected).toEqual(c.expected);
    const decision = interpret(row.response, c.input);
    const score = comparePreferences(decision.preferences, c.expected);
    expect(row.score.exact).toBe(score.exact);
    expect(row.interpreted.preferences).toEqual(decision.preferences);
    expect(row.interpreted.question).toBe(decision.question);
    if (score.exact) exact++;
    if (decision.suggested) {
      expect(
        constraintErrors(
          decision.suggested,
          decision.preferences,
          c.input.inventory,
        ),
      ).toEqual([]);
      if (
        constraintErrors(decision.suggested, c.expected, c.input.inventory)
          .length
      )
        violationsAgainstGold++;
    }
  }
  expect(result.metrics.extractionExact.numerator).toBe(exact);
  expect(result.metrics.guardedSuggestedHardViolations).toBe(
    violationsAgainstGold,
  );
});
test("every original public batch is reconstructable and excludes expected labels and private goals", () => {
  const seen: string[] = [];
  for (const batch of result.requestBatches) {
    const inputs = Object.fromEntries(
      batch.caseIds.map((id: string) => [
        id,
        CASES.find((c) => c.id === id)!.input,
      ]),
    );
    expect(batch.payload).toEqual(recordingPayload(inputs));
    for (const input of Object.values(batch.payload.state.cases) as any[]) {
      expect(Object.keys(input).sort()).toEqual([
        "explicit",
        "inventory",
        "transcript",
      ]);
      expect(Object.hasOwn(input, "goal")).toBe(false);
      expect(Object.hasOwn(input, "expected")).toBe(false);
    }
    seen.push(...batch.caseIds);
  }
  expect(seen.sort()).toEqual(CASES.map((c) => c.id).sort());
});
