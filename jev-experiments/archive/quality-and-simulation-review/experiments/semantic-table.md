# Semantic spreadsheet

Verdict: **repair**. Highest priority: **P1**. The core interaction, asking the same question of many rows and inspecting the answers, is useful and can remain. It needs reliable question/row identity and effective corrections before it can support a working review queue. Findings refer to the baseline hashes in `probes/semantic-table.json`.

## Current purpose and evidence

The catalog asks whether semantic columns can reduce the work of reviewing messy records (`experience-prototypes/src/catalog.ts:86`). The current page is an eight-row conversation review table with one editable question, model scores, a match filter, a detail panel, a correction dropdown, and JSON export (`experience-prototypes/src/new-experiments.tsx:395`). Conversation text is not editable, rows cannot be added or imported, sorting is not connected to header controls, and there are no aggregate summaries. These are scope limits, not observed failures of nonexistent features.

Jev returns one `noul` value per row. One request supplies all eight conversation texts in shared state and eight questions referring to their IDs; the live prompt adds “Use only that conversation as evidence” (`new-experiments.tsx:547`). Code applies a 0.5 threshold, chooses Yes/No badges, filters rows, manages selection, and exports the review. The fixture's `promised` and `completed` booleans are authored source annotations, not model outputs. They are not sent in the request.

The publication points to `experience-prototypes/results/semantic-table.jsonl`. Its decoded record contains eight answers from one successful request, 264 ms reported latency, no retries, and no stored input snapshot. Comparing the saved threshold decisions with the **derived fixture predicate** `promised && !completed` gives 8/8 agreement: three positives and five negatives. This is a check of eight authored examples, not a measured general accuracy rate, calibration result, or evidence of reduced review time.

## What works

- All conversation text and judgments are inspectable, and the page explicitly says the eight examples are not a general accuracy benchmark (`new-experiments.tsx:536`).
- Fixture annotations remain outside model input. The actual request probe contains only a `conversations` map in state, eight row-specific questions, and no gold-label keys. Filtering changes the view, not the set evaluated by Evaluate the column (`new-experiments.tsx:449`, `:550`).
- Selection and correction handlers use the underlying domain ID, so the inspected row currently remains correctly identified after filtering (`new-experiments.tsx:421`, `:520`).
- Editing the question immediately clears old scores in the ordinary synchronous path (`new-experiments.tsx:464`). That is the right dependency behavior; it needs the same protection against outstanding requests.

## Findings

### 1. P1: A late response can label and export the wrong question

The request captures the old `query`; after it resolves, the callback unconditionally installs scores on the current rows and sets `last` (`new-experiments.tsx:546`, `:562`). The query field remains active. The actual callback probe starts the default outstanding-refund question, changes it to “Is a successful refund evidenced?”, and resolves the old answer. Maya's old 0.88 appears under the new question, and Export review pairs that new question with 0.88. These questions have different meanings; this is an artifact identity defect, not uncertain model reasoning.

Bind results to a question version, row ID, row-content hash, and prompt/schema version. A changed dependency invalidates a pending commit. Preserve stale responses as historical evidence if useful, but never display or export them as current. When row editing is added, only the affected row's semantic cells should become stale; sorting or filtering must not invalidate content.

### 2. P1: Corrections are stored but do not correct the review queue

The dropdown writes `row.correction`, while badges and the match filter use only `row.score` (`new-experiments.tsx:430`, `:449`, `:517`). In the probe, marking Maya “Already resolved” leaves her at Yes · 88% and in the matches 01/04/08. Conversely, marking a model-negative row “Needs follow-up” would not make it a match. Export retains the raw score and correction without an explicit effective decision. Changing the question resets all rows to `supportRows`, deleting corrections (`new-experiments.tsx:466`).

