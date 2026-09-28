import {
  countsFor,
  TallyError,
  upstash,
  vote,
  voteSchema,
  type Store,
} from "../../packages/arena/src/decide/tally.js";

/** Vercel's Upstash integration sets KV_REST_API_*; a plain Upstash database sets UPSTASH_*. */
function storeFromEnv(): Store | null {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;

  return url && token ? upstash(url, token) : null;
}

const first = (v: unknown) => String(Array.isArray(v) ? v[0] : (v ?? ""));

export async function tallyHandler(req: any, res: any, store: Store | null, salt: string) {
  res.setHeader("Cache-Control", "no-store");

  if (!store) return res.status(200).json({ available: false });

  try {
    if (req.method === "GET") {
      const id = new URL(req.url ?? "/", "http://x").searchParams.get("id");

      return res.status(200).json({ available: true, counts: await countsFor(store, id ?? "") });
    }

    if (req.method !== "POST") return res.status(405).json({ error: "Use GET or POST." });

    const visitor =
      first(req.headers["x-forwarded-for"]).split(",")[0].trim() ||
      first(req.headers["x-real-ip"]) ||
      "unknown";

    const ballot = voteSchema.safeParse(req.body);

    if (!ballot.success) return res.status(400).json({ error: "Send { id, option }." });

    return res
      .status(200)
      .json({ available: true, ...(await vote(store, ballot.data, visitor, salt)) });
  } catch (e) {
    return res
      .status(e instanceof TallyError ? e.status : 503)
      .json({ error: e instanceof TallyError ? e.message : "The tally is unavailable." });
  }
}

export default function handler(req: any, res: any) {
  // The salt keeps the stored hashes from being matched to addresses; the token is secret already.
  const salt =
    process.env.TALLY_SALT ??
    process.env.KV_REST_API_TOKEN ??
    process.env.UPSTASH_REDIS_REST_TOKEN ??
    "";

  return tallyHandler(req, res, storeFromEnv(), salt);
}
