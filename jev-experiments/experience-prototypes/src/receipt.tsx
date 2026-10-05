/**
 * The result receipt: one quiet line under a Jev answer saying how long it took, how many
 * questions it was, what it cost, whether it was recorded or live, when, and who served it,
 * with the exact request and response one click away. Every field is optional and is left out
 * when the record doesn't have it; nothing here is estimated or invented.
 */
import { createContext, useContext } from "react";
import "./receipt.css";
import { JEV_USD_PER_INPUT_TOKEN } from "../../packages/arena/src/jev-price";
import { requestFor } from "./api";
import { MODE_WORDS, type Mode } from "./mode";
import { BuildThis } from "./build-this";
import { asJevRequest, type CliStudy } from "./build-this-snippets";

/** TypeSafe's list price for Jev, per input token (see packages/arena/src/jev-price.ts). */
export const USD_PER_INPUT_TOKEN = JEV_USD_PER_INPUT_TOKEN;


export type ReceiptData = {
  /** recorded replays a saved answer, live was just asked with the visitor's key, browser ran on this device. */
  mode: Mode;
  ms?: number | null;
  questions?: number | null;
  inputTokens?: number | null;
  /** Cost when the record states it; otherwise derived from inputTokens at the list price. */
  costUsd?: number | null;
  /** ISO timestamp or YYYY-MM-DD. */
  at?: string | null;
  servedBy?: string | null;
  /** For browser runs: which model, since nothing was served. */
  model?: string | null;
  raw?: { request?: unknown; response?: unknown; note?: string };
  /** The CLI study that reproduces this scene end to end, when there is one (see BuildThis). */
  study?: CliStudy;
  /**
   * The record didn't keep its request, so raw.request is rebuilt with code for the same input
   * (the recorder's builder, or what "Try your own" would send), not a copy of the recorded one.
   */
  rebuilt?: boolean;
  /** Where the request lives when the record keeps it only in a published log (see request-log.ts). */
  loadRequest?: () => Promise<unknown>;
  /** One sentence on where "Build this" got the request, when that needs saying. */
  requestNote?: string;
};

