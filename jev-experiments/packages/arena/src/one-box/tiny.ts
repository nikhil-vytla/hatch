/**
 * The tiny One box model: one shared TF-IDF vocabulary and a logistic head per question,
 * trained on Jev's recorded answers to development prefixes (scripts/train-one-box-tiny.py).
 * Distilled from Jev's outputs, as a research-preview comparison. Inference mirrors
 * web/src/local-classifier.ts, which matches sklearn's tokenisation; parity.json pins it.
 */
import { z } from "zod";
import type { WireAnswers } from "./adapter";
import { QUESTION_IDS, QUESTIONS, type QuestionId } from "./questions";
import headsJson from "./tiny/heads.json";
import vectorizerJson from "./tiny/vectorizer.json";

const vectorizerSchema = z.object({
  vocabulary: z.record(z.string(), z.number()),
  idf: z.array(z.number()),
});

const headSchema = z.object({
  classes: z.array(z.string()),
  weights: z.array(z.array(z.number())),
  bias: z.array(z.number()),
});

const headsSchema = z.record(z.string(), headSchema);

type Features = [index: number, value: number][];

/**
 * A tiny model from its exported files: the committed one by default, or a cross-validation
 * fold's (scripts/one-box-tiny-cv.ts).
 */
export function tinyModel(
  vectorizerFile: z.input<typeof vectorizerSchema>,
  headsFile: z.input<typeof headsSchema>,
) {
  const vectorizer = vectorizerSchema.parse(vectorizerFile);
  const heads = headsSchema.parse(headsFile);

  /** sklearn's default analyzer: lowercase words of two or more characters, then bigrams; sublinear TF-IDF, L2. */
  function features(text: string): Features {
    const words = text.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? [];
    const terms = [...words, ...words.slice(1).map((w, i) => `${words[i]} ${w}`)];
    const counts = new Map<number, number>();

    for (const term of terms) {
      const index = Object.hasOwn(vectorizer.vocabulary, term)
        ? vectorizer.vocabulary[term]
        : undefined;

      if (index !== undefined) counts.set(index, (counts.get(index) ?? 0) + 1);
    }

    const values: Features = [...counts].map(([i, n]) => [
      i,
      (1 + Math.log(n)) * vectorizer.idf[i],
    ]);

    const norm = Math.sqrt(values.reduce((s, [, v]) => s + v * v, 0)) || 1;

    return values.map(([i, v]) => [i, v / norm]);
  }

  /** One head's distribution over its classes. */
  function head(id: QuestionId, x: Features) {
    const h = heads[id];

    if (!h) throw new Error(`No tiny head for ${id}.`);

    if (!h.weights.length) return { [h.classes[0]]: 1 };
    let logits = h.weights.map((w, c) => h.bias[c] + x.reduce((s, [j, v]) => s + w[j] * v, 0));

    // A binary head stores one row: the logit of the second class against the first.
    if (logits.length === 1 && h.classes.length === 2) logits = [0, logits[0]];
    const max = Math.max(...logits);
    const exps = logits.map((v) => Math.exp(v - max));
    const sum = exps.reduce((a, b) => a + b, 0);

    return Object.fromEntries(h.classes.map((c, i) => [c, exps[i] / sum]));
  }

  const top = (p: Record<string, number>) =>
    Object.entries(p).reduce((best, cur) => (cur[1] > best[1] ? cur : best));

  /** All 14 answers for a text, in the gateway's wire format so adapter.ts reads them like Jev's. */
  function answers(text: string): WireAnswers {
    const x = features(text);
    const out: WireAnswers = {};

    for (const id of QUESTION_IDS) {
      const p = head(id, x);
      const [value, confidence] = top(p);
      const type = QUESTIONS[id].type;

      if (type === "choice") out[id] = { value, probabilities: p, confidence };
      else if (type === "noul")
        out[id] = { value: p.true ?? 0, probabilities: null, confidence: null };
      else {
        const levels = { "0": p["0"] ?? 0, "1": p["1"] ?? 0, "2": p["2"] ?? 0 };

        out[id] = { value: levels["1"] + 2 * levels["2"], probabilities: levels, confidence };
      }
    }

    return out;
  }

  return { features, head, answers };
}

const committed = tinyModel(vectorizerJson, headsJson);

export const { features, head } = committed;

/** All 14 answers from the committed model, in the gateway's wire format. */
export const tinyAnswers = committed.answers;
