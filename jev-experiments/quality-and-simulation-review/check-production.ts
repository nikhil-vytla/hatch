/** Exercise published assets and unauthenticated boundaries. No provider calls or real keys. */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const origin = "https://jev-experiments.vercel.app";
const expectedStudy = JSON.parse(readFileSync(new URL("../judgment-reliability/verification.json", import.meta.url), "utf8"));
const checks = [
  { path: "/", status: 200 },
  { path: "/data/live-worlds.json", status: 200 },
  { path: "/research/quality-review/review.html", status: 200 },
  { path: "/data/judgment-reliability.json", status: 200 },
  { path: "/judgment-reliability/analysis.json", status: 200 },
  { path: "/api/evaluate", status: 401, body: { state: {}, questions: { ready: { type: "noul", instructions: "Ready?" } } } },
  { path: "/api/compose", status: 401, body: { prompt: "A settings form" } },
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
  const result = data?.result ?? data;
  const cacheControl = response.headers.get("cache-control");
  const completeStudy = check.path !== "/data/judgment-reliability.json" || expectedStudy.complete && result?.availability?.completed_decisions === expectedStudy.planned_questions && result?.availability?.completed === expectedStudy.planned_evaluations && result?.analysis?.source_clusters === expectedStudy.source_clusters && result?.manifest?.cases_sha256 === expectedStudy.source_sha256 && result?.manifest?.protocol_sha256 === expectedStudy.protocol_sha256;
  const currentAnalysis = check.path !== "/judgment-reliability/analysis.json" || result?.source_clusters === expectedStudy.source_clusters && result?.version === expectedStudy.analysis_version;
  results.push({ path: check.path, method: check.body ? "POST" : "GET", expectedStatus: check.status, status: response.status, bytes: Buffer.byteLength(body), ...(check.path.startsWith("/api/") ? { cacheControl, error: data?.error } : {}), ...(check.path === "/data/live-worlds.json" ? { result } : {}), ...(check.path === "/data/judgment-reliability.json" ? { availability: result?.availability, completeStudy } : {}), ...(check.path === "/judgment-reliability/analysis.json" ? { analysis: result } : {}), passed: response.status === check.status && (!check.path.startsWith("/api/") || cacheControl === "no-store") && completeStudy && currentAnalysis });
}
const media = [];
for (const [filename, manifest] of [["try-on-demo.webm", "recording.json"], ["spoken-try-on-demo.webm", "spoken-recording.json"]]) {
  const expected = JSON.parse(readFileSync(new URL(`../wardrobe-lab/${manifest}`, import.meta.url), "utf8"));
  const response = await fetch(`${origin}/wardrobe/${filename}`, { cache: "no-store", signal: AbortSignal.timeout(30000) });
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  media.push({ path: `/wardrobe/${filename}`, status: response.status, bytes: bytes.length, sha256, expectedDurationSeconds: expected.containerDurationSeconds, passed: response.ok && bytes.length === expected.videoBytes && sha256 === expected.videoSha256 });
}
const report = { at: new Date().toISOString(), origin, passed: results.every(result => result.passed) && media.every(result => result.passed), results, media };
writeFileSync(new URL("./production-check.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
