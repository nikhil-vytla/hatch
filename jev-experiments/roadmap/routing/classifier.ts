import type { Adapter } from "../runtime/contract";
import { decide as checkedDecide } from "../runtime/execute";
import type { Classification, Task, TaskCategory } from "./types";
const categories: TaskCategory[] = [
  "bug-fix",
  "test-writing",
  "repository-analysis",
  "writing",
  "other",
];
/** Every decision adapter uses the same questions; category and difficulty affect only soft ranking. */
export function createDecisionClassifier(
  adapter: Adapter,
  accounting: { costUsd?: number | null; maximumCostUsd?: number } = {},
) {
  const source = adapter.identity.local
    ? ("local" as const)
    : ("hosted" as const);
  return {
    classifierIdentity: {
      source,
      local: adapter.identity.local,
      model: adapter.identity.model,
    },
    classifierMaxCostUsd: accounting.maximumCostUsd,
    classifier: async (
      task: Task,
      signal?: AbortSignal,
    ): Promise<Classification> => {
      const result = await checkedDecide(
        adapter,
        {
          schemaVersion: "1",
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
        throw Error(
          `Classifier ${result.status}: ${result.issues.map((i) => i.code).join(", ")}`,
        );
      const category = result.decisions.find(
          (d) => d.questionId === "category",
        )!,
        difficulty = result.decisions.find(
          (d) => d.questionId === "difficulty",
        )!;
      return {
        source,
        category: category.selected as TaskCategory,
        difficulty: Number(difficulty.selected),
        confidence: Math.max(
          ...category.distribution.map((p) => p.probability),
        ),
        latencyMs: result.timing.totalMs,
        costUsd: accounting.costUsd ?? null,
        evidence:
          "Version 1 shared typed category/difficulty questions. Confidence is adapter output; calibration has not been established on routing tasks.",
        execution: {
          source,
          local: adapter.identity.local,
          model: result.execution.model,
        },
        status: "ok",
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
