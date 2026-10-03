import { afterEach, describe, expect, test } from "bun:test";
import { fetchJson } from "./api";

const real = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = real;
});

const respond = (status: number, body: string) => {
  // SAFETY: tests replace fetch with a stub that returns a Response, as fetch does.
  globalThis.fetch = (async () => new Response(body, { status })) as unknown as typeof fetch;
};

describe("fetchJson", () => {
  test("resolves with the parsed body on a 2xx response", async () => {
    respond(200, JSON.stringify({ a: 1 }));
    expect(await fetchJson("/x.json")).toEqual({ a: 1 });
  });

  test("rejects with the status as the message, as the hand-written loaders did", async () => {
    respond(404, "<html>not found</html>");
    await expect(fetchJson("/missing.json")).rejects.toThrow("404");
  });

  test("passes the request options through (e.g. an abort signal)", async () => {
    let seen: RequestInit | undefined;

    // SAFETY: see above.
    globalThis.fetch = (async (_u: string, init?: RequestInit) => {
      seen = init;

      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const signal = new AbortController().signal;

    await fetchJson("/y.json", { signal });
    expect(seen?.signal).toBe(signal);
  });
});
