# Context filter

Verdict: redesign. Highest priority: P1. This is a relevance-based source-selection preview, not yet a context-budget experiment with a downstream outcome. The page says so, but its graph, live request and exported state still show a full-context answer after every source is filtered out.

## Current behavior and evidence

The catalog at `experience-prototypes/src/catalog.ts:166` maps `context` to the `search` dataset. There is intentionally no separate context record. The publication path is `../results/search.jsonl`. The shared `AgentExperiment` in `src/agent-experiments.tsx:70` is unchanged from frozen commit `4c0c40d`; this review concerns only its context mode.

Jev selects a best document and judges relevance. In the Python recording path, it also judges whether each document contains a redirection attempt. Code retains relevant documents below that injection threshold, or host-marked critical records, at `src/jev_lab/compositions.py:202`. In the UI, code sorts six fixed documents by relevance, then retains those at or above 0.5 within a rounded number of source slots. There is no summary, semantic rewrite, evidence-dependent packing or downstream answering step.

Shared `readRecord` reconstructs five completed authored queries, six fixed documents totaling 336 text characters, and 65 recorded judgments: five best-source choices, 30 relevance judgments and 30 injection judgments. The four answerable queries retain their single labeled source, totaling 59, 52, 59 and 46 characters respectively; the fifth correctly selects no source. All five exclude the obvious injected instruction. The `gold_evidence_retained` field is automatically true for the unanswerable case at `compositions.py:232`, so report 4/4 answerable evidence retention and 1/1 abstention separately. There are zero downstream answer trials.

Successful-attempt p50 is 287 ms, while retry-inclusive logical-request p50 is 71.57 seconds, excluding queue wait. Thirteen attempts comprise five HTTP 200 and eight HTTP 429. The shared global budget total is not the cost of context filtering alone.

Strengths are visible source text and IDs, a no-source option, inspectable decisions, shared availability reporting, and the explicit caveat at `agent-experiments.tsx:363` that reduced-context agent success is not measured. The Python note also correctly calls filtering a heuristic rather than a security boundary.

## Findings

### P1: The budget changes a preview, not the input or outcome of an evaluation

The `kept` set at `agent-experiments.tsx:139` affects card styling only. The live request at line 234 always sends every document. The actual callback probe sets allowance to zero, confirms that no cards are retained, then runs Evaluate. All six documents are still sent and the graph still reports `refund`. The state inspector at line 466 exports `row`, which omits the current budget and preview subset. On a saved row, it can still export the original `kept: refund` while the UI shows every card filtered.

The warning limits the claim, but the central control has no measurable downstream consequence. Keep the selector result separate from a reader run. Feed the exact retained context into a fixed reader and bind its answer, citations and status to a budget/source/query hash. At zero budget the old full-context answer may remain as a labeled comparison, but cannot be presented as an answer produced from the empty selection. Export both stages and their actual payloads.

### P1: Recorded and live selection policies differ

The recorder asks 13 questions and excludes high-injection documents. Live context evaluation at `agent-experiments.tsx:233` asks seven questions and omits injection judgments entirely. The UI also ignores recorded injection answers and `row.kept`. A synthetic record with relevance 0.98 and injection judgment 0.99 for the untrusted document is retained by the UI, while the original recorded-policy subset excludes it. This probe demonstrates a policy mismatch, not an observed live security compromise.

The recorder can force retention of host-marked critical records, but the UI's fixed documents, cap and threshold do not implement that rule. No current fixture actually contains a critical tool error, as the saved note acknowledges. Share one versioned selection contract, represent trusted metadata separately from model judgments, and preserve required user constraints and tool outcomes through host rules. Keep untrusted content as quoted evidence; a model's injection score is not an authorization boundary. Test relevant text containing an injected instruction, since the current distractor is simply irrelevant to every legitimate query.

### P1: Source-slot percentages and a single relevant document create a misleadingly shallow budget curve

The slider is accurately labeled “% of source slots” at line 330, but this is not a token or character cap. `Math.round` at line 144 makes 0 through 8% retain nothing and 9 through 100% retain the same single document in the default case. Exhausting all 101 slider positions produces only two distinct subsets. Documents have different lengths, and model request overhead is not counted. Relevance alone also cannot preserve a pair of jointly necessary facts or a low-relevance exception.

