/**
 * Every recorded contestant next to the keyword classifier on the development phrases.
 * Usage: bun packages/arena/scripts/one-box-compare.ts [cancel|latest] [heldout]
 * `heldout` scores the 50 held-out phrases instead; it was run once, after every contestant
 * was recorded and with nothing tuned (see recordings/README.md).
 *
 * Under "cancel" a mid-word request only lands if it answers before the next keystroke (40 ms);
 * recorded Jev never does, so prefixes not yet recorded are treated as still in flight. Under
 * "latest" every prefix must be recorded.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

/**
 * Every recording: Jev's is one-box.jsonl(.gz); any other contestant's is one-box.<id>.jsonl(.gz)
 * in the same row format. The raw log is read while recording; the gzipped copy otherwise.
 */
const NAMES = new Map([
  ["jev", "Jev (recorded)"],
  ["laya", "Laya (local, intent in 3 groups)"],
]);

const recordings = new Map<string, { answers: Map<string, Answered>; dropped: number }>();

const dir = new URL("../recordings/", import.meta.url);

for (const file of readdirSync(dir)) {
  const match = /^one-box(?:\.([a-z0-9-]+))?\.jsonl(\.gz)?$/.exec(file);

  if (!match || match[1] === "laya.meta") continue;
  const id = match[1] ?? "jev";

  // Prefer the raw log when both exist.
  if (match[2] && existsSync(new URL(file.slice(0, -3), dir))) continue;
  const bytes = readFileSync(new URL(file, dir));
  const log = match[2] ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
  const answers = new Map<string, Answered>();
  let dropped = 0;

  for (const line of log.split("\n")) {
    if (!line.trim()) continue;

    const row: { status?: string; key?: string; latencyMs?: number; answers?: unknown } =
      JSON.parse(line);

    if (row.status !== "ok" || !row.key || row.latencyMs === undefined) continue;
    const adapted = toReading(answersSchema.parse(row.answers));

    dropped += adapted.dropped.length;
    answers.set(row.key, { reading: adapted.reading, latencyMs: row.latencyMs });
  }

  recordings.set(id, { answers, dropped });
}

let missing = 0;

const fromRecording =
  (answers: Map<string, Answered>): AnswerFor =>
  (key) => {
    const hit = answers.get(key);

    if (hit) return hit;
    missing++;

    if (policy === "latest") throw new Error(`"${key}" is not recorded yet.`);

    // Still in flight when the next keystroke aborts it.
    return { reading: keyword(key), latencyMs: Infinity };
  };

const kw: AnswerFor = (key) => ({ reading: keyword(key), latencyMs: 1 });

const split = process.argv[3] === "heldout" ? "heldout" : "dev";
const dev = doc.phrases.filter((p) => p.split === split);

console.log(`${split} split: ${dev.length} phrases`);

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** The full phrase alone, with no typing: does the contestant pick the right card? Unrecorded is wrong. */
const finalCard = (full: (key: string) => Answered | undefined, p: Phrase) => {
  const r = full(normalizeKey(p.text))?.reading.intent.value;

  return r !== undefined && (r === p.intent || (p.acceptable ?? []).some((a) => a === r));
};

const table = (name: string, answerFor: AnswerFor, full: (key: string) => Answered | undefined) => {
  console.log(`\n${name} · ${policy} policy`);

  for (const kind of [undefined, "plain", "ambiguous", "adversarial"] as const) {
    const ps = kind ? dev.filter((p) => p.kind === kind) : dev;
    const os = ps.map((p) => outcome(replay(p.text, answerFor, policy), p));
    const times = os.flatMap((o) => (o.timeToRight === undefined ? [] : [o.timeToRight]));

    console.log(
      `  ${(kind ?? "all").padEnd(11)} ${String(ps.length).padStart(3)} · full phrase right ${pct(mean(ps.map((p) => Number(finalCard(full, p)))))} · box right at end ${pct(mean(os.map((o) => Number(o.finalRight))))} · wrong commits ${mean(os.map((o) => o.wrongCommits)).toFixed(2)} · changes ${mean(os.map((o) => o.changes)).toFixed(2)} · right for good ${Math.round(median(times))} ms median (${times.length} reach it)`,
    );
  }
};

for (const [id, { answers, dropped }] of recordings) {
  missing = 0;
  table(NAMES.get(id) ?? id, fromRecording(answers), (key) => answers.get(key));

  const latencies = [...answers.values()].map((a) => a.latencyMs).sort((a, b) => a - b);

  console.log(
    `  ${answers.size} prefixes recorded; latency median ${median(latencies)} ms, 90th ${latencies[Math.floor(latencies.length * 0.9)]} ms; ${dropped} Scores dropped; ${missing} asks for unrecorded prefixes (never land under cancel).`,
  );
}

table("Keyword classifier", kw, kw);
