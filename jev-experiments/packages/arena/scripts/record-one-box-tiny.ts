/**
 * Records the tiny One box model on every prefix of all 200 phrases, in the same row format
 * as Jev's recording (gateway wire answers), so replays and the arena read both alike.
 * Held-out prefixes are predicted, never trained on (scripts/one-box-tiny-data.ts excludes
 * them). Latency is the median in-process time for all 14 heads, measured here, at least 1 ms.
 * Numbers are rounded to 4 decimals.
 *
 *   bun packages/arena/scripts/record-one-box-tiny.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { phrasesSchema } from "../src/one-box/phrases";
import { prefixKeys } from "../src/one-box/replay";
import { tinyAnswers } from "../src/one-box/tiny";

const doc = phrasesSchema.parse(
  JSON.parse(readFileSync(new URL("../src/one-box/phrases.json", import.meta.url), "utf8")),
);

const keys = [...new Set(doc.phrases.flatMap((p) => [...prefixKeys(p.text)]))];

// Warm up, then time each prefix three times and keep the fastest (least disturbed by the OS).
for (const k of keys.slice(0, 200)) tinyAnswers(k);

const times: number[] = [];
const rows: string[] = [];

for (const key of keys) {
  let best = Infinity;
  let answers = tinyAnswers(key);

  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();

    answers = tinyAnswers(key);
    best = Math.min(best, performance.now() - t0);
  }

  times.push(best);
  // Probabilities to 4 decimals keep the file small; the calm rules' thresholds are far coarser.
  rows.push(
    JSON.stringify({ key, status: "ok", answers, model: "one-box-tiny" }, (_, v: unknown) =>
      typeof v === "number" ? Math.round(v * 1e4) / 1e4 : v,
    ),
  );
}

const sorted = [...times].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)];
const latencyMs = Math.max(1, Math.ceil(median));

const out = rows.map((r) => r.replace('"status":"ok"', `"status":"ok","latencyMs":${latencyMs}`));

writeFileSync(
  new URL("../recordings/one-box.tiny.jsonl.gz", import.meta.url),
  gzipSync(`${out.join("\n")}\n`, { level: 9 }),
);

console.log(
  `${keys.length} prefixes; 14 heads take ${median.toFixed(3)} ms median in process (recorded as ${latencyMs} ms), 90th ${sorted[Math.floor(sorted.length * 0.9)].toFixed(3)} ms.`,
);