Define an effective value with visible precedence: a current human override, otherwise a current model judgment, otherwise unknown. Use it consistently in badges, filters, summaries, and export, while retaining the raw model result separately. Scope overrides to the row and question versions and retain an audit history when the question changes. For arbitrary questions, use Yes/No/Uncertain or question-specific labels; the fixed “Needs follow-up/Already resolved” vocabulary does not fit every editable question.

### 3. P1: Published scores and fixture facts are not bound to an immutable evidence contract

The saved file contains answer IDs, timing, and source metadata but no original conversations, full question, fixture hash, or annotation version. The component applies answers to whatever `supportRows` exists in current code (`new-experiments.tsx:405`; `experience-prototypes/scripts/record.ts:51`). A later fixture edit could silently display an old score against new text. The recorder's prompt also lacks the row-isolation instruction used by live requests.

The “Independent fixture facts” panel is better understood as authored annotations. Row 02 sets `promised: true` although its text reports a completed refund without an explicit earlier promise (`new-experiments.tsx:345`). That does not change the default compound target because completion is true, but it exposes an undefined annotation rule. For a timeout or absent transaction confirmation, lack of success evidence is also different from knowing no payment occurred. The model judges supplied text, not an external payment ledger.

Store the exact input snapshot, question, policy, annotation definitions, and source hashes with each record. Keep authored labels separate from predictions and identify their provenance. Define `promiseEvidence` and `successEvidence` as present/absent/uncertain where appropriate, rather than presenting all annotations as verified real-world facts. Add evidence spans or references for human inspection, and reject or mark incompatible recorded inputs instead of silently joining by ID alone.

### 4. P2: Filtered coverage and table identity need explicit handling

With Only show matches checked, editing the question leaves the table empty because all eight scores are now undefined and the filter excludes them (`new-experiments.tsx:449`). There is no coverage or empty-state explanation. A synthetic two-answer record similarly hides six unknown rows while showing one match; the published record itself is complete, and the live gateway rejects incomplete responses. There is currently no aggregate to miscalculate, but a future summary must not equate unevaluated, stale, or failed rows with No.

The installed TanStack core uses index IDs because `getRowId` is absent. Its table ID `1` refers to Leo before filtering and Theo afterward; React keys therefore change meaning (`new-experiments.tsx:448`, `:494`). Current business selection still uses `row.original.id`, so the audit did not reproduce wrong-row selection. The headers also have no sorting handlers despite configuring a sorted row model.

Use the stable domain ID as the table row ID, wire sorting deliberately if offered, and keep editable state independent of visible position. Show current matches, evaluated rows, unknown/stale rows, and failures separately. An empty filter should say whether there are zero matches or zero current evaluations. Preserve these distinctions when aggregation is introduced.

### 5. P1: One shared-context batch does not establish row isolation or review value

Every judgment can receive the entire table through shared state, and the single saved batch contains only eight short, authored conversations. It does not test reordered rows, similarly named customers, contradictory neighboring evidence, long conversations, or independent row payloads (`new-experiments.tsx:547`). There is no measured comparison with a rule filter or manual review, and no test showing that eight returned values are calibrated probabilities. The display uses percentages, but the record's `probabilities` and `confidence` fields are null.

The existing data supports a working demonstration and a derived-fixture agreement check. It cannot yet support an efficiency claim or prove that unrelated rows cannot influence an answer. Compare shared-table batching with isolated rows and row-local evidence embedded in each question. Measure reviewer work and errors separately from request latency. Keep the threshold fixed during held-out evaluation or select it on development data; present the number as a model score unless calibration has been measured.

## Richer interaction: a review sheet that stays current

Start with an imported or authored support table containing stable case IDs and conversation text. The visitor creates a semantic column, reads its definition, and evaluates the sheet. Results appear by row with current/pending/unknown/failed status. Clicking a result shows the relevant text spans, the raw judgment, and any human override. A second column can extract success evidence while a deterministic formula combines the two columns into a follow-up view.

