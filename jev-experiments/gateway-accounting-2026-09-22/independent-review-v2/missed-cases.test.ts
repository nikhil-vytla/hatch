import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
const root = process.env.JEV_GATEWAY_REVIEW_SOURCE;
if (!root) throw Error("Set JEV_GATEWAY_REVIEW_SOURCE to the pinned archive source directory.");
for (const [file, expected] of [
  ["jev-experiments/experience-prototypes/server/gateway.ts", "a08c7db41dd24a62827b15b87190efa3032de56a39618d5ab635dd8e87164e50"],
  ["jev-experiments/roadmap/runtime/accounting.ts", "8a09f483965d55e64e11a909524e9494ee24ebb754b6ee91bc487a24422fa5c8"],
]) if (createHash("sha256").update(readFileSync(resolve(root, file))).digest("hex") !== expected) throw Error("Review source hash changed.");
const { evaluate, GatewayError } = await import(resolve(root, "jev-experiments/experience-prototypes/server/gateway.ts"));
const { usageIssue, accountingIssue } = await import(resolve(root, "jev-experiments/roadmap/runtime/accounting.ts"));
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
