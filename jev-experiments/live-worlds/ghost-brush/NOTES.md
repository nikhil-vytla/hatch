# Ghost Brush notes

## 2026-09-20 — scope and construction

- Read the live-worlds contract and the original Ghost Brush research proposal.
- Building an original SVG drawing engine with woven, windblown, branching, granular and geometric recipes. No Harmony code is copied; its drawing interaction is inspiration only.
- Local lexical selection and real BYOK Jev selection will share a frozen metadata bank. The model receives text descriptions, never the canvas or pointer path. No model calls are planned for this implementation pass.
- Model requests have semantic revisions and branch epochs. Motion and pointer samples do not invalidate a request; brush application waits for the active stroke to end. Editing the prompt, choosing a recipe, rewinding or restoring a variant invalidates pending decisions.
- The app will keep completed stroke samples, seeds, recipe identities and decision receipts for deterministic replay and export.
- Type checking succeeded with the app's installed TypeScript. An initial invocation from the repository root printed compiler help because that directory has no tsconfig; it made no tracked dependency changes.
- Fifteen pure-function and lifecycle tests now pass, including stale reply invalidation and immutable branch preservation. Recipe geometry is deterministic under event-rate changes along the same path.
- The main app route was not integrated at the first browser visit. A temporary isolated preview outside Vite's allowlist returned HTTP 403, so it was removed; browser QA will use the integrated route.

## Completion and evidence

- Root integrated `#experiment/ghost-brush`; the initial missing shared data JSON alert disappeared after root prepared the app.
- Parent explicitly authorized two small genuine style examples. Both succeeded on the first attempt, 20/20 description judgments, selecting Indigo loom for the exact blue-fabric phrase and Coral nerve for the exact violet-coral phrase. Gateway latencies were 319 ms and 253 ms; reported cost was 0 for each. Full requests, normalized responses, attempts and hashes are retained. No further real model calls were made.
- Added visitor-facing recorded-example buttons with explicit curated-demo attribution and exact phrases. Local tag counts, live Jev and recorded Jev remain separate. A later edit now labels an earlier phrase's ranking rather than letting it appear to judge the new phrase.
- All 16 Bun tests passed with 148 assertions. Recorded examples are checked against the exact UI request contract and response hashes.
- Browser checks passed for pointer/keyboard drawing, undo/redo, local selection, saved variants and restore, same-gesture comparison, recorded selection, missing-key handling, SVG/evidence downloads, 390 px layout and reduced motion. Screenshots were visually inspected in desktop dark and mobile light themes.
- Five additional browser lifecycle checks used intercepted, explicitly mocked HTTP responses. Ink continued while a request was pending; a resolved result waited for pointer-up; a prompt edit cancelled stale work without changing the brush or replacing the newer status. The mock key was cleared in `finally`, and no request reached the model during these checks.
- QA corrections: the first comparison test included a button's SVG icon, so it now selects only artwork SVGs. Same-hash navigation preserved React state, so reproducible QA now reloads explicitly before starting. These were test setup problems, not mislabeled model failures.
- Final app TypeScript check and scoped diff whitespace check passed. Source/geometry hashes and measured CPU construction timings are in `validation.json`. Root retains final integrated build responsibility.

## Independent cross-review corrections

- Another worker reproduced two P2 problems: keyboard undo could bypass the toolbar's active-stroke guard, and restored model-selected variants lost their receipt reference and appeared hand-selected.
- Moved rewind protection into the pure session reducer. Attempting Ctrl/Cmd+Z during an active stroke now preserves both that stroke and all completed strokes, with a lift-pen notice.
- Variants now preserve and restore `brushReceiptId`. Recorded and live Jev origin survive restoring a saved brush.
- Added two regression tests, bringing the suite to 18 tests and 164 assertions. Two actual browser regression checks passed for active-second-stroke Ctrl+Z and restored recorded Blue fabric attribution. Combined browser coverage is 21 checks, with no additional real model calls.
- Root added `live-worlds/prepare.ts` to derive ignored `examples.json` from the committed manifest and event JSONL. README now gives the standalone preparation command; app build and test run it automatically. The pretty example JSON should not be committed.

- Canonical production QA on2026-09-20: drew an Indigo loom sample, replayed the actual recorded Violet coral decision, drew a second sample, and opened same-stroke comparison against Coastal wind. Both original recipes stayed on the sheet; UI showed Recorded Jev example and02strokes. No page errors, no overflow at1440px or390px dark mode. Saved production-comparison.png and production-mobile-dark.png under screenshots and personally inspected both. No live provider calls.
