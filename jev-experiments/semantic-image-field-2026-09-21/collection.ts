import type { Artwork } from "../visual-search/protocol";

export type CollectionItem = {
  artworkId: number;
  query: string;
  method: "caption" | "metadata" | "lexical";
  score: number | null;
  rank: number | null;
  evidence:
    "recorded" | "live exploratory" | "deterministic lexical" | "not run";
};

export const MAX_COLLECTION = 12;
const VERSION = "jev-artwork-collection-v1";
type ArtworkSnapshot = Pick<
  Artwork,
  | "id"
  | "title"
  | "artist"
  | "sourceUrl"
  | "caption"
  | "imageUrl"
  | "imageMirror"
>;
export type CollectionArtifact = {
  version: typeof VERSION;
  collection_sha256: string | null;
  items: (CollectionItem & { artwork: ArtworkSnapshot })[];
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isScore = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isFinite(value));
const isRank = (value: unknown): value is number | null =>
  value === null ||
  (typeof value === "number" && Number.isSafeInteger(value) && value > 0);

function artworkIndex(works: readonly ArtworkSnapshot[]) {
  const index = new Map<number, ArtworkSnapshot>();
  for (const work of works) {
    if (!Number.isSafeInteger(work.id) || work.id <= 0 || index.has(work.id))
      throw new Error(
        "The current artwork collection has invalid or duplicate IDs. Reload it.",
      );
    index.set(work.id, work);
  }
  return index;
}

/** Imported descriptions and URLs are ignored; only current collection IDs are accepted. */
export function parseCollection(
  json: unknown,
  works: readonly ArtworkSnapshot[],
  expectedHash?: string | null,
): CollectionItem[] {
  if (!isObject(json) || json.version !== VERSION)
    throw new Error(
      "Choose a saved Jev artwork collection with version jev-artwork-collection-v1.",
    );
  const hash = json.collection_sha256;
  if (hash !== null && typeof hash !== "string")
    throw new Error("The collection hash must be text or null.");
  if (hash !== null && expectedHash != null && hash !== expectedHash)
    throw new Error(
      "This file belongs to a different artwork collection. Open a matching collection file.",
    );
  if (!Array.isArray(json.items))
    throw new Error("The collection must contain an items list.");
  if (json.items.length > MAX_COLLECTION)
    throw new Error(
      `A collection can contain at most ${MAX_COLLECTION} artworks.`,
    );

  const known = artworkIndex(works);
  const seen = new Set<number>();
  return Array.from(json.items, (item, position) => {
    const label = `Collection item ${position + 1}`;
    if (!isObject(item)) throw new Error(`${label} must be an object.`);
    const { artworkId, query, method, score, rank, evidence } = item;
    if (
      typeof artworkId !== "number" ||
      !Number.isSafeInteger(artworkId) ||
      artworkId <= 0
    )
      throw new Error(`${label} needs a valid artwork ID.`);
    if (!known.has(artworkId))
      throw new Error(`Artwork ${artworkId} is not in the current collection.`);
    if (seen.has(artworkId))
      throw new Error(
        `Artwork ${artworkId} appears more than once. Keep one copy.`,
      );
    seen.add(artworkId);
    if (typeof query !== "string" || query.length > 800)
      throw new Error(
        `${label} needs a search query of at most 800 characters.`,
      );
    if (method !== "caption" && method !== "metadata" && method !== "lexical")
      throw new Error(`${label} has an unknown ranking method.`);
    if (!isScore(score))
      throw new Error(
        `${label} needs a finite score or null for an unavailable score.`,
      );
    if (!isRank(rank))
      throw new Error(
        `${label} needs a positive whole-number rank or null for an unavailable rank.`,
      );
    if (
      evidence !== "recorded" &&
      evidence !== "live exploratory" &&
      evidence !== "deterministic lexical" &&
      evidence !== "not run"
    )
      throw new Error(`${label} has an unknown evidence type.`);
    if ((method === "lexical") !== (evidence === "deterministic lexical"))
      throw new Error(
        `${label} must use deterministic lexical evidence for keyword matching, and model evidence for Jev rankings.`,
      );
    if ((score === null) !== (rank === null))
      throw new Error(
        `${label} needs both a score and a rank, or null for both when unavailable.`,
      );
    if (evidence === "not run" && (score !== null || rank !== null))
      throw new Error(
        `${label} cannot have a score or rank when Jev has not run. Set both to null.`,
      );
    return { artworkId, query, method, score, rank, evidence };
  });
}

function snapshot(work: ArtworkSnapshot): ArtworkSnapshot {
  const { id, title, artist, sourceUrl, caption, imageUrl, imageMirror } = work;
  if (
    [title, artist, sourceUrl, caption, imageUrl].some(
      (value) => typeof value !== "string",
    )
  )
    throw new Error(
      `Artwork ${id} has incomplete source details. Reload the current collection.`,
    );
  const artwork: ArtworkSnapshot = {
    id,
    title,
    artist,
    sourceUrl,
    caption,
    imageUrl,
  };
  if (imageMirror !== undefined) {
    if (!isObject(imageMirror) || imageMirror.artwork_id !== id)
      throw new Error(
        `Artwork ${id} has invalid image-source details. Reload the current collection.`,
      );
    const {
      artwork_id,
      image_url,
      commons_page,
      license,
      matched_by,
      match_source,
    } = imageMirror;
    if (
      [image_url, commons_page, license, matched_by, match_source].some(
        (value) => typeof value !== "string",
      )
    )
      throw new Error(
        `Artwork ${id} has incomplete image-source details. Reload the current collection.`,
      );
    artwork.imageMirror = {
      artwork_id,
      image_url,
      commons_page,
      license,
      matched_by,
      match_source,
    };
  }
  return artwork;
}

/** Export fresh metadata from the authored collection, never metadata supplied by an import. */
export function createCollection(
  items: readonly CollectionItem[],
  works: readonly ArtworkSnapshot[],
  collectionHash?: string | null,
): CollectionArtifact {
  const collection_sha256 = collectionHash ?? null;
  const validated = parseCollection(
    { version: VERSION, collection_sha256, items },
    works,
  );
  const known = artworkIndex(works);
  return {
    version: VERSION,
    collection_sha256,
    items: validated.map((item) => ({
      ...item,
      artwork: snapshot(known.get(item.artworkId)!),
    })),
  };
}
