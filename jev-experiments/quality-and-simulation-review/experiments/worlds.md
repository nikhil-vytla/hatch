# Living scenes

Verdict: **redesign**. Highest priority: **P1**. The current experiment is a useful procedural art configurator. Testing whether semantic choices coordinate a persistent world requires an entity model, editable relationships, and independent outcomes. The report describes the source baseline captured in `probes/worlds.json`; concurrent fixes to other experiments are outside this review.

## Current purpose and evidence

The catalog asks, “Can a handful of semantic choices coordinate a living world?” (`experience-prototypes/src/catalog.ts:53`). A visitor selects a recorded brief or submits a new one, sees an animated Canvas illustration and decision chips, and can pause motion or inspect the result (`experience-prototypes/src/creative.tsx:25`). The on-page explanation correctly identifies a procedural renderer and acknowledges limited object-specific rendering (`creative.tsx:129`).

Jev chooses finite labels. The recorded runner asks eight questions: palette, terrain, density, dominant motion, and four shape motifs described as visual layers (`src/jev_lab/pilots.py:38`). The live component asks only the first four, with fewer allowed values (`creative.tsx:73`). Code determines every coordinate, color value, shape path, particle count, motion equation, and background decoration. There are no named entities, object relationships, collisions, causal interventions, or persistent physical state. Four motif labels are reused cyclically across particles, rather than assigned to distinct scene objects (`experience-prototypes/src/motion-art.tsx:132`).

`publication.json` points the visuals entry to `experience-prototypes/results/visuals.jsonl`. Decoding it with the app's `readRecord` yields **20 completed authored scenes and 160 choices**, including 12 scenes recovered after transport failures. These are not an external benchmark or 20 independent demonstrations of visual correctness. The runner's `valid_scenes` check counts the presence of a `scene` key; `human_preference` remains `null` (`pilots.py:121`).

## What works

- The choice space is bounded, and the selected labels and source brief remain inspectable. The caption uses the displayed row's brief, so a draft change alone does not falsely relabel the current picture (`creative.tsx:41`, `:50`, `:135`).
- The renderer supports responsive Canvas sizing and device pixel ratio, cancels animation frames on cleanup, and handles reduced motion (`motion-art.tsx:29`, `:220`). These are useful foundations even though pause semantics need repair.
- The runner explicitly leaves visual preference unmeasured (`pilots.py:125`). Recovery targets transport failures, keeps completed predictions, and preserves the original error on recovered rows (`experience-prototypes/scripts/recover.ts:31`, `:76`). That improves availability without pretending failed requests were incorrect semantic choices.

## Findings

### 1. P1: Recorded and live worlds have different decision contracts

The recorded questions contain `shape0` through `shape3`, `monochrome`, `flat`, and `bounce`; the live questions omit them (`pilots.py:38`; `creative.tsx:73`). Six of the 20 recorded plans use at least one excluded palette, terrain, or motion. Live requests also lack all 80 recorded motif decisions. An offline probe of the actual drawing code found different Canvas command traces for all 20 scenes when retaining only the four live fields, including changes to particle size as well as motif (`motion-art.tsx:152`). This is a command comparison at one specified size/time, not a screenshot or perceptual quality result.

A visitor cannot reproduce several showcased plans through the current button, and recorded evidence does not establish the behavior of the live protocol. Define one versioned scene schema and question builder for recording and live use. Persist prompt, option descriptions, renderer version, and source with each result. Replay the same plan through both paths and require equal state and drawing commands at the same local time. Keep legacy records labeled by their actual schema.

### 2. P1: Terrain controls object presence, while movement labels do not describe a coherent world

The default brief requests a moonlit garden with a pond, but its `stars` terrain produces no pond. The desert brief receives `hills`, which unconditionally adds 12 stem/leaf forms and a pond with five ripples (`motion-art.tsx:102`, `:192`). The offline drawing trace confirms zero ellipses for the first scene and 18 for the desert. These are concrete brief mismatches, not judgments about whether the art is attractive.

Every scene also receives the same sun/moon disk, and all particles share the selected movement equation (`motion-art.tsx:57`, `:138`). “Grow” moves particles upward and wraps them; it does not grow a rooted plant. In the recorded flower scene, the first particle remains radius 4 while its y-position changes from 350 to 200 to 350 at 0, 20, and 40 seconds. The renderer cannot express pond containment, fireflies near light, or flowers growing toward a target.

