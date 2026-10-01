/**
 * Writes the committed copy of a recording: probabilities and other answer numbers rounded to 4
 * decimals, gzipped, as one-box.laya.jsonl.gz is. The full-precision log stays local.
 *
 *   bun packages/arena/open-decisions/compact.ts recordings/one-box.qwen3-0.6b.jsonl
 */
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const round = (v: unknown): unknown => {
  if (typeof v === "number") return Math.round(v * 1e4) / 1e4;

  if (Array.isArray(v)) return v.map(round);

  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)]));

  return v;
};

for (const path of process.argv.slice(2)) {
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const row = JSON.parse(l);

      if (row.answers) row.answers = round(row.answers);

      return JSON.stringify(row);
    });

  writeFileSync(`${path}.gz`, gzipSync(`${lines.join("\n")}\n`, { level: 9 }));
  console.log(`${path}.gz: ${lines.length} rows`);
}
