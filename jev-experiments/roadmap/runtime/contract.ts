import { entryShape, jsonIssue, jsonEqual, type Entry, type EntryShape } from "../../packages/decision-runtime/src/native";
import { scoreAgreement } from "../../packages/decision-runtime/src/score";
import { accountingIssue, usageIssue, type RequestAccounting, type TokenUsage } from "./accounting";
export type { Entry, EntryShape };
export type { RequestAccounting, RequestAttempt, TokenUsage } from "./accounting";
/** Version 2 preserves native structure and names distribution summaries explicitly. */
export type Question =
  | {
      id: string;
      kind: "choice";
      prompt: Entry;
      options: { id: string; label: string; description?: Entry }[];
    }
  | { id: string; kind: "boolean"; prompt: Entry; criteria?: { true: Entry; false: Entry } }
  | {
      id: string;
      kind: "ordinal";
      prompt: Entry;
      min: number;
      max: number;
      step?: number;
      levels?: Entry[];
    };
export type Value = string | boolean | number;
export type DecisionRequest = {
  schemaVersion: "2";
  requestId: string;
  state: unknown;
  questions: Question[];
};
export type Identity = {
  adapter: string;
  model: string;
  revision?: string;
  local: boolean;
  requestedModel?: string;
  modelSource?: "provider-reported" | "configured-unverified";
};
export type Issue = { code: string; message: string; questionIds?: string[] };
export type DecisionResponse = {
  schemaVersion: "2";
  requestId: string;
  status: "ok" | "unsupported" | "error" | "cancelled";
  decisions: {
    questionId: string;
    distribution: { value: Value; probability: number }[];
    selected: Value;
    expected?: number;
    probabilityTrue?: number;
    confidence?: number | null;
    nativeValue?: string | number;
    probabilityMass?: number;
    legend?: { value: Value; description: Entry }[];
  }[];
  execution: Identity;
  timing: { totalMs: number; inferenceMs?: number; loadMs?: number; requestMs?: number };
  usage?: TokenUsage | null;
  costUsd?: number | null;
  accounting?: RequestAccounting;
  issues: Issue[];
};
export type RuntimeLimits = {
  maxStateBytes: number;
  maxInputBytes: number;
  maxQuestions: number;
  maxOptions: number;
  maxOrdinalLevels: number;
  supportedEntryShapes: EntryShape[];
  supportsBooleanCriteria: boolean;
  supportsOrdinalLevels: boolean;
  maxTokens?: number;
  maxPromptChars?: number;
  minPromptChars?: number;
  supportedKinds: Question["kind"][];
};
export type Adapter = {
  identity: Identity;
  limits: RuntimeLimits;
  modelResolution?: "provider";
  decide(
    request: DecisionRequest,
    options?: { signal?: AbortSignal; onAccounting?: (accounting: RequestAccounting) => void },
  ): Promise<DecisionResponse>;
};
export const DEFAULT_LIMITS: RuntimeLimits = {
  maxStateBytes: 100_000,
  maxInputBytes: 128_000,
  maxQuestions: 128,
  maxOptions: 255,
  maxOrdinalLevels: 10,
  supportedEntryShapes: ["string", "object", "array", "null"],
  supportsBooleanCriteria: true,
  supportsOrdinalLevels: true,
  supportedKinds: ["choice", "boolean", "ordinal"],
};
const object = (x: unknown): x is Record<string, any> =>
  x !== null && typeof x === "object" && !Array.isArray(x);
const text = (x: unknown): x is string =>
  typeof x === "string" && x.trim().length > 0;
const finite = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x);
const bytes = (x: unknown) =>
  new TextEncoder().encode(JSON.stringify(x)).length;
