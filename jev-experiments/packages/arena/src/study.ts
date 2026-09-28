/** Reads the recorded local-model study (public/data/local-models.json) as arena answers. */
import { argmax, score, type Scorecard } from "./score";

export type StudyQuestion = {
  key: string;
  type: "choice" | "score" | "noul";
  instructions: string;
  keys: string[];
  options: string[];
  target: number[];
  predictions: Record<string, number[]>;
};

export type StudyCase = {
  id: string;
  workflow: string;
  state: unknown;
  questions: StudyQuestion[];
};

export type StudyModel = {
  id: string;
  name: string;
  kind: string;
  method?: string | null;
  case_latency_ms?: { median: number; p95: number } | null;
};

export type Study = {
  provenance: { name: string; url: string; revision: string; license: string; sampling: string };
  hardware: string;
  workflows: string[];
  models: StudyModel[];
  cases: StudyCase[];
  timing_note: string;
};

export type Filter = { workflow?: string; type?: StudyQuestion["type"] };

export function questions(study: Study, filter: Filter = {}) {
  return study.cases
    .filter((c) => !filter.workflow || c.workflow === filter.workflow)
    .flatMap((c) =>
      c.questions
        .filter((q) => !filter.type || q.type === filter.type)
        .map((q) => ({ case: c, question: q })),
    );
}

export function scoreboard(
  study: Study,
  modelIds: string[],
  filter: Filter = {},
): Record<string, Scorecard> {
  const rows = questions(study, filter);

  return Object.fromEntries(
    modelIds.map((id) => [
      id,
      score(
        rows.map(({ question }) => ({
          prediction: question.predictions[id],
          reference: question.target,
        })),
      ),
    ]),
  );
}

/** Top option and whether it is a confident disagreement with the reference. */
export function verdict(question: StudyQuestion, modelId: string, threshold = 0.7) {
  const p = question.predictions[modelId],
    sum = p.reduce((a, b) => a + b, 0);

  const i = argmax(p),
    top = p[i] / sum,
    agrees = i === argmax(question.target);

  return {
    index: i,
    key: question.keys[i],
    confidence: top,
    agrees,
    confidentButWrong: !agrees && top >= threshold,
  };
}
