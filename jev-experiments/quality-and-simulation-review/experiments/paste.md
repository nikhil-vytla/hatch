# Smart paste audit

Verdict: repair. The fact-selection design is useful, but the claim "Exactly the right thing pasted" is ahead of the evidence. The three recorded examples contain 15 decisions and no abstentions. One recorded choice maps an office address to company headquarters without evidence that the two are the same, and ordinary edits can make the application apply a decision to text the model never saw.

This review executed offline Bun probes against the current component and extension source. It did not run a browser or call a model. Paths below are relative to `jev-experiments/`; the companion is included because this page distributes it as the same paste experience.

## What it does now

The catalog asks whether Jev can match facts to fields and recognize when it needs help at `experience-prototypes/src/catalog.ts:38`. The visitor chooses Conference, Contact, or Memory, edits source text and field labels, requests suggestions, accepts one field or all fields, and can undo. The source panel highlights the selected line. Personal memory is a prepared text example in the app, not a persistent memory system.

Jev chooses one candidate line ID or `none` for each field. The app asks it to respect entity, purpose, and time at `src/new-experiments.tsx:78`. Code splits lines at the first colon, builds candidates, and copies the selected candidate's remaining text into a form input at lines 63 and 120. The model cannot extract a substring, combine an address, normalize a date, inspect actual HTML, or write a value outside that candidate set. Every app destination is a text input. The companion supplies real field types and select options, but uses a separate prompt and parser at `extension/background.js:61` and `:97`.

`experience-prototypes/publication.json:22` publishes `results/paste.jsonl`. Decoding its skeleton and item records gives three rows with five choices each, 24 source facts in total, and no `none` choices. All requests returned on their first attempt, with recorded total latencies of 632, 301, and 432 ms. These are three authored demonstrations, not accuracy or tail-latency measurements. The recorder saves source text and answers, but no gold labels, destination schema, full request, or baseline at `scripts/record.ts:39`.

## What already works

- The model chooses from source-backed candidates with an explicit `none` option. The gateway validates returned option IDs at `server/gateway.ts:188`, and the UI shows source labels beside suggestions at `src/new-experiments.tsx:215`.
- The examples contain useful distinctions: organizer versus venue, work versus personal email, and current versus previous address at `src/new-experiments.tsx:32`. The Conference and Contact mappings are inspectable in full, and the Memory failure remains in the published data at `results/paste.jsonl:4`.
- The extension reviews each value before acceptance, refuses a write if the target changed, handles exact select options, checks write-back, and never submits the form at `extension/content.js:140`. Its undo preserves subsequent manual edits at line 118. These protections provide a good reference for repairing the app.
- The extension omits destination URLs, retains only source origins, and restricts stored keys to trusted extension contexts at `extension/background.js:1`. The existing three extension tests passed with 17 assertions. They establish the tested privacy/authentication behavior, not semantic accuracy or browser compatibility.

## Findings

### P1: The uncertain unsupported choice receives an ordinary fill action

In the recorded Memory row, `Company headquarters` selects `fact4`, `Office address: 210 Mission Street, San Francisco`. The source never says this is headquarters. The response contains confidence 0.45 and candidate probabilities 0.51 for `fact4` versus 0.48 for `none`. The app retains only `a.value` at `src/new-experiments.tsx:112`; its bulk action fills every matched fact at line 120. None of the 15 recorded choices abstains. This is a concrete failure of the catalog's "recognize when it needs help" question, not a provider availability problem.

The experiment has no independent labels, scorer, or competing policy. A confident-looking fixture display cannot establish general paste quality, and this uncertainty is visible only by opening the raw state. The record also omits the exact field schema and prompt, so a future source edit can change how old answer IDs are interpreted.

Keep the record and mark the headquarters suggestion as unsupported by the available evidence. Add independently authored accepted-source sets and explicit missing/conflicting cases. Preserve full requests, schema hashes, model identity, and attempts. Make "needs review" distinct from a supported suggestion; exclude unresolved choices from bulk fill. Tune any probability or margin threshold on separate development cases, since these scores are not established correctness probabilities. Compare the app and companion separately until they share a protocol.

