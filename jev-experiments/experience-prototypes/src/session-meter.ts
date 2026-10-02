/**
 * What this tab has spent on the visitor's key: every request that reached /api/evaluate, the
 * input tokens the gateway reported, and their cost at TypeSafe's list price. It lives in memory
 * and resets on reload, like the key. Recorded answers and in-browser models never count.
 */
import { useSyncExternalStore } from "react";
import { USD_PER_INPUT_TOKEN } from "./receipt";

/** Where the price comes from, shown beside the meter. */
export const LIST_PRICE = {
  label: "$0.042 / 1M input tokens · output free",
  source: "https://docs.typesafe.ai/models",
  checked: "29 Sep 2026",
};

export type SessionUsage = {
  /** Requests that reached the server, answered or not. */
  calls: number;
  /** Requests the server answered with an error. */
  failed: number;
  inputTokens: number;
  costUsd: number;
};

export const EMPTY_USAGE: SessionUsage = { calls: 0, failed: 0, inputTokens: 0, costUsd: 0 };

/** The usage after one more request; `body` is the response body when it succeeded. */
export function addCall(u: SessionUsage, ok: boolean, body?: unknown): SessionUsage {
  const tokens = ok ? Number((body as { usage?: { input_tokens?: number } } | undefined)?.usage?.input_tokens) : NaN;
  const inputTokens = Number.isFinite(tokens) && tokens > 0 ? tokens : 0;

  return {
    calls: u.calls + 1,
    failed: u.failed + (ok ? 0 : 1),
    inputTokens: u.inputTokens + inputTokens,
    costUsd: u.costUsd + inputTokens * USD_PER_INPUT_TOKEN,
  };
}

let usage: SessionUsage = EMPTY_USAGE;
const listeners = new Set<() => void>();

/** Called by api.ts for every /api/evaluate response. */
export function recordCall(ok: boolean, body?: unknown) {
  usage = addCall(usage, ok, body);
  for (const l of listeners) l();
}

export function resetSession() {
  usage = EMPTY_USAGE;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);

  return () => listeners.delete(l);
};

export const useSessionUsage = () => useSyncExternalStore(subscribe, () => usage, () => EMPTY_USAGE);
