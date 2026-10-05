import { apiKeyFromHeader } from "../../packages/jev-client/src/index.js";
import { composeLines } from "../server/compose.js";
export default async function handler(req: any, res: any) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST")
    return res.status(405).json({ error: "Use POST." });
  const apiKey = apiKeyFromHeader(req.headers.authorization);
  if (!apiKey)
    return res
      .status(401)
      .json({ error: "Enter your Vercel AI Gateway API key to run live." });
  res.setHeader("Content-Type", "application/x-ndjson");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 52000);
  res.on?.("close", () => controller.abort());
  try {
    // The framing (events, a line per Jev call, the closing error line) is shared with server/dev.ts.
    for await (const line of composeLines(req.body, controller.signal, apiKey)) res.write(line);
  } finally {
    clearTimeout(timer);
    res.end();
  }
}
