/** Shared wire contract. Runtime-specific token limits must be checked before inference. */
export type Question =
  | {
      id: string;
      kind: "choice";
      prompt: string;
      options: { id: string; label: string; description?: string }[];
    }
  | { id: string; kind: "boolean"; prompt: string }
  | {
      id: string;
      kind: "ordinal";
      prompt: string;
      min: number;
      max: number;
      step?: number;
    };
export type Value = string | boolean | number;
export type DecisionRequest = {
  schemaVersion: "1";
  requestId: string;
  state: unknown;
  questions: Question[];
};
export type Identity = {
  adapter: string;
  model: string;
  revision?: string;
  local: boolean;
};
export type Issue = { code: string; message: string; questionIds?: string[] };
export type DecisionResponse = {
  schemaVersion: "1";
  requestId: string;
  status: "ok" | "unsupported" | "error" | "cancelled";
  decisions: {
    questionId: string;
    distribution: { value: Value; probability: number }[];
    selected: Value;
  }[];
  execution: Identity;
  timing: { totalMs: number; inferenceMs?: number; loadMs?: number };
  issues: Issue[];
};
export type RuntimeLimits = {
  maxStateBytes: number;
  maxInputBytes: number;
  maxQuestions: number;
  maxOptions: number;
  maxTokens?: number;
  maxPromptChars?: number;
  supportedKinds: Question["kind"][];
};
export type Adapter = {
  identity: Identity;
  limits: RuntimeLimits;
  decide(
    request: DecisionRequest,
    options?: { signal?: AbortSignal },
  ): Promise<DecisionResponse>;
};
export const DEFAULT_LIMITS: RuntimeLimits = {
  maxStateBytes: 100_000,
  maxInputBytes: 128_000,
  maxQuestions: 128,
  maxOptions: 255,
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
/** Returns explicit issues; never clips state, questions or candidate options. */
export function validateRequest(
  input: unknown,
  limits: RuntimeLimits = DEFAULT_LIMITS,
): Issue[] {
  const issues: Issue[] = [];
  const issue = (code: string, message: string, id?: string) =>
    issues.push({ code, message, ...(id ? { questionIds: [id] } : {}) });
  if (
    !object(input) ||
    input.schemaVersion !== "1" ||
    !text(input.requestId) ||
    !Object.hasOwn(input, "state") ||
    input.state === undefined ||
    !Array.isArray(input.questions)
  )
    return [
      {
        code: "invalid_request",
        message: "Supply version 1, requestId, JSON state and typed questions.",
      },
    ];
  try {
    // JSON round-tripping must not silently discard unsupported input values.
    JSON.stringify(input, (_, value) => {
      if (
        typeof value === "function" ||
        typeof value === "symbol" ||
        value === undefined ||
        (typeof value === "number" && !Number.isFinite(value))
      )
        throw Error("Non-JSON value");
      return value;
    });
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
      !text(q.prompt) ||
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
    if (
      limits.maxPromptChars !== undefined &&
      q.prompt.length > limits.maxPromptChars
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
            (o.description !== undefined && typeof o.description !== "string"),
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
      if (questionValues(q as Question).length > limits.maxOptions)
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
  if (
    !object(response) ||
    response.schemaVersion !== "1" ||
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
      !text(response.execution.revision))
  )
    return fail("Execution identity is required.");
  if (
    !object(response.timing) ||
    !finite(response.timing.totalMs) ||
    response.timing.totalMs < 0 ||
    Object.values(response.timing).some((v) => !finite(v) || v < 0)
  )
    return fail("Timing must contain finite, nonnegative durations.");
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
  }
  return [];
}
