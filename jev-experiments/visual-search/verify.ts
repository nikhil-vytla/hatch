import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { readRecord } from "../experience-prototypes/scripts/records";
import { question, searchState, PRESETS, PROTOCOL, type Artwork } from "./protocol";
const here = import.meta.dir, hash = (s: string) => createHash("sha256").update(s).digest("hex"), manifest = JSON.parse(readFileSync(resolve(here, "manifest.json"), "utf8")), text = readFileSync(resolve(here, "collection.jsonl"), "utf8"), works: Artwork[] = readRecord(resolve(here, "collection.jsonl")).result.works;
if (hash(text) !== manifest.collection_sha256 || hash(JSON.stringify(PROTOCOL)) !== manifest.protocol_sha256) throw new Error("Frozen collection or protocol drift");
const events: any[] = existsSync(resolve(here, "events.jsonl")) ? readFileSync(resolve(here, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s)) : [], completed = events.filter(e => e.event === "completed");
if (completed.length !== new Set(completed.map(e => e.id)).size) throw new Error("Duplicate accepted score");
const validIds = new Set(PRESETS.flatMap(p => ["metadata", "caption"].flatMap(mode => works.map(w => `${p.id}/${mode}/${w.id}`))));
for (const row of completed) { if (!validIds.has(row.id) || row.score !== row.answer.value || row.score < 0 || row.score > 4 || !Number.isFinite(row.score)) throw new Error(`Invalid accepted score ${row.id}`); if (row.protocol_sha256 !== manifest.protocol_sha256 || row.collection_sha256 !== manifest.collection_sha256) throw new Error("Accepted score fingerprint changed"); }
let verifiedQuestions = 0;
for (const request of events.filter(e => e.event === "request")) {
  const preset = PRESETS.find(p => p.id === request.query_id); if (!preset || request.query !== preset.query) throw new Error("Undeclared query");
  const expected = { state: searchState(preset.query), questions: Object.fromEntries(request.ids.map((id: number) => { const work = works.find(w => w.id === id); if (!work) throw new Error("Unknown artwork"); verifiedQuestions++; return [`art_${id}`, question(work, request.mode)]; })) };
  if (JSON.stringify(request.payload) !== JSON.stringify(expected) || hash(JSON.stringify(expected)) !== request.request_sha256) throw new Error("Request reconstruction failed");
}
const report = { checked_at: new Date().toISOString(), artworks: works.length, queries: PRESETS.length, modes: 2, expected_scores: validIds.size, completed_scores: completed.length, complete: completed.length === validIds.size, reconstructed_question_attempts: verifiedQuestions, collection_sha256: manifest.collection_sha256, protocol_sha256: manifest.protocol_sha256 };
writeFileSync(resolve(here, "verification.json"), JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify(report)); if (process.argv.includes("--complete") && !report.complete) throw new Error("Visual search recording is incomplete");
