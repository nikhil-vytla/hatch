# Ghost Brush

Ghost Brush is a playable drawing instrument with ten original procedural recipes. A pointer or keyboard gesture immediately becomes woven threads, windblown filaments, branching stems, angular grains or geometric facets. The artist can choose a recipe directly, use a declared local tag matcher, replay two real Jev examples, or ask Jev to judge an arbitrary style phrase with their own memory-held key.

The model sees the phrase and the same fixed recipe descriptions and parameters shown by the instrument. It never receives a drawing, image or pointer path. Ten independent `noul` judgments rank the complete bank; code selects the largest fit score and keeps bank order on ties. These are aesthetic fit judgments, not calibrated confidence or evidence of direct vision.

## Try it

Open `#experiment/ghost-brush` in the integrated app. Draw a wandering line, then choose a phrase and compare one recorded gesture across two materials. The next stroke can use either recipe; earlier artwork keeps its original ink.

- Drag with a pointer, or focus the paper and use arrow keys with Space to lower/lift the pen. Shift + arrows makes larger moves; Escape lifts; Ctrl/Command + Z undoes.
- Rewind by stroke, preserve a named variant, or draw from an earlier checkpoint. The old future is preserved automatically. Restore and fresh-sheet actions also preserve the abandoned sheet.
- Export a standalone SVG or JSON containing samples, seeds, recipes, branch snapshots, exact judgment requests, responses and append-only decision events. JSON includes a SHA-256 fingerprint of the recipe bank. Variants are memory-only and must be exported before reloading.

## Genuine recorded examples

Both declared examples completed, **2/2 curated demos and 20/20 judgments**, through the same `requestFor()` contract used by the UI. They are authored demonstrations, not a held-out benchmark or a measure of aesthetic accuracy.

| Exact phrase | Selected recipe | Fit judgment | Gateway latency | Attempts |
| --- | --- | ---: | ---: | ---: |
| A quiet fabric made of blue threads | Indigo loom | 0.94 | 319 ms | 1 |
| Strange branching violet coral | Coral nerve | 0.94 | 253 ms | 1 |

The gateway reported cost 0 for these two calls. That observation does not predict future pricing. `recording-manifest.json` freezes the model helper hash, recipe-bank hash, phrases and request hashes. `recording-events.jsonl` retains exact UI-contract payloads, sanitized attempt metadata and complete gateway-normalized responses. `examples.json` supplies the two visitor-facing buttons and preserves all scores, not just the winning recipe. Provider raw HTTP bodies are not retained by the shared gateway helper.

Only `record.ts` imports the authorized local credential helper. Browser code statically imports the public examples and uses `src/api.ts` for live BYOK requests; it has no owner-key fallback. The recorder resumes completed examples and retries only transient transport/provider failures. Changed frozen requests fail rather than silently replacing prior evidence.

## State and replay contract

`engine.ts` constructs original SVG paths from points, pressure, a stable seed and a recipe. Spatial resampling prevents denser pointer event streams from producing denser texture along the same path. Completed strokes are immutable. Comparison fits the same samples into both preview frames and preserves the seed.

`session.ts` owns semantic revisions and branch epochs. A pending request does not block pointer events. A valid result arriving during a stroke queues until pen-up; that stroke keeps its original recipe. Prompt edits, manual selections, rewind, restore, clear, cancellation and newer requests invalidate obsolete judgments. Receipts retain discarded and failed decisions. Branch snapshots preserve stroke samples, recipe, cursor and the next deterministic stroke seed. Rendering or pointer motion does not itself invalidate semantic work.

Local scores are tag-match counts, and zero matches are explicit. Live and recorded Jev scores have separate provenance. Scores from an earlier phrase remain inspectable but carry the exact prior phrase and an unevaluated-current-phrase notice.

## Validation

`bun test jev-experiments/live-worlds/ghost-brush` passes 18 tests with 164 assertions. Tests cover all ten distinct deterministic recipes, event-rate invariance, seed sensitivity, degenerate inputs, SVG text escaping, full score coverage, invalid scores, ties, six stale-result paths, mid-stroke application, superseded failures, manual-source attribution, immutable forks/restores exact recorded-request/response hashes, active-stroke undo protection and restored receipt attribution.

