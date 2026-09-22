import { test, expect } from "bun:test";
import {
  validateRequest,
  validateResponse,
  questionValues,
  DEFAULT_LIMITS,
  type DecisionRequest,
  type DecisionResponse,
} from "./contract";
const req: DecisionRequest = {
  schemaVersion: "2",
  requestId: "test",
  state: { message: "hello" },
  questions: [
    {
      id: "q",
      kind: "choice",
      prompt: "Pick",
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    },
  ],
};
const answer = (): DecisionResponse => ({
  schemaVersion: "2",
  requestId: "test",
  status: "ok",
  decisions: [
    {
      questionId: "q",
      distribution: [
        { value: "a", probability: 0.6 },
        { value: "b", probability: 0.4 },
      ],
      selected: "a",
    },
  ],
  execution: { adapter: "fixture", model: "none", local: true },
  timing: { totalMs: 0 },
  issues: [],
});
test("preserves meaning for choice, boolean and fractional ordinal", () => {
  expect(validateRequest(req)).toEqual([]);
  expect(validateResponse(req, answer())).toEqual([]);
  expect(
    questionValues({
      id: "q",
      kind: "ordinal",
      prompt: "Rate",
      min: 0,
      max: 1,
      step: 0.5,
    }),
  ).toEqual([0, 0.5, 1]);
  expect(questionValues({ id: "q", kind: "boolean", prompt: "Yes?" })).toEqual([
    false,
    true,
  ]);
});
test("rejects undeclared and inherited keys, missing mass and duplicate answers", () => {
  for (const value of ["constructor", "__proto__"]) {
    const a = answer();
    a.decisions[0].distribution[0].value = value;
    expect(validateResponse(req, a).length).toBeGreaterThan(0);
  }
  const a = answer();
  a.decisions[0].distribution.pop();
  expect(validateResponse(req, a).length).toBeGreaterThan(0);
});
test("rejects oversized requests without truncating", () => {
  expect(
    validateRequest(req, { ...DEFAULT_LIMITS, maxStateBytes: 1 })[0].code,
  ).toBe("input_limit");
  expect(req.state).toEqual({ message: "hello" });
  expect(
    validateRequest({
      ...req,
      questions: [...req.questions, ...req.questions],
    })[0].code,
  ).toBe("duplicate_question");
});
test("requires explicit error and identity, rejects non-JSON values", () => {
  const a = answer();
  a.status = "unsupported";
  expect(validateResponse(req, a).length).toBeGreaterThan(0);
  a.decisions = [];
  a.issues = [{ code: "limit", message: "Too long" }];
  expect(validateResponse(req, a)).toEqual([]);
  expect(validateRequest({ ...req, state: { value: Infinity } })[0].code).toBe(
    "invalid_state",
  );
});
