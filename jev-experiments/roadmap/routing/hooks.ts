import type { Identity } from "../runtime/contract";
import type {
  ExecutionResult,
  Classification,
  ClassifierIdentity,
  VerificationResult,
} from "./types";
import { validatePatchHunks } from "./artifacts";
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
export function nonnegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
export function declaredIdentity(value: unknown): Identity | null {
  const item = object(value);
  if (
    !item ||
    typeof item.adapter !== "string" ||
    !item.adapter.trim() ||
    typeof item.model !== "string" ||
    !item.model.trim() ||
    typeof item.local !== "boolean" ||
    (item.revision !== undefined && typeof item.revision !== "string")
  )
    return null;
  return {
    adapter: item.adapter,
    model: item.model,
    local: item.local,
    ...(item.revision !== undefined ? { revision: item.revision } : {}),
  };
}
/** Retain readable evidence and a valid reported charge even when another field fails. */
export function inspectVerification(value: unknown): {
  issues: string[];
  evidence: string;
  costUsd: number | null;
  result?: VerificationResult;
} {
  const item = object(value),
    issues: string[] = [];
  const evidence =
    typeof item?.evidence === "string" && item.evidence.trim()
      ? item.evidence
      : "No valid verifier evidence was returned.";
  const costUsd = nonnegativeFinite(item?.costUsd) ? item.costUsd : null;
  if (!item)
    return {
      issues: ["Verifier result must be an object."],
      evidence,
      costUsd,
    };
  if (typeof item.adequate !== "boolean")
    issues.push("adequate must be a boolean.");
  if (typeof item.evidence !== "string" || !item.evidence.trim())
    issues.push("evidence must be a nonempty string.");
  if (!nonnegativeFinite(item.latencyMs))
    issues.push("latencyMs must be finite and nonnegative.");
  if (item.costUsd !== null && !nonnegativeFinite(item.costUsd))
    issues.push("costUsd must be null or finite and nonnegative.");
  return {
    issues,
    evidence,
    costUsd,
    ...(!issues.length
      ? {
          result: {
            adequate: item.adequate as boolean,
            evidence,
            latencyMs: item.latencyMs as number,
            costUsd,
          },
        }
      : {}),
  };
}
/** SDK hooks are trusted implementations; their returned accounting still needs validation. */
export function executionIssues(value: unknown): string[] {
  const item = object(value);
  if (!item) return ["Executor result must be an object."];
  const issues: string[] = [];
  if (
    !["ok", "unavailable", "malformed", "error", "cancelled"].includes(
      item.status as string,
    )
  )
    issues.push("Executor status is invalid.");
  if (typeof item.actualModel !== "string" || !item.actualModel.trim())
    issues.push("actualModel must be a nonempty string.");
  if (item.costUsd !== null && !nonnegativeFinite(item.costUsd))
    issues.push("costUsd must be null or finite and nonnegative.");
  if (item.usage !== null) {
    const usage = object(item.usage);
    if (
      !usage ||
      !nonnegativeFinite(usage.inputTokens) ||
      !nonnegativeFinite(usage.outputTokens) ||
      (usage.cachedInputTokens !== undefined &&
        (!nonnegativeFinite(usage.cachedInputTokens) ||
          usage.cachedInputTokens > (usage.inputTokens as number)))
    )
      issues.push(
        "Token usage must be null or nonnegative finite counts, with cached input bounded by total input.",
      );
  }
  if (item.status === "ok" || item.artifact !== undefined) {
    const artifact = object(item.artifact);
    if (
      !artifact ||
      !["answer", "structured", "patch"].includes(artifact.kind as string) ||
      typeof artifact.text !== "string" ||
      !artifact.text.trim()
    )
      issues.push(
        "A successful executor must return a nonempty typed artifact.",
      );
    else if (artifact.kind === "patch") {
      try {
        validatePatchHunks(artifact.text);
      } catch {
        issues.push("Executor patch has invalid hunk syntax.");
      }
    }
  }
  return issues;
}