The Playwright CLI checks in `browser-qa.js` passed 14 actual browser checks: pointer and keyboard drawing, undo, local/recorded attribution, restoration, abandoned-sheet retention, comparison, missing-key behavior, both downloads, 390 px width and reduced motion. `browser-lifecycle-qa.js` passed five additional checks using explicitly intercepted HTTP fixtures. These confirmed ink while pending, between-stroke application and rejection of obsolete responses without making model calls. Two further actual browser regressions verify that Ctrl+Z during an active second stroke preserves both strokes, and that restoring a recorded variant restores its Jev attribution. The fixture tests are software evidence, separate from the two genuine demonstrations. The app typecheck passed, and browser console inspection showed no runtime errors.

Screenshots in `screenshots/` show desktop dark mode and mobile light mode. They were captured before the final copy-only refinement to the `2/2 curated demos` and memory-only history labels. The canvas remains paper-colored in dark mode so exported artwork matches its appearance. The initial browser run caught an overbroad test selector that counted a button icon as a third comparison SVG; the selector now checks only the two artwork previews. Navigating to an unchanged hash did not reset state, so reruns explicitly reload before testing.

`validation.json` records source and mark hashes plus CPU geometry timings for 50 constructions of an 82-point sample per recipe. Median construction times in the final run were approximately 0.06–0.68 ms. These are Bun path-construction measurements, not browser frame-rate measurements. Long sessions can still accumulate many SVG paths. The UI declares an 80-stroke sheet limit and 1,200 pointer samples per stroke; preserved sheets remain available.

## Reproduce and integrate

From the repository root:

```sh
# Required once after a clean checkout for standalone tests:
bun jev-experiments/live-worlds/prepare.ts
bun test jev-experiments/live-worlds/ghost-brush
bun jev-experiments/live-worlds/ghost-brush/validate.ts
bun jev-experiments/live-worlds/ghost-brush/record.ts
# Explicitly authorized recording only; completed examples are reused:
bun jev-experiments/live-worlds/ghost-brush/record.ts --run
```

With the app serving at port 5193 and the installed Playwright skill wrapper:

```sh
/Users/nikhil/.codex/skills/playwright/scripts/playwright_cli.sh -s=ghost-brush open http://127.0.0.1:5193/#experiment/ghost-brush --headed
bun jev-experiments/live-worlds/ghost-brush/qa.ts
bun jev-experiments/live-worlds/ghost-brush/qa.ts --lifecycle
bun jev-experiments/live-worlds/ghost-brush/qa.ts --regression
```

App integration is `import { GhostBrush } from './ghost-brush'` and `<GhostBrush />`. No result prop or new package is required. The shared `live-worlds/prepare.ts` derives the ignored `examples.json` from the committed recording manifest and event JSONL; app build and app test run this preparation automatically. Standalone folder tests need the preparation command above after a clean checkout. Do not commit a duplicate pretty JSON copy. The test glob is `../live-worlds/ghost-brush/*.test.ts`. Root owns catalog, route, publication, prepare and final build integration. This work changed only this folder and `src/ghost-brush.tsx` / `.css`; no worker commit or deployment was made.

## Attribution and limits

The immediate drawing interaction was inspired by [Harmony](https://mrdoob.github.io/harmony/) and the procedural practice documented by [canvas-sketch](https://github.com/mattdesl/canvas-sketch). All brush construction code here is original. No Harmony GPL implementation, fetched repository or generated bitmap is included. Existing app dependencies provide React, Motion and Lucide icons.

This is a creative instrument, not a study of which drawing is objectively better. The lexical baseline cannot reliably interpret negation or subtle aesthetic intent. The fixed recipe bank limits every method to ten materials. There is no image analysis, learned renderer, persisted account, JSON import UI, collaborative editing or performance guarantee for arbitrarily long scribbles. The saved JSON and original engine are sufficient for programmatic replay; browser restoration currently uses in-tab variants.
