# Search reranker — dedicated audit

**Verdict: repair. Highest priority: P1.** Five queries over six short documents yield five correct best-source choices, four retained answer sources and one correct abstention. The recorded filter and displayed/live filter are different implementations, masked by these easy examples. This audit covers the original agent search experiment, not the visual archive or the separate Context filter review.

Paths are relative to `jev-experiments/`. Run `bun jev-experiments/quality-and-simulation-review/probes/search.ts` for complete record/wire comparisons and actual-callback/render probes. Synthetic counterexamples are explicitly separated from saved model results; no browser, model call or corpus download was performed.

## Current behavior and useful foundations

The Python runner provides all six documents to Jev, asks for one best document or none, and requests relevance and instruction-redirection scores for every document: thirteen questions per query (`src/jev_lab/compositions.py:185`). Code retains a noncritical document only when relevance is at least 0.5 and redirection score below 0.5. It records full answers, retained source text and character counts (`compositions.py:202`). There is no first-stage retriever or generated answer.

`experience-prototypes/publication.json:27` loads `../results/search.jsonl`. Its five complete calls contain **65 primitive judgments**, all targets withheld from model state. Four queries have one sufficient source; the damaged-battery query has none. All four answer-bearing sources are retained and the one obvious hostile document is excluded for all five queries. The reported five gold-retention successes include the no-answer row by definition (`compositions.py:232`); the meaningful answerable denominator is four. Thirteen transport attempts include five successes and eight rate limits. The roughly 72-second row latency includes retry waits; successful attempts have a subsecond distribution.

Stable source IDs, a real none choice, full short source text, complete raw score preservation and a note that filtering is not a security boundary are good foundations (`compositions.py:187`, `:217`, `:240`). The probe confirms the current six UI documents exactly match the recorded request corpus. Their combined text is only 336 characters.

## Findings

### 1. P1: Displayed retention does not implement the recorded filter

The runner uses both relevance and redirection scores, with an explicit critical-record bypass (`compositions.py:205`). The UI recomputes Retained/Filtered solely from relevance; live requests ask only best and six relevance questions (`agent-experiments.tsx:131`, `:233`). It neither uses recorded `kept` nor the recorded redirection judgments.

All five saved examples happen to agree because the hostile document's relevance is below threshold. An actual-render probe changes its relevance to 0.95 while keeping its redirection score at 0.99: the runner predicate excludes it and the UI labels it Retained. This is implementation divergence, not a measured model exploit, and filtering remains an advisory heuristic.

Use one versioned request/filter builder, preserve the exact decision inputs, and show relevance and redirection as distinct properties. If live mode deliberately uses a simpler policy, label it and do not replay the old policy's outcomes as equivalent. Keep source content untrusted regardless of its scores.

### 2. P1: Missing relevance is converted into invented 100%/0% judgments

The UI falls back to 1 for the best document and 0 for every other when a relevance answer is absent (`agent-experiments.tsx:135`). It then labels these values Relevance judgment percentages (`:357`). A synthetic best-only record reproduces this behavior. All current saved records have complete relevance scores, so this is a boundary defect rather than an accusation that their displayed scores are fabricated.

There is also a schema mismatch: recorded best probabilities live under `answers.best.probabilities`, but the component reads `row.probabilities`; none of the five recorded examples renders the probability bars, while live results do (`:86`, `:267`, `:464`). Normalize recorded/live results without replacing missing values. Show unknown/unavailable scores, explicit ties and best-source choice separately from per-document relevance; the scores are not established as calibrated probabilities.

### 3. P1: A stale search response replaces a newer selected query

The shared callback accepts every completion (`agent-experiments.tsx:261`). The probe starts the return-policy query, selects shipping, then resolves the old result. The editor/dropdown remain on shipping while the selected result and retained sources revert to refund. The result card displays its old query text, so the issue is inconsistent active state rather than falsified stored provenance.

Bind results to query revision, ordered candidate IDs/content hashes and protocol. Cancel obsolete requests and reject their late completion. Sorting and source inspection must not change identity. Distinguish current draft, submitted query and historical run visibly.

### 4. P2: The five-case result says little about ranking or instruction contamination

One corpus contains four clean facts, one unrelated sentence and an attack explicitly named `injection` with title Untrusted result (`compositions.py:166`). There are no relevance ties, partial answers, competing versions, multiple necessary sources, hidden attacks, or title/ID ablations. Best-source accuracy is five-way fixture success, not nDCG, corpus retrieval recall or downstream answer correctness.

Retain these as smoke examples. Add graded independent relevance and sufficiency labels, neutral IDs/titles, quoted benign instructions and mixed useful/hostile text. Test whether the best choice, per-document scores and retained evidence agree under declared semantics; do not assume all relevant documents are sufficient or safe. Compare an actual lexical retriever on the same frozen candidates and report candidate recall before reranking.

### 5. P2: Corpus provenance and the review loop are incomplete

Published rows retain kept documents but not the complete original corpus or its hash; the UI reconstructs all six from current constants (`agent-experiments.tsx:38`). They match today, as checked against raw request logs, but an edited constant could attach old scores to new text. The visitor can change a query but cannot add/edit a source, inspect a cited supporting span, or mark a source judgment wrong.

