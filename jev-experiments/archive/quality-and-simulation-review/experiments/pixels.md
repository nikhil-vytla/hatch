# Pixel studio

Verdict: **redesign**. Highest priority: **P1**. The useful foundation is a small, inspectable composition tool with a deterministic renderer. Its current question contract and evidence do not test staged composition, and several controls can produce an artifact that no longer matches its mode, lock, or recorded run. This audit covers the original `pixels` catalog entry, not the separate `drawing-framing` experiment. Source hashes are recorded in `probes/pixels.json`.

## Current purpose and evidence

The catalog asks how staged composition compares with independent pixel choices (`experience-prototypes/src/catalog.ts:78`). The current component offers Scenes, Sprites, and Patterns, a brief, a palette lock, version buttons, Compose, and PNG export (`experience-prototypes/src/creative.tsx:294`). It renders a 64×64 Canvas. There is no brush, selection mask, object dragging, animation timeline, or staged progress display.

Jev returns **29 values in one request**: palette, weather, nine inclusion scores, and x/y positions for each of nine object kinds (`creative.tsx:267`). Inclusion uses a fixed 0.5 threshold. Code supplies every object silhouette, five palette colors, draw order, terrain, transparency behavior, rain, pond motion, and the complete animated pattern formula (`creative.tsx:158`). At most one instance of each kind can appear. The on-page explanation accurately says that this is a library of objects rather than unrestricted image generation (`creative.tsx:421`).

The `visuals` publication points to `experience-prototypes/results/visuals.jsonl`. Decoding it yields **three current compositions, one per mode, with 87 answers**. Their recorded request durations are 564, 313, and 613 ms, each with one successful attempt. The same file also contains four legacy 8×8 pixel rows: three successful 64-choice outputs, totaling 192 choices, and one HTTP 503 failure. The current component never renders those legacy pixel rows; it reads `result.compositions`. The enclosing `20/20` checks and availability refer to Living scenes, not Pixel studio. No independent artifact quality score or human rating exists.

## What works

- Current recording and live requests import the same `pixelQuestions` builder (`experience-prototypes/scripts/record-pixels.ts:4`, `:19`; `creative.tsx:394`). The question vocabulary and selected plan are inspectable.
- Drawing uses integer rectangles and disables smoothing, giving a stable 64×64 pixel grid. Sprites start with a transparent canvas, and PNG export serializes the displayed Canvas (`creative.tsx:164`, `:173`, `:409`).
- Live edits include the current plan in the model input. Palette locking works when already enabled at dispatch, and prior plans are retained as version entries (`creative.tsx:395`, `:402`). These useful ideas need a complete document/version contract.
- Per-composition evidence retains answers, model, request/service duration, attempts, retries, and reported cost. The legacy runner explicitly calls its pixel outputs independent distributions rather than a joint image distribution (`src/jev_lab/pilots.py:103`).

## Findings

### 1. P1: There is no staged-versus-independent comparison

`pixelQuestions` creates all fields before a single `run` call. Inclusion, placement, palette, and weather are not applied as successive decisions conditioned on the selected earlier results (`creative.tsx:267`, `:394`). The current API makes no promise of a coherent joint scene. The legacy runner asks 64 color questions for an 8×8 canvas; it uses different briefs, a different palette, and no object templates (`pilots.py:80`). Those rows are not shown next to current output. The current recorder also omits the `current` plan that live requests receive (`record-pixels.ts:18`).

The three fast composition requests demonstrate transport and renderability, not a quality or latency advantage over independent pixel decisions. Hand-drawn templates, changed resolution, different tasks, different request conditions, and omitted failures would confound that comparison. Separate a matched pixel experiment from a matched object-composition experiment. Add explicit stage state only where it is actually used, record the complete input and protocol version, and replace the broad claim with the measured result when one exists.

### 2. P1: Pattern mode ignores 28 of its 29 model answers

The pattern branch reads only `plan.palette`, fills every pixel with a fixed sinusoidal formula, and returns before weather or objects are considered (`creative.tsx:182`). Changing all other answer fields produces identical pixels at the same time. Jev cannot change pattern shape, scale, direction, speed, tiling, or symmetry. Sprite mode ignores weather. Both object modes ask for positions even when the inclusion decision is false.

