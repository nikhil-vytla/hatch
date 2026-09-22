import {
  evaluate,
  GatewayError,
  type Payload,
} from "../../experience-prototypes/server/gateway";
import {
  DEFAULT_LIMITS,
  decisionSummary,
  questionValues,
  type Adapter,
  type DecisionResponse,
  type Value,
} from "./contract";
import { probabilityMassAccepted } from "../../packages/decision-runtime/src/score";
/** Native Jev transport. API keys are supplied per adapter and never serialized in responses. */
export function createJevAdapter(
  apiKey: string,
  fetcher?: typeof fetch,
  transport: { maxAttempts?: number } = {},
): Adapter {
  const identity = {
    adapter: "vercel-jev",
    model: "typesafe-ai/jev",
    local: false,
  };
  return {
    identity,
    modelResolution: "provider",
    limits: {
      ...DEFAULT_LIMITS,
      maxInputBytes: 90_000,
      maxPromptChars: 12_000,
    },
    async decide(request, { signal, onAccounting } = {}) {
      const started = performance.now();
      const body: Payload = {
        state: request.state,
        questions: Object.fromEntries(
          request.questions.map((q) => [
            q.id,
            q.kind === "boolean"
              ? {
                  type: "noul",
                  instructions: q.prompt,
                  ...(q.criteria === undefined ? {} : { criteria: q.criteria }),
                }
              : q.kind === "choice"
                ? {
                    type: "choice",
                    instructions: q.prompt,
                    criteria: Object.fromEntries(
                      q.options.map((o) => [
                        o.id,
                        Object.hasOwn(o, "description")
                          ? o.description!
                          : o.label,
                      ]),
                    ),
                  }
                : {
                    type: "score",
                    instructions: q.prompt,
                    criteria: q.levels ?? questionValues(q).map(String),
                  },
          ]),
        ),
      };
      let raw;
      try {
        raw = await evaluate(body, {
          apiKey,
          fetcher,
          signal,
          onAccounting,
          maxAttempts: transport.maxAttempts,
        });
      } catch (error) {
        if (!(error instanceof GatewayError)) throw error;
        const accounting = error.accounting;
        const last = accounting.attempts.at(-1);
        return {
          schemaVersion: "2",
          requestId: request.requestId,
          status: error.code === "cancelled" ? "cancelled" : "error",
          decisions: [],
          execution: {
            ...identity,
            model: last?.model ?? identity.model,
            requestedModel: identity.model,
            modelSource: last?.modelSource ?? "configured-unverified",
          },
          timing: {
            totalMs: performance.now() - started,
            requestMs: last?.requestMs ?? 0,
          },
          accounting,
          usage: accounting.usage,
          costUsd: accounting.costUsd,
          issues: [{ code: error.code, message: error.message }],
        } satisfies DecisionResponse;
      }
      const decisions = request.questions.map((q) => {
        const answer = raw.answers[q.id],
          values = questionValues(q);
        let distribution: { value: Value; probability: number }[];
        let probabilityMass = 1;
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
          if (!probabilityMassAccepted(sum))
            throw Error(
              "Provider probability mass exceeds rounding tolerance.",
            );
          distribution = values.map((value, i) => ({
            value,
            probability: ps[i] / sum,
          }));
          probabilityMass = sum;
        }
        const selected = distribution.reduce((a, b) =>
          b.probability > a.probability ? b : a,
        ).value;
        return {
          questionId: q.id,
          distribution,
          selected,
          ...decisionSummary(q, distribution),
          nativeValue: answer.value,
          confidence: answer.confidence,
          probabilityMass,
          ...(answer.legend === undefined
            ? {}
            : {
                legend: values.map((value, i) => ({
                  value,
                  description:
                    answer.legend[
                      q.kind === "ordinal" ? String(i) : String(value)
                    ],
                })),
              }),
        };
      });
      return {
        schemaVersion: "2",
        requestId: request.requestId,
        status: "ok",
        decisions,
        execution: {
          ...identity,
          model: raw.model,
          requestedModel: identity.model,
          modelSource: raw.model_source,
        },
        timing: {
          totalMs: performance.now() - started,
          requestMs: raw.service_latency_ms,
        },
        accounting: raw.accounting,
        usage: raw.accounting.usage,
        costUsd: raw.accounting.costUsd,
        issues: [],
      } satisfies DecisionResponse;
    },
  };
}
