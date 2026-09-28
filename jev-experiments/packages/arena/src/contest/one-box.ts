/**
 * Contestants written by visitors, run on One box under exactly the rules every recorded
 * contestant faced: the same keystrokes, the same calm rules, the same request policy. An entry
 * is one function from the state Jev sees (`{ text }`) and the 14 questions to a distribution
 * per question. Whatever it returns is repaired, never trusted: a missing or malformed answer
 * becomes a uniform guess, probabilities are floored at 0.001 and renormalised. An answer that
 * takes longer than the budget counts as not arriving for that keystroke (the box keeps what
 * it had), never as a disqualification.
 */
import { z } from "zod";
import { toReading, type WireAnswers } from "../one-box/adapter";
import { INTENTS, QUESTION_IDS, QUESTIONS, type Reading } from "../one-box/questions";
import {
  normalizeKey,
  outcome,
  replay,
  type AnswerFor,
  type Expected,
  type Outcome,
  type Policy,
} from "../one-box/replay";

/** Time an entry has per keystroke; slower answers do not land for that keystroke. */
export const BUDGET_MS = 50;

const FLOOR = 0.001;

/** What an entry may return: per question, a probability (yes/no) or named weights. */
export const outputSchema = z.record(
  z.string(),
  z.union([
    z.number().transform((p) => ({ kind: "p" as const, p })),
    z.record(z.string(), z.number()).transform((w) => ({ kind: "w" as const, w })),
  ]),
);

export type Output = z.infer<typeof outputSchema>;

/**
 * An entry, already wrapped so its raw return value is parsed at the boundary: `null` when it
 * returned something that is not per-question numbers or weights.
 */
export type Entry = (state: { text: string }, questions: typeof QUESTIONS) => Output | null;

/** Wraps a visitor's raw function: its return value is parsed here, once. */
export const asEntry =
  (raw: (state: { text: string }, questions: typeof QUESTIONS) => Output | object | null): Entry =>
  (state, questions) => {
    const parsed = outputSchema.safeParse(raw(state, questions));

    return parsed.success ? parsed.data : null;
  };

type Weights = Record<string, number>;

/** Floors and renormalises weights over exactly `keys`; anything unusable becomes uniform. */
function distribution(keys: string[], raw: Weights | undefined): Weights {
  const w = keys.map((k) => {
    const v = raw && Object.hasOwn(raw, k) ? raw[k] : 0;

    return Number.isFinite(v) && v > 0 ? v : 0;
  });

  const sum = w.reduce((a, b) => a + b, 0);
  const base = sum > 0 ? w.map((v) => v / sum) : keys.map(() => 1 / keys.length);
  const floored = base.map((v) => Math.max(FLOOR, v));
  const total = floored.reduce((a, b) => a + b, 0);

  return Object.fromEntries(keys.map((k, i) => [k, floored[i] / total]));
}

const top = (d: Weights) => Object.entries(d).reduce((a, b) => (b[1] > a[1] ? b : a));

/** An entry's parsed output, repaired into the gateway's wire format so adapter.ts reads it. */
export type Repaired = { answers: WireAnswers; repaired: number };

export function repair(output: Output | null): Repaired {
  const raw = output ?? {};
  const answers: WireAnswers = {};
  let repaired = output ? 0 : QUESTION_IDS.length;

  for (const id of QUESTION_IDS) {
    const q = QUESTIONS[id];
    const given = Object.hasOwn(raw, id) ? raw[id] : undefined;
    const weights = given?.kind === "w" ? given.w : undefined;

    if (output && !given) repaired++;

    if (q.type === "noul") {
      const p =
        given?.kind === "p"
          ? given.p
          : weights
            ? distribution(["false", "true"], weights).true
            : 0.5;

      const clipped = Math.min(1 - FLOOR, Math.max(FLOOR, Number.isFinite(p) ? p : 0.5));

      answers[id] = { value: clipped, probabilities: null, confidence: null };
    } else if (q.type === "choice") {
      const d = distribution(Object.keys(q.criteria), weights);
      const [value, confidence] = top(d);

      answers[id] = { value, probabilities: d, confidence };
    } else {
      const d = distribution(["0", "1", "2"], weights);
      const [, confidence] = top(d);

      answers[id] = { value: d["1"] + 2 * d["2"], probabilities: d, confidence };
    }
  }

  return { answers, repaired };
}

