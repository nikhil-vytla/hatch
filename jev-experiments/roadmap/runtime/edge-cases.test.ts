import { test, expect } from "bun:test";
import { decide } from "./execute";
import {
  DEFAULT_LIMITS,
  questionValues,
  validateRequest,
  type Adapter,
  type DecisionRequest,
  type DecisionResponse,
} from "./contract";
import { createJevAdapter } from "./jev";
import { evaluate } from "../../experience-prototypes/server/gateway";
import { decode } from "../../adapters/typescript/index";

const request: DecisionRequest = {
  schemaVersion: "2",
  requestId: "fixture",
  state: "fixture",
  questions: [{ id: "q", kind: "boolean", prompt: "Fixture?" }],
};
const identity = {
  adapter: "fixture",
  model: "fixture",
  revision: "one",
  local: true,
};
const response = (): DecisionResponse => ({
  schemaVersion: "2",
  requestId: "fixture",
  status: "ok",
  decisions: [
    {
      questionId: "q",
      distribution: [
        { value: false, probability: 0 },
        { value: true, probability: 1 },
      ],
      selected: true,
        probabilityTrue: 1,
    },
  ],
  execution: identity,
  timing: { totalMs: 1 },
  issues: [],
});
const adapter: Adapter = {
  identity,
  limits: DEFAULT_LIMITS,
  decide: async () => response(),
};
const nativeRequest = {
  state: "fixture",
  questions: { q: { type: "noul" as const, instructions: "Fixture?" } },
};

test("untyped invalid requests return an explicit error before inference", async () => {
  const result = await decide(adapter, null as unknown as DecisionRequest);
  expect(result.status).toBe("error");
  expect(result.decisions).toEqual([]);
  expect(result.issues[0].code).toBe("invalid_request");
});
test("configured revision cannot silently change", async () => {
  const result = await decide(
    {
      ...adapter,
      decide: async () => ({
        ...response(),
        execution: { ...identity, revision: "two" },
      }),
    },
    request,
  );
  expect(result.status).toBe("error");
  expect(result.issues[0].code).toBe("identity_mismatch");
  expect(result.decisions).toEqual([]);
});
test("representable adjacent ordinal values retain identities", () => {
  const q = {
    id: "o",
    kind: "ordinal" as const,
    prompt: "Rate",
    min: 100000000000000,
    max: 100000000000001,
    step: 1,
  };
  expect(questionValues(q)).toEqual([q.min, q.max]);
  expect(validateRequest({ ...request, questions: [q] })).toEqual([]);
});
test("null provider JSON fails once instead of rerolling", async () => {
  let calls = 0;
  await expect(
    evaluate(nativeRequest, {
      apiKey: "fixture",
      fetcher: (async () => {
        calls++;
        return Response.json(null);
      }) as unknown as typeof fetch,
      wait: async () => {},
    }),
  ).rejects.toMatchObject({ status: 502 });
  expect(calls).toBe(1);
});
test("gateway checks cancellation after a transport returns", async () => {
  const control = new AbortController();
  await expect(
    evaluate(nativeRequest, {
      apiKey: "fixture",
      signal: control.signal,
      fetcher: (async () => {
        control.abort();
        return Response.json({ answers: { q: { type: "noul", noul: 0.8 } } });
      }) as unknown as typeof fetch,
    }),
  ).rejects.toThrow();
});
test("native instruction limit is declared and rejected before calling provider", async () => {
  let calls = 0;
  const native = createJevAdapter("fixture", (async () => {
    calls++;
    throw Error("Unexpected provider call");
  }) as unknown as typeof fetch);
  const result = await decide(native, {
    ...request,
    questions: [{ id: "q", kind: "boolean", prompt: "x".repeat(12001) }],
  });
  expect(native.limits.maxPromptChars).toBe(12000);
  expect(result.status).toBe("unsupported");
  expect(result.issues[0].code).toBe("prompt_limit");
  expect(calls).toBe(0);
});
test("direct decoder preserves string enum identity", () => {
  const schema = {
    type: "object",
    required: ["intent"],
    properties: {
      intent: { type: "string", enum: ["1", "2"], description: "Pick" },
    },
  };
  expect(() =>
    decode(schema, {
      intent: {
        type: "choice",
        value: 1,
        probabilities: { "1": 1, "2": 0 },
        confidence: 1,
      },
    }),
  ).toThrow();
});
test("direct decoder rejects array probability containers", () => {
  const schema = {
    type: "object",
    required: ["score"],
    properties: {
      score: {
        type: "number",
        minimum: 0,
        maximum: 2,
        "x-jev-levels": ["Low", "Mid", "High"],
        description: "Rate",
      },
    },
  };
  expect(() =>
    decode(schema, {
      score: {
        type: "score",
        value: 1,
        probabilities: [0, 1, 0] as any,
        confidence: 1,
      },
    }),
  ).toThrow();
});