Separate terrain, explicit object presence, and behavior. Give supported entities stable IDs, roles, anchors, and relationships. Jev should choose a bounded semantic plan or patch; code should implement the resulting rules. Report unsupported requested details instead of silently mapping each to a generic motif. Retain this renderer as the procedural art baseline so added simulation complexity must earn its place.

### 3. P2: Pause jumps to a fixed frame

`draw` uses `t = paused || reduced ? 4 : time / 1000`, and changing `paused` restarts the effect (`motion-art.tsx:41`, `:239`). Pausing at 13 seconds therefore produces exactly the active four-second command trace. The first particle jumps about 49 pixels horizontally in the probe. Resuming uses the current animation-frame timestamp rather than elapsed scene time.

Pause should retain the displayed state. Use a scene-local accumulated clock, a fixed simulation step where needed, and an explicit reset/seed. Separate the static reduced-motion presentation from pause. Verify unchanged coordinates while paused, continuous resume, and repeatable state under the same seed and event schedule. This also makes temporal evaluation possible.

### 4. P1: A late live result replaces a newly selected recorded world

The live callback unconditionally calls `setRow` after awaiting the request; the recorded selector remains active and changes `index`, `row`, and `brief` independently (`creative.tsx:99`, `:112`). An offline execution of the actual callbacks started a garden request, selected the coral reef, and then resolved the old request. The selector and draft still showed the reef, while the displayed row and caption had returned to the garden. The caption remained faithful to the displayed row, but the selected world did not.

Bind each request to the submitted brief and current world revision. Ignore or retain a late result in history when that revision has changed. Give recorded and live rows explicit provenance, and make the active selection match the displayed result. A rejected or failed request should preserve the previous world and explain what happened. This needs a local regression test rather than a model call.

### 5. P1: Availability and renderability leave the central hypothesis unmeasured

All 20 rows have scene choices, but the scorer checks only that the `scene` key exists. There are no independent object, relationship, temporal, or visual preference outcomes, no matched baseline, and no reported human ratings (`pilots.py:107`). Twelve recovered transport cases should remain part of the availability account, not evidence of improved scene quality. No Worlds/MotionArt-specific tests were found in the inspected test/spec paths.

Create expectations before collecting model answers, measure supported brief constraints separately from visual appeal, and use the same renderer across decision policies. Include local revisions and interventions: an attractive initial frame cannot establish that a world retains objects or responds coherently. Keep the original 20 public briefs as development fixtures, not a held-out score.

## Richer simulation: a garden that responds to edits and actions

Start with a small moonlit courtyard containing a pond, rooted plants, fireflies, loose leaves, and a draggable lantern. The visitor asks for a stronger breeze while keeping the pond and plants. Leaves respond to wind, stems bend around fixed anchors, and pond ripples change through explicit rules. Dragging the lantern changes the fireflies' attraction target. The visitor can lock an object, ask for a local change, pause, step, and restore the original seed. The UI exposes which request changed which entities.

State contains entity IDs and types, position/velocity where relevant, root anchors, shape/appearance attributes, locks, containment and attraction relationships, wind, local time, seed, and world/request revisions. Jev maps language to typed additions, removals, parameter changes, and supported relationships. Code validates the patch, preserves untouched state, applies motion and collision rules, and renders. No model call occurs per frame. An unsupported fluid or biological request is identified as unsupported; the garden uses declared stylized rules rather than claiming physical realism.

Invalid patches and stale responses leave the active world intact, with a short explanation and inspectable proposed changes. Failure must not quietly create substitute objects. Acceptance criteria:

- A requested pond is present independently of terrain; unrequested plant/pond decorations are not forced by a hills choice.
- A local edit retains untouched IDs, positions, relationships, and locked attributes.
- Wind and lantern interventions have the specified effects; rooted anchors stay fixed and contained entities remain in their permitted region.
- Pause preserves state, resume is continuous, and a fixed seed plus event schedule repeats within a declared numerical tolerance on a pinned engine version.
- Every applied patch matches its world revision. Unsupported clauses and unapplied changes are visible.

## Evaluation protocol

Use an authored suite; there is no suitable external benchmark claimed here. Keep the existing 20 briefs and 30 newly authored development cases separate from **120 held-out base sequences**, 20 in each family: object/spatial constraints, local edits with preservation, physical interventions, temporal/growth behavior, ambiguous aesthetic requests, and unsupported requests. Each sequence has an initial brief and three revisions or interventions that require a semantic decision. Author expected supported clauses, acceptable alternatives, forbidden additions, preservation requirements, and trajectory rules before examining predictions.

