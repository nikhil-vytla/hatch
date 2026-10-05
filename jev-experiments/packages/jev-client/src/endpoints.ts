/**
 * The endpoint seam: every adapter takes a request in Jev's wire format ({ state, questions })
 * and returns answers in the shape our recordings use ({ type, value, probabilities }), plus
 * timing and token counts. `raw` keeps the adapter's own response for recorders that log more.
 *
 *   jevEndpoint        Jev through the Vercel AI Gateway (billed to the key)
 *   systemoneEndpoint  SGLang's /v1/systemone, or packages/arena/open-decisions/server.py on MLX
 *   decisionsEndpoint  SGLang's /v1/decisions (noul and choice; score is best effort)
 *   mock.ts            a local stand-in for /v1/systemone, for tests and trying things for free
 */
import { evaluate } from "./gateway.js";
import { JEV_PRICE } from "./price.js";
import { toWire, type Answers, type Payload, type Raw } from "./wire.js";

export type Reply<R = unknown> = {
  answers: Answers;
  latencyMs: number;
  inputTokens: number | null;
  /** Cost the endpoint reported, if any; otherwise the recorder prices tokens. */
  costUsd: number | null;
  servedBy: string | null;
  model: string | null;
  /** The adapter's full response (for the jev adapter, what `evaluate` returned). */
  raw?: R;
};

export type Endpoint<Q = Payload, R = unknown> = {
  label: string;
  /** USD per million input tokens, for spend caps; 0 for self-hosted. */
  usdPerMTok: number;
  ask(request: Q, signal?: AbortSignal): Promise<Reply<R>>;
};

export class EndpointError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type JevResult = Awaited<ReturnType<typeof evaluate>>;

/** Jev through the gateway. Without a key, asking throws a 401 (a dry run never asks). */
export function jevEndpoint(
  opts: { apiKey?: string; maxAttempts?: number; deadlineMs?: number; usdPerMTok?: number; missingKey?: string } = {},
): Endpoint<Payload, JevResult> {
  return {
    label: "Jev via the Vercel AI Gateway",
    usdPerMTok: opts.usdPerMTok ?? JEV_PRICE.usdPerMillionInputTokens,
    async ask(request, signal) {
      if (!opts.apiKey) throw new EndpointError(opts.missingKey ?? "Set AI_GATEWAY_API_KEY to ask Jev (it is billed to your key).", 401);

      const r = await evaluate(request, { apiKey: opts.apiKey, maxAttempts: opts.maxAttempts ?? 3, deadlineMs: opts.deadlineMs ?? 20_000, signal });

      return {
        answers: r.answers as Answers,
        latencyMs: r.service_latency_ms ?? r.latency_ms,
        inputTokens: r.usage?.input_tokens ?? null,
        costUsd: r.cost_usd ?? null,
        servedBy: r.served_by ?? null,
        model: r.model ?? null,
        raw: r,
      };
    },
  };
}

async function postJson(url: string, body: unknown, signal?: AbortSignal) {
  const started = performance.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Connection: "close" },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  const wallMs = Math.round(performance.now() - started);

  if (!res.ok) throw new EndpointError(`${res.status} from ${url}: ${text.slice(0, 200)}`, res.status);

  return { json: JSON.parse(text) as Record<string, unknown>, wallMs };
}

/** SGLang's /v1/systemone (or open-decisions/server.py). */
export function systemoneEndpoint(base: string, opts: { model?: string; usdPerMTok?: number } = {}): Endpoint {
  const model = opts.model ?? "default";

  return {
    label: `/v1/systemone at ${base}`,
    usdPerMTok: opts.usdPerMTok ?? 0,
    async ask(request, signal) {
      const { json, wallMs } = await postJson(`${base}/v1/systemone`, { model, ...request }, signal);
      const usage = json.usage as { input_tokens?: number } | undefined;

      return {
        answers: toWire(json.answers as Record<string, Raw>) as Answers,
        latencyMs: (json.latency_ms as number | undefined) ?? wallMs,
        inputTokens: usage?.input_tokens ?? null,
        costUsd: null,
        servedBy: base,
        model: (json.model as string | undefined) ?? model,
        raw: json,
      };
    },
  };
}

/** Jev wire questions as SGLang /v1/decisions questions. */
export function toDecisionsRequest(request: Payload) {
  const questions = Object.entries(request.questions).map(([id, q]) => {
    const question = String(q.instructions ?? "");

    if (q.type === "noul") return { id, type: "yes_no", question };

    if (q.type === "choice") {
      const criteria = (q.criteria ?? {}) as Record<string, string>;

      return { id, type: "choice", question, options: Object.entries(criteria).map(([name, description]) => ({ name, description })) };
    }

    const levels = (q.criteria ?? []) as string[];

    return { id, type: "score", question, levels };
  });

  return { input: request.state, questions };
}

/** SGLang /v1/decisions answers back in our wire shape. */
export function fromDecisionsAnswers(raw: Record<string, { type: string; probabilities: Record<string, number>; choice?: string; score?: number }>): Answers {
  return Object.fromEntries(
    Object.entries(raw).map(([id, a]) => {
      if (a.type === "yes_no") {
        const p = a.probabilities.yes ?? 0;

        return [id, { type: "noul", value: p, probabilities: { false: 1 - p, true: p } }];
      }

      return [id, { type: a.type, value: a.type === "choice" ? a.choice : a.score, probabilities: a.probabilities }];
    }),
  );
}

/** SGLang's /v1/decisions. */
export function decisionsEndpoint(base: string, opts: { model?: string; usdPerMTok?: number } = {}): Endpoint {
  const model = opts.model ?? "default";

  return {
    label: `/v1/decisions at ${base}`,
    usdPerMTok: opts.usdPerMTok ?? 0,
    async ask(request, signal) {
      const { json, wallMs } = await postJson(`${base}/v1/decisions`, { model, ...toDecisionsRequest(request) }, signal);
      const usage = json.usage as { prompt_tokens?: number } | undefined;

      return {
        // SAFETY: /v1/decisions returns answers keyed by question id with type and probabilities.
        answers: fromDecisionsAnswers(json.answers as never),
        latencyMs: wallMs,
        inputTokens: usage?.prompt_tokens ?? null,
        costUsd: null,
        servedBy: base,
        model: (json.model as string | undefined) ?? model,
        raw: json,
      };
    },
  };
}
