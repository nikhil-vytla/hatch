import "./credentials";
import { readFileSync, writeFileSync } from "node:fs";
const origin = process.argv[2] ?? "https://jev-experiences.vercel.app";
const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${process.env.LAB_ACCESS_TOKEN}`,
};
const payload = {
  state: "Hello, it is good to meet you.",
  questions: {
    greeting: { type: "noul", instructions: "Is this a greeting?" },
  },
};
const anonymous = await fetch(origin + "/api/evaluate", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
const invalid = await fetch(origin + "/api/evaluate", {
  method: "POST",
  headers,
  body: JSON.stringify({ state: "Hello", questions: {} }),
});
const live = await fetch(origin + "/api/evaluate", {
  method: "POST",
  headers,
  body: JSON.stringify(payload),
});
const value = await live.json();
const spec = JSON.parse(
  readFileSync("results/composed-ui.json", "utf8"),
).result.rows.find((r: any) => r.domain === "settings").spec;
const state = { ...spec.state, name: "Preserve this edited name" };
const started = Date.now();
const response = await fetch(origin + "/api/compose", {
  method: "POST",
  headers,
  body: JSON.stringify({
    domain: "settings",
    prompt:
      "Remove the notifications switch. Keep every other field and the save action.",
    state,
    spec,
  }),
});
const reader = response.body!.getReader(),
  decoder = new TextDecoder();
let firstChunkMs: number | null = null,
  body = "";
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  firstChunkMs ??= Date.now() - started;
  body += decoder.decode(value, { stream: true });
}
const events = body
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((s) => JSON.parse(s)),
  last = events.at(-1);
const report = {
  at: new Date().toISOString(),
  origin,
  anonymous: anonymous.status,
  invalid: invalid.status,
  live_status: live.status,
  live_answer: value.answers?.greeting,
  live_attempts: value.attempts,
  live_cost_usd: value.cost_usd,
  composition: {
    http_status: response.status,
    event_count: events.length,
    first_chunk_ms: firstChunkMs,
    total_ms: Date.now() - started,
    stopReason: last?.stopReason,
    error: last?.error,
    preserved_name: last?.spec?.state?.name,
    has_toggle: last?.spec
      ? Object.values(last.spec.elements).some((e: any) => e.type === "Toggle")
      : null,
  },
  events,
};
writeFileSync("results/cloudcheck.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, events: undefined }, null, 2));
if (
  report.anonymous !== 401 ||
  report.invalid !== 400 ||
  report.live_status !== 200
)
  process.exitCode = 1;
