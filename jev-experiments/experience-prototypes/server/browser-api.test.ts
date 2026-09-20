import { test, expect } from "bun:test";
import { readResponse, getApiKey, setApiKey } from "../src/api";
test("HTML hosting failures produce an actionable message instead of a JSON parser error", async () => {
  await expect(readResponse(new Response("<html>checkpoint</html>", { status: 403, headers: { "Content-Type": "text/html", "x-vercel-mitigated": "challenge" } }))).rejects.toThrow("Reload the page");
  await expect(readResponse(new Response("<html>unavailable</html>", { status: 503, headers: { "Content-Type": "text/html" } }))).rejects.toThrow("Your input is preserved");
  expect(await readResponse(Response.json({ error: "Invalid API key" }, { status: 401 }))).toEqual({ error: "Invalid API key" });
});
test("disconnect forgets the in-memory key", () => {
  setApiKey("  synthetic-key  "); expect(getApiKey()).toBe("synthetic-key");
  setApiKey(""); expect(getApiKey()).toBe("");
});
