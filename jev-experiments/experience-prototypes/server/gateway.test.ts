import { test, expect, beforeAll, afterAll } from "bun:test";
import {
  evaluate,
  validate,
  retryDelay,
  GatewayError,
  type Payload,
} from "./gateway";
const prior = process.env.AI_GATEWAY_API_KEY;
beforeAll(() => {
  process.env.AI_GATEWAY_API_KEY = "unit-test-key";
});
afterAll(() => {
  if (prior) process.env.AI_GATEWAY_API_KEY = prior;
  else delete process.env.AI_GATEWAY_API_KEY;
});
const payload: Payload = {
  state: "Hello",
  questions: {
    greeting: { type: "noul", instructions: "Is this a greeting?" },
  },
};
const ok = () =>
  Response.json({ answers: { greeting: { type: "noul", noul: 0.96 } } });
test("429 waits for Retry-After and records attempts separately from the answer", async () => {
  let calls = 0;
  const waits: number[] = [];
  const result = await evaluate(payload, {
    apiKey: "caller-owned-key",
    fetcher: (async () =>
      ++calls === 1
        ? new Response("", { status: 429, headers: { "Retry-After": "2" } })
        : ok()) as typeof fetch,
    wait: async (ms) => {
      waits.push(ms);
    },
  });
  expect(waits).toEqual([2000]);
  expect(result.retries).toBe(1);
  expect(result.answers.greeting.value).toBe(0.96);
  expect(result.attempts.map((x) => x.status)).toEqual([429, 200]);
});
test("authorization rejection is not retried", async () => {
  let calls = 0;
  await expect(
    evaluate(payload, {
      apiKey: "caller-owned-key",
      fetcher: (async () => {
        calls++;
        return new Response("", { status: 403 });
      }) as typeof fetch,
    }),
  ).rejects.toMatchObject({ status: 403 });
  expect(calls).toBe(1);
});
test("a cooldown exceeding the deadline is returned for later resumption", async () => {
  let waits = 0;
  await expect(
    evaluate(payload, {
      apiKey: "caller-owned-key",
      fetcher: (async () =>
        new Response("", {
          status: 429,
          headers: { "Retry-After": "120" },
        })) as typeof fetch,
      deadlineMs: 1000,
      wait: async () => {
        waits++;
      },
    }),
  ).rejects.toMatchObject({ status: 503, retryAfterMs: 120000 });
  expect(waits).toBe(0);
});
test("network failure may retry, but an explicit cancellation stops", async () => {
  let calls = 0;
  const result = await evaluate(payload, {
    apiKey: "caller-owned-key",
    fetcher: (async () => {
      if (++calls === 1) throw new TypeError("network");
      return ok();
    }) as typeof fetch,
    wait: async () => {},
  });
  expect(result.retries).toBe(1);
  const controller = new AbortController();
  controller.abort();
  await expect(
    evaluate(payload, {
      apiKey: "caller-owned-key",
      signal: controller.signal,
      fetcher: (async () => {
        throw new Error("must not fetch");
      }) as typeof fetch,
    }),
  ).rejects.toBeDefined();
});
test("malformed model answers remain inspectable failures, never silently rerolled", async () => {
  for (const data of [
    { type: "noul", noul: 1.2 },
    { type: "noul", noul: 0.3, confidence: 9 },
    { type: "noul", noul: 0.3, probabilities: { yes: 2 } },
  ]) {
    let calls = 0;
    await expect(
      evaluate(payload, {
        apiKey: "caller-owned-key",
        fetcher: (async () => {
          calls++;
          return Response.json({ answers: { greeting: data } });
        }) as typeof fetch,
      }),
    ).rejects.toMatchObject({ status: 502 });
    expect(calls).toBe(1);
  }
});
test("request bounds and date Retry-After are enforced", () => {
  expect(() => validate({ state: "x", questions: {} })).toThrow(GatewayError);
  expect(() =>
    validate({
      state: "x",
      questions: {
        x: {
          type: "choice",
          instructions: "Choose",
          criteria: { only: "one" },
        },
      },
    }),
  ).toThrow(GatewayError);
  expect(
    retryDelay(
      "Wed, 21 Oct 2015 07:28:02 GMT",
      0,
      Date.parse("Wed, 21 Oct 2015 07:28:00 GMT"),
    ),
  ).toBe(2000);
});