export function addCosts(
  total: number | null,
  charge: number | null,
): number | null {
  if (total === null || charge === null) return null;
  const sum = total + charge;
  return nonnegativeFinite(sum) ? sum : null;
}
export function classifierIdentity(value: unknown): ClassifierIdentity | null {
  const item = object(value);
  if (
    !item ||
    !["heuristic", "host", "hosted", "local"].includes(item.source as string) ||
    typeof item.local !== "boolean" ||
    typeof item.model !== "string" ||
    !item.model.trim()
  )
    return null;
  return {
    source: item.source as ClassifierIdentity["source"],
    local: item.local,
    model: item.model,
  };
}
export function classificationIssues(
  value: unknown,
  declared?: ClassifierIdentity,
): string[] {
  const item = object(value);
  if (!item) return ["Classifier result must be an object."];
  const issues: string[] = [];
  if (!["heuristic", "host", "hosted", "local"].includes(item.source as string))
    issues.push("Classifier source is invalid.");
  if (
    ![
      "bug-fix",
      "test-writing",
      "repository-analysis",
      "writing",
      "other",
    ].includes(item.category as string)
  )
    issues.push("Classifier category is invalid.");
  if (
    ![item.confidence, item.difficulty].every(
      (n) => nonnegativeFinite(n) && n <= 1,
    )
  )
    issues.push(
      "Classifier confidence and difficulty must be finite values in [0,1].",
    );
  if (!nonnegativeFinite(item.latencyMs))
    issues.push("Classifier latencyMs must be finite and nonnegative.");
  if (item.costUsd !== null && !nonnegativeFinite(item.costUsd))
    issues.push("Classifier costUsd must be null or finite and nonnegative.");
  if (typeof item.evidence !== "string" || !item.evidence.trim())
    issues.push("Classifier evidence must be a nonempty string.");
  if (item.status !== undefined && item.status !== "ok")
    issues.push("Classifier did not return successful traits.");
  if (declared && item.source !== declared.source)
    issues.push("Classifier source contradicts its declared identity.");
  if (item.execution !== undefined) {
    const reported = classifierIdentity(item.execution);
    if (!reported) issues.push("Classifier execution identity is malformed.");
    else {
      if (reported.source !== item.source)
        issues.push(
          "Classifier execution source contradicts its result source.",
        );
      if (
        declared &&
        (reported.source !== declared.source ||
          reported.local !== declared.local ||
          reported.model !== declared.model)
      )
        issues.push(
          "Classifier execution identity contradicts its declared identity.",
        );
    }
  }
  return issues;
}
/** Copy only validated fields. The declaration remains separate from reported execution. */
export function inspectedClassification(
  value: Classification,
  declared: ClassifierIdentity | null,
): Classification {
  return {
    source: value.source,
    category: value.category,
    difficulty: value.difficulty,
    confidence: value.confidence,
    latencyMs: value.latencyMs,
    costUsd: value.costUsd,
    evidence: value.evidence,
    status: "ok",
    ...(value.execution
      ? { execution: classifierIdentity(value.execution)! }
      : {}),
    ...(declared ? { declaredExecution: declared } : {}),
  };
}

/** A reported substitution is an error, not permission to price or use another model. */
export function enforceExecutionIdentity(
  selectedModel: string,
  result: ExecutionResult,
): ExecutionResult {
  if (result.actualModel === selectedModel) return result;
  return {
    status: result.status === "cancelled" ? "cancelled" : "error",
    actualModel: result.actualModel,
    ...(result.identityBasis ? { identityBasis: result.identityBasis } : {}),
    usage: result.usage,
    costUsd: null,
    error: `Reported model ${JSON.stringify(result.actualModel)} does not match selected model ${JSON.stringify(selectedModel)}. No alias matching is applied; charge is unknown.`,
    ...(result.rawOutput !== undefined || result.artifact
      ? {
          rawOutput: (result.rawOutput ?? result.artifact!.text).slice(
            0,
            100_000,
          ),
        }
      : {}),
  };
}
