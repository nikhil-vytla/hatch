import { BlobPreconditionFailedError, get, put } from "@vercel/blob";
import {
  allCounts,
  countsFor,
  EMPTY,
  TallyError,
  tallyDocSchema,
  vote,
  voteSchema,
  type Store,
} from "../../packages/arena/src/decide/tally.js";

/**
 * The tally in a private Vercel Blob store, one JSON document per decision. Functions reach
 * the store through the project's OIDC token and BLOB_STORE_ID, so no secret is configured.
 */
function blobStore(): Store {
  const path = (decision: string) => `decide/tally/${decision}.json`;

  return {
    read: async (decision) => {
      const r = await get(path(decision), { access: "private", useCache: false }).catch(() => null);

      if (!r || r.statusCode !== 200 || !r.stream) return { doc: EMPTY, version: null };

      const doc = tallyDocSchema.safeParse(await new Response(r.stream).json());

      return { doc: doc.success ? doc.data : EMPTY, version: r.blob.etag };
    },
    write: async (decision, doc, version) => {
      try {
        await put(path(decision), JSON.stringify(doc), {
          access: "private",
          addRandomSuffix: false,
          contentType: "application/json",
          ...(version ? { allowOverwrite: true, ifMatch: version } : { allowOverwrite: false }),
        });

        return true;
      } catch (e) {
        // Someone wrote first (a changed ETag, or a document created meanwhile): read again.
        if (e instanceof BlobPreconditionFailedError || /already exists/i.test(String(e)))
          return false;
        throw e;
      }
    },
  };
}

const configured = () => Boolean(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN);

const first = (v: unknown) => String(Array.isArray(v) ? v[0] : (v ?? ""));

export async function tallyHandler(req: any, res: any, store: Store | null, salt: string) {
  res.setHeader("Cache-Control", "no-store");

  if (!store) return res.status(200).json({ available: false });

  try {
    if (req.method === "GET") {
      const params = new URL(req.url ?? "/", "http://x").searchParams;

      if (params.has("all")) {
        // The results page reads every decision; the CDN keeps it a minute so views don't each cost 20 reads.
        res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");

        return res.status(200).json({ available: true, tallies: await allCounts(store) });
      }

      const id = params.get("id") ?? "";

      return res.status(200).json({ available: true, counts: await countsFor(store, id) });
    }

    if (req.method !== "POST") return res.status(405).json({ error: "Use GET or POST." });

    const ballot = voteSchema.safeParse(req.body);

    if (!ballot.success) return res.status(400).json({ error: "Send { id, option }." });

    const visitor =
      first(req.headers["x-forwarded-for"]).split(",")[0].trim() ||
      first(req.headers["x-real-ip"]) ||
      "unknown";

    return res
      .status(200)
      .json({ available: true, ...(await vote(store, ballot.data, visitor, salt)) });
  } catch (e) {
    console.error("tally", e instanceof Error ? e.message : e);

    return res
      .status(e instanceof TallyError ? e.status : 503)
      .json({ error: e instanceof TallyError ? e.message : "The tally is unavailable." });
  }
}

export default function handler(req: any, res: any) {
  // The salt keeps stored hashes from being matched to addresses by anyone without it.
  const salt = process.env.TALLY_SALT ?? process.env.BLOB_STORE_ID ?? "";

  return tallyHandler(req, res, configured() ? blobStore() : null, salt);
}
