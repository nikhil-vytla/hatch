import { test, expect } from "bun:test";
import { readResponse, getApiKey, setApiKey, run, EvaluationError } from "../src/api";
test("HTML hosting failures produce an actionable message instead of a JSON parser error", async () => {
  await expect(readResponse(new Response("<html>checkpoint</html>", { status: 403, headers: { "Content-Type": "text/html", "x-vercel-mitigated": "challenge" } }))).rejects.toThrow("Reload the page");
  await expect(readResponse(new Response("<html>unavailable</html>", { status: 503, headers: { "Content-Type": "text/html" } }))).rejects.toThrow("Your input is preserved");
  expect(await readResponse(Response.json({ error: "Invalid API key" }, { status: 401 }))).toEqual({ error: "Invalid API key" });
});
test("disconnect forgets the in-memory key", () => {
  setApiKey("  synthetic-key  "); expect(getApiKey()).toBe("synthetic-key");
  setApiKey(""); expect(getApiKey()).toBe("");
});
test("failed evaluations retain sanitized attempts for exported run evidence", async () => {
  const original = globalThis.fetch;
  const body = { error: "Provider temporarily unavailable", attempts: [{ status: 503, latency_ms: 12 }], retryAfterMs: 1000 };
  globalThis.fetch = (async () => Response.json(body, { status: 503 })) as typeof fetch;
  try {
    await run({ scene: "fictional" }, {});
    throw Error("Expected an evaluation failure");
  } catch (error) {
    expect(error).toBeInstanceOf(EvaluationError);
    expect((error as EvaluationError).status).toBe(503);
    expect((error as EvaluationError).response).toEqual(body);
  } finally { globalThis.fetch = original; }
});
