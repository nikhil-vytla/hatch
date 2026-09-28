/**
 * The sealed One box set: phrases nobody outside the scorer has seen, with Jev's recorded
 * answers on them. It lives in the repo only encrypted (AES-256-GCM); the key is an
 * environment variable on the server and a gitignored file locally. Scoring returns only
 * aggregates, never phrases or per-item results.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import { answersSchema, toReading } from "../one-box/adapter.js";
import { keyword } from "../one-box/keyword.js";
import { INTENTS } from "../one-box/questions.js";
import { normalizeKey, outcome, replay, type AnswerFor } from "../one-box/replay.js";
import { logScore, pairedGain, runEntry, type Entry } from "./one-box.js";

export const sealedSchema = z.object({
  schema: z.literal("one-box.sealed/1"),
  sealedAt: z.string(),
  phrases: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      intent: z.string(),
      acceptable: z.array(z.string()).optional(),
      kind: z.enum(["plain", "ambiguous", "adversarial"]),
    }),
  ),
  /** Jev's recorded answers on word-end prefixes and full phrases, keyed by normalized prefix. */
  jev: z.record(z.string(), z.object({ latencyMs: z.number(), answers: answersSchema })),
});

export type Sealed = z.infer<typeof sealedSchema>;

export function seal(sealed: Sealed, keyBase64: string) {
  const key = Buffer.from(keyBase64, "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  // Compressed before encrypting (ciphertext does not compress).
  const body = Buffer.concat([cipher.update(gzipSync(JSON.stringify(sealed))), cipher.final()]);

  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

export function unseal(blob: string, keyBase64: string): Sealed {
  const raw = Buffer.from(blob, "base64");

  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(keyBase64, "base64"),
    raw.subarray(0, 12),
  );

  decipher.setAuthTag(raw.subarray(12, 28));

  const json = gunzipSync(
    Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]),
  ).toString("utf8");

  return sealedSchema.parse(JSON.parse(json));
}

export type SealedScore = {
  phrases: number;
  boxRight: number;
  jevBoxRight: number;
  wrongCommits: number;
  changes: number;
  /** Per-phrase log score on the finished phrase minus Jev's, with a 95% interval. */
  gainOverJev: { mean: number; half: number };
  late: number;
  errors: number;
  calls: number;
};

/** Scores an entry on the sealed set under upstream's policy, beside Jev's recorded answers. */
export function scoreSealed(entry: Entry, sealed: Sealed): SealedScore {
  const run = runEntry(entry, sealed.phrases, "cancel");

  const jevFor: AnswerFor = (key) => {
    const hit = Object.hasOwn(sealed.jev, key) ? sealed.jev[key] : undefined;

    // Jev's mid-word answers are not recorded: at its latency they never land before the next key.
    return hit
      ? { reading: toReading(hit.answers).reading, latencyMs: hit.latencyMs }
      : { reading: keyword(""), latencyMs: Infinity };
  };

  const mine: number[] = [];
  const jevs: number[] = [];
  let jevRight = 0;

  sealed.phrases.forEach((p, i) => {
    mine.push(logScore(run.phrases[i].final, p));
    const full = sealed.jev[normalizeKey(p.text)];
    const reading = full ? toReading(full.answers).reading : undefined;

    const dist = Object.fromEntries(
      INTENTS.map((k) => [k, reading?.intent.probabilities[k] ?? 1 / INTENTS.length]),
    );

    jevs.push(logScore(dist, p));

    if (outcome(replay(p.text, jevFor, "cancel"), p).finalRight) jevRight++;
  });

  const n = sealed.phrases.length || 1;

  return {
    phrases: sealed.phrases.length,
    boxRight: run.phrases.filter((p) => p.outcome.finalRight).length / n,
    jevBoxRight: jevRight / n,
    wrongCommits: run.phrases.reduce((s, p) => s + p.outcome.wrongCommits, 0) / n,
    changes: run.phrases.reduce((s, p) => s + p.outcome.changes, 0) / n,
    gainOverJev: pairedGain(mine, jevs),
    late: run.late,
    errors: run.errors,
    calls: run.calls,
  };
}
