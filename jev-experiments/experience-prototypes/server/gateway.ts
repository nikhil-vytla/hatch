export type Question = {
  type: "choice" | "noul" | "score";
  instructions: string;
  criteria?: Record<string, string> | string[];
};
export type Payload = { state: unknown; questions: Record<string, Question> };
export class GatewayError extends Error {
  constructor(
    message: string,
    public status: number,
    public attempts: unknown[] = [],
    public retryAfterMs = 0,
  ) {
    super(message);
  }
}
export function apiKeyFromHeader(header: unknown): string {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return "";
  const supplied = header.slice(7);
  return supplied.length <= 8192 && /^[!-~]+$/.test(supplied) ? supplied : "";
}
export function validate(body: unknown): asserts body is Payload {
  const b = body as Payload;
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
  for (const q of Object.values(b.questions)) {
    if (
      !q ||
      typeof q !== "object" ||
      Array.isArray(q) ||
      Object.keys(q).some(
        (key) => !["type", "instructions", "criteria"].includes(key),
      ) ||
      (q.type === "noul" && q.criteria !== undefined) ||
      !["choice", "noul", "score"].includes(q.type) ||
      typeof q.instructions !== "string" ||
      !q.instructions.length ||
      q.instructions.length > 12000
    )
      throw new GatewayError("Invalid question.", 400);
    if (
      q.type === "choice" &&
      (!q.criteria ||
        Array.isArray(q.criteria) ||
        typeof q.criteria !== "object" ||
        Object.keys(q.criteria).length < 2 ||
        Object.keys(q.criteria).length > 255 ||
        Object.values(q.criteria).some((x) => typeof x !== "string"))
    )
      throw new GatewayError("Invalid choice options.", 400);
    if (
      q.type === "score" &&
      (!Array.isArray(q.criteria) ||
        q.criteria.length < 2 ||
        q.criteria.length > 255 ||
        q.criteria.some((x) => typeof x !== "string"))
    )
      throw new GatewayError("Invalid score rubric.", 400);
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
export async function evaluate(
  body: Payload,
  options: {
    apiKey: string;
    signal?: AbortSignal;
    fetcher?: typeof fetch;
    wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
    deadlineMs?: number;
    onAttempt?: (a: any) => void;
  },
) {
  validate(body);
  const key = apiKeyFromHeader(`Bearer ${options.apiKey ?? ""}`);
  if (!key)
    throw new GatewayError(
      "Enter your Vercel AI Gateway API key to run live.",
      401,
    );
  const started = Date.now(),
    end = started + (options.deadlineMs ?? 48000),
    attempts: any[] = [];
  const fetcher = options.fetcher ?? fetch;
  const wait =
    options.wait ??
    ((ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const abort = () => {
          clearTimeout(t);
          reject(signal?.reason);
        };
        const t = setTimeout(() => {
          signal?.removeEventListener("abort", abort);
          resolve();
        }, ms);
        signal?.addEventListener("abort", abort, { once: true });
      }));
  for (let i = 0; i < 6; i++) {
    options.signal?.throwIfAborted();
    let delay = 0;
    const at = Date.now();
    try {
      const signal = options.signal
        ? AbortSignal.any([
            options.signal,
            AbortSignal.timeout(Math.max(1, Math.min(18000, end - Date.now()))),
          ])
        : AbortSignal.timeout(Math.max(1, Math.min(18000, end - Date.now())));
      const response = await fetcher(
        "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
        {
          method: "POST",
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
      const a = {
        attempt: i + 1,
        status: response.status,
        latency_ms: Date.now() - at,
        retry_after_ms: response.ok
          ? 0
          : retryDelay(response.headers.get("retry-after"), i),
      };
      attempts.push(a);
      options.onAttempt?.(a);
      if (!response.ok) {
        if (!transient.has(response.status))
          throw new GatewayError(
            response.status === 401 || response.status === 403
              ? "Vercel AI Gateway rejected this API key. Check the key and its access to Jev."
              : `Gateway rejected the request (${response.status}).`,
            response.status,
            attempts,
          );
        delay = retryDelay(response.headers.get("retry-after"), i);
      } else {
        let raw: any;
        try {
          raw = await response.json();
        } catch {
          throw new GatewayError(
            "Provider returned invalid JSON.",
            502,
            attempts,
          );
        }
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
              ? !Object.hasOwn(q.criteria!, String(v))
              : typeof v !== "number" ||
                !Number.isFinite(v) ||
                v < 0 ||
                v > upper)
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
          if (a.probabilities != null) {
            const ps = Object.entries(a.probabilities);
            if (
              !ps.length ||
              ps.some(
                ([key, p]) =>
                  typeof p !== "number" ||
                  !Number.isFinite(p) ||
                  p < 0 ||
                  p > 1 ||
                  (q.type === "choice" && !Object.hasOwn(q.criteria!, key)),
              ) ||
              Math.abs(ps.reduce((s, [, p]) => s + Number(p), 0) - 1) > 0.08
            )
              throw new GatewayError(
                "Provider returned invalid probabilities.",
                502,
                attempts,
              );
          }
          answers[id] = {
            type: q.type,
            value: v,
            probabilities: a.probabilities ?? null,
            confidence: a.confidence ?? null,
          };
        }
        return {
          answers,
          latency_ms: Date.now() - started,
          service_latency_ms: Date.now() - at,
          retries: attempts.length - 1,
          attempts,
          cost_usd:
            raw.provider_metadata?.gateway?.cost == null
              ? null
              : Number(raw.provider_metadata.gateway.cost),
          model: raw.model ?? "typesafe-ai/jev",
          source: "live",
        };
      }
    } catch (e) {
      if (options.signal?.aborted) throw e;
      if (e instanceof GatewayError) throw e;
      const a = {
        attempt: i + 1,
        status: "network",
        latency_ms: Date.now() - at,
      };
      attempts.push(a);
      options.onAttempt?.(a);
      delay = retryDelay(null, i);
    }
    if (i === 5 || Date.now() + delay >= end)
      throw new GatewayError(
        "Jev is busy. Your input is preserved; retry shortly.",
        503,
        attempts,
        delay,
      );
    await wait(delay, options.signal);
  }
  throw new GatewayError("Jev is temporarily unavailable.", 503, attempts);
}
