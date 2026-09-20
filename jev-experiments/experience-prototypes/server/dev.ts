import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import evaluateHandler from "../api/evaluate";
import { authorize } from "./gateway";
import { compose } from "./compose";
if (!process.env.AI_GATEWAY_API_KEY) {
  const line = readFileSync(homedir() + "/.zshrc", "utf8")
    .split("\n")
    .find((l) => /^\s*(export\s+)?AI_GATEWAY_API_KEY\s*=/.test(l));
  if (line) {
    const v = line
      .replace(/^\s*(export\s+)?AI_GATEWAY_API_KEY\s*=\s*/, "")
      .trim()
      .replace(/^['"]|['"]$/g, "");
    if (!/[$`;]/.test(v)) process.env.AI_GATEWAY_API_KEY = v;
  }
}
if (!process.env.LAB_ACCESS_TOKEN && existsSync("../.cache/live-access-token"))
  process.env.LAB_ACCESS_TOKEN = readFileSync(
    "../.cache/live-access-token",
    "utf8",
  ).trim();
Bun.serve({
  port: 8793,
  async fetch(req) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });
    if (new URL(req.url).pathname === "/api/compose") {
      if (!authorize(req.headers.get("authorization") ?? undefined))
        return Response.json(
          { error: "Enter the private lab token." },
          { status: 401 },
        );
      const body = await req.json();
      return new Response(
        new ReadableStream({
          async start(c) {
            try {
              for await (const e of compose(body, req.signal))
                c.enqueue(new TextEncoder().encode(JSON.stringify(e) + "\n"));
            } catch (e) {
              c.enqueue(
                new TextEncoder().encode(
                  JSON.stringify({ type: "error", error: String(e) }) + "\n",
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
    await evaluateHandler(
      {
        method: req.method,
        headers: { authorization: req.headers.get("authorization") },
        body: await req.json().catch(() => null),
      },
      response,
    );
    return Response.json(result, { status, headers });
  },
});
console.log(
  "Jev API listening on http://127.0.0.1:8793. Credentials loaded privately.",
);
