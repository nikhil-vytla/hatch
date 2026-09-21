import { metadata, type Artwork, type SearchScores } from "./protocol";
const stop = new Set("a an the and or of to in on with for from at by is are be as very its it this that into against some scene view sense image artwork small".split(" "));
export function tokens(text: string) { return [...new Set(text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].map(t => t.length > 4 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t).filter(t => !stop.has(t)); }
export function lexicalScores(works: Artwork[], query: string): SearchScores {
  const terms = [...new Set(tokens(query))];
  return Object.fromEntries(works.map(work => {
    const fields: [string, number][] = [[work.title, 3], [work.subjects.join(" "), 2], [work.styles.join(" "), 2], [work.caption, 1], [work.artist, 1], [work.origin, 1], [work.classification, .5], [work.medium, .5]];
    const score = terms.reduce((total, term) => total + fields.reduce((n, [text, weight]) => n + (tokens(text).includes(term) ? weight : 0), 0), 0);
    return [work.id, score];
  }));
}
export type RankedArtwork = { work: Artwork; score: number | null; rank: number | null; position: number; tied: number; missing: boolean };
export function rankWorks(works: Artwork[], scores: SearchScores): RankedArtwork[] {
  if (new Set(works.map(w => w.id)).size !== works.length) throw new Error("Duplicate artwork IDs in the collection.");
  const ranked = works.map(work => { const value = scores[work.id]; return { work, score: typeof value === "number" && Number.isFinite(value) ? value : null }; }).sort((a, b) => a.score == null ? b.score == null ? a.work.id - b.work.id : 1 : b.score == null ? -1 : b.score - a.score || a.work.id - b.work.id);
  const counts = new Map<number, number>(); for (const row of ranked) if (row.score != null) counts.set(row.score, (counts.get(row.score) ?? 0) + 1);
  let last: number | null = null, rank = 0;
  return ranked.map((row, index) => { if (row.score != null && (index === 0 || row.score !== last)) rank = index + 1; last = row.score; return { ...row, position: index + 1, rank: row.score == null ? null : rank, tied: row.score == null ? 0 : counts.get(row.score)!, missing: row.score == null }; });
}
export function compareRankings(left: RankedArtwork[], right: RankedArtwork[], k = 12) {
  const complete = left.length === right.length && left.every(r => !r.missing) && right.every(r => !r.missing);
  const topLeft = left.filter(r => !r.missing).slice(0, k), topRight = right.filter(r => !r.missing).slice(0, k), ids = new Set(topLeft.map(r => r.work.id));
  const matched = topRight.filter(r => ids.has(r.work.id)).length;
  return { complete, k, shared: complete ? matched : null, left_boundary_ties: topLeft.at(-1)?.tied ?? 0, right_boundary_ties: topRight.at(-1)?.tied ?? 0, note: "Agreement only, not retrieval quality. Equal scores share a rank; artwork ID resolves display order and top-k cutoff ties." };
}
export function captionQuality(work: Artwork) { return /^A work made of\b/i.test(work.caption) ? "Material description" : "Descriptive museum caption"; }
export function mediumFamily(work: Artwork) { const text = `${work.classification} ${work.medium}`.toLowerCase(); if (/painting|oil on|tempera/.test(text)) return "Paintings"; if (/print|woodblock|lithograph|etching|engraving/.test(text)) return "Prints"; if (/drawing|watercolor|ink|chalk|pencil/.test(text)) return "Drawings"; if (/photograph/.test(text)) return "Photographs"; return "Objects"; }
export function searchableText(work: Artwork) { return JSON.stringify({ ...metadata(work), caption: work.caption }); }
