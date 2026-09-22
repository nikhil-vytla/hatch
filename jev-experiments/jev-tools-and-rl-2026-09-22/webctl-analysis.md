# webctl: selecting evidence for an agent

Source review completed 2026-09-22. This note proposes a next-wave experiment; it records no installation, inference run or measured improvement.

## Source and credit

[webctl](https://github.com/dorkitude/webctl) is by [Kyle Wild, `dorkitude`](https://github.com/dorkitude). The inspected revision is [`e9bc54aacc9680e45af12a636ce5db8998c93337`](https://github.com/dorkitude/webctl/commit/e9bc54aacc9680e45af12a636ce5db8998c93337), the `main` head returned during this review, with a 2026-09-22 UTC commit timestamp. Its [MIT license](https://github.com/dorkitude/webctl/blob/e9bc54aacc9680e45af12a636ce5db8998c93337/LICENSE) names Kyle Wild as the 2026 copyright holder. Preserve that notice and license if adapting substantial code. No upstream code is copied into this folder.

The useful precedent is already a Jev application: a command-line search tool that filters results and document excerpts before a calling agent reads them. The [README](https://github.com/dorkitude/webctl/blob/e9bc54aacc9680e45af12a636ce5db8998c93337/README.md) describes its origin in the author's Pi/Kimi chat workflow and subsequent Claude/Codex use. It does not supply a general browser-control runtime. Our proposed contribution is an inspectable, controlled study of evidence selection, with explicit omission and cost accounting.

## What the inspected project does

| Stage | Source-observed behavior | Consequence for Jev experiments |
| --- | --- | --- |
| Retrieval | Several configured search providers contribute results; reciprocal-rank fusion combines their lists. Queries go to those services, and provider availability changes the result pool. | Replay identical captured inputs when comparing selectors. Evaluate live-provider reliability separately. |
| Result selection | Query, optional goal, title, URL and snippet inform a typed relevance judgment. A four-level distribution becomes an expected score on a 0–10 display scale. | Preserve the distribution and rubric. A high score does not establish factual accuracy or calibrated confidence. |
| Duplication | Exact URL/title matches collapse; MinHash proposes near-duplicate pairs for a Jev judgment. | Treat duplicate suppression as a separate intervention, because a similar page can contain different evidence. |
| Document selection | Optional fetching extracts page text; a boolean Jev decision keeps or drops chunks. | Preserve source offsets and inspect the omitted material as well as the returned text. |

Primary descriptions: [providers](https://github.com/dorkitude/webctl/blob/e9bc54aacc9680e45af12a636ce5db8998c93337/docs/providers.md), [filtering](https://github.com/dorkitude/webctl/blob/e9bc54aacc9680e45af12a636ce5db8998c93337/docs/filtering.md), and the [README pipeline diagrams](https://github.com/dorkitude/webctl/blob/e9bc54aacc9680e45af12a636ce5db8998c93337/README.md).

The default result cutoff is 6. An optional minimum-result count backfills lower-scoring results and labels them; this is a ranking preference, not a permission mechanism. Chunking defaults to approximately 2,000 characters, with preceding context included for judgment but excluded from the reconstructed output. Fetch failures can return the provider excerpt. Batch-filter failures preserve their unjudged chunks and expose failure metadata. PDF support extracts an existing text layer; it is not OCR for scanned pages. These are useful behaviors to examine, not correctness guarantees. [Filtering reference](https://github.com/dorkitude/webctl/blob/e9bc54aacc9680e45af12a636ce5db8998c93337/docs/filtering.md), [scraping reference](https://github.com/dorkitude/webctl/blob/e9bc54aacc9680e45af12a636ce5db8998c93337/docs/scraping.md).

One source-level integration concern deserves a replay fixture: the [chunk client](https://github.com/dorkitude/webctl/blob/e9bc54aacc9680e45af12a636ce5db8998c93337/internal/jev/chunks.go) leaves a missing or undecodable answer as `nil`, without adding it to the batch-failure `Unjudged` list. The [CLI retention loop](https://github.com/dorkitude/webctl/blob/e9bc54aacc9680e45af12a636ce5db8998c93337/cmd/webctl/cli/search.go#L695-L712) keeps explicit positive answers or marked unjudged chunks. This suggests malformed successful responses can omit content without the same failure accounting. It was not executed or reproduced in this review; adopting the path requires a test and explicit unsupported/error handling.

## Runtime and integration boundaries

The [module manifest](https://github.com/dorkitude/webctl/blob/e9bc54aacc9680e45af12a636ce5db8998c93337/go.mod) targets Go 1.26.0 with Cobra/Viper CLI and configuration dependencies. The [command tree](https://github.com/dorkitude/webctl/blob/e9bc54aacc9680e45af12a636ce5db8998c93337/cmd/webctl/cli/root.go) exposes search, setup, keys, config, cooldown, docs and eval commands. Its [MCP implementation](https://github.com/dorkitude/webctl/blob/e9bc54aacc9680e45af12a636ce5db8998c93337/internal/provider/mcp.go) calls hosted provider tools; it is not a host-facing MCP server that our coding clients can simply register.

The [Jev client](https://github.com/dorkitude/webctl/blob/e9bc54aacc9680e45af12a636ce5db8998c93337/internal/jev/client.go) defaults to `https://api.typesafe.ai/v1/systemone` and the mutable `jev-latest` alias. It requires a key and makes remote requests with context-aware HTTP and bounded retries. A configurable endpoint does not establish compatibility with our local runtime. Searching without Jev filtering remains network search, not offline execution. Record the actual returned execution identity in any study.

[Page fetching](https://github.com/dorkitude/webctl/blob/e9bc54aacc9680e45af12a636ce5db8998c93337/internal/scrape/scrape.go) uses HTTP and text extraction. Optional [summarization](https://github.com/dorkitude/webctl/blob/e9bc54aacc9680e45af12a636ce5db8998c93337/internal/summarize/summarize.go#L150-L160) adds another runtime boundary: a configured command runs through `sh -c` with the process environment, or a configured model endpoint receives the selected text. The initial experiment should omit summarization and arbitrary shell commands so it measures evidence selection. Any later summarizer needs its own permission policy, cost ledger and separate comparison arm. No extension installation or authenticated browsing is required for the proposed captured-input prototype.

## What upstream evidence establishes

The pinned [benchmark results](https://github.com/dorkitude/webctl/blob/e9bc54aacc9680e45af12a636ce5db8998c93337/benchmarks/RESULTS.md) report 30 questions, one run per cell and a model judge. They distinguish snippets, scraping and summarization, retain raw cells, and disclose that Jev and summarizer tokens are absent from the reported token counts. Codex native search payload is unobservable in that comparison; the Kimi judge also grades its own Pi answers. These are useful limitations to preserve, not grounds for transferring a savings percentage to Jev's catalog.

The [benchmark protocol](https://github.com/dorkitude/webctl/blob/e9bc54aacc9680e45af12a636ce5db8998c93337/benchmarks/README.md) additionally notes that agreement among answers can reward a shared mistake on recency cases. Our study should use independently checked answers and evidence spans, freeze scoring before the held-out run, and report all model, retrieval, retry and verification costs. Source inspection is the only new evidence supplied here.

## Proposed next-wave experiment

Build an **Evidence selection lab** around explicit queries, goals and captured public documents. A reader sees kept and omitted passages, original sources, typed judgments and an expandable reason for each omission. The initial task is assembling a cited evidence packet for a question. It does not click through an account, execute page instructions or answer on the user's behalf.

Compare provider-order selection, a lexical baseline and Jev under one token budget and identical inputs; retain a full-text reference condition to expose missing evidence. Keep the downstream answer model fixed. Add local typed decisions only where their declared limits support the same inputs, reporting coverage rather than truncating to fit. Measure answer correctness, citation support, required-evidence recall, dropped contradictory evidence, payload size, latency and total cost. Smaller output alone is not success.

Reuse the [decision contract](../roadmap/decisions/decision-contract.md), [hard routing policy](../roadmap/decisions/routing-policy.md) and [actual harness integration method](../roadmap/decisions/harness-evidence.md). Routing selects a destination for a task; this experiment selects source evidence within a permitted task. A later bounded `select_evidence` MCP operation can return a proposal and provenance through the existing toolkit. The host retains fetch, tool and final-answer permissions. This does not advance the separate [private extension](../roadmap/decisions/private-extension.md) or imply that cloud search is local inference.

The named [decision ticket](decisions/webctl-experiment.md) sets the dependencies and completion gate. Thresholds, fetch policy and wrapper design remain open until a frozen protocol exists.
