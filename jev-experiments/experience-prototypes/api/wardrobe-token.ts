import { wardrobeToken, WardrobeTokenError } from "../server/wardrobe-token.js";
import { apiKeyFromHeader } from "../server/gateway.js";
export default async function handler(req: any, res: any) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST")
    return res.status(405).json({ error: "Use POST." });
  try {
    return res
      .status(200)
      .json(
        await wardrobeToken(
          apiKeyFromHeader(req.headers.authorization),
          req.body,
        ),
      );
  } catch (e) {
    return res
      .status(e instanceof WardrobeTokenError ? e.status : 503)
      .json({
        error:
          e instanceof WardrobeTokenError
            ? e.message
            : "Video connection failed. No session was saved.",
      });
  }
}
