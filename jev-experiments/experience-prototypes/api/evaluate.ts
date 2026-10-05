import { apiKeyFromHeader, evaluate, GatewayError } from "../../packages/jev-client/src/index.js";
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
    // Real-time callers ask for a short budget: a late answer is useless, so fail fast and re-ask.
    const header = (name: string) => Number(Array.isArray(req.headers[name]) ? req.headers[name][0] : req.headers[name]);
    const deadlineMs = header("x-jev-deadline-ms"), maxAttempts = header("x-jev-max-attempts");
    // A caller that goes away (a keystroke superseding its request) stops the call to Jev.
    const gone = new AbortController();
    if (req.signal instanceof AbortSignal) req.signal.addEventListener("abort", () => gone.abort(), { once: true });
    res.on?.("close", () => {
      if (!res.writableFinished) gone.abort();
    });
    return res.status(200).json(await evaluate(req.body, {
      apiKey,
      signal: gone.signal,
      ...(Number.isFinite(deadlineMs) ? { deadlineMs: Math.max(1000, Math.min(48000, Math.round(deadlineMs))) } : {}),
      ...(Number.isInteger(maxAttempts) ? { maxAttempts: Math.max(1, Math.min(6, maxAttempts)) } : {}),
    }));
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
