import { expect, test } from "bun:test";
import * as z from "zod";
import { compile, decide, decode, type Answer } from "./index";
import { Ticket } from "./demo";
const answers: Record<string, Answer> = {
  area: {
    type: "choice",
    value: "billing",
    probabilities: {
      billing: 0.9,
      technical: 0.03,
      account: 0.03,
      other: 0.04,
    },
    confidence: 0.7,
  },
  refund: { type: "noul", value: 0.92, probabilities: null, confidence: null },
  missing_context: {
    type: "noul",
    value: 0.3,
    probabilities: null,
    confidence: null,
  },
};
test("validates typed values while preserving distributions", async () => {
  const result = await decide(Ticket, "fixture", async () => answers);
  expect(result.value).toEqual({
    area: "billing",
    refund: true,
    missing_context: 0.3,
  });
  expect(result.answers.area.probabilities!.billing).toBe(0.9);
});
test("rejects unsupported extraction and optional fields before transport", () => {
  expect(() =>
    compile(
      z.toJSONSchema(z.object({ text: z.string().describe("Extract text") })),
    ),
  ).toThrow("Unsupported");
  expect(() =>
    compile(
      z.toJSONSchema(
        z.object({ flag: z.boolean().optional().describe("Is it true?") }),
      ),
    ),
  ).toThrow("Optional");
});
test("rejects wrong types, invalid values and malformed distributions", () => {
  for (const wrong of [
    { ...answers.refund, type: "score" },
    { ...answers.refund, value: NaN },
    { ...answers.refund, value: 2 },
  ])
    expect(() =>
      decode(z.toJSONSchema(Ticket), { ...answers, refund: wrong as Answer }),
    ).toThrow();
  expect(() =>
    decode(z.toJSONSchema(Ticket), {
      ...answers,
      area: { ...answers.area, probabilities: { billing: 1 } },
    }),
  ).toThrow();
});
test("supports nested schema references and refuses cycles", () => {
  const schema = {
    $defs: { flag: { type: "boolean", description: "Is this true?" } },
    type: "object",
    required: ["nested"],
    properties: {
      nested: {
        type: "object",
        required: ["flag"],
        properties: { flag: { $ref: "#/$defs/flag" } },
      },
    },
  };
  expect(compile(schema)["nested.flag"].type).toBe("noul");
  expect(
    decode(schema, {
      "nested.flag": {
        type: "noul",
        value: 0.49,
        probabilities: null,
        confidence: null,
      },
    }),
  ).toEqual({ nested: { flag: false } });
  expect(() =>
    compile({ $defs: { x: { $ref: "#/$defs/x" } }, $ref: "#/$defs/x" }),
  ).toThrow();
});

test("annotations preserve structured instructions, criteria and two-level Score semantics", () => {
  const schema = {type: "object", required: ["kind", "present", "severity"], properties: {
    kind: {type: "string", enum: ["bug", "other"], "x-jev-instructions": {ask: "Which?"}, "x-jev-criteria": {bug: ["Broken behavior"], other: null}},
    present: {type: "boolean", description: "Evidence present?", "x-jev-criteria": {true: {needs: "citation"}, false: null}},
    severity: {type: "number", minimum: 0, maximum: 1, "x-jev-instructions": null, "x-jev-levels": [{impact: "low"}, {impact: "high"}]},
  }};
  const questions = compile(schema);
  expect(questions.kind.instructions).toEqual({ask: "Which?"});
  expect(questions.kind.criteria).toEqual({bug: ["Broken behavior"], other: null});
  expect(questions.present.criteria).toEqual({true: {needs: "citation"}, false: null});
  expect(questions.severity.type).toBe("score");
  expect(questions.severity.instructions).toBeNull();
  expect(decode(schema, {
    kind: {type: "choice", value: "other", probabilities: {bug: .3, other: .7}, confidence: .2},
    present: {type: "noul", value: .4, probabilities: null, confidence: null},
    severity: {type: "score", value: .65, probabilities: {"0": .35, "1": .65}, confidence: .1},
  })).toEqual({kind: "other", present: false, severity: .65});
});

test("unknown, mismatched and excessive annotations fail before transport", () => {
  const field = {type: "string", enum: ["a", "b"], description: "Which?"};
  for (const unsupported of [
    {...field, "x-jev-criterai": {a: "A", b: "B"}},
    {...field, "x-jev-criteria": {a: "A", c: "C"}},
    {...field, "x-jev-levels": ["A", "B"]},
    {type: "number", minimum: 0, maximum: 10, description: "Rate", "x-jev-levels": Array(11).fill("level")},
  ]) expect(() => compile({type: "object", required: ["q"], properties: {q: unsupported}})).toThrow();
});

test("native Noul probability maps must agree with the scalar", () => {
  const schema = {type: "object", required: ["q"], properties: {q: {type: "boolean", description: "Present?"}}};
  const answer: Answer = {type: "noul", value: .7, probabilities: {false: .3, true: .7}, confidence: null};
  expect(decode(schema, {q: answer})).toEqual({q: true});
  expect(() => decode(schema, {q: {...answer, probabilities: {false: .4, true: .6}}})).toThrow("Malformed");
});
