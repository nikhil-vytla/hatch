import { appendFileSync, readFileSync, existsSync, writeFileSync, openSync, closeSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { readRecord } from "../experience-prototypes/scripts/records";
import { evaluate, GatewayError } from "../experience-prototypes/scripts/local-model";
import { PRESETS, PROTOCOL, makeBatches, readScores, type SearchMode, type Artwork, type SearchScores } from "./protocol";
const here = import.meta.dir, file = resolve(here, "events.jsonl"), hash = (s: string) => createHash("sha256").update(s).digest("hex");
const collectionText = readFileSync(resolve(here, "collection.jsonl"), "utf8"), collection = readRecord(resolve(here, "collection.jsonl")), works: Artwork[] = collection.result.works;
const manifest = { ...PROTOCOL, collection_sha256: hash(collectionText), protocol_sha256: hash(JSON.stringify(PROTOCOL)), planned_scores: works.length * PRESETS.length * 2, frozen_at: "2026-09-20" };
const manifestPath = resolve(here, "manifest.json"), expectedManifest = JSON.stringify(manifest, null, 2) + "\n";
if (existsSync(manifestPath) && readFileSync(manifestPath, "utf8") !== expectedManifest) throw new Error("Frozen collection or protocol changed");
writeFileSync(manifestPath, expectedManifest);
if (!process.argv.includes("--run")) { console.log(JSON.stringify({ status: "prepared, no API calls made", planned_scores: manifest.planned_scores, manifest: manifestPath })); process.exit(0); }
const lock = resolve(here, ".recording.lock"), fd = openSync(lock, "wx"); const cleanup = () => { try { closeSync(fd); unlinkSync(lock); } catch {} }; process.on("exit", cleanup); process.on("SIGTERM", () => process.exit(143)); process.on("SIGINT", () => process.exit(130));
const prior: any[] = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s)) : [], completed = new Map<string, any>();
for (const row of prior) if (row.event === "completed") { if (completed.has(row.id)) throw new Error(`Duplicate completed score ${row.id}`); if (row.protocol_sha256 !== manifest.protocol_sha256 || row.collection_sha256 !== manifest.collection_sha256) throw new Error("Evidence protocol changed"); completed.set(row.id, row); }
const write = (row: any) => appendFileSync(file, JSON.stringify(row) + "\n"); let batches = 0;
for (const preset of PRESETS) for (const mode of ["metadata", "caption"] as SearchMode[]) {
  const scores: SearchScores = Object.fromEntries(works.filter(work => completed.has(`${preset.id}/${mode}/${work.id}`)).map(work => [work.id, completed.get(`${preset.id}/${mode}/${work.id}`).score]));
  for (const batch of makeBatches(works, preset.query, mode, scores)) {
    const request_sha256 = hash(JSON.stringify(batch.payload)), base = { query_id: preset.id, query: preset.query, mode, ids: batch.ids, request_sha256, collection_sha256: manifest.collection_sha256, protocol_sha256: manifest.protocol_sha256, started_at: new Date().toISOString() };
    let accepted = false;
    while (!accepted) {
    write({ ...base, event: "request", attempted_at: new Date().toISOString(), payload: batch.payload });
    try {
      const response = await evaluate(batch.payload, { deadlineMs: 115000, onAttempt: attempt => write({ ...base, event: "attempt", ...attempt }) });
      const returned = readScores(batch, response), at = new Date().toISOString();
      // One synchronous append stores the full accepted batch and every normalized score.
      const rows = [{ ...base, event: "batch_completed", finished_at: at, response }, ...batch.ids.map(id => ({ ...base, id: `${preset.id}/${mode}/${id}`, artwork_id: id, event: "completed", finished_at: at, score: returned[id], answer: response.answers[`art_${id}`], model: response.model }))];
      appendFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n"); for (const row of rows.slice(1) as any[]) completed.set(row.id, row); batches++; accepted = true;
      console.log(JSON.stringify({ completed: completed.size, planned: manifest.planned_scores, batches, at }));
    } catch (error) { const e = error as GatewayError; const transient = [408, 429, 500, 502, 503, 504].includes(e.status) && !/invalid/i.test(e.message); write({ ...base, event: "failed", transient, status: e.status, error: e.message, attempts: e.attempts }); if (!transient) throw e; console.log(JSON.stringify({ event: "backoff", reason: e.message, completed: completed.size })); await Bun.sleep(Math.max(15000, e.retryAfterMs || 0)); }
    }
    await Bun.sleep(Number(process.env.VISUAL_RECORD_DELAY_MS ?? 2200));
  }
}
console.log(JSON.stringify({ event: "finished", completed: completed.size, planned: manifest.planned_scores }));
