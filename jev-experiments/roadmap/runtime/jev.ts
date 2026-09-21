import {
  evaluate,
  type Payload,
} from "../../experience-prototypes/server/gateway";
import {
  DEFAULT_LIMITS,
  questionValues,
  type Adapter,
  type DecisionResponse,
  type Value,
} from "./contract";
/** Native Jev transport. API keys are supplied per adapter and never serialized in responses. */
export function createJevAdapter(
  apiKey: string,
  fetcher?: typeof fetch,
): Adapter {
  const identity = {
    adapter: "vercel-jev",
    model: "typesafe-ai/jev",
    local: false,
  };
  return {
    identity,
    limits: {
      ...DEFAULT_LIMITS,
      maxInputBytes: 90_000,
      maxPromptChars: 12_000,
    },
    async decide(request, { signal } = {}) {
      const started = performance.now();
      const body: Payload = {
        state: request.state,
        questions: Object.fromEntries(
          request.questions.map((q) => [
            q.id,
            q.kind === "boolean"
              ? { type: "noul", instructions: q.prompt }
              : q.kind === "choice"
                ? {
                    type: "choice",
                    instructions: q.prompt,
                    criteria: Object.fromEntries(
                      q.options.map((o) => [
                        o.id,
                        o.description
                          ? `${o.label}: ${o.description}`
                          : o.label,
                      ]),
                    ),
                  }
                : {
                    type: "score",
                    instructions: q.prompt,
                    criteria: questionValues(q).map(String),
                  },
          ]),
        ),
      };
      const raw = await evaluate(body, { apiKey, fetcher, signal });
      const decisions = request.questions.map((q) => {
        const answer = raw.answers[q.id],
          values = questionValues(q);
        let distribution: { value: Value; probability: number }[];
        if (q.kind === "boolean")
          distribution = [
            { value: false, probability: 1 - answer.value },
            { value: true, probability: answer.value },
          ];
        else {
          if (!answer.probabilities)
            throw Error(`Missing full distribution for question ${q.id}.`);
          const ps = values.map((value, i) =>
              Number(
                answer.probabilities[
                  q.kind === "choice" ? String(value) : String(i)
                ],
              ),
            ),
            sum = ps.reduce((a, b) => a + b, 0);
          if (!Number.isFinite(sum) || Math.abs(sum - 1) > 0.025)
            throw Error(
              "Provider probability mass exceeds rounding tolerance.",
            );
          distribution = values.map((value, i) => ({
            value,
            probability: ps[i] / sum,
          }));
        }
        const selected = distribution.reduce((a, b) =>
          b.probability > a.probability ? b : a,
        ).value;
        return { questionId: q.id, distribution, selected };
      });
      return {
        schemaVersion: "1",
        requestId: request.requestId,
        status: "ok",
        decisions,
        execution: { ...identity, model: raw.model },
        timing: {
          totalMs: performance.now() - started,
          inferenceMs: raw.service_latency_ms,
        },
        issues: [],
      } satisfies DecisionResponse;
    },
  };
}
