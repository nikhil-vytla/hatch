# Intent-based undo

Verdict: redesign. Highest priority: P1. The recorded choice is sensible, but the current document is a projection of five fixed edits and a Boolean. It cannot yet establish that semantic undo preserves a person's later work.

## What exists

The catalog asks whether Jev can select intended edits without undoing unrelated work, at `experience-prototypes/src/catalog.ts:94`. The visitor sees an apartment listing with five authored changes: accent, layout, background, title and corners. Jev judges each edit in one shared-state request; code selects scores at least 0.5 and restores the selected `before` values when Apply is toggled. The visitor can change the request or manually select edits. Jev chooses the subset, while all values, rendering and reversals come from code.

The audit froze source at commit `4c0c40d`. The complete block from `initialDesign` through `UndoExperiment` is byte-identical to current source. References below use current lines, with block and evidence hashes in `probes/undo.json`. The published mapping points to `results/undo.jsonl`; shared `readRecord` reconstructs one request made on 2026-09-20 and five answers. Scores are e1 0.97, e2 0.04, e3 0.94, e4 0.04 and e5 0.31. The selected accent and background edits match the literal color request. All confidence/probability fields are null. Recorded elapsed and service fields both say 292 ms, while the single successful attempt says 272 ms. Preserve those distinct fields instead of calling either end-to-end interaction latency. Cost is recorded as zero; this is not a future pricing estimate.

What works:

- The model/code boundary is explicit at `src/new-experiments.tsx:727`. No model-generated value is written into the design.
- The visitor can inspect all five operations and adjust the selection before applying it, at line 697. The shared state inspector also exports JSON, through `src/shared.tsx:148`.
- The recorded default restores terracotta and cream while retaining list layout, the new title and square corners. The offline callback probe exhaustively checks all 32 subsets against replaying the retained assignments, and all 32 restoration checks pass for this unique-field fixture.
- A model call does not apply the returned selection automatically. The explicit apply step is useful, even though committed state needs repair.

## Findings

### P1: Editing a proposal silently reverses an applied undo

The document is recomputed from every fixed `after` value plus selected `before` values whenever `applied` is true, at `src/new-experiments.tsx:641`. Clicking any history row sets `applied` false at line 707. Completing a model request does the same at line 759. After applying the two color reversals, the probe selects the title for a second operation. Both colors immediately return to blue and sage, before another Apply. A rerun with exactly the same saved answer also restores the entire post-edit document.

An applied operation is therefore not a durable history entry. The UI cannot support a sequence such as undo colors, then independently undo the title. Store the committed document and committed compensating transaction separately from the next proposal. Selection, request editing and model completion must change only the proposal. Apply should commit one checked operation; undoing that operation should be a separate explicit action.

### P1: A request can use obsolete selections and overwrite manual review

Changing the textarea updates only `query`, at line 734. Existing selections, the apply button and recorded provenance remain current-looking. The probe changes the request to “Undo only the title change. Keep every other change,” then clicks Apply without rerunning. The colors revert and the title stays unchanged. While a request is pending, the same query change plus a manual title-only selection is overwritten by the old response at line 753. The state export then pairs the title-only request with the old color decisions.

Bind every proposal to document revision, history revision, request text and selection revision. Query changes should mark old suggestions stale. A late result can be retained for inspection but must not replace a newer manual selection or become applicable to another request. Disable Apply for stale proposals, and keep the request that produced each record alongside its results.

### P1: Five independent assignments do not test selective history or preservation of user edits

The history at `src/new-experiments.tsx:596` contains exactly one assignment per field, no actors, transaction groups, timestamps, dependencies, object identities or later user edits. Despite the `LIVE EDITABLE PREVIEW` label at line 669, there are no controls to edit the design. The three apartment buttons also have no handlers. The only editable text is the undo request.

This makes every operation commute and avoids the central hard case. The original formula fails on a synthetic extension with agent `red → blue`, then user `blue → green`: undoing only the agent assignment produces red rather than preserving the later explicit green assignment. Selecting both returns blue rather than red because the last `before` value wins. These are extension counterexamples, not actions exposed by the current UI.

