import { expect, test } from "bun:test";
import { evaluate, GatewayError } from "../experience-prototypes/server/gateway";
import { usageIssue, accountingIssue } from "../roadmap/runtime/accounting";
const payload = { state: "authored fixture", questions: { q: { type: "noul", instructions: { check: "ready" } } } };
const response = (usage: unknown = { input_tokens: 10, output_tokens: 4, total_tokens: 14 }) => Response.json({
  model: "authored-model", answers: { q: { type: "noul", noul: 0.75 } }, usage,
  provider_metadata: { gateway: { cost: "0.001" } },
});
for (const observer of ["attempt", "accounting"] as const) test(`cancellation inside final ${observer} observer must not resolve success`, async () => {
  const controller = new AbortController();let calls = 0;
  const pending = evaluate(payload, {
    apiKey: "authored-key", signal: controller.signal,
    fetcher: (async () => { calls++; return response(); }) as typeof fetch,
    onAttempt: observer === "attempt" ? () => controller.abort() : undefined,
    onAccounting: observer === "accounting" ? (a: any) => { if (a.attempts.at(-1)?.status === 200) controller.abort(); } : undefined,
  });
  await expect(pending).rejects.toMatchObject({ code: "cancelled", status: 499 });
  expect(calls).toBe(1);
});
test("an observer failure before dispatch must not invent an outbound attempt", async () => {
  let calls = 0;
  const error = await evaluate(payload, {
    apiKey: "authored-key", fetcher: (async () => { calls++; return response(); }) as typeof fetch,
    onAccounting: () => { throw Error("authored observer failure before dispatch"); },
  }).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(GatewayError); expect(error.code).toBe("observer_error");expect(calls).toBe(0);
  expect(error.accounting.attempts).toEqual([]);expect(error.accounting.costUsd).toBe(0);
});
test("a reported total cannot be smaller than an independently known token component", async () => {
  expect(usageIssue({ inputTokens: 10, totalTokens: 4 })).not.toBeNull();
  expect(usageIssue({ outputTokens: 10, totalTokens: 4 })).not.toBeNull();
  const result = await evaluate(payload, { apiKey: "authored-key", fetcher: (async () => response({input_tokens:10,total_tokens:4})) as typeof fetch });
  expect(result.attempts[0].issues).toContain("invalid_usage");
});
test("control: complete success and valid partial observations remain accepted", async () => {
  const result = await evaluate(payload, { apiKey: "authored-key", fetcher: (async () => response()) as typeof fetch });
  expect(result.answers.q.value).toBe(.75);expect(result.cost_usd).toBe(.001);expect(accountingIssue(result.accounting)).toBeNull();
  expect(usageIssue({ inputTokens: 4, totalTokens: 10 })).toBeNull();
});
test("control: cancellation while a response is outstanding rejects late success", async () => {
  const controller = new AbortController();let settle!: (r:Response)=>void;
  const pending = evaluate(payload,{apiKey:"authored-key",signal:controller.signal,fetcher:(()=>new Promise<Response>(resolve=>{settle=resolve;})) as typeof fetch});
  controller.abort();settle(response());await expect(pending).rejects.toMatchObject({code:"cancelled",status:499});
});
