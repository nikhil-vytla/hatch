import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { readRecord, readRecordText, recordExists, writeRecord } from "../experience-prototypes/scripts/records";
import { PRESETS, PROTOCOL, type SearchMode, type SearchScores } from "./protocol";
import { rankWorks, lexicalScores, compareRankings, captionQuality } from "./ranking";
const here = import.meta.dir, collection = readRecord(resolve(here, "collection.jsonl")), works = collection.result.works;
const events: any[] = recordExists(resolve(here, "events.jsonl")) ? readRecordText(resolve(here, "events.jsonl")).trim().split("\n").filter(Boolean).map(s => JSON.parse(s)) : [];
const successful = events.filter(e => e.event === "completed"), ids = new Set(successful.map(e => e.id)); if (ids.size !== successful.length) throw new Error("Duplicate successful ranking score");
const queries = PRESETS.map(preset => {
  const scores = Object.fromEntries(["metadata", "caption"].map(mode => [mode, Object.fromEntries(successful.filter(e => e.query_id === preset.id && e.mode === mode).map(e => [e.artwork_id, e.score]))])) as Record<SearchMode, SearchScores>;
  const ranked = { metadata: rankWorks(works, scores.metadata), caption: rankWorks(works, scores.caption), lexical: rankWorks(works, lexicalScores(works, preset.query)) };
  const records = successful.filter(e => e.query_id === preset.id), batches = events.filter(e => e.query_id === preset.id && e.event === "batch_completed");
  return { ...preset, scores, source: "recorded", availability: { planned: works.length * 2, completed: records.length }, comparison: compareRankings(ranked.metadata, ranked.caption), recorded_at: batches.at(-1)?.finished_at ?? null, latency_ms: batches.reduce((n, b) => n + b.response.latency_ms, 0), returned_models: [...new Set(records.map(e => e.model))] };
});
const result = { ...collection.result, works, version: PROTOCOL.version, protocol: PROTOCOL, manifest: existsSync(resolve(here, "manifest.json")) ? JSON.parse(readFileSync(resolve(here, "manifest.json"), "utf8")) : null, queries, availability: { planned: works.length * PRESETS.length * 2, completed: successful.length, batches: events.filter(e => e.event === "batch_completed").length, attempts: events.filter(e => e.event === "attempt").length, failures: events.filter(e => e.event === "failed").length }, caption_counts: { description_only: works.filter((w: any) => w.captionSource !== "description + did you know").length, with_did_you_know: works.filter((w: any) => w.captionSource === "description + did you know").length }, archive: "/visual-search/evidence.jsonl", collection_archive: "/visual-search/collection.jsonl" };
writeRecord(resolve(here, "results.jsonl"), { manifest: { experiment: "visual-search", prepared_at: new Date().toISOString() }, result });
console.log(JSON.stringify({ artworks: works.length, queries: queries.length, availability: result.availability }));