export function questionValues(q: Question): Value[] {
  if (q.kind === "choice") return q.options.map((o) => o.id);
  if (q.kind === "boolean") return [false, true];
  const step = q.step ?? 1,
    n = (q.max - q.min) / step;
  if (!finite(n) || n < 1 || n > 254 || Math.abs(n - Math.round(n)) > 1e-9)
    throw Error("Invalid ordinal range");
  const values = Array.from({ length: Math.round(n) + 1 }, (_, i) =>
    i === Math.round(n) ? q.max : q.min + i * step,
  );
  if (
    values.some(
      (value, i) => !finite(value) || (i > 0 && value <= values[i - 1]),
    )
  )
    throw Error("Ordinal values exceed numeric precision");
  return values;
}
export function decisionSummary(q: Question, distribution: {value: Value; probability: number}[]) {
  return q.kind === "ordinal"
    ? { expected: distribution.reduce((sum, p) => sum + Number(p.value) * p.probability, 0) }
    : q.kind === "boolean"
      ? { probabilityTrue: distribution.find(p => p.value === true)!.probability }
      : {};
}
export function requestRejectionStatus(issues: Issue[]): "error" | "unsupported" {
  return issues.some(issue => issue.code.startsWith("invalid_") || issue.code === "duplicate_question") ? "error" : "unsupported";
}
/** Returns explicit issues; never clips state, questions or candidate options. */
export function validateRequest(
  input: unknown,
  limits: RuntimeLimits = DEFAULT_LIMITS,
): Issue[] {
  const issues: Issue[] = [];
  const issue = (code: string, message: string, id?: string) =>
    issues.push({ code, message, ...(id ? { questionIds: [id] } : {}) });
  if (object(input)) {
    const problem = jsonIssue(input);
    if (problem) return [{code: "invalid_state", message: problem}];
  }
  if (
    !object(input) ||
    input.schemaVersion !== "2" ||
    Object.keys(input).some(key => !["schemaVersion", "requestId", "state", "questions"].includes(key)) ||
    !text(input.requestId) ||
    !Object.hasOwn(input, "state") ||
    input.state === undefined ||
    !Array.isArray(input.questions)
  )
    return [
      {
        code: "invalid_request",
        message: "Supply version 2, requestId, JSON state and typed questions.",
      },
    ];
  try {
    if (
      bytes(input.state) > limits.maxStateBytes ||
      bytes(input) > limits.maxInputBytes
    )
      issue("input_limit", "Input exceeds this runtime's byte limit.");
  } catch {
    issue("invalid_state", "Input must contain only serializable JSON values.");
  }
  if (!input.questions.length || input.questions.length > limits.maxQuestions)
    issue("question_limit", `Supply 1–${limits.maxQuestions} questions.`);
  const ids = new Set<string>();
  for (const q of input.questions) {
    if (
      !object(q) ||
      !text(q.id) ||
      !Object.hasOwn(q, "prompt") ||
      !entryShape(q.prompt) ||
      !["choice", "boolean", "ordinal"].includes(q.kind)
    ) {
      issue(
        "invalid_question",
        "Each question needs an id, prompt and supported kind.",
      );
      continue;
    }
    if (ids.has(q.id))
      issue("duplicate_question", "Question ids must be unique.", q.id);
    ids.add(q.id);
    const allowed = q.kind === "choice" ? ["id", "kind", "prompt", "options"] :
      q.kind === "boolean" ? ["id", "kind", "prompt", "criteria"] :
      ["id", "kind", "prompt", "min", "max", "step", "levels"];
    if (Object.keys(q).some(key => !allowed.includes(key)))
      issue("invalid_question", "Question has undeclared fields.", q.id);
    const checkEntry = (entry: unknown) => {
      const shape = entryShape(entry);
      if (!shape) issue("invalid_entry", "Descriptions must be strings, objects, arrays or null.", q.id);
      else if (!limits.supportedEntryShapes.includes(shape))
        issue("unsupported_structure", `This runtime does not support ${shape} entries.`, q.id);
    };
    checkEntry(q.prompt);
    if (typeof q.prompt === "string" && limits.minPromptChars !== undefined && q.prompt.trim().length < limits.minPromptChars)
      issue("unsupported_prompt", "This runtime requires a nonempty string prompt.", q.id);
    if (
      limits.maxPromptChars !== undefined &&
      (typeof q.prompt === "string" ? q.prompt.length : JSON.stringify(q.prompt).length) > limits.maxPromptChars
    )
      issue(
        "prompt_limit",
        `Question prompts must be at most ${limits.maxPromptChars} characters.`,
        q.id,
      );
    if (!limits.supportedKinds.includes(q.kind))
      issue(
        "unsupported_kind",
        `This runtime does not support ${q.kind}.`,
        q.id,
      );
    if (
      q.kind === "choice" &&
      (!Array.isArray(q.options) ||
        q.options.length < 2 ||
        q.options.some(
          (o: unknown) =>
            !object(o) ||
            !text(o.id) ||
            !text(o.label) ||
            Object.keys(o).some(key => !["id", "label", "description"].includes(key)) ||
            (Object.hasOwn(o, "description") && !entryShape(o.description)),
        ) ||
        new Set(q.options.map((o: any) => o.id)).size !== q.options.length)
    ) {
      issue(
        "invalid_options",
        "Supply at least two distinct options with id and label.",
        q.id,
      );
      continue;
    }
    if (q.kind === "choice")
      for (const option of q.options) if (Object.hasOwn(option, "description")) checkEntry(option.description);
    if (q.kind === "boolean" && q.criteria !== undefined) {
      if (!limits.supportsBooleanCriteria) issue("unsupported_criteria", "This runtime does not support boolean boundary descriptions.", q.id);
      if (!object(q.criteria) || Object.keys(q.criteria).length !== 2 || !Object.hasOwn(q.criteria, "true") || !Object.hasOwn(q.criteria, "false"))
        issue("invalid_criteria", "Boolean criteria require true and false descriptions.", q.id);
      else { checkEntry(q.criteria.true); checkEntry(q.criteria.false); }
    }
    if (
      q.kind === "ordinal" &&
      (!finite(q.min) ||
        !finite(q.max) ||
        !finite(q.step ?? 1) ||
        (q.step ?? 1) <= 0)
    ) {
      issue(
        "invalid_ordinal",
        "Ordinal bounds and positive step must be finite.",
        q.id,
      );
      continue;
    }
    try {
      const count = questionValues(q as Question).length;
      if (q.kind === "ordinal") {
        if (count > limits.maxOrdinalLevels) issue("ordinal_limit", `This runtime supports at most ${limits.maxOrdinalLevels} ordinal levels.`, q.id);
        if (q.levels !== undefined) {
          if (!limits.supportsOrdinalLevels) issue("unsupported_levels", "This runtime does not support descriptive ordinal levels.", q.id);
          if (!Array.isArray(q.levels) || q.levels.length !== count) issue("invalid_levels", "Provide one description per ordered value.", q.id);
          else q.levels.forEach(checkEntry);
        }
      }
      if (count > limits.maxOptions)
        issue(
          "option_limit",
          `This runtime supports at most ${limits.maxOptions} options.`,
          q.id,
        );
    } catch {
      issue(
        "invalid_ordinal",
        "Ordinal range must have 2–255 evenly spaced values.",
        q.id,
      );
    }
  }
  return issues;
}
export function validateResponse(
  request: DecisionRequest,
  response: unknown,
): Issue[] {
  const fail = (message: string): Issue[] => [
    { code: "invalid_response", message },
  ];
  if (jsonIssue(response)) return fail("Response must contain finite, bounded JSON.");
  if (
    !object(response) ||
    response.schemaVersion !== "2" ||
    response.requestId !== request.requestId ||
    !["ok", "unsupported", "error", "cancelled"].includes(response.status) ||
    !Array.isArray(response.decisions) ||
    !Array.isArray(response.issues)
  )
    return fail("Response identity, status or arrays are invalid.");
  if (
    !object(response.execution) ||
    !text(response.execution.adapter) ||
    !text(response.execution.model) ||
    typeof response.execution.local !== "boolean" ||
    (response.execution.revision !== undefined &&
      !text(response.execution.revision)) ||
    (response.execution.requestedModel !== undefined && !text(response.execution.requestedModel)) ||
    (response.execution.modelSource !== undefined && !["provider-reported", "configured-unverified"].includes(response.execution.modelSource))
  )
    return fail("Execution identity is required.");
  if (
    !object(response.timing) ||
    !finite(response.timing.totalMs) ||
    response.timing.totalMs < 0 ||
    Object.values(response.timing).some((v) => !finite(v) || v < 0)
  )
    return fail("Timing must contain finite, nonnegative durations.");
  if (response.costUsd !== undefined && response.costUsd !== null && (!finite(response.costUsd) || response.costUsd < 0))
    return fail("Cost must be unknown or finite and nonnegative.");
  if (response.usage !== undefined && response.usage !== null && usageIssue(response.usage))
    return fail("Usage must contain known, nonnegative integer token counts.");
  if (response.accounting !== undefined) {
    const issue = accountingIssue(response.accounting);
    if (issue) return fail(issue);
    if (response.costUsd !== response.accounting.costUsd || !jsonEqual(response.usage, response.accounting.usage))
      return fail("Response usage/cost must retain the complete request accounting.");
    if (response.status === "ok" && response.accounting.attempts.some((attempt: any) => attempt.status === "pending"))
      return fail("Successful responses cannot contain pending outbound attempts.");
  }
  if (
    response.issues.some(
      (i: unknown) => !object(i) || !text(i.code) || !text(i.message),
    )
  )
    return fail("Issues need codes and explanations.");
  if (response.status !== "ok")
    return response.decisions.length === 0 && response.issues.length > 0
      ? []
      : fail(
          "Non-success responses must explain the failure and contain no decisions.",
        );
  if (
    response.issues.length ||
    response.decisions.length !== request.questions.length
  )
    return fail(
      "Success must answer every question exactly once without errors.",
    );
  const seen = new Set<string>();
  for (const d of response.decisions) {
    if (!object(d) || seen.has(d.questionId))
      return fail("Duplicate or malformed decision.");
    const q = request.questions.find((q) => q.id === d.questionId);
    if (!q || !Array.isArray(d.distribution))
      return fail("Unknown question or missing distribution.");
    seen.add(d.questionId);
    const values = questionValues(q),
      options = new Set<Value>();
    let sum = 0;
    for (const p of d.distribution) {
      if (
        !object(p) ||
        !values.includes(p.value) ||
        options.has(p.value) ||
        !finite(p.probability) ||
        p.probability < 0 ||
        p.probability > 1
      )
        return fail("Invalid, duplicate or undeclared probability value.");
      options.add(p.value);
      sum += p.probability;
    }
    if (
      options.size !== values.length ||
      Math.abs(sum - 1) > 1e-6 ||
      !values.includes(d.selected)
    )
      return fail(
        "Distribution must cover all options, sum to one and select a declared value.",
      );
    const winner = Math.max(...d.distribution.map((p: any) => p.probability));
    if (d.distribution.find((p: any) => p.value === d.selected)?.probability !== winner)
      return fail("Selected must be a modal option; use expected for ordinal decisions.");
    for (const [key, expected] of Object.entries(decisionSummary(q, d.distribution))) {
      if (!finite(d[key]) || Math.abs(d[key] - expected) > 1e-6 * Math.max(1, Math.abs(expected)))
        return fail(`${key} must match the complete distribution.`);
    }
    if ((q.kind !== "ordinal" && d.expected !== undefined) || (q.kind !== "boolean" && d.probabilityTrue !== undefined))
      return fail("Decision summary does not match its primitive.");
    if (d.confidence !== undefined && d.confidence !== null && (!finite(d.confidence) || d.confidence < 0 || d.confidence > 1))
      return fail("Provider confidence must be a probability or null.");
    if (d.nativeValue !== undefined && (q.kind === "choice" ? !values.includes(d.nativeValue) :
      !finite(d.nativeValue) || d.nativeValue < 0 || d.nativeValue > (q.kind === "boolean" ? 1 : values.length - 1)))
      return fail("Native answer must be a declared choice, Noul probability or Score index expectation.");
    if (d.probabilityMass !== undefined && (!finite(d.probabilityMass) || d.probabilityMass <= 0))
      return fail("Reported original probability mass must be positive and finite.");
    if (q.kind === "ordinal" && d.nativeValue !== undefined) {
      const rawProbabilities = values.map(value => d.distribution.find((p: any) => p.value === value).probability * (d.probabilityMass ?? 1));
      if (!scoreAgreement(d.nativeValue, rawProbabilities).accepted)
        return [{code: "native_score_mismatch", message: "Native Score disagrees with its complete distribution under the declared rounding allowance.", questionIds: [q.id]}];
    }
    if (d.legend !== undefined && (!Array.isArray(d.legend) || d.legend.length !== values.length ||
      d.legend.some((level: any, i: number) => !object(level) || level.value !== values[i] || !entryShape(level.description))))
      return fail("Legend must describe every option in request order.");
  }
  return [];
}
