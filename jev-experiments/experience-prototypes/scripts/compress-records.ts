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
import { gzippedRecordings } from "./publication";

/**
 * Paths relative to jev-experiments/: every recording the publication manifest reads that is
 * committed as `.gz`, and the builders' own. Keep their plain copies in .gitignore.
 */
export const GZIPPED_RECORDINGS = gzippedRecordings();

if (import.meta.main) {
  const lab = resolve(import.meta.dir, "../..");

  for (const relative of GZIPPED_RECORDINGS) {
    const path = resolve(lab, relative);

    if (!existsSync(path)) continue;

    compressRecord(path);
    console.log(`${relative}: ${statSync(path).size} → ${statSync(`${path}.gz`).size} bytes`);
  }
}