The actual renderer probe observes **59 of 87 recorded answers unread**: 14 in Scenes, 17 in Sprites, and 28 in Patterns. These counts describe returned decisions, not 59 separate HTTP requests. In particular, animation in Patterns is entirely code-defined after choosing one palette.

Use mode-specific contracts. Patterns should expose a small documented set of kernels, frequency, symmetry, speed, and palette roles that rendering actually consumes. Select scene/sprite entities before asking for their positions, or explicitly justify a one-call latency tradeoff. Omit weather where unsupported and do not ask for a locked palette. Add an output-to-renderer coverage check and show which controls the model actually changed.

### 3. P1: The capability and geometry contracts permit incomplete or clipped artwork

The recorded noodle-shop brief requests a shop, warm window, and cat under an awning. Its plan includes only cat and cloud, with rain; the `house` inclusion score is 0.17. The deterministic library can draw a house-like shape but has no shop, window, or awning entity or “under” relationship (`creative.tsx:141`, `:210`). It is a capability mismatch as well as an unsatisfied brief, not evidence that the model failed to paint pixels. The prepared initial plan looks more complete because code preselects house, tree, moon, pond, and cat.

Coordinate questions offer generic anchors without object bounds. Exhaustively rendering all 25 offered locations for each of nine single objects finds **49 of 225 placements with drawing rectangles outside the canvas**. A legal robot y=12 clips the antenna; y=52 clips its feet. This is a renderability finding, not an observed failure rate for the three recorded outputs. Layer order is fixed by object kind, so the model also cannot choose which object occludes another. On a transparent moon sprite, the crescent cutout paints the opaque background color instead of erasing alpha (`creative.tsx:253`); the probe's pixel at (36,20) is opaque even outside the original disk.

Give every template explicit anchor, bounds, alpha mask, instance ID, and legal placement range. Validate sprite clipping and requested relationships before commit. Make layering deliberate. Report unsupported clauses, and let the visitor choose an allowed substitute rather than silently losing the main subject. Use real alpha masks for cutouts and selected-region edits. Preserve the limited library as a declared constraint when scoring quality.

### 4. P1: Requests, locks, and versions are not bound to the active artifact

Compose captures `mode`, `plan`, and `locked`, then unconditionally installs its result (`creative.tsx:392`). Mode and palette-lock controls remain usable while it waits. The actual callback probe submits a scene, switches to Sprites, and resolves the old request: the sprite tab and robot brief remain, but cat/cloud replace the robot. Enabling Keep the palette while a request is pending leaves the box checked but permits the old callback to change night to warm.

Version entries store only plans, and selecting one changes only `plan` (`creative.tsx:360`). After selecting an older night version, the inspector still exposes the latest warm run and the brief remains “Make a warm scene.” The generic composition badge also does not distinguish recorded and live source, though the raw inspector contains source metadata. Recorded mode changes reset their history, so there is no persistent per-document edit history.

Store immutable versions containing plan, brief, mode, source, request/schema/renderer IDs, locks, and animation phase. Apply responses only to the matching document revision. Treat mode changes, version selection, and lock changes as revisions; stale proposals can remain reviewable without replacing the canvas. Display the selected version's provenance and request timing. Validate locks again at commit, and distinguish model output from any deterministic override.

### 5. P2: The animation loop and export are not under creative control

The loop resizes and redraws the entire Canvas on every animation frame, including the static robot and reduced-motion presentation (`creative.tsx:164`, `:314`). The pattern makes 4,097 fill calls per frame. At 60 frames per second that would be 245,820 calls, but this audit did not measure browser performance. The reduced-motion callback probe confirms continued redraw scheduling even though time stays zero. There is no pause, frame step, scrubber, or fixed-phase export. Each plan change restarts the animation clock; PNG export captures whichever frame happens to be current.

Maintain a document-local clock and render static art only when it changes. Stop scheduling when paused, hidden, or in reduced-motion mode. Add an explicit frame/phase for export and deterministic replay. Keep code animation immediate while a semantic edit is pending, then preview the proposed change without resetting unrelated motion. Measure frame timing and interaction latency before claiming real-time generation.

## Richer interaction: a living pixel postcard

