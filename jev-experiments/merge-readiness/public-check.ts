import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
const origin = "https://jev-experiments.vercel.app", results: any[] = [];
for (const path of ["/.env", "/.env.local", "/.git/config", "/.vercel/project.json", "/server/gateway.ts", "/scripts/credentials.ts", "/data/access.json", "/data/smoke.json"]) {
  const res = await fetch(origin + path);
  assert.equal(res.status, 404, path);
  results.push({ path, method: "GET", status: res.status });
}
for (const path of ["/api/evaluate", "/api/compose"]) {
  const get = await fetch(origin + path);
  assert.equal(get.status, 405); results.push({ path, method: "GET", status: get.status });
  for (const authorization of [undefined, "invalid-without-bearer-prefix"]) {
    const res = await fetch(origin + path, { method: "POST", headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}) }, body: "{}" });
    assert.equal(res.status, 401); assert.equal(res.headers.get("cache-control"), "no-store");
    results.push({ path, method: "POST", credentials: authorization ? "malformed" : "absent", status: res.status });
  }
}
const rejected = await fetch(origin + "/api/evaluate", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer invalid-audit-key" }, body: JSON.stringify({ state: "hello", questions: { greeting: { type: "noul", instructions: "Is this a greeting?" } } }) });
assert([401,403].includes(rejected.status));
const rejection = await rejected.json();
assert(!JSON.stringify(rejection).includes("invalid-audit-key"));
results.push({ path: "/api/evaluate", credentials: "invalid caller key", status: rejected.status, attempts: rejection.attempts?.length });
const head = await fetch(origin, { method: "HEAD" });
assert(head.headers.get("content-security-policy")?.includes("frame-ancestors 'none'"));
assert.equal(head.headers.get("x-frame-options"), "DENY");
const report = { at: new Date().toISOString(), origin, results, headers: Object.fromEntries(["content-security-policy", "x-frame-options", "x-content-type-options", "referrer-policy"].map(name => [name, head.headers.get(name)])) };
writeFileSync(new URL("public-check.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
