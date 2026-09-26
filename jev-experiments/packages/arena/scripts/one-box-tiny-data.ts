/**
 * Training rows for the tiny One box model: Jev's recorded top answer to each of the 14
 * questions, for every prefix of a development phrase that is not also a prefix of a held-out
 * phrase, so held-out text is never seen. Writes packages/arena/.cache/one-box-tiny/train.jsonl
 * (gitignored; rebuilt from the recording).
 *
 *   bun packages/arena/scripts/one-box-tiny-data.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { answersSchema } from "../src/one-box/adapter";
import { phrasesSchema } from "../src/one-box/phrases";
import { QUESTION_IDS, QUESTIONS, type QuestionId } from "../src/one-box/questions";
import { prefixKeys } from "../src/one-box/replay";

const doc = phrasesSchema.parse(
  JSON.parse(readFileSync(new URL("../src/one-box/phrases.json", import.meta.url), "utf8")),
);

const heldout = new Set(
  doc.phrases.filter((p) => p.split === "heldout").flatMap((p) => [...prefixKeys(p.text)]),
);

const train = new Set(
  doc.phrases
    .filter((p) => p.split === "dev")
    .flatMap((p) => [...prefixKeys(p.text)])
    .filter((k) => !heldout.has(k)),
);

const raw = new URL("../recordings/one-box.jsonl", import.meta.url);

const log = existsSync(raw)
  ? readFileSync(raw, "utf8")
  : gunzipSync(readFileSync(new URL("../recordings/one-box.jsonl.gz", import.meta.url))).toString(
      "utf8",
    );

/** Jev's top option: a choice's value, yes when P(yes) ≥ 0.5, a score's most likely level. */
function label(
  id: QuestionId,
  a: { value: string | number; probabilities?: Record<string, number> | null },
) {
  const type = QUESTIONS[id].type;

  if (type === "choice") return String(a.value);

  if (type === "noul") return Number(a.value) >= 0.5 ? "true" : "false";

  const p = a.probabilities;

  if (!p) return String(Math.round(Number(a.value)));

  return Object.entries(p).reduce((best, cur) => (cur[1] > best[1] ? cur : best))[0];
}

const rows: string[] = [];

const ids = QUESTION_IDS;

for (const line of log.split("\n")) {
  if (!line.trim()) continue;
  const row: { status?: string; key?: string; answers?: unknown } = JSON.parse(line);

  if (row.status !== "ok" || !row.key || !train.has(row.key)) continue;
  const answers = answersSchema.parse(row.answers);

  // A Score the gateway dropped leaves that question unlabelled for this prefix.
  const labels = Object.fromEntries(
    ids.flatMap((id) => (Object.hasOwn(answers, id) ? [[id, label(id, answers[id])]] : [])),
  );

  rows.push(JSON.stringify({ text: row.key, labels }));
}

const out = new URL("../.cache/one-box-tiny/", import.meta.url);

mkdirSync(out, { recursive: true });

writeFileSync(new URL("train.jsonl", out), `${rows.join("\n")}\n`);

/**
 * Five folds over development phrases (seeded), for an honest dev estimate: each fold's model
 * trains without any prefix of that fold's phrases. Keys shared across folds are excluded from
 * every fold that contains them.
 */
const FOLDS = 5;

const dev = doc.phrases.filter((p) => p.split === "dev");

let seed = 20260926;

const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;

  return seed / 2147483648;
};

const shuffled = dev.map((p) => ({ p, r: rand() })).sort((a, b) => a.r - b.r);

const phraseFold = Object.fromEntries(shuffled.map(({ p }, i) => [p.id, i % FOLDS]));

const foldKeys = Array.from({ length: FOLDS }, (_, f) => [
  ...new Set(dev.filter((p) => phraseFold[p.id] === f).flatMap((p) => [...prefixKeys(p.text)])),
]);

writeFileSync(new URL("folds.json", out), JSON.stringify({ phraseFold, foldKeys }));

console.log(
  `${rows.length} training prefixes of ${train.size} eligible (${heldout.size} held-out prefixes excluded).`,
);
