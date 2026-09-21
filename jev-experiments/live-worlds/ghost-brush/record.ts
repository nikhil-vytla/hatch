/** Explicit recording CLI; never imported by browser modules. */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { evaluate, GatewayError } from "../../experience-prototypes/scripts/local-model";
import { ENGINE_VERSION, RECIPES } from "./engine";
import { PROTOCOL, parseRanking, requestFor } from "./model";
const here = import.meta.dir, hash = (s: string) => createHash("sha256").update(s).digest("hex");
const cases = [{ id: "quiet-fabric", prompt: "A quiet fabric made of blue threads" }, { id: "violet-coral", prompt: "Strange branching violet coral" }];
const manifest = { protocol: PROTOCOL, engine: ENGINE_VERSION, label: "Two authored demonstration examples, not a held-out benchmark", bankSha256: hash(JSON.stringify(RECIPES)), modelSourceSha256: hash(readFileSync(resolve(here, "model.ts"), "utf8")), cases: cases.map(c => ({ ...c, requestSha256: hash(JSON.stringify(requestFor(c.prompt))) })) };
const frozen = resolve(here, "recording-manifest.json"), json = JSON.stringify(manifest, null, 2) + "\n";
if (existsSync(frozen) && readFileSync(frozen, "utf8") !== json) throw new Error("Frozen protocol changed. Preserve the old run before changing the contract.");
writeFileSync(frozen, json);
if (!process.argv.includes("--run")) { console.log("Prepared two authored examples. No model calls made; use --run to record."); process.exit(0); }
const file = resolve(here, "recording-events.jsonl"), prior = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s)) : [];
const rows = prior.filter(r => r.event === "completed");
const write = (r: unknown) => appendFileSync(file, JSON.stringify(r) + "\n");
for (const c of manifest.cases) {
  if (rows.some(r => r.id === c.id)) continue;
  const request = requestFor(c.prompt); let complete = false;
  while (!complete) {
    const base = { id: c.id, prompt: c.prompt, requestSha256: c.requestSha256, bankSha256: manifest.bankSha256, startedAt: new Date().toISOString() };
    write({ ...base, event: "request", request });
    try {
      const response = await evaluate(request as Parameters<typeof evaluate>[0], { deadlineMs: 55000, onAttempt: attempt => write({ ...base, event: "attempt", ...attempt }) });
      const row = { ...base, event: "completed", finishedAt: new Date().toISOString(), request, response, ranking: parseRanking(response), responseSha256: hash(JSON.stringify(response)) };
      write(row); rows.push(row); complete = true; console.log(JSON.stringify({ completed: rows.length, planned: 2, id: c.id, best: row.ranking[0].id }));
    } catch (error) {
      const e = error as GatewayError, transient = [408, 429, 500, 502, 503, 504].includes(e.status) && !/invalid/i.test(e.message);
      write({ ...base, event: "failed", status: e.status ?? null, error: e.message, attempts: e.attempts ?? [], transient });
      if (!transient) throw e;
      console.log(JSON.stringify({ event: "backoff", id: c.id, retryMs: Math.max(15000, e.retryAfterMs || 0) }));
      await Bun.sleep(Math.max(15000, e.retryAfterMs || 0));
    }
  }
  writeFileSync(resolve(here, "examples.json"), JSON.stringify({ ...manifest, rows }, null, 2) + "\n");
  await Bun.sleep(2200);
}
