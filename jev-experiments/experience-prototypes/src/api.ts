import { useSyncExternalStore } from "react";
import { describeFailure, failureLine } from "./live-failure";
import { recordCall } from "./session-meter";

// Deliberately in memory. Reloading or disconnecting forgets the key.
let apiKey = "";
const keyListeners = new Set<() => void>();
export const getApiKey = () => apiKey;
export const setApiKey = (value: string) => {
  apiKey = value.trim();
  for (const l of keyListeners) l();
};
/** Whether a key is connected, re-rendering when it's added or removed. */
export const useHasKey = () =>
  useSyncExternalStore(
    (l) => {
      keyListeners.add(l);
      return () => keyListeners.delete(l);
    },
    () => apiKey !== "",
    () => false,
  );
if (typeof sessionStorage !== "undefined") {
  sessionStorage.removeItem("jev-live-token");
  sessionStorage.removeItem("lab-token");
}
export async function readResponse(response: Response) {
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new Error(
      response.headers.get("x-vercel-mitigated") === "challenge"
        ? "The site's security check interrupted this request. Reload the page and try again."
        : "The server could not complete this request. Your input is preserved; try again shortly.",
    );
  return response.json();
}
export class EvaluationError extends Error {
  constructor(message: string, public status: number, public response: unknown) {
    super(message);
    this.name = "EvaluationError";
  }
}
/** What every live control says when no key is connected, before any request is sent. */
export const NO_KEY_MESSAGE =
  "Connect your AI Gateway key in Settings to run Jev live. Recorded examples work without one, and live runs are billed to your key.";

/** Throws the shared no-key error; call before any request that needs the visitor's key. */
export function requireKey() {
  if (!getApiKey()) throw new EvaluationError(NO_KEY_MESSAGE, 401, { error: NO_KEY_MESSAGE });
}

export async function run(
  state: unknown,
  questions: Record<string, unknown>,
  signal?: AbortSignal,
  /** Real-time callers set a short budget so a slow request fails fast instead of retrying for up to 48 s. */
  budget?: { deadlineMs: number; maxAttempts: number },
) {
  requireKey();
  let response: Response;
  try {
    response = await fetch("/api/evaluate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getApiKey()}`,
        ...(budget ? { "x-jev-deadline-ms": String(budget.deadlineMs), "x-jev-max-attempts": String(budget.maxAttempts) } : {}),
      },
      body: JSON.stringify({ state, questions }),
      signal,
    });
  } catch (e) {
    // A cancelled request stays an AbortError; anything else never reached the server.
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new EvaluationError(failureLine(describeFailure(new TypeError(String(e)))), 0, null);
  }
  // The request reached the server, so it counts on the session meter whatever came back.
  let body;
  try {
    body = await readResponse(response);
  } catch (e) {
    recordCall(false);
    throw new EvaluationError(e instanceof Error ? e.message : String(e), response.status, null);
  }
  recordCall(response.ok, body);
  if (!response.ok) {
    const failed = new EvaluationError(body.error ?? "The run could not complete.", response.status, body);
    const f = describeFailure(failed, NO_KEY_MESSAGE);
    // Known states read the same everywhere; anything else keeps the server's own words.
    failed.message = f.kind === "error" ? failed.message : failureLine(f);
    throw failed;
  }
  return body;
}
export const choice = (
  instructions: string,
  options: string[] | Record<string, string>,
) => ({
  type: "choice",
  instructions,
  criteria: Array.isArray(options)
    ? Object.fromEntries(options.map((s) => [s, s.replaceAll("_", " ")]))
    : options,
});
export const judge = (instructions: string) => ({ type: "noul", instructions });
export function download(
  name: string,
  value: unknown,
  type = "application/json",
) {
  const blob = new Blob(
    [typeof value === "string" ? value : JSON.stringify(value, null, 2)],
    { type },
  );
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function pretty(s: unknown) {
  return String(s ?? "").replaceAll("_", " ");
}
export const percent = (n: number) => `${Math.round(n * 100)}%`;