Start with a small scene or transparent sprite on a 64×64 indexed-color canvas. The visitor can move a layer, paint a few pixels, select a region, and lock the character's face or palette. “Make the background feel windy, leave the cat unchanged” proposes a bounded background motion recipe while the preview keeps playing. A later request can move the moon behind a cloud or change one sprite pose. The user can compare, accept, undo, pause, scrub, and export the selected frame or a sprite sheet. Templates and unsupported operations remain visible so the interaction does not suggest unrestricted image synthesis.

State includes document revision, mode, palette roles, bitmap/layer data, stable entity IDs, anchors/bounds, masks, layer order, protected pixels, animation recipe/phase/seed, and complete versions. Jev chooses entities or a patch to a selected region, then placement conditioned on chosen entities and their bounds, then supported attributes or motion parameters where needed. Code draws shapes, clips patches to the edit mask, preserves locked pixels, checks geometry, and runs the animation. Manual dragging and brush changes update immediately without a model call; Jev is used for semantic changes, not each frame.

For patterns, a typed recipe can choose among waves, cellular patches, stripes, and seeded noise, with exposed frequency, direction, symmetry, and speed. It does not need arbitrary generated JavaScript. For sprites, the smallest useful animation system is a few named poses with explicit masks, not an endless redraw of the same picture.

Invalid, unsupported, or stale patches leave the active document intact and identify the unsatisfied request. If an edit overlaps a newer brush stroke, it needs a fresh proposal rather than silently overwriting that stroke. Acceptance criteria:

- Unmasked and locked pixels remain byte-identical after an edit; locked palette roles retain their values.
- Every applied model field affects a declared layer or recipe parameter. No weather/object decisions are solicited by modes that ignore them.
- Required objects and relations are either represented by validated layers or reported as unsupported. Sprite clipping requires explicit permission.
- Version selection restores the artifact, brief, mode, phase, source, and result metadata together. Undo restores exactly the previous committed document.
- Pause, scrub, and export use the same phase. Seed plus document version and phase reproduces the same RGBA bytes.
- New manual input, mode changes, or version selection prevent stale requests from modifying the document. Reduced-motion/static states stop continuous drawing.

## Evaluation protocol

Use authored tests, not an invented external benchmark. Keep the existing three composition examples and legacy pixel prompts for development. Define two separate comparisons so template quality does not masquerade as better model coordination.

**Object composition and editing:** hold out 60 briefs, 20 per mode, with initial composition plus two edits. Include supported object/relationship tasks, geometry boundaries, mask/palette preservation, motion requests, and unsupported clauses. Use two predeclared initial canvas seeds and two wording variants: **240 sessions and 720 semantic turns per protocol**. Compare one flat request with a three-stage protocol using the same templates, allowed operations, resolution, palettes, and renderer. The two protocols require **720 + 2,160 = 2,880 logical requests before retries** if every staged turn uses three requests. Record actual primitive decisions and skips; extra calls and elapsed time are part of the comparison, not free improvements.

Baselines are a keyword/rule composer with deterministic placement, legal random plans, and independently authored oracle plans rendered by the same code. The oracle reveals whether a failed brief is unrepresentable or merely planned badly. Expected objects, allowed substitutes, relations, geometry, masks, and forbidden changes must be labeled before examining predictions. Separate unsupported-request handling from fidelity on supported tasks. Any manual template improvements apply to all conditions.

**Independent versus sequential pixels:** use 40 new held-out 8×8 briefs with exact authored targets for simple icons, geometry, and color arrangements, two paraphrases and two predeclared initial/background states: **160 matched cases**. Hold the four-color palette and 64 final color decisions constant. Compare one 64-question request with eight row requests that receive preceding chosen rows: **160 + 1,280 = 1,440 requests**, producing 20,480 pixel decisions across the pair. Report order effects explicitly; a scan-order protocol may improve one arrangement and harm another. This small task measures bounded pixel coordination, not unrestricted scene generation. At 64×64, 4,096 pixel questions would require at least 32 requests at the current 128-question limit, so scaling the old baseline is not free (`experience-prototypes/server/gateway.ts:35`).