Save the entire small candidate snapshot and hashes. Add source cards with provenance, version and evidence-span selection; let a user edit one source and invalidate only dependent judgments. Keep corrections distinct from model scores. A none result should explain that no supplied source was sufficient, without claiming the answer does not exist elsewhere.

## Richer workflow: a source desk with competing revisions

Open a question beside a small collection of policy pages, an outdated revision and a distracting excerpt. A lexical first stage reveals candidates immediately; Jev reranks them while the reader can inspect complete text. Mark one quote as the answer evidence, compare why another page is merely related, then replace a policy version and replay the same query. A branch keeps the earlier ranking and evidence visible.

Code owns ingestion, stable source/version IDs, lexical retrieval, hashes, exact prompt construction, ranking/tie rules, status, citation offsets and exports. Jev scores semantic relevance and sufficiency from the supplied text; it does not execute source instructions or authenticate the publisher. Human corrections affect the review view through a visible override layer. Model failures leave the lexical list and previously valid evidence available with accurate status.

Acceptance: all candidates are traceable to the submitted snapshot; absent scores remain unknown; recorded and live policies produce identical retained sets for identical answers; stale responses cannot rerank a new query; best-source choice and relevance have separate labels; no-answer is explicit; and span references survive only while their source hash matches. A keyboard-readable list supports the same actions as animated cards.

## Evaluation: authored behavior plus full external query coverage

For product behavior, author 60 independent source bundles with twelve documents each and four queries: direct evidence, paraphrase, multiple-source requirement and absent answer. Use 20 bundles for development, 40 held out. Two reviewers label graded relevance, sufficiency, expected supporting spans and instruction-redirection content separately. For the **160 held-out queries**, compare original, reversed and neutral-ID/title orders: **480 requests ×25 questions =12,000 primitive decisions** under the current best-plus-two-scores design. The neutral metadata condition changes labels only, preserving document identity through a mapping. Pair by source bundle and cluster bootstrap intervals there. Freeze thresholds and baselines; include an all-unknown provider-failure result in UI tests. No proposed runs were performed.

For an external retrieval test, use **all 300 BEIR SciFact test queries against its 5,183-document corpus**; current coverage is **0/300**. The dataset card lists 1,109 total query rows across its query collection, which must not be mistaken for the test split. [Official dataset card](https://huggingface.co/datasets/BeIR/scifact), [BEIR split table](https://github.com/beir-cellar/beir/wiki/Datasets-available).

Freeze a lexical top-100 run from the complete corpus, then score all 100 candidates for every test query with an annotation-free, document-isolated relevance question: **30,000 scores**, approximately **2,100 requests at at most sixteen candidates per batch**, subject to actual token/byte limits. Every independent question must carry its complete query/document evidence. This is full query coverage with bounded reranking; exhaustive query–corpus scoring would be 1,554,900 pairs and is not the proposed protocol. Publish candidate Recall@100 so omissions cannot be hidden by reranker quality.

Use BEIR's official qrels and `EvaluateRetrieval`/pytrec_eval path for nDCG@10, MAP, Recall@100 and MRR; do not replace labels with another model. Preserve a stable tie rule and the original lexical scores/runfile. SciFact evaluates evidence retrieval, not the medical truth of a generated answer or prompt-injection resistance. [BEIR evaluation API](https://github.com/beir-cellar/beir), [Metric definitions](https://github.com/beir-cellar/beir/wiki/Metrics-available).

Baselines are the unchanged lexical ranker, fixed candidate order and oracle ordering within the same retrieved candidates. Use paired query bootstrap intervals for external metrics; keep authored no-answer and contamination diagnostics separate. Record relevance/sufficiency precision-recall, evidence recall, false retention, no-answer accuracy, repeat/order changes, coverage, latency and cost. Checkpoint every query/document score and retain wrong answers. Blockers are a frozen lexical implementation, a later licensed dataset fetch, prompt/threshold development outside test qrels, and provider budget for the declared volume; no weights are required for the lexical baseline. The dataset card labels its distribution CC-BY-SA-4.0; preserve appropriate attribution in any later data publication.

## Libraries and priorities

[MiniSearch](https://github.com/lucaong/minisearch) supplies a local lexical candidate index and immediate query feedback for the source desk; Jev adds semantic reranking. [BEIR](https://github.com/beir-cellar/beir) supplies the external loader and official evaluation integration. These solve different parts of the workflow; neither makes model filtering a security boundary.

P1/S: share retention logic and request schemas, preserve unknowns and normalize scores. P1/S: guard query/source revisions and persist corpus snapshots. P2/M: build the evidence desk with corrections and source versioning. P2/M: collect the authored suite and full SciFact query evaluation. The source/evidence model can later support multi-document answer review, with generation evaluated independently from retrieval.

Investigation: decoded all five rows and all 65 judgments; inspected successful raw requests; compared corpus identity and rendered retention; reproduced a relevant-plus-redirection counterexample, missing-score fallback, missing recorded probability bars and late query completion. Checked current source/tests and verified exact external counts/metrics using primary pages. No app changes, browser interaction, model calls, large downloads or commits.
