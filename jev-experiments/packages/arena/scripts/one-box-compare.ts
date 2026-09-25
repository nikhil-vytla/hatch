/**
 * Jev (recorded) next to the keyword classifier on the development phrases, never the held-out
 * ones. Usage: bun packages/arena/scripts/one-box-compare.ts [cancel|latest]
 *
 * Under "cancel" a mid-word request only lands if it answers before the next keystroke (40 ms);
 * recorded Jev never does, so prefixes not yet recorded are treated as still in flight. Under
 * "latest" every prefix must be recorded.
 */
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { answersSchema, toReading } from "../src/one-box/adapter";
import { keyword } from "../src/one-box/keyword";
import { phrasesSchema, type Phrase } from "../src/one-box/phrases";
import {
  normalizeKey,
  outcome,
  replay,
  type AnswerFor,
  type Answered,
  type Policy,
} from "../src/one-box/replay";

const policy: Policy = process.argv[2] === "latest" ? "latest" : "cancel";

const doc = phrasesSchema.parse(
  JSON.parse(readFileSync(new URL("../src/one-box/phrases.json", import.meta.url), "utf8")),
);

const recorded = new Map<string, Answered>();
let dropped = 0;

/** The raw log while recording; the committed gzipped copy otherwise. */
const raw = new URL("../recordings/one-box.jsonl", import.meta.url);

const log = existsSync(raw)
  ? readFileSync(raw, "utf8")
  : gunzipSync(readFileSync(new URL("../recordings/one-box.jsonl.gz", import.meta.url))).toString(
      "utf8",
    );

for (const line of log.split("\n")) {
  if (!line.trim()) continue;
  const row: { status?: string; key?: string; latencyMs?: number; answers?: unknown } =
    JSON.parse(line);

  if (row.status !== "ok" || !row.key || row.latencyMs === undefined) continue;
  const adapted = toReading(answersSchema.parse(row.answers));

  dropped += adapted.dropped.length;
  recorded.set(row.key, { reading: adapted.reading, latencyMs: row.latencyMs });
}

let missing = 0;

const jev: AnswerFor = (key) => {
  const hit = recorded.get(key);

  if (hit) return hit;
  missing++;

  if (policy === "latest") throw new Error(`"${key}" is not recorded yet.`);

  // Still in flight when the next keystroke aborts it.
  return { reading: keyword(key), latencyMs: Infinity };
};

const kw: AnswerFor = (key) => ({ reading: keyword(key), latencyMs: 1 });

const dev = doc.phrases.filter((p) => p.split === "dev");
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** The full phrase alone, with no typing: which card does each contestant pick? */
const finalCard = (answerFor: AnswerFor, p: Phrase) => {
  const r = answerFor(normalizeKey(p.text))?.reading.intent.value;

  return r === p.intent || (p.acceptable ?? []).some((a) => a === r);
};

const table = (name: string, answerFor: AnswerFor) => {
  console.log(`\n${name} · ${policy} policy`);

  for (const kind of [undefined, "plain", "ambiguous", "adversarial"] as const) {
    const ps = kind ? dev.filter((p) => p.kind === kind) : dev;
    const os = ps.map((p) => outcome(replay(p.text, answerFor, policy), p));
    const times = os.flatMap((o) => (o.timeToRight === undefined ? [] : [o.timeToRight]));

    console.log(
      `  ${(kind ?? "all").padEnd(11)} ${String(ps.length).padStart(3)} · full phrase right ${pct(mean(ps.map((p) => Number(finalCard(answerFor, p)))))} · box right at end ${pct(mean(os.map((o) => Number(o.finalRight))))} · wrong commits ${mean(os.map((o) => o.wrongCommits)).toFixed(2)} · changes ${mean(os.map((o) => o.changes)).toFixed(2)} · right for good ${Math.round(median(times))} ms median (${times.length} reach it)`,
    );
  }
};

table("Jev (recorded)", jev);
table("Keyword classifier", kw);

const latencies = [...recorded.values()].map((a) => a.latencyMs);

console.log(
  `\n${recorded.size} prefixes recorded; Jev latency median ${median(latencies)} ms, 90th ${[...latencies].sort((a, b) => a - b)[Math.floor(latencies.length * 0.9)]} ms; ${dropped} Scores dropped by the gateway; ${missing} asks for unrecorded prefixes (never land under cancel).`,
);
