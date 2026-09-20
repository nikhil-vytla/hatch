/** Exercise published assets and unauthenticated boundaries. No provider calls or real keys. */
import { writeFileSync } from "node:fs";
const origin = "https://jev-experiments.vercel.app";
const checks = [
  { path: "/", status: 200 },
  { path: "/data/live-worlds.json", status: 200 },
  { path: "/research/quality-review/review.html", status: 200 },
  { path: "/data/judgment-reliability.json", status: 200 },
  { path: "/api/evaluate", status: 401, body: { state: {}, questions: { ready: { type: "noul", instructions: "Ready?" } } } },
  { path: "/api/wardrobe-token", status: 401, body: { model: "decart/lucy2-vton/realtime" } },
  { path: "/api/wardrobe-token", status: 405 },
  { path: "/api/wardrobe-token", status: 400, key: "synthetic-boundary-check", body: { model: "unsupported-model" } },
];
const results = [];
for (const check of checks) {
  const response = await fetch(origin + check.path, {
    method: check.body ? "POST" : "GET",
    headers: { "Cache-Control": "no-cache", ...(check.body ? { "Content-Type": "application/json" } : {}), ...(check.key ? { Authorization: `Bearer ${check.key}` } : {}) },
    ...(check.body ? { body: JSON.stringify(check.body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  const body = await response.text();
  const data = response.headers.get("content-type")?.includes("application/json") ? JSON.parse(body) : undefined;
  const cacheControl = response.headers.get("cache-control");
  results.push({ path: check.path, method: check.body ? "POST" : "GET", expectedStatus: check.status, status: response.status, bytes: Buffer.byteLength(body), ...(check.path.startsWith("/api/") ? { cacheControl, error: data?.error } : {}), ...(check.path === "/data/live-worlds.json" ? { result: data } : {}), ...(check.path === "/data/judgment-reliability.json" ? { availability: data?.availability } : {}), passed: response.status === check.status && (!check.path.startsWith("/api/") || cacheControl === "no-store") });
}
const report = { at: new Date().toISOString(), origin, passed: results.every(result => result.passed), results };
writeFileSync(new URL("./production-check.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