The visitor edits a conversation to add a confirmation message. Only dependent semantic cells become stale; sorting and filtering remain usable. They can recompute affected rows, correct an ambiguous result, and see the effective match count update. A delayed response for the old text cannot overwrite the new version. The sheet can pause and resume a batch without losing completed rows. Export includes the current source data, column definitions, effective values, raw judgments, overrides, and coverage.

State consists of row IDs/content hashes, column definitions and versions, dependency metadata, per-cell status, raw model answer, evidence references, model/request IDs, and versioned human overrides. Code owns dependency invalidation, batching, joins, formulas, sorting, aggregation, and export. Jev interprets the requested semantic property from the allowed row evidence. It does not decide which rows disappear or invent aggregate totals. Use conservative named formula operations initially, rather than asking the model to author arbitrary spreadsheet code.

A summary should say, for example, “18 effective matches among 92 current evaluations; 5 pending and 3 failed,” not “18 of 100” with the missing states silently treated as negatives. Human overrides count only when their source row and column definition are current. A review of text should also say whether it is judging evidence in a conversation or reconciling a separate authoritative record.

Acceptance criteria:

- A semantic cell belongs to one row-content hash and one column version; stale results never become current through sorting, filtering, or delayed delivery.
- Human overrides visibly control the effective value everywhere and remain auditable after changes.
- Editing one source row invalidates only its dependent cells. View changes do not cause new model calls.
- Row order, duplicate customer names, inserted/deleted rows, and asynchronous batch completion cannot change result identity.
- Summaries and exports separately account for current model values, current overrides, unknowns, stale cells, pending work, and failures; their denominators reconcile with the source table.
- A stopped or failed batch preserves valid completed rows, exposes remaining work, and resumes by versioned identity without replaying completed decisions unnecessarily.

## Evaluation protocol

Use an authored evidence-review benchmark with a declared scope; this is not an external dataset or an official spreadsheet benchmark. Keep the current eight cases plus 60 new cases for development. Hold out **300 conversations**, 50 each covering explicit unfulfilled commitments, clear success evidence, denied refunds/alternative credit, temporal changes and tool uncertainty, quoted/conditional statements and multiple actors, and confusing adjacent-case references. Split by source/template family, not individual paraphrase, so development patterns do not leak into evaluation.

Two reviewers independently label promise evidence, success evidence, follow-up outcome, and supporting spans before seeing predictions. A third adjudicates disagreements; preserve uncertainty where the text cannot decide. These labels concern what the supplied record establishes, not whether a real transfer occurred. Freeze the rubric, prompt, threshold, model identifier, and data snapshot before the held-out run.

Test two equivalent question wordings and four protocols:

| Protocol | Primitive decisions | Logical requests before retries |
| --- | --- | --- |
| One isolated conversation per request, direct compound question | 600 | 600 |
| Twelve row-local questions per request, each carrying only its row evidence under constant policy state | 600 | 50 |
| Current shared-table method, twelve rows per batch, two fixed row/distractor orderings | 1,200 | 100 |
| Row-local promise/success evidence questions, then a declared three-state code formula | 1,200 | 50 |
| Total | **3,600** | **800** |

The last protocol has two semantic decisions per row, not two model-derived votes on the same target. Its formula should return unknown when the evidence cannot establish the compound result. Use scheduling seeds 42 and 43 for the shared-context permutations; these are order variants, not independent semantic cases. Batch by both question count and serialized bytes. The current gateway accepts 1–128 questions under 100 KB (`experience-prototypes/server/gateway.ts:33`); twelve moderate-length rows should be checked against that limit, not assumed to fit. Splits for unusually long rows add requests and must be reported.

Code baselines are a frozen keyword filter, a negation/temporal rule parser, and an oracle formula using independent human evidence labels. The oracle isolates errors in combining facts from errors in extracting them. Neither code baseline receives fixture labels. Measure recall and precision of the effective follow-up queue, balanced accuracy, abstention/unknown coverage, evidence-span agreement, and row/order invariance. Evaluate source-text changes separately from unchanged neighboring rows. Report completed and all-scheduled outcomes, service failures, payload size, primitive decisions, logical calls, retries, and p50/p95 elapsed time.

