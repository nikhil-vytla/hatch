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
 *   bun jev-experiments/packages/arena/scripts/record-one-box.ts [words|all]
 *
 * `words` asks only prefixes that end a word (about 1,300 requests); `all` asks every prefix
 * (about 5,500). Upstream's cancel-on-keystroke policy only ever lands word-end prefixes and
 * the full phrase at this typing speed; `all` also supports the keep-the-latest policy.
 */
import "../../../experience-prototypes/scripts/credentials";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { evaluate, GatewayError } from "../../../experience-prototypes/server/gateway";
import { phrasesSchema } from "../src/one-box/phrases";
import { normalizeKey } from "../src/one-box/replay";
import { QUESTIONS } from "../src/one-box/questions";

const key = process.env.AI_GATEWAY_API_KEY;

if (!key) throw Error("Set AI_GATEWAY_API_KEY to record.");

const scope = process.argv[2] ?? "all";

if (scope !== "words" && scope !== "all") throw Error("Scope is words or all.");

const out = new URL("../recordings/one-box.jsonl", import.meta.url);

const doc = phrasesSchema.parse(
  JSON.parse(readFileSync(new URL("../src/one-box/phrases.json", import.meta.url), "utf8")),
);

/** Every prefix key and the phrases that produce it. */
const prefixes = new Map<string, string[]>();

for (const p of doc.phrases) {
  // Whole characters, as a typist produces them: an emoji is one keystroke, never half of one.
  const chars = Array.from(p.text);

  for (let i = 1; i <= chars.length; i++) {
    const endsWord = i === chars.length || chars[i] === " ";

    if (scope === "words" && !endsWord) continue;
    const k = normalizeKey(chars.slice(0, i).join(""));

    if (k.length < 2) continue;
    const ids = prefixes.get(k) ?? [];

    if (!ids.includes(p.id)) ids.push(p.id);
    prefixes.set(k, ids);
  }
}

const done = new Set<string>();

if (existsSync(out))
  for (const line of readFileSync(out, "utf8").split("\n"))
    if (line.trim()) {
      const row: { key?: unknown; status?: unknown } = JSON.parse(line);

      if (typeof row.key === "string" && row.status === "ok") done.add(row.key);
    }

/** A seeded shuffle (mulberry32), so the order is the same on every run and resume. */
function shuffled<T>(xs: T[], seed = 20260924) {
  let s = seed;
  const rand = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);

    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const a = [...xs];

  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));

    [a[i], a[j]] = [a[j], a[i]];
  }

  return a;
}

const todo = shuffled([...prefixes.keys()]).filter((k) => !done.has(k));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Pause between requests. The first 150 prefixes ran at 150 ms and about half the attempts
 * came back busy; a longer gap asks the provider less often.
 */
const GAP_MS = 700;

console.log(
  `${prefixes.size} prefixes in scope "${scope}", ${done.size} recorded, ${todo.length} to ask.`,
);

let n = 0;

for (const k of todo) {
  let backoff = 2000;

  for (let attempt = 1; ; attempt++) {
    const at = new Date().toISOString();

    try {
      const r = await evaluate(
        { state: { text: k }, questions: QUESTIONS },
        { apiKey: key, maxAttempts: 1, deadlineMs: 20_000 },
      );

      appendFileSync(
        out,
        `${JSON.stringify({
          key: k,
          phrases: prefixes.get(k),
          at,
          attempt,
          status: "ok",
          latencyMs: r.service_latency_ms,
          model: r.model,
          answers: r.answers,
          rejected: r.rejected,
          costUsd: r.cost_usd,
        })}\n`,
      );
      break;
    } catch (error) {
      const status = error instanceof GatewayError ? error.status : 0;
      const message = error instanceof Error ? error.message : String(error);

      appendFileSync(
        out,
        `${JSON.stringify({ key: k, at, attempt, status: "error", code: status, message })}\n`,
      );

      // Busy or unreachable: wait and ask again. Anything else is a real failure; stop.
      if (status !== 429 && status !== 503 && status !== 0) throw error;
      await wait(backoff);
      backoff = Math.min(30_000, backoff * 2);
    }
  }

  if (++n % 50 === 0) console.log(`${n} / ${todo.length}`);
  await wait(GAP_MS);
}

console.log("Done.");
