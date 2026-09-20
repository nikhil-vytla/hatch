# Logo studio

Verdict: repair. Highest priority: P1. The original experiment is a clear bounded symbol selector, with a useful SVG renderer. Its saved examples do not establish brief fit, and the live controls can attach an old mark to a new brief or overwrite a manual decision.

## Current experiment and evidence

The catalog at `experience-prototypes/src/catalog.ts:110` asks which design decisions make a mark fit its brief. The original `Logos` component in `src/misc.tsx:18` remains identical to commit `4c0c40d`; this review does not assess the separately developed Icon studio.

Jev makes four choices in one request: one of five symbols, four palettes, four arrangements and three line weights. Code supplies every path, coordinate, transform and color at lines 33 through 82. The nominal space contains 240 specifications and 60 distinct geometry/weight strings before color. All four chosen fields affect the output. The four “family” cards are deterministic arrangements of the same shape, not four independent Jev designs. Palette, weight and arrangement are manually editable; the symbol itself has no manual control.

The published mapping points to `../results/logos.jsonl`. Decoding it with shared `readRecord` yields six attempted authored briefs, five completed specifications, 20 decisions and one HTTP 429 failure for case ID 2. The runner's original list identifies that case as “A playful astronomy club,” at `src/jev_lab/compositions.py:542`. The generic collector preserves the ID but drops the brief on failure, at `core.py:404`.

Every completed mark uses `single`; four use `light`, and one uses `medium`. There are no independent design judgments. Six requests generated 16 provider attempts: five HTTP 200 and eleven HTTP 429. Successful-attempt p50 is 299 ms; retry-inclusive logical-request p50 is 18.62 seconds, explicitly excluding queue wait. The record's global `budget_at_finish` covers shared experiment work and is not the price of these six logos.

Strengths are the visible finite vocabulary at `misc.tsx:203`, deterministic inspectable SVG, instant manual variations, and a standalone SVG download that supplies the namespace and resolved inherited color. The offline export check verifies these serialized attributes; it is not a real browser export or optical-quality test.

## Findings

### P1: Late results replace manual choices and belong to the wrong brief

The textarea at `misc.tsx:119` changes the heading immediately, but the request completion at line 151 always replaces the entire spec. The probe starts the seed-library request, changes the brief to astronomy, manually changes teal to coral, then supplies the original answer. The visible astronomy mark becomes the old teal leaf and the coral correction is lost. No input/spec revision, lock or proposal acceptance guards this write.

Keep the committed mark separate from pending suggestions. Bind requests to brief, spec and lock revisions. Show a completed old result under its original brief without replacing a newer edit. Allow the user to lock a symbol, palette or path while requesting variation of another property.

### P1: The interactive page drops most saved evidence and confuses provenance

`misc.tsx:19` filters failed rows and initializes only from `rows[0]`. There is no case selector. The visitor sees one of the five completed examples; the failure is available only in the page's raw evidence download. `last` starts null at line 31, so the initial mark's recorded answers are absent from its state inspector. After a live response, manual arrangement/palette/weight changes leave `last` unchanged. The probe produces `spec.structure = orbit` beside a raw model answer of `single`. The inspector at line 201 omits the brief entirely.

Provide a six-case evidence selector with explicit failure and retry timing, initialize provenance from the selected record, and distinguish model source spec from current edited spec. Save brief, grammar version, request, decisions and human changes with each revision. Preserve the failing brief directly in future records. Raw evidence remaining downloadable is useful, but it does not make the current artifact's provenance coherent.

### P1: The available marks and current evidence cannot answer the fit question

The five paths and fixed transforms constrain every result. A request for a bicycle, a monogram or a two-symbol story has no representation, nor an unsupported/clarify choice. “Explore a direction” sends only the brief at line 127; it cannot ask for a variation of the current mark while respecting existing edits. All five completed cases selecting `single` is a measured lack of structural variety in this tiny sample, not proof that other structures would be better.

Retain the bounded vocabulary and make it directly editable, including symbol selection. Show unsupported requests as such. For a stronger interaction, let Jev choose a small set of meaningful operations on a versioned vector document and test whether those choices improve brief fit. Evaluate hard constraints separately from subjective preference. A high choice confidence does not measure originality, legibility or design quality.

### P2: Export validity is checked at the large-preview scale only

The mark uses a 200-unit view box, line widths 3/5/9 and a 0.45 scale inside `orbit`, at `misc.tsx:54`. At a 16 px icon size, a light single stroke is 0.24 px and the light orbit stroke is 0.108 px before antialiasing. The page shows a 200 px main mark and 90 px family marks, at `style.css:2513` and line 2544, with no small-size, monochrome or background proof.

These calculated widths identify a legibility risk, not a measured raster failure. Add exact-size 16/24/32/128 px proofs on light and dark backgrounds, an explicit icon-size stroke/shape treatment, and raster/export parity checks. Define acceptable ink coverage and minimum feature separation on development cases, then have people check recognizability. SVG syntax alone cannot establish usable exported marks.

## Richer interaction

