import { expect, test } from "bun:test";
import { hashText, preparePublicResult } from "./publication";

test("public omissions remove only hashed fields, retain scores, and tolerate repeated preparation", () => {
  const manifest: any = {
    notice: "Omitted",
    criterion: "Test policy",
    coverage: {},
    omissions: [
      {
        subset: "Safety",
        id: "same-id",
        prompt_omitted: true,
        prompt_sha256: hashText("fixture prompt"),
        candidates: [{ sha256: hashText("fixture rejected") }],
      },
    ],
  };
  const result = {
    rows: [
      {
        subset: "Safety",
        id: "same-id",
        prompt: "fixture prompt",
        candidates: [
          { text: "fixture preferred", chosen: true, score: 9 },
          { text: "fixture rejected", chosen: false, score: 2 },
        ],
      },
      {
        subset: "Focus",
        id: "same-id",
        prompt: "different case",
        candidates: [],
      },
    ],
  };
  preparePublicResult(result, manifest);
  expect(result.rows[0].prompt).toBe("Omitted");
  expect(
    result.rows[0].candidates.map((c) => [c.text, c.chosen, c.score]),
  ).toEqual([
    ["fixture preferred", true, 9],
    ["Omitted", false, 2],
  ]);
  expect(result.rows[1].prompt).toBe("different case");
  expect(() => preparePublicResult(result, manifest)).not.toThrow();
});

test("changed source text fails closed rather than quietly missing a reviewed omission", () => {
  expect(() =>
    preparePublicResult(
      {
        rows: [{ subset: "Focus", id: "1", prompt: "changed", candidates: [] }],
      },
      {
        notice: "Omitted",
        criterion: "Test",
        coverage: {},
        omissions: [
          {
            subset: "Focus",
            id: "1",
            prompt_omitted: true,
            prompt_sha256: hashText("original"),
            candidates: [],
          },
        ],
      } as any,
    ),
  ).toThrow("Omission source mismatch");
});
