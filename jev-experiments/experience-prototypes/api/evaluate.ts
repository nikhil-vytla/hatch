import { apiKeyFromHeader, evaluate, GatewayError } from "../server/gateway.js";
export default async function handler(req: any, res: any) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST")
    return res.status(405).json({ error: "Use POST." });
  const apiKey = apiKeyFromHeader(req.headers.authorization);
  if (!apiKey)
    return res.status(401).json({
      error:
        "Enter your Vercel AI Gateway API key to run live. Recorded examples are available without a key.",
    });
  try {
    return res.status(200).json(await evaluate(req.body, { apiKey }));
  } catch (e) {
    const error = e as GatewayError;
    if (error.status === 503)
      res.setHeader(
        "Retry-After",
        String(Math.max(3, Math.ceil(error.retryAfterMs / 1000))),
      );
    return res.status(error.status || 500).json({
      error:
        e instanceof GatewayError
          ? error.message
          : "The request could not complete.",
      attempts: error.attempts ?? [],
      retry_after_ms: error.retryAfterMs || 0,
    });
  }
}
