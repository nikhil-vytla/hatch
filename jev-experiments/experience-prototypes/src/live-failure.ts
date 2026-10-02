/**
 * What went wrong with a live Jev call, in plain words, and what to do next. These messages say
 * only what happened; what is still on screen depends on the scene, so each scene states that
 * itself (LiveFailure's `fallback`). Every live control
 * shows failures through this, so a missing key, a rejected key, a rate limit, a spent budget
 * and a dropped connection each read the same way everywhere.
 */

export type FailureKind = "no-key" | "bad-key" | "rate-limited" | "budget" | "unavailable" | "offline" | "cancelled" | "error";

export type Failure = {
  kind: FailureKind;
  title: string;
  message: string;
  /** When retrying makes sense, how long to wait first. */
  retryAfterMs?: number;
  /** Whether trying again, unchanged, could work. */
  retryable: boolean;
};

/** The shape api.ts throws; kept structural so this file has no imports. */
type Thrown = { name?: string; message?: string; status?: number; response?: unknown };

const TEXT: Record<FailureKind, { title: string; message: string; retryable: boolean }> = {
  "no-key": { title: "No key connected.", message: "Add your gateway key in Settings to ask Jev live.", retryable: false },
  "bad-key": { title: "Your key was rejected.", message: "Check it in Settings, or replace it.", retryable: false },
  "rate-limited": { title: "Jev is busy (rate limited).", message: "Try again in a moment.", retryable: true },
  budget: { title: "Your gateway budget ran out.", message: "Add credit or raise the limit in Vercel AI Gateway, then try again.", retryable: false },
  unavailable: { title: "Jev didn't answer.", message: "It's unavailable right now; try again shortly.", retryable: true },
  offline: { title: "Can't reach Jev.", message: "Check your connection.", retryable: true },
  cancelled: { title: "Cancelled.", message: "", retryable: true },
  error: { title: "That run didn't complete.", message: "", retryable: true },
};

const BUDGET = /budget|credit|quota|insufficient|payment|spend limit|billing/i;

/** The retry delay a response asked for, in ms, if any. */
function retryAfter(response: unknown): number | undefined {
  const ms = Number((response as { retry_after_ms?: unknown } | null)?.retry_after_ms);

  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

export function describeFailure(e: unknown, noKeyMessage?: string): Failure {
  const t = (e ?? {}) as Thrown;
  const status = typeof t.status === "number" ? t.status : undefined;
  const message = typeof t.message === "string" ? t.message : String(e ?? "");
  const make = (kind: FailureKind, extra: Partial<Failure> = {}): Failure => ({ kind, ...TEXT[kind], ...extra });

  if (t.name === "AbortError") return make("cancelled");

  if (status === 401 && noKeyMessage && message === noKeyMessage) return make("no-key");

  if (status === 401 || status === 403) return make("bad-key");

  if (status === 402 || BUDGET.test(message)) return make("budget");

  if (status === 429) return make("rate-limited", { retryAfterMs: retryAfter(t.response) ?? 8000 });

  if (status === 0 || t.name === "TypeError") return make("offline");

  if (status !== undefined && status >= 500) return make("unavailable", { retryAfterMs: retryAfter(t.response) });

  return make("error", { message: message && message !== "[object Object]" ? message : TEXT.error.message });
}

/** One line for places with room for only a sentence. */
export const failureLine = (f: Failure) => (f.message ? `${f.title} ${f.message}` : f.title);
