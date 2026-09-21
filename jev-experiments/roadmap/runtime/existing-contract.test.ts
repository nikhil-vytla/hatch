import { test, expect } from "bun:test";
import { evaluate } from "../../experience-prototypes/server/gateway";
import { decode } from "../../adapters/typescript/index";
const request = {
  state: "fixture",
  questions: {
    q: {
      type: "score" as const,
      instructions: "Rate low to high",
      criteria: ["low", "high"],
    },
  },
};
test("gateway rejects undeclared score probabilities without rerolling", async () => {
  for (const probabilities of [
    { unrelated: 1 },
    { constructor: 1 },
    { "0": 1 },
    { "0": 0.5, "1": 0.5, extra: 0 },
    [0.5, 0.5],
  ]) {
    let calls = 0;
    await expect(
      evaluate(request, {
        apiKey: "fixture",
        fetcher: (async () => {
          calls++;
          return Response.json({
            answers: { q: { type: "score", score: 1, probabilities } },
          });
        }) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ status: 502 });
    expect(calls).toBe(1);
  }
  const actual = await evaluate(request, {
    apiKey: "fixture",
    fetcher: (async () =>
      Response.json({
        answers: {
          q: {
            type: "score",
            score: 0.7,
            probabilities: { "0": 0.3, "1": 0.7 },
          },
        },
      })) as unknown as typeof fetch,
  });
  expect(actual.answers.q.value).toBe(0.7);
});
test("direct decoder rejects inherited option names", () => {
  const schema = {
    type: "object",
    required: ["intent"],
    properties: {
      intent: { type: "string", enum: ["a", "b"], description: "Pick" },
    },
  };
  for (const value of ["constructor", "__proto__", "toString"])
    expect(() =>
      decode(schema, {
        intent: {
          type: "choice",
          value,
          probabilities: null,
          confidence: null,
        },
      }),
    ).toThrow("Unknown option");
});
