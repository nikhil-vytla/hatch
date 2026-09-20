import { FAL_MODEL } from "../../wardrobe-lab/engine";
export class WardrobeTokenError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function wardrobeToken(
  apiKey: string,
  body: unknown,
  fetcher: typeof fetch = fetch,
) {
  if (!apiKey || apiKey.length > 8192 || !/^[!-~]+$/.test(apiKey))
    throw new WardrobeTokenError(
      "Enter your own fal API key to connect video.",
      401,
    );
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((k) => k !== "model") ||
    (body as any).model !== FAL_MODEL
  )
    throw new WardrobeTokenError(
      "This endpoint only connects the wardrobe try-on model.",
      400,
    );
  // The live endpoint requires `app`; its published guide currently shows
  // `allowed_apps`, which returns HTTP 422. Verified against the live service.
  const response = await fetcher("https://rest.fal.ai/tokens/realtime", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Key ${apiKey}`,
    },
    body: JSON.stringify({ app: FAL_MODEL, token_expiration: 70 }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new WardrobeTokenError(
      response.status === 401 || response.status === 403
        ? "fal rejected this key. Check its permissions and account credits."
        : "fal could not start a video session. Try again shortly.",
      response.status === 401 || response.status === 403 ? 401 : 503,
    );
  const data = await response.json();
  const token = typeof data === "string" ? data : data.token;
  if (typeof token !== "string" || !token || token.length > 16000)
    throw new WardrobeTokenError("fal returned an invalid session token.", 502);
  return { token, expiresIn: 70, model: FAL_MODEL };
}
