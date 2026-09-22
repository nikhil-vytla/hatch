import type { Adapter, DecisionResponse } from "../runtime/contract";
import { decide as checkedDecide } from "../runtime/execute";
import type { Classification, Task, TaskCategory } from "./types";
const categories: TaskCategory[] = [
  "bug-fix",
  "test-writing",
  "repository-analysis",
  "writing",
  "other",
];
export class DecisionClassifierError extends Error {
  constructor(public response: DecisionResponse, public source: "hosted" | "local") {
    super(`Classifier ${response.status}: ${response.issues.map(issue => `${issue.code}: ${issue.message}`).join(" ")}`);
  }
}
/** Every decision adapter uses the same questions; category and difficulty affect only soft ranking. */
export function createDecisionClassifier(
  adapter: Adapter,
  accounting: { costUsd?: number | null; maximumCostUsd?: number } = {},
) {
  if (accounting.costUsd !== undefined && accounting.costUsd !== null &&
    (!Number.isFinite(accounting.costUsd) || accounting.costUsd < 0)) throw Error("Configured classifier cost must be a nonnegative estimate.");
  const source = adapter.identity.local
    ? ("local" as const)
    : ("hosted" as const);
  return {
    classifierIdentity: {
      source,
      local: adapter.identity.local,
      model: adapter.identity.model,
      adapter: adapter.identity.adapter,
      ...(adapter.identity.revision === undefined ? {} : {revision: adapter.identity.revision}),
      ...(adapter.modelResolution ? {modelResolution: adapter.modelResolution} : {}),
    },
    classifierMaxCostUsd: accounting.maximumCostUsd,
    classifier: async (
      task: Task,
      signal?: AbortSignal,
    ): Promise<Classification> => {
      const result = await checkedDecide(
        adapter,
        {
          schemaVersion: "2",
          requestId: `${task.id}-classification`,
          state: { prompt: task.prompt, context: task.context },
          questions: [
            {
              id: "category",
              kind: "choice",
              prompt: "Which category best describes the requested work?",
              options: categories.map((id) => ({
                id,
                label: id.replaceAll("-", " "),
              })),
            },
            {
              id: "difficulty",
              kind: "ordinal",
              prompt:
                "Rate required reasoning difficulty: 0 is a direct mechanical edit; 1 is demanding multistep reasoning. Use the whole task, not its length.",
              min: 0,
              max: 1,
              step: 0.25,
            },
          ],
        },
        { signal },
      );
      if (result.status !== "ok")
        throw new DecisionClassifierError(result, source);
      const category = result.decisions.find(
          (d) => d.questionId === "category",
        )!,
        difficulty = result.decisions.find(
          (d) => d.questionId === "difficulty",
        )!;
      return {
        source,
        category: category.selected as TaskCategory,
        difficulty: difficulty.expected!,
        confidence: Math.max(
          ...category.distribution.map((p) => p.probability),
        ),
        latencyMs: result.timing.totalMs,
        costUsd: result.costUsd ?? null,
        ...(accounting.costUsd === undefined ? {} : {estimatedCostUsd: accounting.costUsd}),
        ...(result.accounting ? {accounting: result.accounting} : {}),
        evidence:
          "Version 2 shared typed category/difficulty questions. Difficulty is the distribution's expected score. Confidence is maximum category probability; calibration has not been established on routing tasks.",
        execution: {
          source,
          local: adapter.identity.local,
          model: result.execution.model,
          adapter: result.execution.adapter,
          ...(result.execution.revision === undefined ? {} : {revision: result.execution.revision}),
          ...(result.execution.requestedModel ? {requestedModel: result.execution.requestedModel} : {}),
          ...(result.execution.modelSource ? {modelSource: result.execution.modelSource} : {}),
        },
        status: "ok",
        decisionStatus: result.status,
        issues: [],
      };
    },
  };
}
export function createHostClassifier(
  classification: Pick<
    Classification,
    "category" | "difficulty" | "confidence"
  >,
) {
  return {
    classifierIdentity: {
      source: "host" as const,
      local: true,
      model: "calling-host",
    },
    classifierMaxCostUsd: 0,
    classifier: async (): Promise<Classification> => ({
      ...classification,
      source: "host",
      latencyMs: 0,
      costUsd: 0,
      evidence:
        "Traits explicitly supplied by the calling host. Host inference overhead is outside this call and must be included separately in comparative evaluation.",
    }),
  };
}