### P1: Candidate construction loses content and cannot deliver the advertised page-to-form behavior

The executed app parser turns bare `https://northstar.example` into value `//northstar.example`, and bare `9:30 AM` into `30 AM`. The actual extension background code does the same. A sentence containing a person's name, company, and email remains one indivisible candidate. Those facts cannot become separate correct field values regardless of model quality. The implementations are at `src/new-experiments.tsx:63` and `extension/background.js:61`; exact probe output is in `quality-and-simulation-review/probes/paste.json`.

The companion sample adds a second limit. Its destination uses `type=date` and `type=time` at `public/companion-demo/destination.html:61`, but its source contains `October 12, 2026` and `9:30 AM`. The companion copies raw values, detects a rejected write, restores the original, and asks for manual formatting at `extension/content.js:148`. That fallback is honest, but the default sample cannot complete these two fields through the suggested accept action. This conclusion follows source and the HTML date/time value rules, not a browser test. [HTML input standard](https://html.spec.whatwg.org/multipage/input.html#date-state-(type=date)).

Use one shared candidate builder that preserves immutable source spans and original text. Recognize labels without treating URL schemes or clock punctuation as separators; extract typed email, URL, date, and time spans. Give Jev source-backed candidates and validated formatting alternatives. Code should produce `2026-10-12` and `09:30` only with explicit locale/reference rules, and request clarification when a date is ambiguous. Add actual native-control checks to the demo and show supported input scope beside the paste action.

### P1: An old response can be applied to a new source or destination

Editing source text clears suggestions at `src/new-experiments.tsx:309`, but the request at line 331 has no revision guard. Its callback always installs answers at line 335. Both fact IDs and field IDs are positional. In the offline component probe, a request started on the Conference source, the source changed to `Event: Changed while request was running`, and the old `fact0` answer was accepted as that new value. The model never evaluated it. Field relabeling or preset changes have the same missing request binding.

Attach a source revision, destination revision, and request ID to every result. Ignore or cancel requests when either revision changes. Bind each suggestion to a stable field identity, exact source span, and expected existing field value, then check those bindings again when accepting. Record loading should verify its input/schema hash too. An obsolete result can remain inspectable as history, but must not become an actionable suggestion for the current form.

### P1: Bulk fill and undo can overwrite manual work or another example

The bulk action writes over existing values without showing replacements at `src/new-experiments.tsx:120`. The app saves an entire values object, then restores that object on undo at line 260. In the probe, Fill suggestions replaced `Manual title`; after another manual edit, Undo discarded that later edit and restored the earlier title. Switching to Contact after an accept did not clear history at line 290, so Undo placed the previous conference title in `Full name`. The same omission occurs when entering Personal memory at line 142.

Use field-level transactions containing field identity, before value, applied value, and form revision. Default bulk fill to empty, eligible fields. List nonempty replacements separately and let the visitor choose them. Undo only fields whose current value still equals the applied value, preserving later manual edits. Scope or clear history on preset/schema changes. The companion already follows much of this write/undo pattern and should share the implementation rather than maintaining divergent behavior.

### P1: A modest source exceeds the gateway limit, and truncation is invisible

The companion accepts up to 30,000 captured characters at `extension/popup.js:37`, then retains only 80 nonempty lines at `extension/background.js:65`. It independently retains only 24 fields at `extension/content.js:55`. Neither omission appears in the returned suggestion state. The full fact descriptions are duplicated in every field's choice criteria at `extension/background.js:97`.

An executed request containing 80 lines, 7,189 source bytes, and 24 fields serialized to 205,107 bytes. The actual gateway validator rejected it against its 100,000-byte limit at `server/gateway.ts:33`. Another probe supplied 81 lines; the background payload silently retained 80. A missing field can therefore mean missing evidence, truncation, or failed transport, while the interaction presents only a generic unsupported result or error.

Measure serialized payload bytes before calling the provider. Keep full source text once in shared state and compact candidate references in per-field criteria, subject to a validated prompt contract. Batch fields within both byte and question budgets while preserving source revision and complete outcome counts. Show omitted lines/fields and allow scope selection instead of silent slicing. Distinguish "unsupported", "not evaluated", "too large", and "request unavailable" in the UI and evidence records.

## A richer interaction: resolve a mixed-source form

The visitor is arranging travel for a conference. They receive the current event page, an older event notice, and personal notes containing home, shipping, and work addresses. The destination has eight native fields, including event date, venue address, contact email, attendee shipping address, and company headquarters. An existing manual entry and an unsupported headquarters field are deliberate parts of the case.

The visitor chooses destination purpose and source scope, runs matching, and compares proposed values with source spans and the deterministic baseline. They accept the supported empty fields, open the unresolved headquarters field, and either leave it blank or add explicit evidence. While a second request is pending, a scripted date change arrives. The old response becomes visibly stale. The visitor edits one accepted field manually, then undoes the remaining accepted changes without losing that edit. Nothing submits automatically.

State includes source documents and effective dates, span IDs, typed candidates, field IDs and constraints, source/form revisions, pending request ID, proposals, unresolved reasons, and accepted transactions. Actions are edit source, change scope, request, cancel, inspect, clarify, accept field, accept eligible fields, manually edit, and undo. Jev chooses among candidates or finite unresolved reasons such as missing evidence or conflicting entities. Code extracts and formats candidates, enforces constraints and revision checks, manages requests and transactions, and scores the final state. Jev supplies the semantic connection between a field's purpose and the right source fact; it does not control form submission or invent missing data.

Failures preserve the current form. Missing evidence offers a targeted clarification; an invalid formatted value stays unfilled; expired results are read-only; partial batches report exactly which fields were evaluated. Acceptance criteria:

- The office-address-only fixture leaves headquarters unresolved and outside bulk fill.
- The conference date and time become valid native-control values with visible source attribution.
- Every accepted value traces to the exact evaluated source revision and approved formatting rule.
- Editing source, schema, or target value blocks stale acceptance; delayed responses cannot restore eligibility.
- Undo preserves later manual edits and never crosses destination sessions.
- All 81 source lines and 25 destination fields are either evaluated or visibly reported as excluded; no request exceeds the configured payload budget.
- Recorded replay, deterministic baseline, and live exploratory runs are clearly named and never pooled into one accuracy score.

## Evaluation that could support a claim

There is no external benchmark or official split attached to Smart paste. Keep this an authored form-matching study and publish its generator, fixtures, independent labels, and scorer. No external benchmark score is proposed here, so there is no external split count or official metric to imply.

Create 60 development cases and a disjoint held-out set of 300 source/form bundles, eight fields per bundle. Use six strata with 50 cases each: entity/purpose conflicts, temporal conflicts, missing/ambiguous evidence, prose and multi-fact lines, typed normalization and locale ambiguity, and long sources with unrelated or instruction-like text. Cases may carry multiple tags. Hold out semantic templates and organizations, not merely names substituted into the same template. A second author specifies accepted source spans, permitted normalizations, required abstentions, and valid final values before seeing predictions. Resolve annotation disagreement before freezing the set. Permit multiple equivalent supporting sources where appropriate.

Run three presentation seeds per held-out case, changing candidate order, irrelevant line order, and field paraphrases while preserving each case's truth. This gives 900 logical requests and 7,200 field decisions per prompt protocol. Evaluating both current app and companion protocols requires 1,800 logical requests and 14,400 decisions before retries. Add 30 preselected cases repeated five times without input changes to measure repeat variation, 150 requests and 1,200 decisions per protocol. The complete two-protocol plan is 2,100 logical requests and 16,800 field decisions. Retries are attempts, not new cases. No such model run occurred in this audit. Small local fixtures make full coverage feasible; labels, shared parsing, provider budget, and checkpoints are the work required before execution. Preserve failed outcomes and charge/cost fields without treating recorded zero cost as guaranteed billing.

Baselines are always abstain; case-insensitive exact field/label matching with abstention on ties; a frozen synonym and typed-parser policy; and the existing Jev prompt on the identical candidate set. Evaluate candidate extraction separately by supplying an oracle selector. Compare current and improved candidate builders without attributing parser gains to Jev. For workflow value, use a counterbalanced study with 12 participants and 12 disjoint forms each, ordinary copy/paste versus reviewed suggestions, six forms per condition. Score the submitted local form state independently; no real user data or external submissions are needed.

Report supported-selection precision, recall over answerable fields, unsupported-selection rate, abstention recall on missing/ambiguous fields, exact normalized field-value accuracy, and full-form success. Also report candidate recall, valid-control rate, overwritten-manual-value count, stale-accept count, clarification count, human corrections, completion time, availability, retry-inclusive latency, payload size, and cost per correct completed field. An HTTP 200 or a legal candidate ID is never semantic correctness.

Use 10,000 paired bootstrap resamples clustered by original source/form bundle and stratified by case family. Keep presentation variants and repeats in the same cluster. Report 95% intervals for protocol differences and separate repeat variation. Plot risk against coverage rather than presenting confidence as calibrated probability. Freeze thresholds on development data. A useful release target is a lower 95% precision bound of at least 98% at at least 85% answerable-field coverage, an upper 95% unsupported-selection-rate bound below 2%, and a positive lower 95% bound for full-form success improvement over the strongest deterministic baseline. Report counts and stratum intervals even if the aggregate target passes. Require zero stale writes, unintended overwrites, or cross-session undo failures in 1,000 seeded offline transition sequences, then check native inputs in browser integration tests. The participant study should show no extra final-form errors and a paired completion-time improvement; its small size supports a usability direction, not a population claim.

## Libraries worth using

- [XState](https://stately.ai/docs/invoke) can model editing, evaluating, reviewing, and accepting, with invocation lifetimes that discard results after leaving a state. Keep explicit revision checks at the write boundary too. Jev remains the candidate selector; XState handles when its result is still usable.
- [Chrono](https://github.com/wanasit/chrono) can extract date/time spans with source offsets, known versus inferred components, reference instants, and locale configuration. Code can create validated native input values while Jev chooses the relevant date. Require clarification for missing reference context and ambiguous formats.
- [fast-check](https://fast-check.dev/docs/introduction/) can generate and shrink sequences of source edits, late responses, accepts, and undos. Use it under Bun to enforce transaction invariants. It tests deterministic correctness; it does not turn generated fixtures into independent evidence of Jev's semantic ability.

## Next steps

| Priority | Size | Action |
| --- | --- | --- |
| P1 | S | Label the current evidence as three authored demonstrations, expose the headquarters failure, and persist complete versioned requests and labels. |
| P1 | M | Share revision-bound suggestions and field-level write/undo transactions between app and companion. Add the reproduced transitions as regressions. |
| P1 | M | Share span-preserving typed parsing, add explicit format validation, and preflight payload budgets with visible omissions. |
| P1 | M | Author and review the disjoint cases and scoring contract; run the complete paired protocol after offline checks pass. |
| P2 | M | Build the mixed-source form journey and its baseline comparison; carry the same transactions into a later structured-document paste experiment. |

## Investigation log

Read the current catalog, React component, shared run helper, publication manifest, JSONL decoder, complete three-row record, recorder, gateway validator, companion background/content/popup code, sample source/destination pages, and extension tests. An initial raw-header read incorrectly suggested an empty result; decoding the JSONL item lines established the correct three-row count and corrected that interpretation before the report. The broader review's notes should retain that correction.

Executed `bun test server/extension.test.ts` in the app directory: three tests passed, 17 assertions. Wrote and ran `bun jev-experiments/quality-and-simulation-review/probes/paste.ts` from the repository root. It dynamically reads the actual component through a minimal hook/element harness, executes the actual companion background with mocked Chrome/fetch, and calls the actual gateway validator. It reproduces parser loss, bulk overwrite, later-edit loss on undo, cross-preset undo, stale-response reuse, hidden 80-line truncation, and the 205,107-byte rejected request. Outputs are `probes/paste.ts` and `probes/paste.json`. Consulted the primary documentation linked above for the proposed libraries and native input rules. Only audit outputs changed; the probes used the existing Bun setup and mocked provider responses.
