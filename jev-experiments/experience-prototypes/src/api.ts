// Deliberately in memory. Reloading or disconnecting forgets the key.
let apiKey = "";
export const getApiKey = () => apiKey;
export const setApiKey = (value: string) => {
  apiKey = value.trim();
};
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
export async function run(
  state: unknown,
  questions: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const response = await fetch("/api/evaluate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({ state, questions }),
    signal,
  });
  const body = await readResponse(response);
  if (!response.ok)
    throw new EvaluationError(body.error ?? "The run could not complete.", response.status, body);
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
