/**
 * One box (after anishfn/shapeshift): records Jev answering its 14 questions for every prefix a typist produces.
 *
 * Protocol (fixed before running): phrases from src/one-box/phrases.json, both splits
 * (thresholds are tuned on dev only; held-out answers are not looked at until then). Each
 * distinct normalized prefix of two or more characters is asked once, as `{ text }` with
 * upstream's questions, exactly as upstream's client sends it. Prefixes are asked in a seeded
 * shuffled order so latency drift over the run is not tied to any phrase or intent.
 *
 * Transport: one request at a time with a 700 ms gap. A busy reply (429/503) is waited out and
 * asked again, and every attempt is logged; the recorded latency is the successful attempt's
 * service latency, which is what a visitor's box would wait for. A Score the gateway drops is
 * kept as dropped. Weak answers are never re-asked.
 *
 * The log is append-only. Rerunning resumes: prefixes already recorded are skipped, never
 * re-asked or overwritten.
 *
 *   bun jev-experiments/packages/arena/scripts/record-one-box.ts [words|all] [phrases.json] [log.jsonl] [--dry-run]
 *
 * `words` asks only prefixes that end a word (about 1,300 requests); `all` asks every prefix
 * (about 5,500). Upstream's cancel-on-keystroke policy only ever lands word-end prefixes and
 * the full phrase at this typing speed; `all` also supports the keep-the-latest policy.
 */
import { readFileSync } from "node:fs";
import { jevEndpoint } from "../../jev-client/src/endpoints";
import { attemptErrorRow, attemptRow, record, recorderKey, waitOutBusy, type Job } from "../../jev-client/src/recorder";
import type { Payload } from "../../jev-client/src/wire";
import { mulberry32, shuffled } from "../../seeded/src/index";
import { phrasesSchema } from "../src/one-box/phrases";
import { normalizeKey } from "../src/one-box/replay";
import { QUESTIONS } from "../src/one-box/questions";

export type OneBoxJob = Job & { phrases: string[] };

const defaultPhrases = new URL("../src/one-box/phrases.json", import.meta.url).pathname;
export const defaultOut = new URL("../recordings/one-box.jsonl", import.meta.url).pathname;

/**
 * Every prefix key, asked as `{ text }` with upstream's questions. Word-end prefixes first (all
 * upstream's cancel-on-keystroke policy ever lands), then the rest, each group in seeded
 * shuffled order. The grouping was added after the first ~250 prefixes, when busy replies
 * capped the run at about 22 answers a minute; asked keys are never re-asked.
 */
export function jobs(scope: "words" | "all" = "all", phrasesPath = defaultPhrases): OneBoxJob[] {
  const doc = phrasesSchema.parse(JSON.parse(readFileSync(phrasesPath, "utf8")));
  /** Every prefix key and the phrases that produce it. */
  const prefixes = new Map<string, string[]>();
  const wordEnds = new Set<string>();

  for (const p of doc.phrases) {
    // Whole characters, as a typist produces them: an emoji is one keystroke, never half of one.
    const chars = Array.from(p.text);

    for (let i = 1; i <= chars.length; i++) {
      const endsWord = i === chars.length || chars[i] === " ";

      if (endsWord) wordEnds.add(normalizeKey(chars.slice(0, i).join("")));

      if (scope === "words" && !endsWord) continue;
      const k = normalizeKey(chars.slice(0, i).join(""));

      if (k.length < 2) continue;
      const ids = prefixes.get(k) ?? [];

      if (!ids.includes(p.id)) ids.push(p.id);
      prefixes.set(k, ids);
    }
  }

  const order = shuffled([...prefixes.keys()], mulberry32(20260924));

  return [...order.filter((k) => wordEnds.has(k)), ...order.filter((k) => !wordEnds.has(k))].map((k) => ({
    id: k,
    request: { state: { text: k }, questions: QUESTIONS } as Payload,
    phrases: prefixes.get(k)!,
  }));
}

if (import.meta.main) {
  await import("../../../experience-prototypes/scripts/credentials");

  const { dryRun, apiKey } = recorderKey();
  const [scope = "all", phrasesPath = defaultPhrases, out = defaultOut] = process.argv.slice(2).filter((a) => !a.startsWith("--"));

  if (scope !== "words" && scope !== "all") throw Error("Scope is words or all.");

  const all = jobs(scope, phrasesPath);
  const result = await record(all, jevEndpoint({ apiKey, maxAttempts: 1, deadlineMs: 20_000 }), {
    out,
    dryRun,
    // One box keys its rows by prefix.
    idOf: (row) => row.key as string,
    failFast: Infinity,
    retry: waitOutBusy,
    // The first 150 prefixes ran at 150 ms and about half the attempts came back busy; a longer
    // gap asks the provider less often.
    gapMs: 700,
    okRow: (job, reply, at) => attemptRow(job, reply, at, { key: job.id, phrases: job.phrases }),
    errorRow: (job, e, at) => attemptErrorRow(job, e, at, { key: job.id }),
    onStart: (todo, skipped) => console.log(`${all.length} prefixes in scope "${scope}", ${skipped} recorded, ${todo} to ask.`),
    onJob: (s) => {
      if (s.jobs % 50 === 0) console.log(`${s.jobs} / ${s.todo}`);
    },
  });

  if (!dryRun) console.log(result.stopped ? `Stopped: ${result.stopped}` : "Done.");
}