Use 10,000 paired bootstrap resamples clustered by base conversation, retaining wordings, order variants, and protocols together. Report each stratum; batching does not make rows or repeated questions independent trials. A provisional quality gate is a 95% lower recall bound of at least 90% on supported follow-up cases, alongside published precision and unknown coverage. Do not label scores as probabilities without a separate held-out calibration assessment. Current eight-case agreement has no such generalization claim.

Run **1,000 offline interaction schedules** covering text edits, query changes, correction changes, out-of-order responses, row insertion/deletion, filters, sorting, interrupted batches, and exports. Require zero wrong-version commits, lost current overrides, or denominator mismatches. These integrity tests need no provider calls and should run before the semantic benchmark.

To test the catalog's review-effort claim, use a counterbalanced pilot with 12 reviewers and two blocks of 25 distinct conversations per reviewer: **600 case reviews**, half manual and half assisted. No reviewer sees the same case twice. Measure review time, missed follow-ups, false follow-ups, and corrections, using frozen model predictions without extra model calls. Report reviewer and case variability; this small pilot may only justify a larger study. Claim reduced work only if time improves with no unacceptable increase in missed cases, under criteria chosen before the study.

The full proposed run is feasible without external downloads or large weights. It needs new independently labeled conversations, versioned state, batch-size checks, future request budget, and reviewer time. None of the 800 proposed requests or reviewer sessions were run in this audit.

## Useful existing libraries

- [TanStack Table v8 rows](https://tanstack.com/table/v8/docs/guide/rows), already installed as 8.21.3: set `getRowId` to the domain ID and keep cell edits/overrides keyed to that ID. Its row model provides view transformations; it does not supply semantic dependency or request-version correctness. Jev contributes the meaning-based cell value.
- [DuckDB-Wasm queries](https://duckdb.org/docs/current/clients/wasm/query): useful once imported tables grow beyond this small fixture. Prepared queries can compute coverage-aware counts and filters over typed cell-status tables; Arrow result batches support larger result sets. For eight rows, plain TypeScript is enough. Keep semantic inference outside SQL and retain provenance columns so computed totals can be reproduced.

## Prioritized work

| Priority | Size | Action |
| --- | --- | --- |
| P1 | M | Bind results to row/query revisions and reject stale commits, including exports. |
| P1 | M | Make human corrections control effective values consistently; preserve their scoped history. |
| P1 | S | Save exact source/question snapshots, distinguish recorded/live provenance, and clarify annotation/score meanings. |
| P2 | S | Configure stable table IDs, coverage/empty states, and real sorting if exposed. |
| P1 | M | Add editable rows, dependency invalidation, resumable bounded batches, and coverage-aware summaries. |
| P1 | M | Run independent row-isolation/baseline evaluation and a separate reviewer-effort study. |

The same per-cell dependency and provenance system can support semantic joins or document-review checklists later. It should first prove that a changed source cannot leave an apparently current semantic value behind.

## Investigation log

Read the catalog, complete SemanticTable/supportRows source, original recorder and prompts, publication mapping, decoded JSONL record, gateway limits, and relevant test searches. No SemanticTable-specific tests were found. Ran `bun jev-experiments/quality-and-simulation-review/probes/semantic-table.ts` using actual component callbacks and installed TanStack core, with mocked React hooks and deferred responses. It checks all eight saved answers against the derived fixture predicate, gold-label exclusion, correction/filter behavior, query races and export, index-ID rebinding, and a synthetic incomplete-record coverage case. The initial JSX harness used a factory name shadowed by a header variable; renaming the probe factory fixed the harness and the rerun passed. Results and baseline hashes are saved in `probes/semantic-table.json`. This was not a browser run or a new model evaluation. Verified the linked version-appropriate TanStack and DuckDB primary documentation; only assigned audit outputs were written.