/** Two significant figures, no false precision: $0.000013, $0.0011, $0.04; "$0" for free. */
export function formatCost(usd: number) {
  if (usd === 0) return "$0";

  if (usd >= 0.01) return `$${usd.toFixed(2)}`;

  return `$${Number(usd.toPrecision(2)).toFixed(Math.max(2, 1 - Math.floor(Math.log10(usd))))}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "30 Sep 2026" from an ISO timestamp or date, in UTC, so it reads the same everywhere. */
export function formatDate(at: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(at);

  if (!m) return null;

  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/** The receipt's parts, in reading order. */
export function receiptParts(d: ReceiptData): string[] {
  const parts: string[] = [];

  if (d.ms !== null && d.ms !== undefined && Number.isFinite(d.ms)) parts.push(`${Math.round(d.ms)} ms`);

  if (d.questions) parts.push(`${d.questions.toLocaleString("en-US")} question${d.questions === 1 ? "" : "s"}`);

  const cost =
    d.costUsd !== null && d.costUsd !== undefined
      ? d.costUsd
      : d.inputTokens !== null && d.inputTokens !== undefined
        ? d.inputTokens * USD_PER_INPUT_TOKEN
        : d.mode === "browser"
          ? 0
          : null;

  if (cost !== null && Number.isFinite(cost)) parts.push(formatCost(cost));

  parts.push(MODE_WORDS[d.mode].receipt);

  const date = d.at ? formatDate(d.at) : null;

  if (date) parts.push(date);

  if (d.servedBy) parts.push(d.servedBy);
  else if (d.model) parts.push(d.model);

  return parts;
}

/** A receipt from a live /api/evaluate response body (and the request that produced it). */
export function fromLive(body: unknown, request?: unknown): ReceiptData {
  const b = (body ?? {}) as {
    latency_ms?: number;
    usage?: { input_tokens?: number } | null;
    served_by?: string | null;
    answers?: Record<string, unknown>;
  };

  return {
    mode: "live",
    ms: b.latency_ms ?? null,
    questions: b.answers ? Object.keys(b.answers).length : null,
    inputTokens: b.usage?.input_tokens ?? null,
    at: new Date().toISOString(),
    servedBy: b.served_by ?? null,
    raw: { request: request ?? requestFor(body), response: body },
  };
}

/**
 * One receipt for a live run made of several requests (a scene that asks in batches): time,
 * questions and tokens summed, host from the first response. Missing fields stay missing.
 */
export function fromLiveBatches(bodies: unknown[], request?: unknown): ReceiptData {
  const sent = bodies.map(requestFor);

  const one = bodies.map((b) => fromLive(b));
  const sum = (pick: (r: ReceiptData) => number | null | undefined) => {
    const xs = one.map(pick).filter((x): x is number => typeof x === "number" && Number.isFinite(x));

    return xs.length ? xs.reduce((a, b) => a + b, 0) : null;
  };

  return {
    mode: "live",
    ms: sum((r) => r.ms),
    questions: sum((r) => r.questions),
    inputTokens: sum((r) => r.inputTokens),
    at: new Date().toISOString(),
    servedBy: one.find((r) => r.servedBy)?.servedBy ?? null,
    raw: {
      request: request ?? (sent.some(Boolean) ? (sent.length === 1 ? sent[0] : sent) : undefined),
      response: bodies.length === 1 ? bodies[0] : bodies,
    },
  };
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/**
 * A receipt from one recorded response or row, whatever the scene's record calls its fields:
 * `latency_ms`/`latencyMs`, `cost_usd`/`costUsd`, `usage.input_tokens`, `served_by`/`servedBy`,
 * `at`/`recorded_at`, and the question count from `question_count`, `batchQuestions`,
 * `batch_size` or the number of `answers`. Anything the object lacks stays out. `extra`
 * supplies what lives elsewhere in the record (usually the run's date) or overrides.
 */
export function fromRecorded(obj: unknown, extra: Partial<ReceiptData> = {}): ReceiptData {
  const o = (obj && typeof obj === "object" ? obj : {}) as Record<string, unknown>;
  const usage = (o.usage && typeof o.usage === "object" ? o.usage : {}) as Record<string, unknown>;
  const answers = o.answers && typeof o.answers === "object" && !Array.isArray(o.answers) ? Object.keys(o.answers).length : null;

  return {
    mode: "recorded",
    ms: num(o.latency_ms) ?? num(o.latencyMs),
    questions: num(o.question_count) ?? num(o.batchQuestions) ?? num(o.batch_size) ?? answers,
    inputTokens: num(usage.input_tokens),
    // A Jev call is never free: early recordings logged 0 because the gateway didn't report cost
    // yet, so a recorded 0 means unknown, not $0.
    costUsd: num(o.cost_usd) || num(o.costUsd) || null,
    at: str(o.at) ?? str(o.recorded_at),
    servedBy: str(o.served_by) ?? str(o.servedBy),
    // A record that kept its typed request shows it (and "Build this") without the scene asking.
    raw: { ...(asJevRequest(o.request) ? { request: o.request } : {}), response: obj },
    ...extra,
  };
}

/**
 * The date of the record a scene is showing (its manifest's start). A recorded receipt whose row
 * has no timestamp of its own shows this instead, so scenes don't have to thread it through.
 */
export const RecordDate = createContext<string | null>(null);

// Scenes say for themselves whether an answer is recorded or live (fromRecorded or fromLive):
// a recorded response often carries `source: "live"` because it was live when it was captured.

export function Receipt({ data, label, className = "" }: { data: ReceiptData; label?: string; className?: string }) {
  const recordDate = useContext(RecordDate);
  const parts = receiptParts(data.mode === "recorded" && !data.at && recordDate ? { ...data, at: recordDate } : data);

  return (
    <div className={`receipt ${className}`.trim()}>
      <span className="receipt-line">
        {label && <span className="receipt-label">{label}: </span>}
        {parts.join(" · ")}
      </span>
      {data.raw && (data.raw.request !== undefined || data.raw.response !== undefined) && (
        <details className="receipt-raw">
          <summary>raw JSON</summary>
          {data.raw.note && <p className="receipt-note">{data.raw.note}</p>}
          <pre>{JSON.stringify({ request: data.raw.request, response: data.raw.response }, null, 2)}</pre>
        </details>
      )}
      {(data.raw?.request !== undefined || data.loadRequest) && data.mode !== "browser" && (
        <BuildThis request={data.raw?.request} load={data.loadRequest} response={data.raw?.response} study={data.study} rebuilt={data.rebuilt} note={data.requestNote} />
      )}
    </div>
  );
}
