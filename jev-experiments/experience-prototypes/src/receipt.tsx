/**
 * The result receipt: one quiet line under a Jev answer saying how long it took, how many
 * questions it was, what it cost, whether it was recorded or live, when, and who served it,
 * with the exact request and response one click away. Every field is optional and is left out
 * when the record doesn't have it; nothing here is estimated or invented.
 */
import "./receipt.css";

/** TypeSafe's list price for Jev: $0.042 per million input tokens, output free. */
export const USD_PER_INPUT_TOKEN = 0.042 / 1e6;

/** "recorded" replays a saved answer, "live" was just asked with the visitor's key, "browser" ran on this device. */
export type ReceiptMode = "recorded" | "live" | "browser";

export type ReceiptData = {
  mode: ReceiptMode;
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

const MODE_LABEL: Record<ReceiptMode, string> = { recorded: "recorded", live: "live", browser: "in your browser" };

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

  parts.push(MODE_LABEL[d.mode]);

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
    raw: { request, response: body },
  };
}

export function Receipt({ data, label, className = "" }: { data: ReceiptData; label?: string; className?: string }) {
  const parts = receiptParts(data);

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
    </div>
  );
}