Replace the flat fixture with real commands over stable object IDs. Record author, transaction, operation order, touched paths, expected values and dependency links. For explicit assignments, define removal of selected events by replaying retained events in order; later retained assignments survive. Structural operations and derived edits need a declared conflict policy. For example, removing an object creation must not silently discard a later unselected text edit on that object. Ask for review or decline the conflicting removal. Do not present arbitrary inverse patches as a solution to this policy question.

### P1: One literal request provides no evidence that a model improves undo

The recorder at `scripts/record.ts:71` sends the same five edits and default request. A field rule selecting `accent` and `background` returns exactly the same subset. There are no retained independent labels, alternate histories, ambiguous requests, corrections or final-state scores. The generic saved record at line 18 contains the result but omits request text, exact edit history and source hash. The live and recorded per-edit instruction strings also differ slightly.

Keep this as a transparent example, not an accuracy or productivity result. Preserve an immutable input/output bundle, shared prompt version, independent intended outcomes and exact final document. Compare model selection with explicit field filters and keyword rules on requests that require actor, temporal and semantic distinctions. Keep invalid or unavailable responses in the denominator. A number such as 0.31 is a raw judgment score here, not an established calibrated probability.

## A richer interaction

Build a small apartment-page editor with working title, layout, corner and palette controls, plus object add/delete/reorder actions. Seed it by executing a real sequence: an agent changes the theme and layout, the user corrects the title and recolors one card, then another agent groups the cards. The visitor can continue editing and say “Undo the agent's color changes, keep my green card and the new layout.” The proposed result appears beside the committed page, with included edits, preserved later edits and conflicts. After applying, the visitor makes another manual change, undoes the accepted transaction, and sees that newer change preserved.

State contains a document revision, stable object IDs, an append-only command log, actor and transaction IDs, dependencies, versioned requests, separate draft selections, committed compensating transactions and a redo branch. Jev selects `undo`, `keep` or `needs review` for candidate operations from the same visible history. Code derives permissible operations, handles dependencies, computes the exact preview, checks revisions and commits atomically. Jev never creates replacement document values. Clarification, provider failure, cancellation or a stale result leaves committed work intact. If a current-value precondition fails, show the conflict instead of overwriting it.

Acceptance criteria:

- Editing a request or selection and receiving an answer never changes the committed document.
- Applying one accepted proposal produces the independently specified document and records one transaction. Reapplying the same transaction ID is a no-op.
- A later retained assignment survives undo of an earlier event on the same path. Undoing all assignments restores the actual base value.
- Manual edits during inference cannot be replaced by a late proposal. Actor filters distinguish the visitor's edits from agent edits.
- Structural dependencies either produce a declared safe result or an explicit unresolved conflict. No hidden cascade removes unrelated work.
- Undo and redo restore exact states when preconditions hold. A new edit after undo branches history explicitly; redo cannot discard it.
- Inspect/export includes the source history, semantic request, raw decisions, human adjustments, accepted patch, conflicts and resulting document hash.

## Evaluation

Current coverage is one authored history, one request and five decisions. The 32 offline subset checks evaluate deterministic behavior on that history, not 32 independent model trials. No external benchmark is claimed.

Create 48 development histories and 240 held-out histories, each with exactly 12 logged operations. Use six held-out strata of 40: independent properties; repeated assignments; mixed actors; temporal or grouped requests; structural dependencies; ambiguous, empty or already-satisfied requests. Keep template families and object naming patterns separate across development and test. Two people independently annotate intended removals, protected operations, required clarification and expected final snapshots. Adjudicate disagreements before seeing model output. For ambiguous cases, an unchanged document plus the specified clarification is the success outcome. The expected snapshots should be authored independently of the transaction reducer.

Evaluate two request paraphrases and two history presentations for every case. Presentation seeds 42 and 43 reorder the visible grouping while retaining explicit event order and dependencies. Compare the current packed score/0.5 protocol with the proposed finite `undo/keep/needs review` protocol. Each condition uses one 12-question request. Total held-out cost is **240 × 2 × 2 × 2 = 1,920 logical requests and 23,040 per-edit decisions**, before retries. A 24-history pilot uses 192 requests and is a subset of that allocation. Verify the 100 KB payload and 128-question gateway limits for every request. No calls in this plan have been made by this audit.

