/**
 * The large committed recordings are stored gzipped. Recorders append to an uncompressed working
 * copy (gitignored; see unpackForAppend in records.ts). After recording, run this to refresh the
 * committed `.gz`: it compresses every working copy that exists. Output is deterministic.
 *
 *   bun scripts/compress-records.ts
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { compressRecord } from "./records";

/** Paths relative to jev-experiments/. Keep in sync with the .gitignore entries for their plain copies. */
export const GZIPPED_RECORDINGS = [
  "rewardbench2/results.jsonl",
  "judgment-reliability/events.jsonl",
  "judgment-reliability/cases.jsonl",
  "visual-search/events.jsonl",
  "outcome-framing/events.jsonl",
  "music-arranger-v2/music-v2.jsonl",
  "local-models-and-games/apple/results.jsonl",
  "experience-prototypes/results/classify.jsonl",
  "cafe-jev/cafe.jsonl",
];

if (import.meta.main) {
  const lab = resolve(import.meta.dir, "../..");

  for (const relative of GZIPPED_RECORDINGS) {
    const path = resolve(lab, relative);

    if (!existsSync(path)) continue;

    compressRecord(path);
    console.log(`${relative}: ${statSync(path).size} → ${statSync(`${path}.gz`).size} bytes`);
  }
}
