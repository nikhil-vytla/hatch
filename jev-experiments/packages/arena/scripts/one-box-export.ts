/**
 * Writes what a local contestant needs to answer One box: the 14 questions in our native wire
 * shape, and every distinct normalized prefix of all 200 phrases (whole characters, two or
 * more), the same keys Jev's recording uses. Output goes to .cache/one-box/ (gitignored).
 *
 *   bun jev-experiments/packages/arena/scripts/one-box-export.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { phrasesSchema } from "../src/one-box/phrases";
import { QUESTIONS } from "../src/one-box/questions";
import { normalizeKey } from "../src/one-box/replay";

const out = new URL("../../../.cache/one-box/", import.meta.url);

const doc = phrasesSchema.parse(
  JSON.parse(readFileSync(new URL("../src/one-box/phrases.json", import.meta.url), "utf8")),
);

const keys = new Set<string>();

for (const p of doc.phrases) {
  const chars = Array.from(p.text);

  for (let i = 1; i <= chars.length; i++) {
    const k = normalizeKey(chars.slice(0, i).join(""));

    if (k.length >= 2) keys.add(k);
  }
}

mkdirSync(out, { recursive: true });

writeFileSync(new URL("questions.json", out), JSON.stringify(QUESTIONS, null, 1));

writeFileSync(new URL("keys.json", out), JSON.stringify([...keys]));

console.log(`${Object.keys(QUESTIONS).length} questions, ${keys.size} prefixes → .cache/one-box/`);
