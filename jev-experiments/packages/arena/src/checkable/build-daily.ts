/**
 * Builds public/daily/daily.json from every source the Daily draws on: the checkable bank
 * (Tetris, only its local "fills a row" questions; mazes stay in the arena), the judgement bank
 * (orders and routing) when it has been recorded, and One box phrases. Items Jev has not
 * answered are left out. Every eligible question is its own puzzle, and Jev's calibration is
 * measured per kind over every puzzle in the pool.
 * Run by experience-prototypes/scripts/prepare.ts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { keyword } from "../one-box/keyword";
import { phrasesSchema } from "../one-box/phrases";
import { normalizeKey } from "../one-box/replay";
import {
  BANDS,
  dailySchema,
  jevPick,
  optionKeys,
  truthKey,
  type Band,
  type DailyItem,
} from "./daily";
import { bankSchema, rng, shuffled, type Item } from "./items";

const answerSchema = z.object({
  value: z.union([z.string(), z.number()]),
  probabilities: z.record(z.string(), z.number()).nullish(),
});

const rowSchema = z.object({
  id: z.string().optional(),
  key: z.string().optional(),
  at: z.string().optional(),
  status: z.string(),
  latencyMs: z.number().optional(),
  answers: z.record(z.string(), answerSchema).optional(),
});

type Answer = z.infer<typeof answerSchema>;

type Row = z.infer<typeof rowSchema>;

/** A recording's answered rows keyed by item id (or One box prefix key); raw log first, then .gz. */
function readLog(path: string) {
  const text = existsSync(path)
    ? readFileSync(path, "utf8")
    : existsSync(`${path}.gz`)
      ? gunzipSync(readFileSync(`${path}.gz`)).toString("utf8")
      : "";

  const rows = new Map<string, Row>();

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const row = rowSchema.parse(JSON.parse(line));
    const id = row.id ?? row.key;

    if (id && row.status === "ok" && row.answers) rows.set(id, row);
  }

  return rows;
}

/** Jev's answer as a distribution over `keys`, renormalised over them. */
function distribution(keys: string[], a: Answer) {
  if (keys.length === 2 && keys[0] === "true") {
    const yes = Number(a.value);

    return Object.fromEntries([
      ["true", yes],
      ["false", 1 - yes],
    ]);
  }

  const p = a.probabilities ?? { [String(a.value)]: 1 };
  const total = keys.reduce((s, k) => s + (p[k] ?? 0), 0) || 1;

  return Object.fromEntries(keys.map((k) => [k, (p[k] ?? 0) / total]));
}

/** The questions of a bank item the Daily may ask: Tetris only its local "fills a row" ones. */
const eligible = (item: Item) =>
  Object.keys(item.questions).filter((q) => item.kind !== "tetris" || q.startsWith("completes_"));

export function buildDaily(root: string, outDir: string) {
  const items: DailyItem[] = [];
  let recordedAt = "";

  const banks: [string, string][] = [
    ["src/checkable/bank.json", "recordings/checkable.jsonl"],
    ["src/checkable/judgement-bank.json", "recordings/judgement.jsonl"],
  ];

  for (const [bankPath, logPath] of banks) {
    if (!existsSync(join(root, bankPath))) continue;
    const bank = bankSchema.parse(JSON.parse(readFileSync(join(root, bankPath), "utf8")));
    const rows = readLog(join(root, logPath));

    for (const item of bank.items) {
      const row = rows.get(item.id);

      if (!row?.answers || item.kind === "grid") continue;
      recordedAt = row.at && row.at > recordedAt ? row.at : recordedAt;

      // Every eligible question is its own puzzle.
      for (const qid of eligible(item)) {
        const answer = row.answers[qid];

        if (!answer) continue;

        items.push({
          id: `${item.id}:${qid}`,
          kind: item.kind,
          difficulty: item.difficulty,
          state: item.state,
          questionId: qid,
          question: item.questions[qid],
          truth: item.truth[qid],
          jev: distribution(optionKeys(item.questions[qid]), answer),
          jevMs: row.latencyMs ?? 0,
        });
      }
    }
  }

  // One box phrases: the right card plus the keyword rules' three likeliest others (so Jev's own
  // answer never shapes the options), shuffled; Jev's distribution renormalised over the four.
  const phrases = phrasesSchema.parse(
    JSON.parse(readFileSync(join(root, "src/one-box/phrases.json"), "utf8")),
  );

  const oneBox = readLog(join(root, "recordings/one-box.jsonl"));

  for (const p of phrases.phrases) {
    const row = oneBox.get(normalizeKey(p.text));
    const answer = row?.answers?.intent;

    if (!row || !answer) continue;
    recordedAt = row.at && row.at > recordedAt ? row.at : recordedAt;
    const fair = new Set<string>([p.intent, ...(p.acceptable ?? [])]);

    const distractors = Object.entries(keyword(p.text).intent.probabilities)
      .filter(([k]) => k !== "none" && !fair.has(k))
      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
      .slice(0, 3)
      .map(([k]) => k);

    const options = shuffled([p.intent, ...distractors], rng(Number(p.id.replace(/\D/g, "")) || 1));

    items.push({
      id: `phrase-${p.id}`,
      kind: "phrase",
      difficulty: p.kind === "plain" ? 0 : 2,
      state: { text: p.text },
      questionId: "intent",
      question: {
        type: "choice",
        instructions: "Someone typed this into a box. What should the box become?",
        criteria: Object.fromEntries(options.map((k) => [k, k.replaceAll("_", " ")])),
      },
      truth: p.intent,
      jev: distribution(options, answer),
      jevMs: row.latencyMs ?? 0,
    });
  }

  // How often Jev's top answer is right in each confidence band, per kind, over the whole pool.
  const calibration: Record<string, Band[]> = {};

  for (const kind of new Set(items.map((i) => i.kind))) {
    calibration[kind] = BANDS.map(([lo, hi]) => {
      const inBand = items.filter((i) => {
        const { p } = jevPick(i);

        return i.kind === kind && p >= lo && p < hi;
      });

      return {
        lo,
        hi: Math.min(1, hi),
        n: inBand.length,
        right: inBand.filter((i) => jevPick(i).key === truthKey(i.truth)).length,
      };
    });
  }

  const daily = dailySchema.parse({
    schema: "jev.daily/2",
    recordedAt: recordedAt || new Date(0).toISOString(),
    calibration,
    items,
  });

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "daily.json"), JSON.stringify(daily));

  return { items: items.length, calibration };
}