Measure the actual serialized reader prompt with that reader's tokenizer, including separators, provenance, instructions and reserved output space. Pack source spans or dependency groups under a declared budget, preserve exact IDs and quotes, and show when mandatory content makes a requested budget infeasible. Use multi-source, contradiction, correction and no-answer cases with independent sufficient-evidence sets. Do not report slot reduction as token savings.

### P1: A late result replaces a newly selected example

The request completes unconditionally into `setRow` at `agent-experiments.tsx:261`. During a pending refund request, the probe switches the selector to the invoice example. The selector remains at invoice and its textarea says invoice, but the old result replaces the graph with `refund` and stores the old refund text. `setIndex` and the completed row no longer identify the same example. Query edits have the same missing request-version guard.

Bind selection and reader results to example ID, query version, corpus revision and budget. Changing any input should make old results visibly stale and prevent a late response from overwriting the current example. Preserve completed prior runs in a separate comparison history.

## A richer context experiment

Build an evidence tray for a bounded support case: a current policy, an outdated policy, the user's exception, an invoice lookup result and a tool failure. Let the visitor ask a question, pin a critical fact and lower an actual token allowance. Show exactly which spans enter the reader prompt, which dependency forces another span to stay, and what budget remains. Run the same frozen reader on full and reduced inputs side by side. The user can inspect an unsupported answer, restore a missing exception and rerun only the affected branch. End with a supported answer or an explicit insufficient-evidence outcome, plus a reproducible context package.

State includes immutable sources and versions, stable span IDs, trust metadata, critical records, query revision, selection judgments, dependency groups, token costs, pins, packed prompt hash and reader results. Jev judges which spans or groups matter to the query, and can choose an unresolved reason when relevance alone is insufficient. Code owns provenance, mandatory retention, byte/token bounds, packing, revision checks and independent scoring. A model failure leaves prior work available but cannot silently convert missing judgment into irrelevance. Budget changes are deterministic until the user requests a new downstream run.

Acceptance criteria:

- The evaluated reader payload exactly matches the inspected retained context, including at zero budget.
- Every retained quote maps to its original source/version; the system never changes negation, numbers or temporal scope during extraction.
- Required host records either fit or produce an explicit infeasible-budget state. They cannot disappear because their relevance score is low.
- Reader outcomes include answer support and correct abstention, independently checked from gold facts, rather than the selector's self-assessment.
- Late runs cannot attach to another query, example, corpus or budget.
- Export contains input hashes, tokenizer/version, counts, selected spans, raw model decisions, actual packed prompt and both full/reduced outcomes.

## Evaluation and full coverage

Keep current coverage separate: five small search fixtures, four labeled positive sources, one no-source case, zero downstream runs. Five best-source matches do not establish context compression quality or robust injection handling.

Author 24 development and 120 held-out bundles, 20 in each of six strata: single-source answers; facts requiring multiple sources; exceptions/negation; temporal correction/contradiction; critical tool outcomes; and absent answers or relevant content mixed with redirection. Each bundle has 32 identified chunks and independent facts, permissible answers and minimal sufficient evidence groups. Two people annotate support and adjudicate disagreements before seeing predictions. Split source templates across development and test.

Use two chunk-order seeds, 42 and 43, giving 240 held-out presentations. One Jev selector call per presentation asks relevance and redirection judgments for 32 chunks, or 64 judgments per call. Reuse those scores at 25% and 50% token budgets. Compare three selectors: Jev with deterministic packing, a frozen lexical/BM25 baseline with the same host retention, and a pinned local LLMLingua-2 compressor. Keep a full-context reader baseline once per presentation. Three methods at two budgets plus one full run give 1,680 reader calls. Including 240 Jev selector calls, the planned total is **1,920 logical calls**, before retries; selector volume is 15,360 judgments. A 12-bundle pilot is a 192-call subset. All methods share the same fixed reader, tokenizer and answer format; gold evidence and answers stay out of selector inputs.

