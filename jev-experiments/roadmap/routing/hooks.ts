import { accountingIssue, type RequestAccounting } from "../runtime/accounting";
import type { Identity, Issue } from "../runtime/contract";
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
function inspectedUsage(value: unknown): ExecutionResult["usage"] {
  const usage = object(value);
  if (
    !usage ||
    !nonnegativeFinite(usage.inputTokens) || !Number.isSafeInteger(usage.inputTokens) ||
    !nonnegativeFinite(usage.outputTokens) || !Number.isSafeInteger(usage.outputTokens) ||
    (usage.cachedInputTokens !== undefined &&
      (!nonnegativeFinite(usage.cachedInputTokens) || !Number.isSafeInteger(usage.cachedInputTokens) ||
        usage.cachedInputTokens > usage.inputTokens))
  ) return null;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cachedInputTokens === undefined ? {} : { cachedInputTokens: usage.cachedInputTokens as number }),
  };
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
    (item.revision !== undefined && typeof item.revision !== "string") ||
    (item.requestedModel !== undefined && (typeof item.requestedModel !== "string" || !item.requestedModel.trim())) ||
    (item.modelSource !== undefined && !["provider-reported", "configured-unverified"].includes(String(item.modelSource)))
  )
    return null;
  return {
    adapter: item.adapter,
    model: item.model,
    local: item.local,
    ...(item.revision !== undefined ? { revision: item.revision } : {}),
    ...(typeof item.requestedModel === "string" ? { requestedModel: item.requestedModel } : {}),
    ...(item.modelSource === "provider-reported" || item.modelSource === "configured-unverified" ? {modelSource: item.modelSource} : {}),
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
  if (item.usage !== null && !inspectedUsage(item.usage))
    issues.push(
      "Token usage must be null or nonnegative safe integer counts, with cached input bounded by total input.",
    );
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
    !item.model.trim() ||
    (item.adapter !== undefined && (typeof item.adapter !== "string" || !item.adapter.trim())) ||
    (item.revision !== undefined && (typeof item.revision !== "string" || !item.revision.trim())) ||
    (item.modelResolution !== undefined && item.modelResolution !== "provider") ||
    (item.requestedModel !== undefined && (typeof item.requestedModel !== "string" || !item.requestedModel.trim())) ||
    (item.modelSource !== undefined && !["provider-reported", "configured-unverified"].includes(String(item.modelSource)))
  )
    return null;
  return {
    source: item.source as ClassifierIdentity["source"],
    local: item.local,
    model: item.model,
    ...(typeof item.adapter === "string" ? {adapter: item.adapter} : {}),
    ...(typeof item.revision === "string" ? {revision: item.revision} : {}),
    ...(item.modelResolution === "provider" ? {modelResolution: "provider" as const} : {}),
    ...(typeof item.requestedModel === "string" ? {requestedModel: item.requestedModel} : {}),
    ...(item.modelSource === "provider-reported" || item.modelSource === "configured-unverified" ? {modelSource: item.modelSource} : {}),
  };
}
/** Preserve typed diagnostics without copying arbitrary adapter response fields. */
export function classifierIssues(value: unknown): Issue[] | null {
  if (!Array.isArray(value)) return null;
  const issues: Issue[] = [];
  for (const entry of value) {
    const item = object(entry);
    if (!item || typeof item.code !== "string" || !item.code.trim() ||
      typeof item.message !== "string" || !item.message.trim() ||
      (item.questionIds !== undefined && (!Array.isArray(item.questionIds) ||
        !item.questionIds.every(id => typeof id === "string" && id.trim())))) return null;
    issues.push({code: item.code, message: item.message,
      ...(item.questionIds === undefined ? {} : {questionIds: [...item.questionIds as string[]]})});
  }
  return issues;
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
  if (item.estimatedCostUsd !== undefined && item.estimatedCostUsd !== null && !nonnegativeFinite(item.estimatedCostUsd))
    issues.push("Classifier estimatedCostUsd must be unknown or finite and nonnegative.");
  if (item.accounting !== undefined && (accountingIssue(item.accounting) || item.costUsd !== (item.accounting as RequestAccounting).costUsd))
    issues.push("Classifier accounting must preserve all outbound attempts and known totals.");
  if (typeof item.evidence !== "string" || !item.evidence.trim())
    issues.push("Classifier evidence must be a nonempty string.");
  if (item.status !== undefined && item.status !== "ok")
    issues.push("Classifier did not return successful traits.");
  if (item.decisionStatus !== undefined && item.decisionStatus !== "ok")
    issues.push("Classifier typed decision did not succeed.");
  if (item.issues !== undefined && (!classifierIssues(item.issues) || (item.issues as unknown[]).length))
    issues.push("Successful classifier traits cannot contain refusal issues.");
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
          (declared.adapter !== undefined && reported.adapter !== declared.adapter) ||
          (declared.revision !== undefined && reported.revision !== declared.revision) ||
          (declared.modelResolution === "provider"
            ? reported.requestedModel !== declared.model
            : reported.model !== declared.model))
      )
        issues.push(
          "Classifier execution identity contradicts its declared identity.",
        );
    }
  }
  return issues;
}
/** Inspect spend independently of whether classification traits are usable. */
export function classifierAccounting(value: unknown): Pick<Classification, "costUsd" | "accounting" | "execution" | "estimatedCostUsd"> {
  const item = object(value);
  if (!item) return {costUsd: null};
  const accounting = item.accounting !== undefined && !accountingIssue(item.accounting)
    ? structuredClone(item.accounting as RequestAccounting) : undefined;
  const execution = classifierIdentity(item.execution);
  return {
    costUsd: item.accounting !== undefined ? accounting?.costUsd ?? null : nonnegativeFinite(item.costUsd) ? item.costUsd : null,
    ...(accounting ? {accounting} : {}),
    ...(execution ? {execution} : {}),
    ...(item.estimatedCostUsd === null || nonnegativeFinite(item.estimatedCostUsd) ? {estimatedCostUsd: item.estimatedCostUsd} : {}),
  };
}

