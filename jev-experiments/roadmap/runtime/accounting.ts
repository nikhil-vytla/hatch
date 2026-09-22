import {
  jsonIssue,
  jsonEqual,
} from "../../packages/decision-runtime/src/native";
import {
  scoreAgreement,
  type ScoreAgreement,
} from "../../packages/decision-runtime/src/score";

export type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};
export type RequestAttempt = {
  attempt: number;
  status: number | "pending" | "network" | "cancelled";
  requestMs: number;
  headersMs?: number;
  retryAfterMs?: number;
  requestedModel: string;
  model: string;
  modelSource: "provider-reported" | "configured-unverified";
  usage: TokenUsage | null;
  costUsd: number | null;
  accountingScope: "gateway-response";
  providerAttempts: "unknown";
  generationId?: string;
  issues: string[];
  scoreChecks?: { questionId: string; result: ScoreAgreement }[];
};
export type RequestAccounting = {
  scope: "outbound-http-attempts";
  providerAttempts: "unknown";
  attempts: RequestAttempt[];
  costUsd: number | null;
  usage: TokenUsage | null;
};
const fields = ["inputTokens", "outputTokens", "totalTokens"] as const;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const duration = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const name = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export function usageIssue(value: unknown): string | null {
  if (
    !object(value) ||
    !Object.keys(value).length ||
    Object.keys(value).some(
      (key) => !fields.includes(key as (typeof fields)[number]),
    ) ||
    Object.values(value).some(
      (n) => typeof n !== "number" || !Number.isSafeInteger(n) || n < 0,
    )
  )
    return "Usage must contain known nonnegative integer token counts.";
  const { inputTokens, outputTokens, totalTokens } = value as TokenUsage;
  if (
    totalTokens !== undefined &&
    ((inputTokens !== undefined && inputTokens > totalTokens) ||
      (outputTokens !== undefined && outputTokens > totalTokens))
  )
    return "A known token count exceeds total tokens.";
  if (
    inputTokens !== undefined &&
    outputTokens !== undefined &&
    totalTokens !== undefined &&
    inputTokens + outputTokens !== totalTokens
  )
    return "Input and output token counts disagree with total tokens.";
  return null;
}

/** Only genuine nonnegative numeric amounts; JavaScript coercions are not cost observations. */
export function parseCost(value: unknown): number | null {
  if (
    typeof value !== "number" &&
    (typeof value !== "string" ||
      !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value))
  )
    return null;
  const cost = Number(value);
  return Number.isFinite(cost) && cost >= 0 ? cost : null;
}

/** Copy every attempt, and expose a total only for fields known across every attempt. */
export function requestAccounting(
  attempts: RequestAttempt[],
): RequestAccounting {
  const cost = attempts.every((a) => a.costUsd !== null)
    ? attempts.reduce((sum, a) => sum + a.costUsd!, 0)
    : null;
  const usage: TokenUsage = {};
  for (const field of fields) {
    if (
      attempts.length &&
      attempts.every((a) => a.usage?.[field] !== undefined)
    ) {
      const total = attempts.reduce((sum, a) => sum + a.usage![field]!, 0);
      if (Number.isSafeInteger(total)) usage[field] = total;
    }
  }
  return {
    scope: "outbound-http-attempts",
    providerAttempts: "unknown",
    attempts: structuredClone(attempts),
    costUsd: cost !== null && Number.isFinite(cost) ? cost : null,
    usage: Object.keys(usage).length ? usage : null,
  };
}

export function accountingIssue(value: unknown): string | null {
  if (
    jsonIssue(value) ||
    !object(value) ||
    value.scope !== "outbound-http-attempts" ||
    value.providerAttempts !== "unknown" ||
    !Array.isArray(value.attempts)
  )
    return "Request accounting needs explicit outbound-attempt scope.";
  for (let i = 0; i < value.attempts.length; i++) {
    const a = value.attempts[i];
    if (
      !object(a) ||
      a.attempt !== i + 1 ||
      !(
        (typeof a.status === "number" &&
          Number.isInteger(a.status) &&
          a.status >= 100 &&
          a.status <= 599) ||
        (typeof a.status === "string" &&
          ["pending", "network", "cancelled"].includes(a.status))
      ) ||
      !duration(a.requestMs) ||
      (a.headersMs !== undefined &&
        (!duration(a.headersMs) || a.headersMs > a.requestMs)) ||
      (a.retryAfterMs !== undefined && !duration(a.retryAfterMs)) ||
      !name(a.requestedModel) ||
      !name(a.model) ||
      !["provider-reported", "configured-unverified"].includes(
        String(a.modelSource),
      ) ||
      a.accountingScope !== "gateway-response" ||
      a.providerAttempts !== "unknown" ||
      (a.generationId !== undefined && !name(a.generationId)) ||
      (a.costUsd !== null &&
        (typeof a.costUsd !== "number" || parseCost(a.costUsd) === null)) ||
      (a.usage !== null && usageIssue(a.usage)) ||
      !Array.isArray(a.issues) ||
      a.issues.some((issue) => !name(issue))
    )
      return "An outbound attempt contains invalid accounting or identity metadata.";
    if (a.status === "pending" && (a.costUsd !== null || a.usage !== null))
      return "A pending outbound attempt cannot claim completed accounting.";
    if (
      a.scoreChecks !== undefined &&
      (!Array.isArray(a.scoreChecks) ||
        a.scoreChecks.some((check) => {
          if (
            !object(check) ||
            !name(check.questionId) ||
            !object(check.result) ||
            !Array.isArray(check.result.probabilities) ||
            check.result.probabilities.some((p) => typeof p !== "number") ||
            typeof check.result.rawScore !== "number"
          )
            return true;
          return !jsonEqual(
            check.result,
            scoreAgreement(check.result.rawScore, check.result.probabilities),
          );
        }))
    )
      return "Score-check evidence does not match its raw observations.";
  }
  const derived = requestAccounting(value.attempts as RequestAttempt[]);
  if (
    !jsonEqual(value.costUsd, derived.costUsd) ||
    !jsonEqual(value.usage, derived.usage)
  )
    return "Request totals must derive from every outbound attempt, preserving unknown fields.";
  return null;
}
