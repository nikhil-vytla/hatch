# Visual search through a public art collection

The explorer searches 204 public-domain artworks from the [Art Institute of Chicago](https://www.artic.edu/collection). It presents full images, original museum captions and provenance, then compares Jev ranking with metadata alone, Jev ranking with metadata plus the museum caption, and a deterministic keyword baseline. All methods rank the same complete collection. All 2,448 planned Jev relevance scores are recorded.

## Collection and evidence

The parent collected the first 18 public-domain image results for each of twelve museum search topics, then deduplicated by artwork ID and retained records with museum alt text. The retained archive contains 204 unique works, full metadata, public museum links, original image identifiers, IIIF URLs, captions, collection query URLs and response hashes. It is a declared sample, not the museum's full collection. No new scraping was needed during implementation.

The [museum API documentation](https://api.artic.edu/docs/) describes the metadata and IIIF image interfaces and recommends cached metadata and polite request pacing. The app reuses the fixed archive and lazy-loads artwork previews. Of the 204 captions, 51 are descriptive and 153 mainly identify the medium or material. Caption quality therefore varies substantially. These are existing museum alt descriptions, not newly generated vision captions.

Browser QA found that the museum IIIF host returned Cloudflare 403 challenges, an unresolved [upstream delivery issue](https://github.com/art-institute-of-chicago/api-data/issues/9). A separate image delivery sidecar now provides 101/204 public-domain Wikimedia copies matched through [exact ARTIC artwork IDs](https://www.wikidata.org/wiki/Property:P4610), or an exact museum source URL plus the artwork title in the Commons filename. Every accepted file has a Commons public-domain or CC0 designation, a source page, file hash and matching provenance. The remaining works keep their original museum URL and an explicit image failure placeholder. Matching identifies the artwork; a mirrored photograph can differ in crop or view from the museum image described by the caption. This enrichment never changes the frozen collection, query text, captions or model requests. Raw source responses and their hashes are in image-source-events.jsonl.

The collection acquisition script applied a limited title/caption keyword screen. That is not an exhaustive visual content review. All retained records have the museum's public-domain flag. The app displays source links and the full text without executing embedded HTML.

## Frozen comparison

Six exploratory requests describe quiet water, night lights, winter space, flowers, restrained geometric patterns, and birds among branches. Every request scores every work in both Jev modes, for 6 × 204 × 2 = 2,448 independent questions. The precise query list, rubric and hashes are in manifest.json. No relevance labels, accuracy, recall or model-superiority claims were invented.

Each native question carries one artwork's exact text. Shared state contains only the search query and fixed policy. Metadata mode includes title, artist, date, medium, classification, style tags, subject tags and origin. Caption mode adds exactly one museum_caption field. Both exclude image pixels, image URLs and the collection acquisition topic labels. Jev grades support for the entire requested scene on a fixed 0–4 relevance rubric and is instructed to treat missing visual detail as uncertainty. Its returned fractional score is preserved. Artist/title metadata may still trigger learned associations; this is a textual retrieval comparison, not a direct vision evaluation.

Native batches use at most 32 questions and 44,000 serialized bytes. Every request payload and hash, attempt, accepted response and normalized score remains in events.jsonl. Completed answers are not rerun when resuming. The current summary contains 84 accepted batches, 136 network attempts and 1 failed batch invocations.

| Saved query | Jev scores completed | Top-12 shared works across modes |
| --- | ---: | ---: |
| Quiet water | 408/408 | 10/12 |
| After dark | 408/408 | 11/12 |
| Winter air | 408/408 | 9/12 |
| Flowers, closely | 408/408 | 11/12 |
| Quiet patterns | 408/408 | 9/12 |
| Birds & branches | 408/408 | 11/12 |

Top-12 overlap measures agreement, not correctness. All scores sort descending. Equal scores receive equal competition ranks, then artwork ID supplies deterministic display ordering, including ties at the top-12 boundary. Missing scores remain at the end without replacing missing judgments with zero.

The lexical baseline uses unique normalized query tokens. Title matches receive weight 3; subject/style matches 2; caption, artist and origin matches 1; classification and medium matches 0.5. It normalizes case, accents and simple plural endings, drops a declared stop list, and does not understand negation. These points are not compared numerically with the Jev 0–4 score.

## Interaction and operational behavior

The gallery reranks with Motion while respecting reduced-motion preferences. Keyword search updates as the visitor types. Presets expose saved comparisons, refinement chips edit the scene, and a medium filter applies after ranking. The first 24 cards load initially, with all 204 already participating in ranking and a Show more control for browsing the complete set. Artwork details use a native modal dialog, show the full image and exact caption, compare all three ranks, and link to the museum and original API record. Image failures have a clear placeholder and a retry in the detail view.

Live runs use only the visitor's in-memory gateway key through the existing /api/evaluate path. They score every work in both Jev modes and remain separate from recorded evidence. Changing a query, cancelling or unmounting aborts the active run. Generation guards prevent a late provider response from overwriting a newer query. Accepted partial responses are retained for that query and missing scores stay explicit; a continuation skips accepted scores. No owner credential is imported into frontend code.

## Reproduction and integration

Run from the repository root:

```sh
bun jev-experiments/visual-search/record.ts             # freeze/check only; no API calls
bun jev-experiments/visual-search/record.ts --run       # explicitly record all 2,448 scores
bun jev-experiments/visual-search/build.ts
bun test jev-experiments/visual-search/search.test.ts
bun jev-experiments/visual-search/verify.ts --complete
bun jev-experiments/visual-search/report.ts
```

The optional images.ts script rebuilds the image delivery sidecar from cached public source responses and queries missing image metadata with a 3.5-second pause and Retry-After backoff. Add --expand to query exact museum source links for works without Wikidata image matches. It does not invoke Jev. The existing prepare.ts is the museum acquisition script; it is not needed for a normal build and should not be rerun casually. build.ts consumes the committed collection and available evidence and writes results.jsonl in the app's shared codec. Publication should point to ../visual-search/results.jsonl. The frontend exports VisualSearch({result}). Copy collection.jsonl and, when present, events.jsonl into public/visual-search for explicit archive downloads. No additional packages are required.

Eight tests cover all 204 works for all six queries in both modes, exact caption ablation, image delivery isolation, stable ties and missing-score ordering, invalid provider output, partial resume, stale-response rejection and explicit cancellation. TypeScript compilation passed. Browser observations and any later recording findings are appended to NOTES.md.
