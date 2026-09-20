# Visual search

## 2026-09-20

- User requested fast, visual image/video search using a public collection, vision captions, metadata or tags.
- Selected Art Institute of Chicago's public API and public-domain image records. Its supplied thumbnail alt text offers a caption channel without pretending Jev reads pixels.
- Plan a provenance-rich image gallery with metadata-only versus caption-assisted Jev ranking and a lexical comparator. Model retrieval relevance is not ground truth; full images and text are visible for inspection.
- API documentation recommends fields filtering, caching, small-scale requests and no more than one request per second. IIIF images can load directly from museum-hosted image IDs.

## Protocol and implementation

Read the cached 204-work collection through the app's shared record codec; did not rescrape museum data. The supplied captions range from detailed visual descriptions to generic material-only alt text, so the viewer labels those separately. The museum API documents IIIF image URLs and asks clients to cache metadata and avoid parallel scraping; this experience reuses the fixed metadata archive and lazy-loads museum-hosted images.

Froze six exploratory scene queries before scoring. Each query will score all 204 works in both metadata-only and metadata-plus-caption modes, for 2,448 independent Jev relevance judgments. The only evidence difference is the museum_caption field. Source collection query labels and image URLs/pixels are excluded from the scorer. A five-level relevance rubric returns a score from 0 to 4; these are not ground-truth labels or calibrated probabilities. The lexical baseline uses declared weighted token overlap on the same complete collection. Tied scores share a rank, missing scores sort last, and artwork ID resolves display ordering ties.

The recorder has a preparation-only default; model calls require an explicit --run argument. No model calls have been started for this task. The parent is coordinating the existing full JudgeBench run. Native batches are capped at 32 independent questions and 44KB, and completed results are retained across resume. Seven tests passed, covering all 204 works in all twelve query/mode combinations, exact evidence ablation, equal-score and unavailable behavior, malformed responses, partial resume, stale response rejection, and explicit cancellation. The frontend imports only pure protocol/ranking helpers; recording credentials stay in scripts.

Built a responsive artwork gallery with animated reranking, instant keyword search, recorded presets, refinements, full collection BYOK runs, a native accessible detail dialog, exact museum captions and provenance, exports, image failure fallback/retry, and reduced-motion support. Metadata/caption top-12 overlap is shown only when both rankings are complete and is labeled agreement, never search accuracy.

## Recording and browser checks

After the parent authorized recording, started one detached recorder with a 2.2-second pause between accepted native batches. Shared gateway limits are 30 requests and 250,000 input tokens per minute; transient quota waits preserve accepted scores. PID 4947 writes the ignored recording.log. At the first integrity check, 1,008/2,448 scores were accepted with every recorded prompt reconstructed against the frozen protocol.

Browser interactions passed for changing a query into immediate keyword ranking, native dialog opening and Escape dismissal, the in-memory key guard before any live request, full 204-work export with the correct collection hash, dark mode, and a 390px viewport without horizontal overflow. Reduced-motion emulation disables transitions. The app production build passes. The CLI run-code command requires an async function wrapper; an initial bare-await invocation failed and was corrected.

Every museum-hosted preview initially returned a Cloudflare 403 challenge here, including the documented 843px size. The API repository has the same unresolved issue at https://github.com/art-institute-of-chicago/api-data/issues/9. We did not bypass that challenge. Instead, a separate image delivery sidecar matches public-domain Wikimedia copies to the exact artwork via Wikidata P4610/P18, or exact museum source URL plus artwork title in a Commons filename. Only files explicitly marked Public domain or CC0 are accepted. Source responses and hashes are archived; original model evidence remains byte-for-byte unchanged. The first Wikidata query succeeded with 102 matching artwork IDs, then a repeat timed out. Reused the captured successful response with its file timestamp documented in the audit, added a 45-second request deadline, and continued at one public metadata request per second. Eight tests now pass, including a check that the image sidecar cannot change model requests or lexical ranks.

## Image delivery and handoff

The accepted sidecar currently contains 100 Wikimedia previews with explicit public-domain or CC0 metadata. The gallery and modal load these images successfully, expose the exact Commons source page, and retain the museum URL as fallback. The browser now states the preview and museum-link counts explicitly. All 204 candidates remain in every ranking; image availability does not filter the evidence. The optional source-link expansion is detached as PID 9527 and logs to ignored images.log. Commons returned a 429 with Retry-After 8, so public metadata calls now wait at least 3.5 seconds and back off at least 60 seconds on 429. No challenge bypass was attempted.

Final interaction checks passed: painting facet gives 93 works while preserving global ranks, Show more grows from 24 to 48 cards, complete export contains 204 unique IDs, source details include the actual loaded image and exact caption, and a 390px layout has no horizontal overflow. Reduced-motion emulation turns transitions off. Screenshots in output/playwright cover the desktop gallery, full image/detail comparison, and mobile dark gallery. A concurrent Vite dependency refresh briefly mixed old/new React chunks and caused an invalid-hook error; the automatic full reload recovered, and a fresh page check had zero errors.

Jev recording remains active as PID 4947. Root owns monitoring and final regeneration: run verify.ts --complete, build.ts, report.ts, then the app build after all 2,448 scores finish. The image extension can finish independently; rebuild to publish its updated delivery counts. This handoff does not claim complete model recording or universal image availability.
