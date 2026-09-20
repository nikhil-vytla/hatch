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
