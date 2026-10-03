/**
 * Where `jev-lab` sends requests. Every endpoint takes a request in Jev's wire format
 * ({ state, questions }) and returns answers in the shape our recordings use
 * ({ type, value, probabilities }), plus timing and token counts.
 *
 *   jev                         Jev through the Vercel AI Gateway (AI_GATEWAY_API_KEY, billed to you)
 *   systemone:http://host:port  SGLang's /v1/systemone, or packages/arena/open-decisions/server.py on MLX
 *   decisions:http://host:port  SGLang's /v1/decisions (noul and choice; score is best effort)
 */
import { evaluate } from "../../../experience-prototypes/server/gateway";
import { toWire, type Raw } from "../../../packages/arena/open-decisions/wire";
import type { Payload } from "./studies";

export type Answers = Record<string, { type: string; value: unknown; probabilities: Record<string, number> | null }>;

export type Reply = {
  answers: Answers;
  latencyMs: number;
  inputTokens: number | null;
  /** Cost the endpoint reported, if any; otherwise the recorder prices tokens. */
  costUsd: number | null;
  servedBy: string | null;
  model: string | null;
};

export type Endpoint = {
  label: string;
  /** USD per million input tokens, for --max-usd; 0 for self-hosted. */
  usdPerMTok: number;
  ask(request: Payload, signal?: AbortSignal): Promise<Reply>;
};

/** TypeSafe's list price for Jev: $0.042 per million input tokens, output free (docs.typesafe.ai/models). */
export const JEV_USD_PER_MTOK = 0.042;

export class EndpointError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
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

export function endpoint(spec: string, opts: { model?: string; usdPerMTok?: number } = {}): Endpoint {
  if (spec === "jev") {
    const key = process.env.AI_GATEWAY_API_KEY;

    return {
      label: "Jev via the Vercel AI Gateway",
      usdPerMTok: opts.usdPerMTok ?? JEV_USD_PER_MTOK,
      async ask(request, signal) {
        if (!key) throw new EndpointError("Set AI_GATEWAY_API_KEY to ask Jev (it is billed to your key).", 401);

        // SAFETY: Payload is the same { state, questions } shape the gateway validates on entry.
        const r = await evaluate(request as never, { apiKey: key, maxAttempts: 3, deadlineMs: 20_000, signal });

        return {
          answers: r.answers as Answers,
          latencyMs: r.service_latency_ms ?? r.latency_ms,
          inputTokens: r.usage?.input_tokens ?? null,
          costUsd: r.cost_usd ?? null,
          servedBy: r.served_by ?? null,
          model: r.model ?? null,
        };
      },
    };
  }

  const [kind, ...rest] = spec.split(":");
  const base = rest.join(":").replace(/\/$/, "");

  if ((kind === "systemone" || kind === "decisions") && base.startsWith("http")) {
    const model = opts.model ?? "default";

    return {
      label: `${kind === "systemone" ? "/v1/systemone" : "/v1/decisions"} at ${base}`,
      usdPerMTok: opts.usdPerMTok ?? 0,
      async ask(request, signal) {
        if (kind === "systemone") {
          const { json, wallMs } = await postJson(`${base}/v1/systemone`, { model, ...request }, signal);
          const usage = json.usage as { input_tokens?: number } | undefined;

          return {
            answers: toWire(json.answers as Record<string, Raw>) as Answers,
            latencyMs: (json.latency_ms as number | undefined) ?? wallMs,
            inputTokens: usage?.input_tokens ?? null,
            costUsd: null,
            servedBy: base,
            model: (json.model as string | undefined) ?? model,
          };
        }

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
        };
      },
    };
  }

  throw new Error(`Unknown endpoint "${spec}". Use jev, systemone:http://host:port or decisions:http://host:port.`);
}
