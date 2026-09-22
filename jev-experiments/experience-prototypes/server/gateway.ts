import {
  entryShape,
  jsonEqual,
  jsonIssue,
  nativeQuestionIssue,
  type NativeQuestion,
} from "../../packages/decision-runtime/src/native";
import { probabilityMassAccepted, scoreAgreement } from "../../packages/decision-runtime/src/score";
import {
  parseCost,
  requestAccounting,
  usageIssue,
  type RequestAttempt,
  type RequestAccounting,
  type TokenUsage,
} from "../../roadmap/runtime/accounting";
export type Question = NativeQuestion;
export type Payload = { state: unknown; questions: Record<string, Question> };
export class GatewayError extends Error {
  constructor(
    message: string,
    public status: number,
    public attempts: RequestAttempt[] = [],
    public retryAfterMs = 0,
    public code = "runtime_error",
  ) {
    super(message);
  }
  get accounting() {
    return requestAccounting(this.attempts);
  }
}
export function apiKeyFromHeader(header: unknown): string {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return "";
  const supplied = header.slice(7);
  return supplied.length <= 8192 && /^[!-~]+$/.test(supplied) ? supplied : "";
}
export function validate(body: unknown): asserts body is Payload {
  const b = body as Payload;
  const structuralIssue = jsonIssue(body);
  if (structuralIssue) throw new GatewayError(structuralIssue, 400);
  if (
    !b ||
    typeof b !== "object" ||
    Array.isArray(b) ||
    Object.keys(b).some((key) => !["state", "questions"].includes(key)) ||
    b.state === undefined ||
    !b.questions ||
    typeof b.questions !== "object" ||
    Array.isArray(b.questions) ||
    Buffer.byteLength(JSON.stringify(b)) > 100000 ||
    Object.keys(b.questions).length < 1 ||
    Object.keys(b.questions).length > 128
  )
    throw new GatewayError(
      "Provide state and 1–128 questions under 100 KB.",
      400,
    );
  for (const [id, q] of Object.entries(b.questions)) {
    if (!id.trim())
      throw new GatewayError("Question ids must be nonempty.", 400);
    const issue = nativeQuestionIssue(q);
    if (issue) throw new GatewayError(issue, 400);
  }
}
export function retryDelay(
  value: string | null,
  attempt: number,
  now = Date.now(),
) {
  const seconds = value === null ? NaN : Number(value);
  const date = value ? Date.parse(value) : NaN;
  return Math.max(
    0,
    Number.isFinite(seconds)
      ? seconds * 1000
      : Number.isFinite(date)
        ? date - now
        : Math.min(12000, 700 * 2 ** attempt),
  );
}
const transient = new Set([408, 429, 500, 502, 503, 504]);
function answersFromProvider(
  raw: any,
  body: Payload,
  attempts: RequestAttempt[],
  current: RequestAttempt,
) {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    !raw.answers ||
    typeof raw.answers !== "object" ||
    Array.isArray(raw.answers) ||
    Object.keys(raw.answers).length !== Object.keys(body.questions).length ||
    (raw.model !== undefined &&
      (typeof raw.model !== "string" || !raw.model.trim()))
  )
    throw new GatewayError(
      "Provider returned an invalid answer envelope.",
      502,
      attempts,
    );
  const answers: Record<string, any> = Object.create(null);
  for (const [id, q] of Object.entries(body.questions)) {
    const a = raw.answers?.[id],
      v = a?.[q.type],
      upper =
        q.type === "noul"
          ? 1
          : Array.isArray(q.criteria)
            ? q.criteria.length - 1
            : 0;
    if (
      !a ||
      a.type !== q.type ||
      (q.type === "choice"
        ? typeof v !== "string" || !Object.hasOwn(q.criteria!, v)
        : typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > upper)
    )
      throw new GatewayError(
        "Provider returned an invalid answer.",
        502,
        attempts,
      );
    if (
      a.confidence != null &&
      (typeof a.confidence !== "number" ||
        !Number.isFinite(a.confidence) ||
        a.confidence < 0 ||
        a.confidence > 1)
    )
      throw new GatewayError(
        "Provider returned invalid confidence.",
        502,
        attempts,
      );
    if (q.type !== "noul" && a.probabilities == null)
      throw new GatewayError(
        "Provider omitted the complete distribution.",
        502,
        attempts,
      );
    if (a.probabilities != null) {
      const expected =
        q.type === "choice"
          ? Object.keys(q.criteria!)
          : q.type === "score"
            ? q.criteria.map((_, i) => String(i))
            : ["false", "true"];
      const ps = Object.entries(a.probabilities);
      if (
        typeof a.probabilities !== "object" ||
        Array.isArray(a.probabilities) ||
        ps.length !== expected.length ||
        !ps.length ||
        ps.some(
          ([key, p]) =>
            typeof p !== "number" ||
            !Number.isFinite(p) ||
            p < 0 ||
            p > 1 ||
            !expected.includes(key),
        ) ||
        !probabilityMassAccepted(ps.reduce((s, [, p]) => s + Number(p), 0)) ||
        (q.type === "noul" &&
          (Math.abs(a.probabilities.true - v) > 1e-6 ||
            Math.abs(a.probabilities.false - (1 - v)) > 1e-6))
      )
        throw new GatewayError(
          "Provider returned invalid probabilities.",
          502,
          attempts,
        );
    }
    if (q.type === "score") {
      const result = scoreAgreement(
        v,
        q.criteria.map((_, i) => a.probabilities[String(i)]),
      );
      current.scoreChecks ??= [];
      current.scoreChecks.push({ questionId: id, result });
      if (!result.accepted)
        throw new GatewayError(
          "Native Score disagrees with its distribution under the declared rounding allowance.",
          502,
          attempts,
          0,
          "native_score_mismatch",
        );
    }
    if (a.legend != null) {
      const expected =
        q.type === "choice"
          ? Object.keys(q.criteria)
          : q.type === "score"
            ? q.criteria.map((_, i) => String(i))
            : ["false", "true"];
      if (
        typeof a.legend !== "object" ||
        Array.isArray(a.legend) ||
        jsonIssue(a.legend) ||
        Object.keys(a.legend).length !== expected.length ||
        expected.some(
          (key) => !Object.hasOwn(a.legend, key) || !entryShape(a.legend[key]),
        )
      )
        throw new GatewayError(
          "Provider returned an invalid legend.",
          502,
          attempts,
        );
      const requested =
        q.type === "score"
          ? Object.fromEntries(q.criteria.map((level, i) => [String(i), level]))
          : q.criteria;
      if (requested !== undefined && !jsonEqual(a.legend, requested))
        throw new GatewayError(
          "Provider legend disagrees with requested descriptions.",
          502,
          attempts,
        );
    }
    answers[id] = {
      type: q.type,
      value: v,
      probabilities: a.probabilities ?? null,
      confidence: a.confidence ?? null,
      ...(a.legend == null ? {} : { legend: a.legend }),
    };
  }
  return answers;
}

