import { authorize, evaluate, GatewayError } from "../server/gateway.js";
let inflight = 0;
export default async function handler(req: any, res: any) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST")
    return res.status(405).json({ error: "Use POST." });
  if (!authorize(req.headers.authorization))
    return res
      .status(401)
      .json({
        error:
          "Enter the private lab token to run live. Recorded examples are available without a token.",
      });
  if (inflight >= 6) {
    res.setHeader("Retry-After", "2");
    return res
      .status(429)
      .json({ error: "Queued behind other requests. Try again shortly." });
  }
  inflight++;
  try {
    return res.status(200).json(await evaluate(req.body));
  } catch (e) {
    const error = e as GatewayError;
    if (error.status === 503)
      res.setHeader(
        "Retry-After",
        String(Math.max(3, Math.ceil(error.retryAfterMs / 1000))),
      );
    return res
      .status(error.status || 500)
      .json({
        error: error.message,
        attempts: error.attempts ?? [],
        retry_after_ms: error.retryAfterMs || 0,
      });
  } finally {
    inflight--;
  }
}
