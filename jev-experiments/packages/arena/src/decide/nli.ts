/**
 * A small zero-shot classifier as a Decide contestant. It answers a setup's questions the way
 * an NLI model can: the state (and question) is the premise, each option a hypothesis.
 *
 * - choice: the question's criteria are the candidates, softmaxed against each other;
 * - yes/no: the statement alone, P(entailed) vs P(contradicted);
 * - 0–2 score: the level texts are the candidates.
 *
 * The same code runs in the recorder (Node) and in the visitor's browser (a worker), so the
 * recorded answers are the ones the page reproduces live.
 */
import type { WireQuestion } from "../checkable/items";
import type { WireAnswer } from "./combine";

export const NLI_MODEL = "Xenova/mobilebert-uncased-mnli";

/** transformers.js's zero-shot-classification pipeline, as far as this file uses it. */
export type ZeroShot = (
  premise: string,
  labels: string[],
  options: { hypothesis_template: string; multi_label?: boolean },
) => Promise<{ labels: string[]; scores: number[] }>;

export const premiseOf = (state: Record<string, string>) =>
  Object.entries(state)
    .map(([k, v]) => `${k.replaceAll("_", " ")}: ${v}`)
    .join(". ");

async function ranked(clf: ZeroShot, premise: string, labels: string[]) {
  const r = await clf(premise, labels, { hypothesis_template: "{}" });

  return Object.fromEntries(r.labels.map((l, i) => [l, r.scores[i]]));
}

export async function answerWithNli(
  clf: ZeroShot,
  request: { state: Record<string, string>; questions: Record<string, WireQuestion> },
): Promise<Record<string, WireAnswer>> {
  const premise = premiseOf(request.state);
  const answers: Record<string, WireAnswer> = {};

  for (const [qid, q] of Object.entries(request.questions)) {
    if (q.type === "noul") {
      const r = await clf(premise, [q.instructions], {
        hypothesis_template: "{}",
        multi_label: true,
      });

      answers[qid] = { value: r.scores[0], probabilities: null };
    } else if (q.type === "choice") {
      const keys = Object.keys(q.criteria);

      const scores = await ranked(
        clf,
        `${premise}. Question: ${q.instructions}`,
        keys.map((k) => q.criteria[k]),
      );

      answers[qid] = {
        value: null,
        probabilities: Object.fromEntries(keys.map((k) => [k, scores[q.criteria[k]] ?? 0])),
      };
    } else {
      const scores = await ranked(clf, `${premise}. Question: ${q.instructions}`, q.criteria);

      answers[qid] = {
        value: null,
        probabilities: Object.fromEntries(q.criteria.map((c, i) => [String(i), scores[c] ?? 0])),
      };
    }
  }

  return answers;
}
