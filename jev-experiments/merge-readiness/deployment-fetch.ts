import { spawnSync } from "node:child_process";
export const ownerFetch = (async (url: any, init: any = {}) => {
  const config = ["silent", "show-error", `request = ${JSON.stringify(init.method ?? "GET")}`, ...Object.entries(init.headers ?? {}).map(([name, value]) => `header = ${JSON.stringify(name + ": " + value)}`), ...(init.body ? [`data = ${JSON.stringify(String(init.body))}`] : []), 'write-out = "\\nJEV_HTTP_STATUS:%{http_code}"'].join("\n");
  const result = spawnSync("bunx", ["--bun", "vercel", "curl", new URL(String(url)).pathname, "--deployment", new URL(String(url)).origin, "--", "--config", "-"], { cwd: new URL("../experience-prototypes/", import.meta.url), input: config, maxBuffer: 5_000_000, timeout: 90000 });
  if (result.status !== 0) throw new Error("Owner-authenticated deployment request failed; credential-bearing diagnostics suppressed.");
  const index = result.stdout.lastIndexOf(Buffer.from("\nJEV_HTTP_STATUS:"));
  if (index < 0) throw new Error("Missing deployment response status.");
  return new Response(result.stdout.slice(0, index), { status: Number(result.stdout.subarray(index + 17).toString()), headers: { "Content-Type": new URL(String(url)).pathname.endsWith("compose") ? "application/x-ndjson" : "application/json" } });
}) as typeof fetch;
