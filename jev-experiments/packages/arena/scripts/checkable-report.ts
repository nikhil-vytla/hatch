/**
 * Jev on the checkable bank, scored against the right answers code computed: accuracy, mean
 * log score (probabilities clamped to 1–99%), a uniform guess and an always-the-most-common-
 * answer baseline, per kind and question, then calibration bins (stated confidence against
 * how often the top answer is right).
 *
 *   bun jev-experiments/packages/arena/scripts/checkable-report.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { bankSchema, type Item } from "../src/checkable/items";

/** Optional: another bank in src/checkable/ and its log name, e.g. judgement-bank.json judgement. */
const BANK = process.argv[2] ?? "bank.json";
const LOG = process.argv[3] ?? "checkable";

const bank = bankSchema.parse(
  JSON.parse(readFileSync(new URL(`../src/checkable/${BANK}`, import.meta.url), "utf8")),
);

const raw = new URL(`../recordings/${LOG}.jsonl`, import.meta.url);

const log = existsSync(raw)
  ? readFileSync(raw, "utf8")
  : gunzipSync(readFileSync(new URL(`../recordings/${LOG}.jsonl.gz`, import.meta.url))).toString(
      "utf8",
    );

const answerSchema = z.object({
  value: z.union([z.string(), z.number()]),
  probabilities: z.record(z.string(), z.number()).nullish(),
});

const rowSchema = z.object({
  id: z.string(),
  status: z.string(),
  latencyMs: z.number().optional(),
  answers: z.record(z.string(), answerSchema).optional(),
});

const byId = new Map<string, Item>(bank.items.map((i) => [i.id, i]));

type Scored = {
  kind: string;
  family: string;
  conf: number;
  right: boolean;
  logScore: number;
  uniform: number;
  truth: string;
};

const scored: Scored[] = [];
const latencies: number[] = [];
let attempts = 0,
  busy = 0,
  dropped = 0;

const clamp = (p: number) => Math.min(0.99, Math.max(0.01, p));

for (const line of log.split("\n")) {
  if (!line.trim()) continue;
  const row = rowSchema.parse(JSON.parse(line));

  attempts++;

  if (row.status !== "ok") {
    busy++;
    continue;
  }

  const item = byId.get(row.id);

  if (!item || !row.answers) continue;

  if (row.latencyMs !== undefined) latencies.push(row.latencyMs);

  for (const [qid, q] of Object.entries(item.questions)) {
    const truth = item.truth[qid];
    const a = Object.hasOwn(row.answers, qid) ? row.answers[qid] : undefined;
    const family = qid.replace(/_[ABC]$/, "_X");

    if (!a) {
      dropped++;
      continue;
    }

    if (q.type === "noul") {
      const p = Number(a.value);

      scored.push({
        kind: item.kind,
        family,
        conf: Math.max(p, 1 - p),
        right: p >= 0.5 === truth,
        logScore: Math.log(clamp(truth ? p : 1 - p)),
        uniform: Math.log(0.5),
        truth: String(truth),
      });
      continue;
    }

    const keys =
      q.type === "choice" ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
    const probs = a.probabilities ?? { [String(a.value)]: 1 };
    const sum = keys.reduce((s, k) => s + (probs[k] ?? 0), 0) || 1;
    const p = (k: string) => (probs[k] ?? 0) / sum;
    const top = keys.reduce((best, k) => (p(k) > p(best) ? k : best), keys[0]);

    scored.push({
      kind: item.kind,
      family,
      conf: p(top),
      right: top === String(truth),
      logScore: Math.log(clamp(p(String(truth)))),
      uniform: Math.log(1 / keys.length),
      truth: String(truth),
    });
  }
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const sortedLat = [...latencies].sort((a, b) => a - b);

console.log(
  `${latencies.length} items answered · ${attempts} attempts, ${busy} busy or failed (${pct(busy / (attempts || 1))}) · latency median ${sortedLat[Math.floor(sortedLat.length / 2)]} ms, 90th ${sortedLat[Math.floor(sortedLat.length * 0.9)]} ms · ${dropped} answers dropped by the gateway\n`,
);

const groups = new Map<string, Scored[]>();

for (const s of scored) {
  for (const g of [`${s.kind} · all`, `${s.kind} · ${s.family}`])
    groups.set(g, [...(groups.get(g) ?? []), s]);
}

console.log("group                                n     Jev right  majority   log score  uniform");

for (const [g, ss] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
  const counts = new Map<string, number>();

  for (const s of ss) counts.set(s.truth, (counts.get(s.truth) ?? 0) + 1);
  const majority = Math.max(...counts.values()) / ss.length;

  console.log(
    `${g.padEnd(36)} ${String(ss.length).padStart(4)}   ${pct(mean(ss.map((s) => Number(s.right)))).padStart(7)}   ${pct(majority).padStart(7)}   ${mean(
      ss.map((s) => s.logScore),
    )
      .toFixed(3)
      .padStart(8)}  ${mean(ss.map((s) => s.uniform))
      .toFixed(3)
      .padStart(7)}`,
  );
}

console.log("\ncalibration (stated confidence of the top answer → how often it is right)");

for (const kind of ["all", ...new Set(bank.items.map((i) => i.kind))]) {
  const ss = kind === "all" ? scored : scored.filter((s) => s.kind === kind);
  const cells = [];

  for (let lo = 0.3; lo < 1; lo += 0.1) {
    const inBin = ss.filter((s) => s.conf >= lo && (lo >= 0.9 ? s.conf <= 1 : s.conf < lo + 0.1));

    if (inBin.length)
      cells.push(
        `${Math.round(lo * 100)}–${Math.round(Math.min(1, lo + 0.1) * 100)}%: ${pct(mean(inBin.map((s) => Number(s.right))))} of ${inBin.length}`,
      );
  }

  const ece =
    ss.length &&
    [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].reduce((acc, lo) => {
      const inBin = ss.filter((s) => s.conf >= lo && (lo >= 0.9 ? s.conf <= 1 : s.conf < lo + 0.1));

      return (
        acc +
        (inBin.length / ss.length) *
          Math.abs(mean(inBin.map((s) => s.conf)) - mean(inBin.map((s) => Number(s.right))))
      );
    }, 0);

  console.log(`  ${kind.padEnd(7)} calibration error ${ece.toFixed(3)} · ${cells.join(" · ")}`);
}
