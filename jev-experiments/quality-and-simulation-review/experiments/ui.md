# Generative interfaces audit

Verdict: repair. Jev makes real component-tree decisions within an app-owned candidate set. The experiment is worth keeping, but its state and stream handling undermine the catalog question about revising an interface without losing edits. The existing evidence supports three prepared initial compositions and one successful revision, not general interactive application generation.

This audit read current source and decoded records, executed offline Bun probes, and checked primary library documentation. It did not run a browser or call a model. Repository paths below are relative to `jev-experiments/`.

## Purpose and actual model authority

The catalog asks, "Can Jev assemble and revise a working interface without losing your edits?" at `experience-prototypes/src/catalog.ts:46`. Visitors choose settings, apartments, or event; compose or revise; interact with bound inputs; replay a recorded build; and select prior versions.

The app gives Jev 10 settings recipes, 10 apartment recipes, or 12 event recipes through `src/ui-catalog.ts:114`. Each recipe already fixes component type, copy, bindings, action parameters, and layout properties. The three apartment records, rent, commute text, and shortlist actions are authored at lines 159 to 187. Jev chooses which recipes to add, which container receives them, and when to finish. On revision it can select supported replace, remove, or move operations. It cannot invent a field, change arbitrary copy or binding paths, implement an action, compute eligibility, or create data missing from the candidates.

This is dynamic composition, not selection of one complete page template. The fixed React registry at `src/generated-ui.tsx:68` renders the chosen tree. The installed composer validates structure and applies legal operations; the server calls the evaluator through `server/compose.ts:25`. Input state is carried through the spec but is not sent to the evaluator automatically. An offline call to the actual composer preserved an edited marker while excluding it from model inputs. That is a useful boundary, but a request such as "show only apartments under my entered budget" needs explicitly supplied derived context or deterministic application logic.

## Evidence and strengths

`publication.json` contains both `ui`, the older layout-classification study, and `composed-ui`, the current renderer's record. `src/main.tsx:610` passes `composed-ui` to this component. Decoding `results/composed-ui.jsonl` gives three finished initial trees with 8, 5, and 10 elements; their recorded elapsed times are 2,753, 1,651, and 21,607 ms. Three earlier attempts remain in `previous_attempts`: two stopped at a limit and one reported unavailable. These runs used changing configurations, so 3/6 is not a controlled success rate.

The separate `results/cloudcheck.jsonl` contains a real settings revision that removed the notifications switch and retained `Preserve this edited name`. It finished in 832 ms and retained its two streamed events. That demonstrates one successful server revision, not the full browser version-history behavior.

- Inputs, selects, and switches use real state bindings at `src/generated-ui.tsx:27`, `:39`, and `:56`. The live revision request passes current state at line 251, and the composer preserves it.
- The model cannot emit arbitrary executable code. Candidate props/actions are app-owned, while the composer validates candidate IDs, catalog compatibility, and tree structure.
- The preview is inert during generation or replay at `src/generated-ui.tsx:325`, limiting conflicts with input edits. Recorded, prepared, live, and partial labels already exist.
- Earlier unsuccessful composition attempts remain published. The footer explicitly acknowledges prepared content and local demonstration actions at `src/generated-ui.tsx:469`.
- Four BYOK tests passed with 71 assertions, including isolated caller keys for concurrent composition/evaluation. They cover transport and credential handling, not composition quality or draft preservation.

## Findings

### P1: Selecting a version discards the current draft

`StateProvider` is keyed by `epoch` and initialized from `spec.state` at `src/generated-ui.tsx:330`. User edits reach `state.current` through `StateObserver`, but versions store only a spec at line 299. Every version click increments `epoch` at line 365, including a click on the already selected version. Replay also increments it at line 210.

