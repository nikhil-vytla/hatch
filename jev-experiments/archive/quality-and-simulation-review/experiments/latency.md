# Batching & latency

Verdict: repair. The current evidence is a useful gateway transport sweep, but it does not establish useful decision throughput. It measures 120 serial requests across 12 payload shapes, all asking the same easy question. The strongest result is that the gateway returned 128 answer slots in roughly the same median elapsed time as one slot in some conditions. Whether those slots contain different, correct, timely judgments remains untested.

## What the experiment does

The [catalog](../../experience-prototypes/src/catalog.ts#L213), lines 213-219, asks how much work one request can carry. The [runner](../../src/jev_lab/benchmarks.py#L218), lines 218-274, builds a state saying a reader requests a book, appends 100, 1,000, or 4,000 copies of `background`, and sends 1, 8, 32, or 128 copies of `Does the reader request a book?`. It repeats each condition ten times in a fixed order.

Jev only decides that Noul probability. Code builds the payload, validates every returned answer, retries requests, records timing and usage, then computes percentiles. This is multiple independent questions about one shared state. It does not batch independent state inputs, run concurrent HTTP requests, or use an asynchronous provider batch API. Both [TypeSafe](https://docs.typesafe.ai/introduction) and [Vercel](https://vercel.com/docs/ai-gateway/modalities/evaluation) document the shared-state question semantics.

The visitor sees twelve animated median bars with textual p95 and completed/attempted counts. The page explains that timings include waiting and retries, and exposes the complete result through a raw-state control. There are no batching controls or request timelines. This is a source inspection of [Learning](../../experience-prototypes/src/benchmarks.tsx#L547), lines 547-570 and 607-618, not a browser test.

## Evidence and what works

The publication manifest selects `../results/latency.jsonl` at [publication.json](../../experience-prototypes/publication.json#L17), line 17. The selected run is `20260920T054001-latency-3a9397`, completed September 20, 2026. The probe at [latency.py](../probes/latency.py) decodes all published rows and, when present, checks the local attempt log.

| Observation | Measured value |
| --- | --- |
| Logical requests completed | 118 of 120 |
| Network attempts | 169, including 32 HTTP 429 and 19 HTTP 503 responses |
| Requests needing more than one attempt | 43 of 120 |
| Maximum requests observed in flight | 1 |
| Distinct payload hashes / question instructions | 12 / 1 |
| Requested / returned question slots | 5,070 / 5,030 |
| Successful attempt p50 / p95 | 339 / 544 ms |
| Retry-aware logical request p50 / p95, excluding initial queue wait | 412 / 10,681 ms |
| Reported cost / attempts without cost metadata | $0 / 51 |

All twelve published percentile pairs reproduce from the successful rows. Local logs contain all 5,030 answer values, between 0.95 and 0.98. Every value clears a 0.5 threshold for the one true statement. This confirms the trivial positive control, not 5,030 independent semantic test cases.

Several foundations are sound. [core.py](../../src/jev_lab/core.py#L211), lines 211-251, rejects missing, wrong-type, and out-of-range answers. Lines 355-368 measure the whole `evaluate` call, including local admission waits and retries, and retain the final attempt timing separately. [reporting.py](../../src/jev_lab/reporting.py#L31), lines 31-70, separately reports successful attempt latency and retry-aware logical duration, explicitly excluding initial queue wait. Failures remain in published rows, and their `total_ms` values make the selective percentile problem repairable without rerunning. Five relevant contract tests pass, including malformed responses, budget accounting, HTTP failure recording, cancellation cleanup, and failed-case denominators. No latency-specific percentile, batch-accuracy, or display-null test was found in the inspected suites.

## Findings

### P1: One repeated fact cannot establish useful batching capacity

The runner at `src/jev_lab/benchmarks.py:220-239` varies padding and copies a single instruction. It saves no answers or targets in latency rows. Actual states contain 109, 1,009, and 4,009 whitespace-delimited words, so the chart's state-word labels also omit the nine-word sentence. Raw logs confirm exactly one instruction across all slots.

The experiment can establish payload acceptance and timing for repetitive fan-out. It cannot establish accuracy under diverse questions, mixed positive and negative judgments, longer instructions, choice vocabularies, or unrelated records packed into one state. Correct this with a balanced authored workload of distinct judgments and retained labels, predictions, question IDs, input tokens, and payload bytes. Keep the repeated-question condition as a named transport control. Separate same-state fan-out from multiple-record packing, where state contamination is an additional accuracy question.

### P1: Successful-only p95 hides failed-request waiting

`src/jev_lab/benchmarks.py:256-268` filters out every row without `latency_ms` before calculating p95. In `results/latency.jsonl:11`, the 4,000-padding-word, eight-question group reports p95 of 3,378 ms from nine successes. Its tenth request failed after 12,815 ms. Using all ten terminal durations gives p95 of 9,085 ms. These are different quantities, and a fast failure would also lower terminal-duration p95.

Show conditional success latency, terminal duration for all attempts, failure rate, and correct decisions delivered before a deadline separately. Never treat a terminal error as a successful response at its failure time. Preserve failures in every availability and deadline denominator. Use completion counts labelled `requests`, and show returned answer-slot counts separately.

### P1: Fixed-order serial runs do not isolate batching, cold starts, or capacity

`src/jev_lab/benchmarks.py:220-252` awaits each call before starting the next and walks conditions in increasing order. There are ten samples per condition, no warm-up designation, no shuffled blocks, and no cold-client or repeated-content control. The shared client uses connection pooling at `src/jev_lab/core.py:255-258`, while a four-call semaphore and global ledger ceiling appear at lines 257 and 125-131. Neither makes this particular runner concurrent. The probe found at most one attempt in flight.

Time-dependent provider pressure, pooled connections, identical-content reuse, and unrelated processes sharing the ledger can affect these figures. Ten samples also leave p95 determined by the largest two observations. There is no evidence that a slow row is a provider cold start, or that a repeated request hits a model cache. Randomize paired conditions across several time blocks, isolate the run ledger, record client queue time, and measure request concurrency explicitly. Distinguish a fresh HTTP client from provider coldness, which this endpoint cannot prove. [HTTPX documents connection reuse](https://www.python-httpx.org/advanced/clients/), and [k6 documents why completion-paced load can hide offered-load pressure](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/).

### P1: Request duration is not time per useful decision

The UI displays request medians but does not measure throughput, queue wait, job completion, or correctness. Its `answered/attempted` value counts requests. For example, `results/latency.jsonl:9` describes ten requests carrying 1,280 answer slots, not ten decisions. The attractive 1,000-word comparison of 342 ms for one question and 368 ms for 128 questions compares different amounts of repeated work and different moments in the run.

Make the same independently labelled work available to each strategy. Compare singleton serial requests, singleton requests with bounded concurrency, and native multi-question requests under the same arrival stream. Measure correct on-time decisions per wall-clock second, full job completion, and availability. Do not divide a batch's elapsed time by its question count and call that user latency: every question still waits for the shared response, and dynamic batching adds a collection wait before dispatch.

### P2: The chart suppresses the tail and has misleading empty states

`experience-prototypes/src/benchmarks.tsx:558` clamps all median bars at 1,500 ms without an axis explaining the cap. The 4,000-word, 32-question median of 1,670 ms is clipped. The 3.4-12.0 second p95 values only appear as small text. The same component passes nullable percentiles to `Math.round`; a zero-success group would render `0 ms` because JavaScript coerces `null` to zero.

Use a labelled shared axis, show individual request dots or an empirical cumulative distribution, distinguish failed requests, and render `No successful requests` for empty groups. Selecting a point should reveal queue, attempt, retry-wait, and terminal timing, with the exact state and question count. Keep all recorded attempts accessible through the result artifact.

### P2: Cost and model provenance cannot support a durable efficiency claim

`results/latency.jsonl:1` records $0 reported cost and 51 attempts without cost metadata. Lines 134-136 contain cumulative ledger totals for 3,500 attempts across models, not the 169 attempts in this run. The local successful responses identify only `typesafe-ai/jev`, with no underlying version. The 298,398 successful input tokens therefore describe the observed workload more usefully than the aggregate budget snapshot.

On September 20, the [Vercel model listing](https://vercel.com/ai-gateway/models/jev) advertised free promotional pricing ending September 25, 2026, and a 32K context. [TypeSafe's native documentation](https://docs.typesafe.ai/models) listed $0.042 per million input tokens, free output, a 64K total request budget, and a 32K state-plus-longest-question limit. These are separate documented routes, not interchangeable measured bills or limits. Record actual route, exposed model identity, run-local token and cost totals, missing-cost counts, pricing source and date. Report promotion, estimate, and billed cost separately. Preserve unknown version and unknown cost instead of filling them in.

## Richer interaction: a support desk under load

The visitor opens a replay with customer tickets arriving at a support desk. Each ticket needs an intent and urgency decision. They choose singleton dispatch, immediate shared-state packing, or packing with a 25/100 ms collection window. They vary the question cap, incoming ticket rate, request concurrency from one to four, and a two-second service target. A common seeded arrival sequence lets them compare policies side by side.

Jev judges the prose in each ticket using stable ticket/question IDs and a frozen rubric. All questions in a packed request see its shared state. Code creates that state, schedules dispatch, enforces payload limits and deadlines, maps answers back to tickets, validates values, and records outcomes. Code also generates the comparison timelines. Jev does not choose the scheduling policy or invent elapsed times.

Selecting a delayed ticket opens a timeline of collection wait, local queue wait, network attempts, backoff, validation, and final disposition. Failed or expired work stays visible and counted. Replays use recorded calls and label counterfactual queue simulations as simulations. A cached semantic answer is shown as cache reuse and contributes no fresh inference claim. Unsupported load conditions cannot inherit an optimistic latency curve from the current serial run.

Acceptance criteria:

- The same seed produces the same arrival stream and deterministic scheduler events.
- Every result maps to its ticket, question ID, state revision, and request record; stale or missing answers cannot silently complete a ticket.
- A batch waits at most its configured collection window unless a separately labelled capacity queue blocks dispatch.
- All policies receive identical work and arrival timestamps; all dropped, expired, and failed decisions remain in throughput and service-target denominators.
- The timeline reconciles to measured end-to-end duration and shows request latency separately from per-ticket waiting.
- Replaying a recorded run makes zero model requests. Any future live measurement is explicitly labelled and retained as a new record.

## Evaluation protocol

Use an authored systems benchmark. There is no external dataset split or official leaderboard scoring for this claim, and the current coverage is one positive semantic fact with twelve payload shapes. Do not rebrand it as an external benchmark.

Prepare 20 development seeds and 100 held-out scene seeds. Each seed defines 128 distinct, balanced true/false statements about a common support scene, including negation, paraphrase, and plausible distractors. Generate facts and labels independently of Jev, and manually audit the prose against its facts. Build three token-length variants per seed. The complete held-out set is 300 state bundles and 38,400 question instances; length variants share a seed and are not independent observations. Freeze generation templates, rubrics, thresholds, and schedule before running. Reserve the support-ticket multi-record condition as a separate follow-up, since it changes the state semantics.

For each held-out state bundle, evaluate the same 128 questions using pack sizes 1, 8, 32, and 128, under request-concurrency caps 1 and 4. This gives 149 requests per packing sweep, `128 + 16 + 4 + 1`, and 89,400 logical requests for the full paired comparison. Split the 100 test seeds into five time blocks and randomize strategy order within blocks. Log achieved concurrency and the precise arrival schedule. The one-question, concurrency-one arm is the serial baseline; the one-question, concurrency-four arm tests whether native packing improves over ordinary request concurrency. A deterministic oracle provides correctness and scheduling checks; an always-true baseline exposes imbalance. Neither counts as a semantic model competitor.

This design yields 100 completed-workset observations per condition and unequal numbers of individual request observations. Publish those counts. For request-tail claims, extend each 32-question condition from 400 to 1,000 requests and each 128-question condition from 100 to 1,000 requests. Across three lengths and two concurrency caps, that adds 9,000 logical requests. Add 20 explicitly excluded warm-up requests for each of five blocks. The full plan is 98,500 logical requests, at most 295,500 attempts under the existing three-attempt rule. Fresh-client and repeated-content diagnostics should be separately budgeted and labelled if added; a fresh client does not establish a cold provider. This is an executable coverage target, not work performed in this audit.

The existing global 10,000-attempt ledger cap would stop this plan. Use a dedicated run ledger with a reviewed request/token budget, measured pacing, and checkpoints. Cheap or promotional inference makes complete coverage practical financially; rate limits, elapsed time, version visibility, and unknown failed-attempt costs remain operational constraints. Do not raise traffic by bypassing provider limits. First run the complete scheduler and scorer offline against recorded/error fixtures. A short transport preflight validates access, not model quality, and cannot replace the planned evaluation.

Record arrival, collection-close, admission, each attempt start/end, backoff, validation-end, and terminal timestamps. Keep provider timing as unknown unless the provider returns it. Compute request p50/p95, success-conditional latency, terminal duration, queue wait, batch completion, retries per request, request availability, decision availability, semantic accuracy among returned decisions, and correct-on-time decisions divided by all offered decisions. Throughput uses wall-clock elapsed time and includes queues, retries, drain time, failures, and actual returned work. Never count 128 copies of one fact as 128 independent correct judgments.

Use 95% paired bootstrap intervals resampling scene seeds and time blocks for policy differences. Report uncertainty in percentiles and observed availability, and retain all individual times. Avoid p99 claims below 1,000 request observations per stratum. Correlated lengths and repeated questions are not extra independent seeds. A five-block result still samples few service periods, so a deployment claim requires replication on another day and route.

Predeclare the product target as 99% of offered decisions correct within two seconds. Call packing an improvement only if its goodput beats the best singleton strategy with the paired 95% interval above 1.0, its correctness loss has a 95% upper bound below one percentage point, and it meets the service target. A failure to meet these gates remains a useful result. Report billed cost, estimated nonpromotional cost, and unknown-cost coverage per 1,000 correct on-time decisions.

For the interactive scheduler, run 30 arrival seeds across steady, burst, and outage profiles, three dispatch policies, and concurrency caps 1, 2, and 4. That is 810 offline simulations with no model calls. Validate each against conservation of work and exact event accounting. An eventual live arrival-rate test should preserve offered arrival times even while the service slows and report dropped arrivals; this is the distinction explained by [k6's open-load model](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/).

## Useful existing tools

| Tool | Contribution | What Jev contributes |
| --- | --- | --- |
| [k6](https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/constant-arrival-rate/) | A controlled arrival-rate driver, transport timing, error metrics, and explicit dropped iterations for the future endpoint load test. Keep custom decision outcomes and question counts alongside HTTP metrics. | Native structured judgments give the workload useful decisions whose accuracy and deadline can be checked. |
| [SimPy](https://simpy.readthedocs.io/en/latest/) | Deterministic event simulation of collection windows, finite request slots, outages, deadlines, and backoff. Export a replay trace to the existing React view. | Recorded semantic answers and timings let visitors see which useful judgments arrived; the scheduler remains code. |

## Prioritized work

| Priority | Size | Action |
| --- | --- | --- |
| P1 | S | Relabel existing counts and timings, expose failed waits and transport attempts, fix null handling and axis clipping, and describe the repeated-question control accurately. |
| P1 | M | Add independent labels, distinct question IDs, token lengths, answer retention, run-local cost accounting, and explicit timing stages. Add regression cases for failed-only groups and mixed success/failure percentiles. |
| P1 | M | Build the paired runner with randomized blocks, explicit concurrency, isolated budget state, and checkpointed full coverage. Publish the run plan before measurement. |
| P2 | M | Build the recorded support-desk queue simulation and the 810-seed-policy checks. |
| P2 | L | Extend to independently packed records and a measured live arrival-rate test. Reuse the scheduler and outcome records for semantic-table scans, ticket routing, and deadline-aware fallback experiments. |

## Investigation log

- Read the catalog, selected publication manifest, actual React branch, latency runner, core timing/retry/normalization code, record decoder, transport summary, and relevant contract tests.
- Decoded all 120 published rows and all 169 local attempt records. Reproduced all twelve percentile pairs, counted payload hashes and answer values, checked actual word counts, reconstructed maximum in-flight attempts, and recalculated failure-inclusive terminal durations with the saved read-only probe.
- Ran five selected Python contract tests, all passing. No paid calls, app edits, browser run, fetched repository copies, or large downloads were involved.
- Verified the official TypeSafe and Vercel contract, current gateway promotion, HTTPX connection reuse, k6 arrival-rate semantics, and SimPy capabilities on September 20, 2026.
- One source search hit an unmatched shell wildcard and was retried with exact paths. The papercut logger declined because the repository has not opted into its log; no log file was created.
