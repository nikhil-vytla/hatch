/** Small, non-mutating checks against the authorized public deployment. */
import { writeFileSync } from "node:fs";
const origin = "https://jev-experiments.vercel.app";
const paths = ["/.env", "/.env.local", "/.git/config", "/.vercel/project.json", "/server/gateway.ts", "/scripts/credentials.ts", "/data/access.json", "/data/smoke.json", "/api/evaluate", "/api/compose"];
const results = [];
for (const path of paths) {
  const response = await fetch(origin + path);
  const body = await response.text();
  results.push({ path, method: "GET", status: response.status, content_type: response.headers.get("content-type"), bytes: body.length, exposes_source_or_secret_file: response.status === 200 && !body.includes('<div id="root">') && !body.includes('<div id="app">') });
}
for (const path of ["/api/evaluate", "/api/compose"]) {
  for (const authorization of [undefined, "Bearer audit-invalid-token"]) {
    const response = await fetch(origin + path, { method: "POST", headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}) }, body: JSON.stringify({ state: "audit", questions: {}, prompt: "audit" }) });
    results.push({ path, method: "POST", credentials: authorization ? "incorrect" : "absent", status: response.status });
    if (response.status !== 401) throw new Error("Unexpected authorization response for " + path);
  }
}
const headers = await fetch(origin, { method: "HEAD" });
const report = { at: new Date().toISOString(), origin, results, headers: { csp: headers.headers.get("content-security-policy"), frame_options: headers.headers.get("x-frame-options"), content_type_options: headers.headers.get("x-content-type-options"), referrer_policy: headers.headers.get("referrer-policy"), strict_transport_security: headers.headers.get("strict-transport-security"), access_control_allow_origin: headers.headers.get("access-control-allow-origin") } };
writeFileSync(new URL("public-surface-results.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
