/**
 * Collects the archive from the Cleveland Museum of Art Open Access API (CC0 data and images):
 * the first 18 CC0 works with an image and a curatorial description for each of 12 topics,
 * deduplicated by artwork ID. Raw responses are hashed; nothing here calls a model.
 *
 *   bun visual-search/prepare.ts
 */
import { writeRecord } from "../experience-prototypes/scripts/records";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const topics = ["landscape", "flowers", "boats", "birds", "night", "mountains", "garden", "architecture", "still life", "geometric", "waves", "winter"];
const api = "https://openaccess-api.clevelandart.org/api/artworks/";
const perTopic = 18;

/** Curatorial text arrives with occasional HTML; the model and the page get plain text. */
const plain = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const works = new Map<number, any>();
const sources: any[] = [];

for (const topic of topics) {
  const url = api + "?" + new URLSearchParams({ q: topic, cc0: "1", has_image: "1", limit: "60" });
  const response = await fetch(url, { headers: { "User-Agent": "JevExperimentsResearch/1.0 (CC0 visual search)" } });

  if (!response.ok) throw Error(`Museum response ${response.status}`);

  const data: any = await response.json();
  let taken = 0;

  for (const w of data.data) {
    if (taken >= perTopic) break;

    const description = w.description ? plain(w.description) : "";
    const imageUrl = w.images?.web?.url;

    if (w.share_license_status !== "CC0" || !imageUrl || !description) continue;

    const text = [w.title, description].join(" ");

    if (/\b(nude|naked|nudity|behead|crucifix|corpse|slaughter|rape|sexual)\b/i.test(text)) continue;

    taken++;

    if (works.has(w.id)) {
      works.get(w.id).collectedThrough.push(topic);
      continue;
    }

    const didYouKnow = w.did_you_know ? plain(w.did_you_know) : "";

    works.set(w.id, {
      id: w.id,
      title: w.title,
      artist: (w.creators ?? []).map((c: any) => c.description).filter(Boolean).join("; ") || "Artist not identified",
      date: w.creation_date ?? "",
      imageId: w.accession_number,
      imageUrl,
      sourceUrl: w.url,
      apiUrl: `${api}${w.id}`,
      caption: didYouKnow ? `${description} Did you know? ${didYouKnow}` : description,
      captionSource: didYouKnow ? "description + did you know" : "description",
      medium: w.technique ?? "",
      classification: w.type ?? "",
      styles: [],
      subjects: [],
      origin: (w.culture ?? []).join(", "),
      isPublicDomain: true,
      license: "CC0",
      collectedThrough: [topic],
    });
  }

  sources.push({ topic, url, returned: data.data.length, taken, sha256: createHash("sha256").update(JSON.stringify(data.data)).digest("hex") });
  console.log(`${topic}: ${data.data.length} returned, ${taken} taken; ${works.size} unique works`);
  await Bun.sleep(1100);
}

const document = {
  manifest: { experiment: "visual-search-collection", created: new Date().toISOString() },
  result: {
    institution: "Cleveland Museum of Art",
    documentation: "https://openaccess-api.clevelandart.org/",
    license: "CC0 (data and images)",
    method:
      "First 18 CC0 works with an image and a curatorial description for each of 12 declared topics; deduplicated by artwork ID. Captions are the museum's curatorial description, plus its 'Did you know?' note when present. Lexical content screen is limited, not exhaustive.",
    sources,
    works: [...works.values()],
  },
};

writeRecord(resolve(import.meta.dir, "collection.jsonl"), document);
console.log(`Saved ${works.size} CC0 artworks with curatorial descriptions.`);
