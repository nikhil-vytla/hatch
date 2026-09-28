/**
 * Records the tiny One box model on every prefix of all 200 phrases, in the same row format
 * as Jev's recording (gateway wire answers), so replays and the arena read both alike.
 *
 * Development prefixes are answered out of fold, so the recording never scores the model on
 * text it trained on: a key is answered by the cross-validation model for the lowest fold of
 * any development phrase containing it, which was trained without every key of that fold.
 * Held-out prefixes are answered by the committed full model, which never saw them
 * (scripts/one-box-tiny-data.ts excludes them). Each row names its model.
 * Needs the fold models: `train-one-box-tiny.py --cv` after `one-box-tiny-data.ts`. Latency is the median in-process time for all 14 heads, measured here, at least 1 ms.
 * Numbers are rounded to 4 decimals.
 *
 *   bun packages/arena/scripts/record-one-box-tiny.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import type { WireAnswers } from "../src/one-box/adapter";
import { QUESTION_IDS, QUESTIONS } from "../src/one-box/questions";
import { phrasesSchema } from "../src/one-box/phrases";
import { prefixKeys } from "../src/one-box/replay";
import { tinyAnswers, tinyModel } from "../src/one-box/tiny";

const doc = phrasesSchema.parse(
  JSON.parse(readFileSync(new URL("../src/one-box/phrases.json", import.meta.url), "utf8")),
);

const keys = [...new Set(doc.phrases.flatMap((p) => [...prefixKeys(p.text)]))];

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

/** Answers with every number rounded to 4 decimals. */
function rounded(answers: WireAnswers): WireAnswers {
  const out: WireAnswers = {};

  for (const id of QUESTION_IDS) {
    const a = answers[id];

    const probabilities = a.probabilities
      ? Object.fromEntries(Object.entries(a.probabilities).map(([k, p]) => [k, r4(p)]))
      : a.probabilities;

    out[id] = {
      // Choice values are option names; yes/no and score values are numbers.
      value: QUESTIONS[id].type === "choice" ? a.value : r4(Number(a.value)),
      probabilities,
      confidence:
        a.confidence === null || a.confidence === undefined ? a.confidence : r4(a.confidence),
    };
  }

  return out;
}

const cache = new URL("../.cache/one-box-tiny/", import.meta.url);

const { phraseFold }: { phraseFold: Record<string, number> } = JSON.parse(
  readFileSync(new URL("folds.json", cache), "utf8"),
);

const folds = [0, 1, 2, 3, 4].map((f) =>
  tinyModel(
    JSON.parse(readFileSync(new URL(`cv-${f}/vectorizer.json`, cache), "utf8")),
    JSON.parse(readFileSync(new URL(`cv-${f}/heads.json`, cache), "utf8")),
  ),
);

/** The lowest fold of any development phrase containing the key; undefined for held-out-only keys. */
const foldOf = new Map<string, number>();

for (const p of doc.phrases)
  if (p.split === "dev")
    for (const k of prefixKeys(p.text)) {
      const f = phraseFold[p.id];

      foldOf.set(k, Math.min(f, foldOf.get(k) ?? f));
    }

const answerer = (key: string) => {
  const f = foldOf.get(key);

  return f === undefined
    ? { answer: tinyAnswers, model: "one-box-tiny/full" }
    : { answer: folds[f].answers, model: `one-box-tiny/fold-${f}` };
};

// Warm up, then time each prefix three times and keep the fastest (least disturbed by the OS).
for (const k of keys.slice(0, 200)) tinyAnswers(k);

const times: number[] = [];

const rows: string[] = [];

for (const key of keys) {
  const { answer, model } = answerer(key);
  let best = Infinity;
  let answers = answer(key);

  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();

    answers = answer(key);
    best = Math.min(best, performance.now() - t0);
  }

  times.push(best);
  // Probabilities to 4 decimals keep the file small; the calm rules' thresholds are far coarser.
  rows.push(JSON.stringify({ key, status: "ok", answers: rounded(answers), model }));
}

const sorted = [...times].sort((a, b) => a - b);

const median = sorted[Math.floor(sorted.length / 2)];

const latencyMs = Math.max(1, Math.ceil(median));

const out = rows.map((r) => r.replace('"status":"ok"', `"status":"ok","latencyMs":${latencyMs}`));

writeFileSync(
  new URL("../recordings/one-box.tiny.jsonl.gz", import.meta.url),
  gzipSync(`${out.join("\n")}\n`, { level: 9 }),
);

const byModel = new Map<string, number>();

for (const k of keys) byModel.set(answerer(k).model, (byModel.get(answerer(k).model) ?? 0) + 1);

console.log([...byModel].map(([m, n]) => `${m}: ${n}`).join(", "));

console.log(
  `${keys.length} prefixes; 14 heads take ${median.toFixed(3)} ms median in process (recorded as ${latencyMs} ms), 90th ${sorted[Math.floor(sorted.length * 0.9)].toFixed(3)} ms.`,
);
