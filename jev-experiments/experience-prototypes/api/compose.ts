import { apiKeyFromHeader, GatewayError } from "../server/gateway.js";
import { compose } from "../server/compose.js";
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
  res.setHeader("Cache-Control", "no-store");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 52000);
  res.on?.("close", () => controller.abort());
  try {
    for await (const event of compose(req.body, controller.signal, apiKey))
      res.write(JSON.stringify(event) + "\n");
  } catch (e) {
    res.write(
      JSON.stringify({
        type: "error",
        error:
          e instanceof GatewayError
            ? e.message
            : "Composition interrupted. Check your input and try again.",
      }) + "\n",
    );
  } finally {
    clearTimeout(timer);
    res.end();
  }
}
