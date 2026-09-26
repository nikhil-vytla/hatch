import evaluateHandler from "../api/evaluate";
import contestHandler from "../api/contest";
import wardrobeTokenHandler from "../api/wardrobe-token";
import { apiKeyFromHeader, GatewayError } from "./gateway";
import { compose } from "./compose";
Bun.serve({
  hostname: "127.0.0.1",
  port: 8793,
  async fetch(req) {
    if (!["POST", "OPTIONS"].includes(req.method))
      return Response.json({ error: "Use POST." }, { status: 405 });
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });
    if (new URL(req.url).pathname === "/api/compose") {
      const apiKey = apiKeyFromHeader(req.headers.get("authorization"));
      if (!apiKey)
        return Response.json(
          { error: "Enter your Vercel AI Gateway API key to run live." },
          { status: 401 },
        );
      const body = await req.json();
      return new Response(
        new ReadableStream({
          async start(c) {
            try {
              for await (const e of compose(body, req.signal, apiKey))
                c.enqueue(new TextEncoder().encode(JSON.stringify(e) + "\n"));
            } catch (e) {
              c.enqueue(
                new TextEncoder().encode(
                  JSON.stringify({
                    type: "error",
                    error:
                      e instanceof GatewayError
                        ? e.message
                        : "Composition interrupted.",
                  }) + "\n",
                ),
              );
            } finally {
              c.close();
            }
          },
        }),
        { headers: { "Content-Type": "application/x-ndjson" } },
      );
    }
    let status = 200,
      result: any;
    const headers: Record<string, string> = {};
    const response = {
      status(n: number) {
        status = n;
        return this;
      },
      json(x: any) {
        result = x;
      },
      setHeader(k: string, v: string) {
        headers[k] = v;
      },
    };
    const path = new URL(req.url).pathname;
    if (!["/api/evaluate", "/api/wardrobe-token", "/api/contest"].includes(path)) return Response.json({ error: "Not found." }, { status: 404 });
    await (path === "/api/wardrobe-token" ? wardrobeTokenHandler : path === "/api/contest" ? contestHandler : evaluateHandler)(
      {
        method: req.method,
        headers: {
          authorization: req.headers.get("authorization"),
          "x-jev-deadline-ms": req.headers.get("x-jev-deadline-ms") ?? undefined,
          "x-jev-max-attempts": req.headers.get("x-jev-max-attempts") ?? undefined,
        },
        body: await req.json().catch(() => null),
        // The browser aborting its request stops the call to Jev too.
        signal: req.signal,
      },
      response,
    );
    return Response.json(result, { status, headers });
  },
});
console.log(
  "Jev API listening on http://127.0.0.1:8793. Live requests use the caller’s API key.",
);
