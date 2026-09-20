/** Local-only reproductions. Uses fake credentials and intercepts every provider call. */
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync, writeFileSync } from "node:fs";
import { evaluate, authorize } from "../experience-prototypes/server/gateway";
import evaluateHandler from "../experience-prototypes/api/evaluate";
import composeHandler from "../experience-prototypes/api/compose";

process.env.AI_GATEWAY_API_KEY = "audit-provider-sentinel";
process.env.LAB_ACCESS_TOKEN = "audit-lab-sentinel";
const payload = { state: "Synthetic audit case", questions: { greeting: { type: "noul", instructions: "Is this a greeting?" } } };
const mockResponse = (body: any) => Response.json({ answers: Object.fromEntries(Object.entries(body.questions).map(([id, q]: [string, any]) => [id, q.type === "choice" ? { type: "choice", choice: Object.hasOwn(q.criteria, "finish") ? "finish" : Object.hasOwn(q.criteria, "unavailable") ? "unavailable" : Object.keys(q.criteria)[0] } : { type: q.type, [q.type]: q.type === "noul" ? 0.9 : 0 }])) });
const report: any = { network: "Every provider request was intercepted; no live API calls." };
assert.equal(authorize(undefined), false);
assert.equal(authorize("Bearer incorrect"), false);
assert.equal(authorize("Bearer audit-lab-sentinel"), true);
report.auth_checks = "Missing and incorrect credentials rejected; correct synthetic token accepted.";
let forwarded: any;
await evaluate({ ...payload, model: "audit/arbitrary-model", gateway: { audit_marker: true } } as any, {
  fetcher: async (_url, init) => { forwarded = JSON.parse(String(init?.body)); return mockResponse(forwarded); },
});
assert.equal(forwarded.model, "audit/arbitrary-model");
assert.equal(forwarded.gateway.audit_marker, true);
report.extra_fields = { model_override_forwarded: true, extra_gateway_options_forwarded: true, provider_acceptance_tested: false };

const makeResponse = () => ({ code: 200, body: null as any, chunks: [] as string[], setHeader() {}, status(n: number) { this.code = n; return this; }, json(body: any) { this.body = body; return this; }, on() {}, write(chunk: string) { this.chunks.push(chunk); }, end() {} });
const realFetch = globalThis.fetch;
try {
  globalThis.fetch = async (_url, init) => mockResponse(JSON.parse(String(init?.body)));
  let successful = 0;
  for (let i = 0; i < 100; i++) {
    const response = makeResponse();
    await evaluateHandler({ method: "POST", headers: { authorization: "Bearer audit-lab-sentinel" }, body: payload }, response);
    if (response.code === 200) successful++;
  }
  assert.equal(successful, 100);
  report.sequential_evaluations = { sent: 100, accepted: successful, context: "One local handler instance; mocked provider." };
  let active = 0, maxActive = 0, release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = async (_url, init) => {
    active++; maxActive = Math.max(maxActive, active);
    await hold; active--;
    return mockResponse(JSON.parse(String(init?.body)));
  };
  const responses = Array.from({ length: 8 }, makeResponse);
  const work = responses.map(response => composeHandler({ method: "POST", headers: { authorization: "Bearer audit-lab-sentinel" }, body: { prompt: "Stop when possible", domain: "settings" } }, response));
  await new Promise(resolve => setTimeout(resolve, 50));
  release();
  await Promise.all(work);
  assert.equal(maxActive, 8);
  report.concurrent_compositions = { sent: 8, simultaneous_mock_provider_calls: maxActive, context: "No production load test was performed." };
} finally { globalThis.fetch = realFetch; }

let listener: any, extensionRequest: any;
const context = {
  chrome: {
    runtime: { onInstalled: { addListener() {} }, onMessage: { addListener(fn: any) { listener = fn; } } },
    contextMenus: { create() {}, onClicked: { addListener() {} } },
    storage: { local: { async get() { return { endpoint: "https://lab.example", token: "audit-lab-sentinel", source: "Email: demo@example.com", useMemory: false }; } } },
    action: { setBadgeText() {} },
  },
  URL,
  fetch: async (_url: any, init: any) => { extensionRequest = JSON.parse(init.body); return Response.json({ answers: { field0: { value: "f0" } } }); },
};
vm.runInNewContext(readFileSync(new URL("../experience-prototypes/extension/background.js", import.meta.url), "utf8"), context);
const destination = "https://forms.example/reset?token=AUDIT_QUERY_SENTINEL#AUDIT_FRAGMENT_SENTINEL";
await new Promise(resolve => listener({ type: "suggest", fields: [{ id: "field0", label: "Email", type: "email" }] }, { tab: { url: destination } }, resolve));
assert.equal(extensionRequest.state.destination, destination);
report.companion_url = { query_sent_to_provider: true, fragment_sent_to_provider: true, fixture: destination };
writeFileSync(new URL("local-probe-results.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
