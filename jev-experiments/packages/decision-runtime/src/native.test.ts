import { expect, test } from "bun:test";
import { jsonIssue, nativeQuestionIssue } from "./native";

test("JSON transport rejects lossy values without invoking accessors", () => {
  let read = false;
  const getter = { get value() { read = true; return "side effect"; } };
  const cycle: any = {}; cycle.self = cycle;
  for (const value of [getter, cycle, {x: undefined}, {x: NaN}, new Date(), [1,,3], {x: 1n}, {x: () => 1}])
    expect(jsonIssue(value)).not.toBeNull();
  expect(read).toBe(false);
  expect(jsonIssue({same: {x: null}, nested: [true, 2, "value"]})).toBeNull();
  const shared = {value: true};
  expect(jsonIssue([shared, shared])).toBeNull();
});

test("native structure supports all entry shapes while enforcing documented Score limits", () => {
  expect(nativeQuestionIssue({type: "choice", instructions: {ask: ["Which?", null]}, criteria: {a: null, b: [{evidence: true}]}})).toBeNull();
  expect(nativeQuestionIssue({type: "noul", instructions: null, criteria: {true: {means: "Explicit evidence"}, false: ["Missing evidence"]}})).toBeNull();
  expect(nativeQuestionIssue({type: "score", instructions: ["Rate"], criteria: Array(10).fill(null)})).toBeNull();
  for (const q of [
    {type: "score", instructions: "Rate", criteria: Array(11).fill("level")},
    {type: "noul", instructions: "True?", criteria: {true: "yes"}},
    {type: "choice", instructions: "Pick", criteria: {a: 3, b: "text"}},
    {type: "choice", instructions: true, criteria: {a: null, b: "text"}},
  ]) expect(nativeQuestionIssue(q)).not.toBeNull();
});
