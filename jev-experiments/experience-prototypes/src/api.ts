import { useSyncExternalStore } from "react";

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
/** What a request without a key is rejected with; live-ask.ts turns it into the shared no-key failure. */
export const NO_KEY_MESSAGE =
  "Connect your AI Gateway key in Settings to run Jev live. Recorded examples work without one, and live runs are billed to your key.";

/** Throws the shared no-key error; call before any request that needs the visitor's key. */
export function requireKey() {
  if (!getApiKey()) throw new EvaluationError(NO_KEY_MESSAGE, 401, { error: NO_KEY_MESSAGE });
}

/**
 * The request each live response answered, keyed by the response body, so a receipt (and its
 * "Build this" code) can show exactly what was sent without every scene threading it through.
 */
const sentRequests = new WeakMap<object, { state: unknown; questions: Record<string, unknown> }>();
export const requestFor = (body: unknown) => (body && typeof body === "object" ? sentRequests.get(body) : undefined);
/** Called by live-ask.ts for every answered request. */
export const rememberRequest = (body: unknown, request: { state: unknown; questions: Record<string, unknown> }) => {
  if (body && typeof body === "object") sentRequests.set(body, request);
};

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
/** Fetches a JSON file; a non-2xx response rejects with its status as the message. */
export const fetchJson = <T = any>(url: string, init?: RequestInit): Promise<T> =>
  fetch(url, init).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))));
export function pretty(s: unknown) {
  return String(s ?? "").replaceAll("_", " ");
}
/** A share as a whole percent: 0.473 → "47%". */
export const percent = (n: number) => `${Math.round(n * 100)}%`;
/** A share as a percent to one decimal: 0.4734 → "47.3%". */
export const percent1 = (n: number) => `${(n * 100).toFixed(1)}%`;