/** An unusable artifact does not erase independently valid cost, usage or reported identity. */
export function rejectedExecution(value: unknown, configuredModel: string, issues: string[]): ExecutionResult {
  const item = object(value);
  const hasModel = typeof item?.actualModel === "string" && item.actualModel.trim().length > 0;
  const usage = inspectedUsage(item?.usage);
  const artifact = object(item?.artifact);
  const rawOutput = typeof item?.rawOutput === "string" ? item.rawOutput : typeof artifact?.text === "string" ? artifact.text : undefined;
  return {
    status: "malformed", actualModel: hasModel ? item!.actualModel as string : configuredModel,
    ...(!hasModel ? {identityBasis: "configured-unverified" as const} : item?.identityBasis === "provider-reported" || item?.identityBasis === "configured-unverified" ? {identityBasis: item.identityBasis} : {}),
    usage, costUsd: nonnegativeFinite(item?.costUsd) ? item.costUsd : null,
    error: `Executor returned invalid metadata: ${issues.join(" ")}`,
    ...(rawOutput === undefined ? {} : {rawOutput: rawOutput.slice(0, 100_000)}),
  };
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
    ...(value.estimatedCostUsd === undefined ? {} : {estimatedCostUsd: value.estimatedCostUsd}),
    ...(value.accounting ? {accounting: structuredClone(value.accounting)} : {}),
    evidence: value.evidence,
    status: "ok",
    ...(value.decisionStatus === undefined ? {} : {decisionStatus: value.decisionStatus}),
    ...(value.issues === undefined ? {} : {issues: classifierIssues(value.issues)!}),
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
    costUsd: result.costUsd,
    error: `Reported model ${JSON.stringify(result.actualModel)} does not match selected model ${JSON.stringify(selectedModel)}. No alias matching is applied; observed accounting is retained.`,
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