export type EntryRun = {
  /** Per phrase, in the order given. */
  phrases: {
    id: string;
    outcome: Outcome;
    /** The entry's distribution over cards for the finished phrase, asked once. */
    final: Record<string, number>;
  }[];
  late: number;
  errors: number;
  /** The first error an entry threw, so a visitor can see why. */
  firstError?: string;
  repaired: number;
  calls: number;
  /** Median milliseconds per call. */
  medianMs: number;
};

/**
 * Runs an entry over phrases: every distinct prefix is asked once (as recorded contestants
 * were), timed, and replayed under `policy`. `now` is injected so tests are deterministic.
 */
export function runEntry(
  entry: Entry,
  phrases: (Expected & { id: string; text: string })[],
  policy: Policy,
  now: () => number = () => performance.now(),
): EntryRun {
  const cache = new Map<string, { reading: Reading; ms: number } | null>();

  let late = 0,
    errors = 0,
    repaired = 0;

  let firstError: string | undefined;

  const times: number[] = [];

  const ask = (key: string) => {
    if (cache.has(key)) return cache.get(key) ?? null;
    let result: { reading: Reading; ms: number } | null = null;

    try {
      const started = now();
      const out = entry({ text: key }, QUESTIONS);
      const ms = now() - started;
      const fixed = repair(out);

      times.push(ms);
      repaired += fixed.repaired;
      result = { reading: toReading(fixed.answers).reading, ms };

      if (ms > BUDGET_MS) late++;
    } catch (error) {
      errors++;
      firstError ??= error instanceof Error ? error.message : String(error);
    }

    cache.set(key, result);

    return result;
  };

  const answerFor: AnswerFor = (key) => {
    const r = ask(key);

    // Too slow for this keystroke: it never lands, and the box keeps what it had.
    if (!r || r.ms > BUDGET_MS) return undefined;

    return { reading: r.reading, latencyMs: Math.max(1, Math.round(r.ms)) };
  };

  const results = phrases.map((p) => {
    const o = outcome(replay(p.text, answerFor, policy), p);
    const finalReading = ask(normalizeKey(p.text))?.reading;

    const final = Object.fromEntries(
      INTENTS.map((k) => [k, finalReading?.intent.probabilities[k] ?? 1 / INTENTS.length]),
    );

    return { id: p.id, outcome: o, final };
  });

  const sorted = [...times].sort((a, b) => a - b);

  return {
    phrases: results,
    late,
    errors,
    firstError,
    repaired,
    calls: cache.size,
    medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
  };
}

/** Scores clamp probabilities to 1–99%, so one confident miss can't swamp everything else. */
export const SCORE_CLAMP = 0.01;

/** Log score of a distribution over cards for one phrase: the log of the weight on fair cards. */
export function logScore(dist: Record<string, number>, p: Expected) {
  const fair = new Set([p.intent, ...(p.acceptable ?? [])]);
  const mass = Object.entries(dist).reduce((s, [k, v]) => (fair.has(k) ? s + v : s), 0);

  return Math.log(Math.min(1 - SCORE_CLAMP, Math.max(SCORE_CLAMP, mass)));
}

/** Mean per-phrase difference with a normal 95% interval: how much better `a` scores than `b`. */
export function pairedGain(a: number[], b: number[]) {
  const d = a.map((v, i) => v - b[i]);
  const mean = d.reduce((s, v) => s + v, 0) / (d.length || 1);
  const sd = Math.sqrt(d.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, d.length - 1));

  return { mean, half: (1.96 * sd) / Math.sqrt(d.length || 1) };
}