Baselines are deterministic field/actor/time filters, a frozen keyword rule with explicit exclusions, and manual history selection. An oracle selection passed through the same transaction engine isolates execution defects from semantic errors. A plain last-action undo can be reported as the familiar limited baseline, with its limitation stated. All assisted methods must share the same history, preview and correction controls.

Score exact intended selection, exact final snapshot, unintended mutations of protected operations, clarification precision/recall, reviewed-operation count, provider availability, and wall-clock/cost distributions including retries. Report score-threshold tradeoffs on development data; never tune the cutoff on held-out snapshots. Use 10,000 paired bootstrap resamples clustered by base history, keeping paraphrases and presentations together. A provisional release gate is a lower 95% bound of at least 90% exact outcome success and no observed unrelated writes. Publish the interval for the latter rather than interpreting zero observed defects as zero risk.

Separately run 1,000 seeded offline command schedules covering edits, conflicting writes, pending results, cancellation, proposal revision, apply, undo and redo. Require zero silent stale writes, duplicate commits or losses of retained edits. Use a simple independent operation specification instead of comparing the reducer with a copy of itself. Then run 12 reviewers through 12 counterbalanced tasks each: 48 manual, 48 keyword-assisted and 48 Jev-assisted sessions, with no person repeating a history. Replay frozen decisions, so the study needs no extra model calls. Measure final-state correctness, completion time and correction effort. This is a small usability study, not evidence of population-level productivity gains.

The full authored suite is feasible without external datasets or weights. Its blockers are the transaction implementation and independent annotation effort, not download size. Publish all case inputs, outputs and failures to make the claims checkable.

## Useful libraries and next work

[Immer patches](https://immerjs.github.io/immer/patches/) can capture forward and inverse changes through `produceWithPatches` and apply a checked transaction through `applyPatches`. Enable patch support explicitly. Keep stable object identities, current-value checks and dependency policy in application code; inverse patches do not themselves decide which later edits must survive. Jev contributes the semantic selection over that operation log.

[fast-check's command testing](https://fast-check.dev/docs/advanced/model-based-testing/) can generate and shrink edit/response/apply/undo schedules and replay failures with saved seeds and paths. Its scheduled runner is useful for late-result cases. The reference model should express protected-edit and revision invariants, not duplicate the production reducer.

| Priority | Size | Action |
| --- | --- | --- |
| P1 | M | Separate committed document, proposal and compensating transactions; preserve all reproduced sequences as regression cases. |
| P1 | M | Add request/history/selection revisions and stale-result handling before expanding live editing. |
| P1 | L | Implement stable-ID commands, actor attribution, repeated assignments and explicit dependency conflicts. Add real editor controls. |
| P1 | S | Save exact request/history/prompt snapshots and rename the current preview until it is editable. |
| P1 | M | Annotate the full suite and compare semantic selection with deterministic filters before making quality claims. |
| P2 | M | Run the counterbalanced reviewer study once transaction invariants pass. |

A follow-up can reuse this command log for semantic grouping of a diagram or spreadsheet. The reusable result is a checked, inspectable operation history with intent selection; each new editor still needs its own dependency rules.

## Investigation log

Read the catalog, unchanged Undo component, shared controls, gateway bounds, recorder and publication mapping. Compared the full Undo block and original evidence with `4c0c40d`; decoded the JSONL using shared `readRecord`. Ran `bun jev-experiments/quality-and-simulation-review/probes/undo.ts`. It executes original callbacks with mocked hooks and model completion, checks 32 subsets and restoration states, reproduces proposal resets and stale-selection writes, and marks overlapping-field examples as synthetic extension tests. A probe-only console variable typo was fixed before the successful rerun. No experiment-specific tests were found. Verified both official library pages above. This audit made no browser or provider calls and changed no app files.
