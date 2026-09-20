export const token = () =>
  sessionStorage.getItem("jev-live-token") ??
  sessionStorage.getItem("lab-token") ??
  "";
export async function run(
  state: unknown,
  questions: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const response = await fetch("/api/evaluate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token()}`,
    },
    body: JSON.stringify({ state, questions }),
    signal,
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(body.error ?? "The run could not complete.");
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