The offline callback probe supplied `User-edited draft` through the actual observer callback, clicked the current version, and observed a new provider key with initial name `Alex Morgan`. The next mount therefore starts from the older record rather than the working draft. React documents the reset behavior when a key changes. [React state preservation](https://react.dev/learn/preserving-and-resetting-state).

Keep canonical user data in a stable external store, independent of layout versions. Version entries should contain structure and explicit branch metadata, with a separate policy for restoring data snapshots. Selecting or replaying layout history should preserve the working draft by default. Offer an explicit restore-data action if that behavior is wanted. Do not remount the active version merely because its button was clicked.

### P1: Stream results are not bound to the selected session

Domain controls and version buttons remain active outside the inert preview. Domain switching clears the replay timer but never aborts live composition at `src/generated-ui.tsx:392`. Incoming events always call `setSpec` at line 278. The offline probe started a settings composition, switched to apartments, and then delivered the old completion. The domain stayed apartments while its preview became the settings tree and its badge said `Live Jev composition`; the request signal was not aborted.

The same lifecycle lacks a terminal-event requirement. An offline stream ending after one valid step left the badge at `Jev is composing`, added a partial version, and displayed no interruption notice. Error events set an interrupted label at line 274, but clean early EOF and cancellation take other paths. Version clicks during replay can also compete with the still-running timer.

Bind each request/replay to a domain, base-version ID, and session revision. Abort on a domain/session change and reject all events whose identity no longer matches. Treat finish, unavailable, limit, cancelled, transport error, and premature EOF as explicit terminal outcomes. Preserve the last valid snapshot as an incomplete branch with its cause. Keep a chosen version stable while another branch composes, or disable that navigation deliberately. Test domain changes, version changes, replay, cancellation, and truncated streams together.

### P1: Buttons acknowledge actions without producing application outcomes

The save handler only sets a notice; shortlist only announces that an apartment was added at `src/generated-ui.tsx:337`. There is no saved snapshot, shortlist collection, removal action, or comparison result. The offline probe produced `Sunlit studio added to your shortlist.` without adding a shortlist to state. Changing budget or commute edits bound text but does not alter apartment eligibility, ranking, or prices. The existing footer honestly calls these local demonstrations, but those status messages still do not establish a working task outcome.

Implement a small deterministic domain model: draft preferences, a saved snapshot, selected apartment IDs, and computed affordability/commute status. Save should validate and copy a visible snapshot; shortlist should add/remove a stable ID and expose the collection. Jev can choose what information to show and how to arrange it. Code should own filtering, arithmetic, validation, and action effects. Show unsupported requests against the offered capabilities before making an expensive composition, and retain the `unavailable` outcome when semantic intent cannot be met. Use independently checked action outcomes rather than successful rendering as the functional score.

### P1: The current claim spans incompatible evidence and lacks a revision evaluation

The three current initial trees contain all the main requested content, but do not test a sequence of edits, action correctness, or untouched-state preservation. Settings and event records lack `catalog_version`; their traces use `column` twice and three times, while the current candidate allows one use at `src/ui-catalog.ts:132`. The recorder reuses any finished prior row by domain at `scripts/record.ts:128`, without checking candidate or composer changes. These old trees remain renderable, but cannot be regenerated under the same current candidate-use rules. Only the apartment row carries `catalog_version: 2`.

The older `../results/ui.jsonl` is a separate classifier with 20 planned cases, 12 complete cases, 12 matching layout labels, and 9 preserved layout labels on revision. Its stored 0.60 and 0.45 rates include unavailable cases in the denominator at `src/jev_lab/pilots.py:250`; conditional rates are 12/12 and 9/12. Neither metric tests current generated trees or edited values. The current detail page still loads this old `ui` record for the main record metadata while loading composition separately at `src/main.tsx:658` and `:672`; its download link selects `composed-ui` at line 782.

Trace fidelity also needs work. The recorder collects only `type=step` events and overwrites the complete event's full `steps` array at `scripts/record.ts:142`, losing terminal finish decisions. The server adapter discards gateway attempt, cost, and model metadata at `server/compose.ts:37`. Replay reveals prefixes of the final tree every 550 ms at `src/generated-ui.tsx:205`, not the actual saved event sequence or timing.

Give the component one explicit evidence source with its own manifest. Keep the classifier as historical evidence with separate quality and availability rates. Hash candidates, catalog, composer version, prompt, seed spec, and input-state policy; retain all terminal decisions, attempts, and request counts. Invalidate checkpoints when that identity changes. Build a scored multi-step revision suite and compare paired protocols on the same candidate set. Replay actual snapshots or label the current animation as an illustrative reconstruction.

### P2: The exposed batch strategy cannot run

`server/compose.ts:15` accepts `batched`, but the installed `@json-render/core` implementation accepts `batch` or `sequential` at `node_modules/@json-render/core/dist/index.js:3724`. The wrapper rejects `batch` before reaching the library. The offline probe called both paths without reaching a provider: `batched` raised `Unknown composition strategy`; `batch` raised `Invalid composition request`.

The default sequential path works, so this does not invalidate the recorded trees. It blocks a useful latency/call-count comparison and makes the advertised API option unusable. Derive the request enum from the pinned composer type, or translate one external spelling explicitly. Add offline tests for both supported strategies, edits, and invalid values. Record logical evaluator calls and actual primitive decisions separately, since one batched selection can contain many choices.

## Richer simulation: an apartment decision desk

Start with a catalogue of six synthetic apartments and a visitor's current budget, commute limit, and shortlist. The visitor requests a comparison, changes budget, shortlists two apartments, and saves their preferences. They then ask to place affordable apartments first, move commute above rent, and hide an unneeded section while preserving the shortlist and all entered values. A timeline lets them compare layout branches without resetting their working data. One unsupported request, such as booking a viewing, demonstrates the capability boundary.

The persistent state includes canonical preferences, a saved snapshot, apartment records, selected IDs, validated derived eligibility, layout versions, draft branches, and request IDs. Jev receives candidate descriptions plus the minimum approved derived context needed for selection. It selects presentation recipes, grouping, and order. Deterministic code computes affordability and commute status, validates saves, manages shortlist IDs, checks the tree, handles branch/session lifetimes, and records independent outcomes. A new budget changes derived status immediately without asking the model to do arithmetic; recomposition is an explicit separate action.

If generation fails, the current layout and data remain usable. A partial tree lives on an incomplete branch. A domain or branch switch invalidates late responses. Unsupported actions remain unavailable and never create a success notice.

Acceptance criteria:

- Six supplied records render with source-backed rent and commute facts; no model-created apartments or prices appear.
- A shortlist click changes an inspectable collection exactly once, and removal reverses it.
- Saving creates a visible, validated preferences snapshot distinct from the draft.
- All input values and selected IDs survive reorder, hide/show, layout history, and replay; data restoration is explicit.
- Candidate order changes do not alter preserved data, and a stale response cannot overwrite another branch.
- A failed or cancelled stream ends with an accurate status and a usable prior layout.
- Booking a viewing produces an unsupported-capability explanation, not a simulated success.
- The visitor can inspect the changed tree edges, model decisions, baseline layout, and measured final task outcome separately.

## Evaluation protocol

Use an authored workflow suite. No external dataset or official benchmark score is attached to this experiment, and a layout-classification label is not a proxy for generated-application quality.

Create 30 development workflows and 120 held-out workflows, balanced across the three domains and six families: required content/minimality, grouping/reordering, removal with data preservation, recipe replacement with constraints, unsupported capabilities, and adaptation using explicit derived context. Each workflow contains an initial composition and three revisions with intervening user edits or local actions. Independent authors specify semantic postconditions, required/forbidden controls, allowed tree alternatives, immutable data, and expected action outcomes before seeing model responses. Do not demand one arbitrary pixel arrangement when multiple layouts meet the task. Hold out prompt templates and datasets, not just substituted names.

Run three candidate-order/paraphrase seeds for each held-out workflow, 360 workflows and 1,440 composition sessions per protocol. Compare current sequential composition with repaired batch creation plus sequential edits. At current budgets, the sequential condition permits at most 28,800 evaluator requests, `360 × (32 + 3 × 16)`. The batch-create condition permits at most 18,000, `360 × (2 + 3 × 16)`. The full pair therefore has 2,880 composition sessions and an upper bound of 46,800 logical evaluator requests before retries. These are caps, not a predicted bill. Record actual calls, choice slots, attempts, completion times, and cost. A 10-workflow preflight can check packing and estimate cost, but is not a substitute for the full held-out run. No model run was performed in this audit.

Baselines should include a fixed complete form/comparison, a deterministic rule-based command parser using the same candidates, and a manual component command palette. Compare selection/layout policies with identical recipes and state handling. Otherwise improved atomic apartment cards or better action code can masquerade as better model reasoning. An oracle operation planner measures renderer/state failures independently of model choice. Unsupported requests need labelled negative cases so a policy cannot earn apparent completeness by rendering everything or always finishing.

Measure semantic postcondition pass rate after every edit, complete-workflow pass rate, required-field recall, irrelevant-control count, valid bindings, action correctness, unsupported-request recognition, field-value and shortlist preservation, stale-response writes, replay correctness, and change scope outside the request. Record availability and limit stops separately from semantic failures. Add first usable preview time, time to completed usable workflow, evaluator calls, attempts, cost, and serialized bytes. Validate native interactions at narrow and wide viewports; use automated accessibility checks plus keyboard/focus review, without calling an automated pass full accessibility compliance.

Use 10,000 paired bootstrap resamples clustered by original workflow, keeping its seeds and revisions together, and report 95% intervals by family. Keep transport failures in offered-workflow outcomes and show conditional semantic results separately. Require zero unauthorized data resets or stale writes across 1,000 seeded offline transition sequences and the recorded held-out workflows. Pre-register a 95% lower complete-workflow-success bound of at least 90% for supported tasks and zero observed false successes on unsupported tasks. Report an exact one-sided bound for rare failures: zero failures among 20 independent unsupported workflows still permits a 13.9% upper bound at 95% confidence. This suite cannot establish a below-2% false-success claim; that would need at least 149 independent negative workflows with zero failures, not repeated seeds counted as new cases. Compare batch with sequential using a two-percentage-point correctness noninferiority margin and a positive latency reduction interval. A counterbalanced 12-person, eight-task study can compare manual templates and generated revisions for completion time and final errors; it provides usability direction, not a broad population claim.

## Libraries that directly help

- [json-render controlled state](https://json-render.dev/docs/data-binding#external-store-controlled-mode) already provides `createStateStore` and `StateProvider store`. Keep one stable store per work session while Jev changes the component tree. Use the existing library rather than adding another store solely to fix remounts. Its [Jev contract](https://json-render.dev/docs/jev) also distinguishes structural completion from correctness and documents bounded recipes.
- [fast-check](https://fast-check.dev/docs/advanced/model-based-testing/) supports generated command sequences and shrinking. Exercise edit, compose, switch version, switch domain, replay, cancel, save, and shortlist against a small independent session model under Bun. It verifies lifecycle invariants rather than judging visual quality.
- [axe-core](https://github.com/dequelabs/axe-core) can check the rendered trees after each revision for automated accessibility violations. Pair it with keyboard/focus checks and task outcomes; Jev's contribution remains semantic layout selection, not accessibility certification.

## Next steps

| Priority | Size | Action |
| --- | --- | --- |
| P1 | M | Separate canonical data from layout versions; add stable session/branch/request identity and explicit stream terminal states. |
| P1 | M | Implement inspectable save/shortlist outcomes and deterministic derived apartment status. |
| P1 | S | Correct evidence wiring, checkpoint identity, trace completeness, and the historical classifier's labels. |
| P2 | S | Fix the batch strategy enum and add mocked protocol tests. |
| P1 | M | Build and independently label the multi-step workflow suite, then run complete paired comparisons. |
| P2 | M | Build the decision-desk simulation. Reuse its state/version machinery in adaptive forms and structured-document editing. |

## Investigation log

Read the catalog, full generated-interface component, all candidate definitions, composer wrapper, installed composer code/types, recorder, shared UI helpers, publication wiring, complete initial composition records, all three prior attempts, the cloud revision events, legacy classifier records/scorer, and relevant BYOK tests. The cloud check uses a direct document shape rather than `document.result`; the decoder handled both formats once that distinction was recognized.

Ran `bun test server/byok.test.ts`: four passes and 71 assertions. Wrote and ran `bun jev-experiments/quality-and-simulation-review/probes/ui.ts`. The probe executes actual component callbacks through a small hook/element harness, the installed composer with a deterministic evaluator, and invalid-strategy paths in the real wrapper. It records provider reset inputs, stale cross-domain replacement, premature-EOF status, the notice-only shortlist, both rejected batch spellings, preserved-but-unshared form state, current candidate counts, and record/config differences in `probes/ui.json`. This is code execution evidence, not a browser run or a model-quality test. Only this experiment's report and probe outputs changed.