/** Metadata survives semantic rejection; missing or malformed observations never become zero. */
function observe(raw: any, attempt: RequestAttempt) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  if (typeof raw.model === "string" && raw.model.trim()) {
    attempt.model = raw.model;
    attempt.modelSource = "provider-reported";
  }
  const gateway = raw.provider_metadata?.gateway;
  if (gateway?.cost !== undefined && gateway.cost !== null) {
    attempt.costUsd = parseCost(gateway.cost);
    if (attempt.costUsd === null) attempt.issues.push("invalid_cost");
  }
  if (typeof gateway?.generationId === "string" && gateway.generationId.trim())
    attempt.generationId = gateway.generationId;
  if (raw.usage !== undefined && raw.usage !== null) {
    const usage: TokenUsage = {};
    if (typeof raw.usage === "object" && !Array.isArray(raw.usage)) {
      for (const [wire, field] of [
        ["input_tokens", "inputTokens"],
        ["output_tokens", "outputTokens"],
        ["total_tokens", "totalTokens"],
      ] as const)
        if (Object.hasOwn(raw.usage, wire)) usage[field] = raw.usage[wire];
    }
    if (usageIssue(usage)) attempt.issues.push("invalid_usage");
    else attempt.usage = usage;
  }
}

export async function evaluate(
  body: Payload,
  options: {
    apiKey: string;
    signal?: AbortSignal;
    fetcher?: typeof fetch;
    wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
    deadlineMs?: number;
    maxAttempts?: number;
    onAttempt?: (attempt: RequestAttempt) => void;
    onAccounting?: (accounting: RequestAccounting) => void;
  },
) {
  validate(body);
  const key = apiKeyFromHeader(`Bearer ${options.apiKey ?? ""}`);
  if (!key)
    throw new GatewayError(
      "Enter your Vercel AI Gateway API key to run live.",
      401,
    );
  const maximum = options.maxAttempts ?? 6;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 6)
    throw new GatewayError("Set 1–6 outbound attempts.", 400);
  const started = Date.now(),
    end = started + (options.deadlineMs ?? 48000);
  const attempts: RequestAttempt[] = [];
  const fetcher = options.fetcher ?? fetch;
  const wait =
    options.wait ??
    ((ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const abort = () => {
          clearTimeout(timer);
          reject(signal?.reason);
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", abort);
          resolve();
        }, ms);
        signal?.addEventListener("abort", abort, { once: true });
      }));
  const cancelled = () =>
    new GatewayError(
      "The caller cancelled this decision.",
      499,
      attempts,
      0,
      "cancelled",
    );
  const publishAccounting = () => {
    try {
      options.onAccounting?.(requestAccounting(attempts));
    } catch {
      throw new GatewayError(
        "Accounting observer failed.",
        500,
        attempts,
        0,
        "observer_error",
      );
    }
  };
  for (let i = 0; i < maximum; i++) {
    if (options.signal?.aborted) throw cancelled();
    const at = Date.now();
    const attempt: RequestAttempt = {
      attempt: i + 1,
      status: "pending",
      requestMs: 0,
      requestedModel: "typesafe-ai/jev",
      model: "typesafe-ai/jev",
      modelSource: "configured-unverified",
      usage: null,
      costUsd: null,
      accountingScope: "gateway-response",
      providerAttempts: "unknown",
      issues: [],
    };
    attempts.push(attempt);
    publishAccounting();
    let finalized = false;
    const finish = () => {
      if (finalized) return;
      finalized = true;
      attempt.requestMs = Date.now() - at;
      try {
        options.onAttempt?.(structuredClone(attempt));
      } catch {
        throw new GatewayError(
          "Attempt observer failed.",
          500,
          attempts,
          0,
          "observer_error",
        );
      }
      publishAccounting();
    };
    let delay = 0;
    try {
      const timeout = AbortSignal.timeout(
        Math.max(1, Math.min(18000, end - Date.now())),
      );
      const signal = options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout;
      const response = await fetcher(
        "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
        {
          method: "POST",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "typesafe-ai/jev",
            state: body.state,
            questions: body.questions,
          }),
          signal,
        },
      );
      attempt.status = response.status;
      attempt.headersMs = Date.now() - at;
      attempt.retryAfterMs = response.ok
        ? 0
        : retryDelay(response.headers.get("retry-after"), i);
      let raw: any;
      try {
        raw = await response.json();
      } catch {
        if (options.signal?.aborted) throw cancelled();
        attempt.issues.push("invalid_json");
        if (response.ok)
          throw new GatewayError(
            "Provider returned invalid JSON.",
            502,
            attempts,
          );
      }
      observe(raw, attempt);
      if (options.signal?.aborted) throw cancelled();
      if (!response.ok) {
        if (!transient.has(response.status))
          throw new GatewayError(
            response.status === 401 || response.status === 403
              ? "Vercel AI Gateway rejected this API key. Check the key and its access to Jev."
              : `Gateway rejected the request (${response.status}).`,
            response.status,
            attempts,
          );
        delay = attempt.retryAfterMs;
      } else {
        const answers = answersFromProvider(raw, body, attempts, attempt);
        finish();
        const accounting = requestAccounting(attempts);
        const usage = accounting.usage;
        return {
          answers,
          latency_ms: Date.now() - started,
          service_latency_ms: attempt.requestMs,
          retries: attempts.length - 1,
          attempts: accounting.attempts,
          accounting,
          cost_usd: accounting.costUsd,
          model: attempt.model,
          model_source: attempt.modelSource,
          usage: usage
            ? {
                ...(usage.inputTokens === undefined
                  ? {}
                  : { input_tokens: usage.inputTokens }),
                ...(usage.outputTokens === undefined
                  ? {}
                  : { output_tokens: usage.outputTokens }),
                ...(usage.totalTokens === undefined
                  ? {}
                  : { total_tokens: usage.totalTokens }),
              }
            : null,
          source: "live",
        };
      }
    } catch (error) {
      if (options.signal?.aborted) {
        if (attempt.status === "pending") attempt.status = "cancelled";
        attempt.issues.push("cancelled");
        throw cancelled();
      }
      if (error instanceof GatewayError) {
        attempt.issues.push(error.code);
        throw error;
      }
      if (attempt.status === "pending") attempt.status = "network";
      attempt.issues.push("network_error");
      delay = retryDelay(null, i);
    } finally {
      finish();
    }
    if (i === maximum - 1 || Date.now() + delay >= end)
      throw new GatewayError(
        "Jev is busy. Your input is preserved; retry shortly.",
        503,
        attempts,
        delay,
      );
    try {
      await wait(delay, options.signal);
    } catch (error) {
      if (options.signal?.aborted) throw cancelled();
      throw error;
    }
  }
  throw new GatewayError("Jev is temporarily unavailable.", 503, attempts);
}