Score sufficient-evidence-group retention, answer exact match or independently specified structured predicates, correct abstention, unsupported assertions, constraint/exception loss, exact token cost, infeasible budgets and total selector-plus-reader latency/cost. Compare against full-context accuracy, not just character reduction. Report source-grounded answer quality separately from whether an obvious injected sentence was dropped. Count all attempted cases and failures. Use 10,000 paired bootstrap resamples clustered by bundle, retaining both orderings and budgets. Report Pareto curves of answer quality versus total resource cost. A provisional useful outcome is a paired 95% lower bound for compressed-minus-full accuracy of at least -0.02 at half context tokens, plus zero loss of host-mandatory records. This is a target to test, not a result.

For an external follow-up, [RULER](https://github.com/NVIDIA/RULER) provides 13 task configurations across four categories. Its [default configuration](https://github.com/NVIDIA/RULER/blob/main/scripts/config_tasks.sh) generates 500 samples per task, so complete coverage at one declared length is **6,500 examples**, not a small sampled subset. Run all 13 tasks at 4K first; longer lengths are separate complete runs. The [official scorer](https://github.com/NVIDIA/RULER/blob/main/scripts/eval/synthetic/constants.py) uses the fraction of reference strings found for retrieval/tracking/word-extraction tasks and any-reference substring matching for QA. Retain that score, with optional stricter diagnostics reported separately.

Using the same three selectors, two budgets and full reader baseline requires 45,500 reader calls plus at least 6,500 Jev selection calls, or **52,000 logical calls** for one complete 4K run before retries or chunk-batch splits. This is a later budgeted study, not part of the 1,920-call authored plan. Pin upstream revision, generation seed and reader tokenizer. Current external coverage is zero. Blockers are the reader implementation, source-chunk mapping, tokenizer compatibility, local compressor resources, QA-source preparation and the substantial call budget. RULER is generated, so “full” means the declared 13-task/500-sample configuration, not a universal fixed test split. The current 100 KB/128-question gateway bounds must be checked before calling Jev; do not silently truncate a longer benchmark. No datasets or model weights were downloaded in this audit.

## Useful libraries and next steps

[Transformers.js tokenizers](https://huggingface.co/docs/transformers.js/api/tokenizers) can count the actual prompt with a pinned reader tokenizer and chat template. Do not use an arbitrary tokenizer as an exact count for an undocumented provider model. Download only required tokenizer files when implementing this step; no model weights are needed just for counting.

[LLMLingua-2](https://github.com/microsoft/LLMLingua) is a concrete local compression baseline with a requested compression rate and optional protected tokens/sections. It requires local model resources, so it is a future implementation dependency. Compare it on the same reader outcome and total cost rather than assuming the project's published compression claims transfer to these cases. Jev's distinct role would be query-aware evidence/group selection with an inspectable rationale and exact source mapping.

| Priority | Size | Action |
| --- | --- | --- |
| P1 | M | Connect retained context to a separate reader run and export the actual reduced payload. |
| P1 | M | Share recorded/live selection policy and host-mandatory retention; add version guards. |
| P1 | M | Replace source-slot allowance with exact token accounting and dependency-aware packing. |
| P1 | M | Build and independently label the complete authored comparison, including no-answer and exception cases. |
| P2 | L | Run all 6,500 RULER examples at 4K once the reader and call budget are ready. |

A later agent-memory experiment can reuse these provenance and budget controls to compare retained commitments and tool failures over a long session. It needs independently scored final task outcomes rather than a polished memory summary.

## Investigation log

Read the catalog-to-search mapping, unchanged shared component, live request, recording filter and generic record preparation. An initial lookup for a separate context file failed; the catalog establishes that search evidence is intentional. Decoded all five records through shared `readRecord`, checked character counts and exact decisions, and ran `probes/context.ts` with Bun. The probe exhausts 101 slider positions, captures the zero-budget full request, checks a synthetic policy mismatch and reproduces late-response example replacement. No context-specific tests were found. Verified primary library and RULER configuration/scoring sources. No app edits, real browser runs, downstream inference, provider calls, large downloads or commits.