Keep a live vector workbench with a selected symbol, editable handles, spacing, stroke and palette. Start with “a seed exchange that should feel neighborly.” Jev proposes three bounded modifications such as softer leaf curvature, closer paired spacing and a calmer palette. The visitor locks the silhouette, drags the pair apart, and asks “make the relationship feel more connected.” Preview the proposed operation alongside the current mark and exact-size usage proofs. Accept one change, compare revisions, undo, and export the chosen SVG with its brief and operation history.

Code owns the vector document, stable path IDs, constraints, transform bounds, proof rendering and transactions. Jev selects operation IDs and bounded parameters from the current document and request; it cannot silently replace locked geometry. Pending suggestions have request/document revisions. Failure or an unsupported request leaves the document intact and asks a focused question. Continuous dragging and proof updates are deterministic; inference happens on a deliberate request or after a controlled pause, never on every pointer event.

Accept when every model field maps to a visible operation, locked paths remain byte-identical, stale replies cannot replace later edits, undo restores the exact previous document, all proof views derive from one document, and the exported SVG reproduces the accepted shape and palette. Distinguish the displayed design name from the semantic brief, since the current heading exports neither.

## Evaluation

Current coverage is six authored briefs, five completed outputs, and zero independent fit ratings. There is no suitable external benchmark used here and no claim of full logo-design coverage.

First exhaust all 240 current specifications at four sizes and two backgrounds: 1,920 deterministic renders with no model calls. Check parseability, bounded geometry, visible ink, feature loss, palette resolution and export parity. Keep optical thresholds as heuristics with independently reviewed failure cases. The present probe serializes all 240 specifications but does not perform these raster checks.

Create 24 development and 120 held-out briefs, 20 each across literal supported symbols, indirect meanings, explicit visual constraints, negative instructions, conflicting constraints and unsupported concepts. Two independent designers annotate acceptable choices and hard constraints before viewing outputs; allow several acceptable outcomes. Separate template families across splits. For the five supported symbol categories, balance category counts within the relevant strata.

Run two paraphrases and two option-order seeds, 42 and 43, under the recorded and current live prompt versions. This costs **120 × 2 × 2 × 2 = 960 logical requests and 3,840 choices**, before retries. The two prompt versions differ in wording and symbol/arrangement order; do not pool them as identical evidence. Compare frozen keyword/rule selection, uniform valid specifications and manual parameter selection. Random candidates use the same grammar and rendering budget, with seeds 42, 43 and 44. Include an unsupported outcome in the proposed protocol, and score failure to abstain separately from preference.

Measure hard-constraint satisfaction, supported/unsupported recognition, order sensitivity, all-attempt availability, diversity within an accepted constraint set, accepted edits, and retry-inclusive latency. Three independent blinded raters assess fit and legibility for each method on the canonical 120 briefs, with randomized method order. Do not use Jev as its own quality judge. Report disagreement and paired preference with 10,000 bootstrap samples clustered by base brief; keep paraphrases and repeats together. Report exact numbers of available artifacts, not only ratings on successful calls.

For the richer interaction, use 40 held-out four-step edit scripts: initial proposal, locked-property revision, manual correction, and final request. At most three model calls per script gives 120 further requests, so the complete planned evaluation is 1,080 requests before retries. Independently specified masks, locks and final constraints measure coherence; a 12-person study can replay these outputs to compare correction effort against the same manual editor. No requests or user study were performed during this audit. The full authored case set is feasible; independent design annotation and rendering proofs are the main work.

## Tools and next steps

[Paper.js](https://paperjs.org/features/) supplies editable paths, segments, groups, interaction handlers and SVG import/export for a real vector workbench. Its [path operations](https://paperjs.org/reference/pathitem/) can support checked combinations. Jev would choose among meaningful edits while the library handles geometry; it would not replace direct manipulation.

[SVGO](https://github.com/svg/svgo) can optimize the final SVG under a pinned configuration. Compare rendered output before and after optimization and preserve required viewBox, IDs and metadata outside the optimized asset. It reduces serialization overhead; it is not a design-quality judge.

| Priority | Size | Action |
| --- | --- | --- |
| P1 | M | Add revision-bound proposals and property locks, preserving manual changes during inference. |
| P1 | S | Expose all six recorded cases, failures, original briefs and current-versus-source provenance. |
| P1 | M | Add symbol editing, unsupported handling and a shared versioned request builder. |
| P2 | M | Add size/background proofs and exhaustive 240-spec export checks. |
| P1 | M | Independently label the authored suite and run matched fit/availability comparisons. |
| P2 | L | Build the constrained vector-editing session if the fit study shows value beyond manual/rule selection. |

A future diagram-symbol editor could reuse the same locked-path and proof system. It should remain a separate evaluation from the new Icon studio.

## Investigation log

Read the original component, renderer CSS, catalog, Python runner/collector, shared export, page evidence link and publication mapping. Decoded the published JSONL through shared `readRecord`; verified the original component against `4c0c40d`. Ran `probes/logos.ts` with Bun, enumerated 240 specifications/60 geometry strings, checked namespace/color serialization, and reproduced stale brief/manual overwrite and provenance mismatch. Initial broad searches hit nonexistent path guesses; narrowed them to the observed source files. No dedicated Logos tests were found. Verified official library docs. No app edits, browser/raster checks, model calls or commits.
