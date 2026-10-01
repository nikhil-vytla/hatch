import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readRecord } from "../experience-prototypes/scripts/records";
const here = import.meta.dir, { result: r } = readRecord(resolve(here, "results.jsonl")), done = r.availability.completed === r.availability.planned;
const n = r.works.length, scores = r.availability.planned.toLocaleString();
const text = `# Visual search through an open museum collection

The explorer searches ${n} CC0 artworks from the [Cleveland Museum of Art](https://www.clevelandart.org/art/collection/search). It presents full images, the museum's curatorial descriptions and provenance, then compares Jev ranking with metadata alone, Jev ranking with metadata plus the museum caption, and a deterministic keyword baseline. All methods rank the same complete collection. ${done ? `All ${r.availability.completed.toLocaleString()} planned Jev relevance scores are recorded.` : `Recording is incomplete: ${r.availability.completed.toLocaleString()}/${scores} planned Jev scores. The keyword baseline already covers all ${n} works, while missing Jev scores remain explicit.`}

**Moved on 1 Oct 2026.** Until then the archive used 204 public-domain works from the Art Institute of Chicago. That museum's IIIF image server began answering visitors' browsers with a Cloudflare challenge ([upstream issue](https://github.com/art-institute-of-chicago/api-data/issues/9)), and 103 of the 204 works had no Wikimedia copy, so about half the gallery showed "Image preview unavailable". Cleveland publishes data and images under CC0 on a CDN that loads without a challenge. The collection was rebuilt and every Jev score re-recorded; the Art Institute run, its Wikimedia image sidecar and its notes remain in the repository history.

## Collection and evidence

\`prepare.ts\` collected the first 18 CC0 works with an image and a curatorial description for each of twelve topics through the [Open Access API](https://openaccess-api.clevelandart.org/), then deduplicated by artwork ID. The archive contains ${n} unique works, full metadata, museum links, accession numbers, image URLs, captions, query URLs and response hashes. It is a declared sample, not the museum's full collection.

Captions are the museum's curatorial \`description\`, with its "Did you know?" note appended for ${r.caption_counts.with_did_you_know} of the ${n} works; ${r.caption_counts.description_only} have the description alone. Each work records which (\`captionSource\`). Embedded HTML is stripped to plain text. These are written for people, not as alt text or vision descriptions: they discuss history, technique and meaning as well as what is depicted. The Art Institute captions they replace were short alt texts, three quarters of which only named the medium.

The acquisition script applied a limited title and description keyword screen. That is not an exhaustive visual content review. Cleveland's open data has no subject or style tags, so those fields are empty.

## Frozen comparison

Six exploratory requests describe quiet water, night lights, winter space, flowers, restrained geometric patterns, and birds among branches. Every request scores every work in both Jev modes, for 6 × ${n} × 2 = ${scores} independent questions. The precise query list, rubric and hashes are in manifest.json (protocol ${r.protocol.version}). No relevance labels, accuracy, recall or model-superiority claims are made.

Each native question carries one artwork's exact text. Shared state contains only the search query and fixed policy. Metadata mode includes title, artist, date, medium (technique), classification (type), style tags, subject tags and origin (culture). Caption mode adds exactly one museum_caption field. Both exclude image pixels, image URLs and the collection acquisition topic labels. Jev grades support for the entire requested scene on a fixed 0–4 relevance rubric and is instructed to treat missing visual detail as uncertainty. Its returned fractional score is preserved. Artist and title metadata may still trigger learned associations; this is a textual retrieval comparison, not a direct vision evaluation.

Native batches use at most 32 questions and 44,000 serialized bytes. Every request payload and hash, attempt, accepted response and normalized score remains in events.jsonl. Completed answers are not rerun when resuming. The recording made ${r.availability.batches} accepted batches, ${r.availability.attempts} network attempts and ${r.availability.failures} failed batch invocations, under a hard $0.25 cap at Jev's list price.

| Saved query | Jev scores completed | Top-12 shared works across modes |
| --- | ---: | ---: |
${r.queries.map((q: any) => `| ${q.title} | ${q.availability.completed}/${q.availability.planned} | ${q.comparison.complete ? `${q.comparison.shared}/12` : "Unavailable until both rankings finish"} |`).join("\n")}

Top-12 overlap measures agreement, not correctness. All scores sort descending. Equal scores receive equal competition ranks, then artwork ID supplies deterministic display ordering, including ties at the top-12 boundary. Missing scores remain at the end without replacing missing judgments with zero.

The lexical baseline uses unique normalized query tokens. Title matches receive weight 3; subject and style matches 2 (empty for this collection); caption, artist and origin matches 1; classification and medium matches 0.5. It normalizes case, accents and simple plural endings, drops a declared stop list, and does not understand negation. These points are not compared numerically with the Jev 0–4 score.

## Interaction and operational behavior

The gallery reranks with Motion while respecting reduced-motion preferences. Keyword search updates as the visitor types. Presets expose saved comparisons, refinement chips edit the scene, and a medium filter applies after ranking. The first 24 cards load initially, with all ${n} already participating in ranking and a Show more control for browsing the complete set. Artwork details use a native modal dialog, show the full image and exact caption, compare all three ranks, and link to the museum and original API record. Image failures have a clear placeholder and a retry in the detail view.

Live runs use only the visitor's in-memory gateway key through the existing /api/evaluate path. They score every work in both Jev modes and remain separate from recorded evidence. Changing a query, cancelling or unmounting aborts the active run. Generation guards prevent a late provider response from overwriting a newer query. Accepted partial responses are retained for that query and missing scores stay explicit; a continuation skips accepted scores. No owner credential is imported into frontend code.

## Reproduction and integration

Run from \`jev-experiments/\`:

\`\`\`sh
bun visual-search/prepare.ts                         # collect the archive (museum API only; no model calls)
bun visual-search/record.ts                          # freeze/check only; no API calls
bun visual-search/record.ts --run --max-batches 10   # pilot
bun visual-search/record.ts --run                    # record all ${scores} scores; stops at the $0.25 cap or after 5 consecutive failures
bun visual-search/build.ts
bun test visual-search/search.test.ts
bun visual-search/verify.ts --complete
bun visual-search/report.ts
\`\`\`

build.ts consumes the committed collection and evidence and writes results.jsonl in the app's shared codec; publication points to ../visual-search/results.jsonl. The frontend exports VisualSearch({result}). The app's prepare step copies collection.jsonl and events.jsonl into public/visual-search for the archive downloads.

Nine tests cover every work for all six queries in both modes, exact caption ablation, image URL isolation from model evidence, CC0 Cleveland images with plain-text captions, stable ties and missing-score ordering, invalid provider output, partial resume, stale-response rejection and explicit cancellation.
`;
writeFileSync(resolve(here, "README.md"), text);
writeFileSync(resolve(here, "_summary.md"), `A visual gallery searches ${n} CC0 works from the [Cleveland Museum of Art](https://openaccess-api.clevelandart.org/), using the museum's metadata and curatorial descriptions to compare two Jev rankings with a deterministic keyword baseline. Six declared scene queries cover every artwork in both model modes, with ${r.availability.completed.toLocaleString()}/${scores} relevance scores recorded; these are exploratory judgments, not ground-truth search accuracy. The archive moved from the Art Institute of Chicago on 1 Oct 2026, because that museum's image server challenged visitors' browsers and about half the images failed to load. The model ranks text and does not inspect pixels.\n`);
console.log(JSON.stringify({ report: "README.md", complete: done, recorded: r.availability.completed }));