Run three scene seeds and two wording variants per base sequence: **720 sequences and 2,880 logical Jev requests** before retries for one planner protocol. Seeds control the simulation, not independent samples of user intent. Count actual primitive choices, latency, retries, and billed requests separately; batching several choices is not several independent successes. Freeze prompts and schema after development, and do not tune against the held-out wording.

Compare the Jev planner with a deterministic keyword/rule planner, a seeded legal random planner, and an independently authored oracle plan. These use the same entity vocabulary, renderer, seeds, event schedule, and allowable patches. The oracle estimates the renderer's achievable ceiling. Keep today's four/eight-label artwork as a separate limited-capability baseline on the constraints it can express; do not score missing capabilities as proof of worse model reasoning.

Primary outcome: the share of supported sequences satisfying **all** required semantic, preservation, and temporal constraints across their four decision points. Report clause coverage, forbidden additions, unsupported-request handling, state preservation, containment/anchor violations, pause/resume discontinuities, stale-result acceptance, and end-to-end availability separately. Measure frame cadence and request latency alongside correctness. A provisional release target is a 95% lower confidence bound of at least 90% on supported full-sequence success, plus zero observed stale-result applications or lock/anchor violations in the declared suite. Publish failures even if visual ratings are favorable.

Use 10,000 paired bootstrap resamples clustered by the 120 base sequences, retaining each sequence's wording variants, seeds, and edits together. Report each family and the paired difference from the rule planner. Twenty unsupported base cases are only a screening set: zero failures would still give a one-sided 95% binomial upper failure bound of about 13.9% when treating base cases as independent. Add a separate offline suite of 1,000 seeded event schedules for pause, response ordering, locks, containment, and repeated resets. These need no provider calls and do not increase the number of independent semantic cases.

For appearance, prespecify 60 Jev-versus-rule sequence pairs across the six families, with three blinded raters each: **180 paired judgments**. Show equal-duration 12-second clips with matched size, frame rate, palette, and seed. Ask brief fidelity and aesthetic preference separately; randomize side/order. Report uncertainty clustered by sequence, agreement, and missing judgments. A beauty preference cannot substitute for a failed requested object or state invariant.

The proposed suite needs new independent labels, entity rules, and future provider budget. It requires no large asset or weight download. None of these model requests or human ratings were run during this audit.

## Useful libraries

- [Matter.js Engine](https://brm.io/matter-js/docs/classes/Engine.html): fixed-step updates, bodies, forces, and collision events can implement loose leaves and movable obstacles. Its time scale can stop progression. Pin the version and verify numerical repeatability; these APIs do not establish cross-platform determinism or simulate fluid/plant biology. Jev contributes the semantic choice of entities and rules, while the engine performs motion.
- [PixiJS events](https://pixijs.com/8.x/guides/components/events) and [Ticker](https://pixijs.com/8.x/guides/components/ticker): scene entities can have hit areas and pointer interactions, while explicit ticker control supports pause/step. Adopt it only if the entity interaction benefits justify replacing Canvas; the current renderer can implement a local clock directly. Jev connects a natural-language edit to the selected entity and available operations.

## Prioritized work

| Priority | Size | Action |
| --- | --- | --- |
| P1 | S | Share and version the recorded/live contract; label source and replay equal plans through both paths. |
| P1 | M | Bind results to world revisions and add the recorded-selection race regression. |
| P2 | S | Replace the global timestamp/fixed pause phase with local time, pause, step, and reset. |
| P1 | L | Build the garden entity model and a small set of causal rules; preserve the current artwork as a baseline. |
| P1 | M | Author the independent suite and oracle/rule baselines before expanding scene polish. |

The resulting entity and patch system can support a later experiment on natural-language control of a small game or weather sandbox, with the same preservation and temporal checks.

## Investigation log

Read the catalog, Worlds component, MotionArt renderer, original scene questions/scorer, publication mapping, decoded scene records, recovery path, and relevant test/spec search results. Counted all 20 scene rows and 160 choices, and checked recorded/live options against each plan. Ran `bun jev-experiments/quality-and-simulation-review/probes/worlds.ts`: the probe executes current drawing code with a recording Canvas stub and executes Worlds callbacks with mocked hooks and a deferred request. It records source hashes, all 20 command comparisons, default/desert geometry, pause/growth samples, and the late-response state mismatch in `probes/worlds.json`. This was an offline source/callback audit, not browser rendering, visual assessment, or a live model run. Verified the linked Matter.js and PixiJS APIs against their primary documentation. Only review reports and the original probe were written.
