/**
 * Where Jev lives and the shapes that cross the wire, in one place. Browser-safe: no Node APIs,
 * so the site, the Screen sentry extension and the recorders can all import it.
 *
 * Request: Jev's native { state, questions } body (the gateway adds `model`).
 * Answer: one normalized answer, as `evaluate` returns it and as recordings store it.
 */
import type { NativeQuestion } from "../../decision-runtime/src/native.js";

/** The Vercel AI Gateway's TypeSafe route. The SDKs take this as their base URL. */
export const JEV_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/typesafe";
/** Jev's native endpoint. */
export const JEV_GATEWAY_URL = `${JEV_GATEWAY_BASE_URL}/v1/systemone`;
export const JEV_MODEL = "typesafe-ai/jev";

export type Question = NativeQuestion;
export type Payload = { state: unknown; questions: Record<string, Question> };

/** One answer after normalization: the provider's `{ [type]: value }` becomes `value`. */
export type Answer = {
  type: string;
  value: unknown;
  probabilities: Record<string, number> | null;
  confidence?: number | null;
  legend?: unknown;
};
export type Answers = Record<string, Answer>;

/**
 * The value of each raw provider answer, read from under its question type (or under `type` when
 * the caller knows it). For callers that post to the gateway themselves (the extension);
 * `evaluate` validates and normalizes in full.
 */
export function providerValues(answers: unknown, type?: string): Record<string, { value: unknown }> {
  const out: Record<string, { value: unknown }> = {};

  if (!answers || typeof answers !== "object") return out;

  for (const [id, a] of Object.entries(answers as Record<string, Record<string, unknown> | null>))
    out[id] = { value: a?.[type ?? String(a.type)] };

  return out;
}

/** An answer as SGLang's System One method returns it (noul / choice / score, x_label_mass). */
export type Raw = {
  type: string;
  noul?: number;
  choice?: string;
  score?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
  x_label_mass?: number;
};

export type WireAnswer = Answer & {
  /** Full-vocabulary probability of the answer labels (SGLang's label_mass). */
  labelMass?: number;
};

/** SGLang's System One answers in the shape our recordings use for Jev and Laya. */
export function toWire(raw: Record<string, Raw>): Record<string, WireAnswer> {
  return Object.fromEntries(
    Object.entries(raw).map(([k, a]): [string, WireAnswer] => {
      if (a.type === "noul") {
        const p = a.noul ?? 0;

        return [k, { type: "noul", value: p, probabilities: { false: 1 - p, true: p }, labelMass: a.x_label_mass }];
      }

      return [
        k,
        {
          type: a.type,
          value: a.type === "choice" ? a.choice : a.score,
          probabilities: a.probabilities ?? null,
          confidence: a.confidence,
          labelMass: a.x_label_mass,
        },
      ];
    }),
  );
}