The combined proposed comparison is **4,320 logical requests before retries**. These future runs were not performed. It needs new independent labels and a real staged/editor implementation, but no large dataset or weight download. Freeze prompts, thresholds, schemas, and renderer versions after development. Give recording and live paths the same initial-state contract.

Primary composition outcomes are supported-constraint pass rate across the whole session and locked/unmasked preservation. Pixel outcomes are exact target accuracy, per-color intersection-over-union, boundary agreement, and connectedness/symmetry only where explicitly requested. Multiple valid targets should be specified in advance; do not penalize arbitrary aesthetic choices through a single hidden reference. Report geometry violations, unsupported handling, unchanged-field preservation, consumed versus discarded decisions, failures/retries, p50/p95 time to first preview/final result, and total cost separately.

Use 10,000 paired bootstrap resamples clustered by base brief within each suite, retaining paraphrases, initial states, and edit sequences together. Pixels and repeated frames are not independent samples. Claim a staged advantage only if the paired 95% interval for the prespecified fidelity metric is above zero, alongside the added request/time cost. For editor integrity, require zero mask/lock/stale-commit violations in 1,000 offline generated interaction schedules and byte-exact export replay. Measure direct manipulation on a declared desktop/mobile setup; a provisional p95 local preview target is under 50 ms, independent of remote completion time.

For visual quality, prespecify 60 matched composition pairs across the modes and collect three blinded judgments each, totaling **180 paired ratings**. Match display size, phase, renderer, and palette; ask brief fidelity, edit preservation, and aesthetic preference separately. Report clustered intervals, agreement, and missing ratings. Do not compare the attractive prepared house composition with an unrelated low-resolution model image and call the difference model quality.

## Useful existing libraries

- [p5.js noLoop](https://p5js.org/reference/p5/noLoop/), [redraw](https://p5js.org/reference/p5/redraw/), and [noiseSeed](https://p5js.org/reference/p5/noiseSeed/): useful for bounded creative-coding kernels, repeatable fields, and explicit redraw control. Jev chooses semantic recipe parameters; code evaluates them. The existing Canvas renderer can implement these controls directly, so a framework migration is optional.
- [fast-check model-based testing](https://fast-check.dev/docs/advanced/model-based-testing/): generate and shrink edit/mask/lock/version/response-order schedules. Test simple document invariants against an independent model, not a copy of the renderer. This supports trustworthy creative interaction rather than improving art through more prompts.

## Prioritized work

| Priority | Size | Action |
| --- | --- | --- |
| P1 | S | State the current one-batch design accurately and separate Pixel studio evidence from the enclosing scenes counters. |
| P1 | M | Bind requests, locks, versions, and source metadata to document revisions. |
| P1 | M | Give modes consumed-field contracts and templates bounds/anchors/alpha masks; fix legal-placement clipping. |
| P1 | L | Add direct layer/mask editing and a genuinely conditioned composition flow using the same renderer. |
| P2 | M | Add local phase, pause/scrub, stopped static loops, and deterministic PNG/sprite-sheet export. |
| P1 | M | Build the independent paired suites and oracle/rule baselines before claiming staged quality or latency gains. |

The document, mask, and recipe system could later support user-edited game sprites or reactive pixel art driven by a live control. Its evidence should stay separate from the newer outcome-framing drawing experiment unless a deliberate matched study connects them.

## Investigation log

Read the original catalog entry, Pixels component, question builder, renderer, recorder, publication mapping, complete decoded composition plans/answers and legacy pixel rows, legacy runner, gateway limits, and relevant test search results. No Pixel studio-specific tests were found. Ran `bun jev-experiments/quality-and-simulation-review/probes/pixels.ts`, which executes actual source with a rectangle rasterizer and a mocked React/deferred-request harness. It records field consumption, exhaustive single-object positions, alpha behavior, version/lock/mode races, and redraw scheduling in `probes/pixels.json`.

Viewed the generated `probes/pixels.png` contact sheet. Top row: recorded scene, sprite, pattern at time zero. Bottom row: prepared initial scene, legal robot placement with clipped antenna, and moon with opaque cutout. This is an offline rasterization of the renderer's integer rectangles, not a browser screenshot or human quality study. Verified the linked primary library documentation. No live model calls, browser runs, app edits, or commits were made.
