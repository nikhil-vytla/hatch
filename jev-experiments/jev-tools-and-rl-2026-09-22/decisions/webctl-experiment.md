# Select useful web evidence without hiding necessary context

- Owner: routing/integration, with evaluation and experience review
- Stage: next wave
- Status: source research complete; experiment direction proposed, protocol and implementation open
- Depends on: [typed decisions](../../roadmap/decisions/decision-contract.md), [hard routing restrictions](../../roadmap/decisions/routing-policy.md), provenance-preserving document fixtures and independently checked answer/evidence labels
- Evidence: [webctl source analysis](../webctl-analysis.md)

## Question

Can typed relevance decisions reduce what an agent must read while preserving the evidence needed for a correct, well-supported answer?

## Direction

Use [webctl](https://github.com/dorkitude/webctl/tree/e9bc54aacc9680e45af12a636ce5db8998c93337), by [Kyle Wild / dorkitude](https://github.com/dorkitude), as the primary reference. The pinned project already uses Jev for result scoring, chunk filtering and near-duplicate judgments. Credit that existing contribution. Preserve its [MIT notice](https://github.com/dorkitude/webctl/blob/e9bc54aacc9680e45af12a636ce5db8998c93337/LICENSE) if adapting substantial code. This decision proposes an Evidence selection lab and controlled evaluation, not a new autonomous browser.

Start with a query, an explicit goal and captured public search results/documents. Keep source IDs, capture dates, hashes and passage offsets. The interface exposes original text alongside selected text, including dropped passages and distinct unjudged, unavailable and budget-trimmed states. Let the user restore a passage and export a cited evidence packet. Query edits invalidate pending results; stale decisions cannot change the packet after an edit or reset.

Selection is advisory. Source content is data, not authority to change tools, permissions, model destinations or spending limits. Preserve the host's control over retrieval and final answers. The first prototype uses captured inputs and performs no browser actions, shell summarization or account access.

## Study boundary

Use a proposed initial set of 36 authored questions: short facts in technical documentation, long documents with evidence away from the opening, and sources containing conflicting or qualified claims. Split 12 for calibration and 24 held out, keeping related documents and near-duplicate questions in the same split. Freeze the final cases, labels, transformations, budgets, prompts and thresholds before measurements. This is an exploratory study; its small sample cannot establish general web-search superiority.

Compare provider-order selection, a lexical selector and hosted Jev on exactly the same captured candidates and output budget. Include a full-text reference condition, labeled with its larger context cost. Keep extraction, duplicate policy, downstream answer model and answer prompt fixed. A later local-model condition must accept the same input contract and explicitly report unsupported inputs. Near-duplicate classification and summarization require separate arms if added; do not combine their effects into the initial selector claim.

Calibrate only on the designated split. Before held-out runs, freeze the acceptable loss in answer correctness and evidence recall, cost accounting and repeated-run count. A useful result must preserve task quality within that preregistered bound while reducing a measured resource. A negative result can close the research question without promoting a public savings claim.

## Dependencies and open decisions

The existing [MCP/harness work](../../roadmap/decisions/harness-evidence.md) supplies the integration pattern. A prospective `select_evidence` operation should return typed decisions, provenance, errors and timing through that toolkit; it should not replace the calling harness. Decide whether to wrap the pinned CLI or implement a narrow adapter after a source-level comparison of contracts. Upstream's provider MCP client is not already this server operation.

Before any live-fetch phase, choose explicit provider permissions, URL/redirect policy, request and byte limits, cancellation behavior and total spending bounds. Provider fallback must remain inside those permissions. An upstream minimum-result backfill is a soft ranking feature and cannot bypass a hard source or permission constraint. Keyless search still sends requests to external services; a local classifier alone does not make retrieval private or offline.

## Completion gate

Publish the frozen protocol, fixture manifest, exact execution identities and held-out results. Report answer correctness and citation support against independently checked evidence; evidence recall; contradictory evidence lost; coverage; actual serialized payload size; total and stage latency; and all search, selector, downstream answer, retry and verifier costs. Distinguish tokenizer measurements from character estimates. Do not infer native-tool payload when the harness does not expose it.

Replay empty results, duplicate evidence, unavailable pages, oversized documents, missing/invalid successful answers, partial failure, cancellation and budget exhaustion. A missing judgment must remain visibly unjudged; it must not become an unexplained omission. Verify that restoration and exports preserve source links and passage identity. Check keyboard access, touch, dark mode and reduced motion before catalog inclusion.

A later host-facing integration closes only when the existing supported harnesses actually call it, use the packet in a task and pass independent answer/evidence checks. Configuration parsing is insufficient. Upstream benchmark outcomes are cited precedent; our own integration, quality and savings claims remain pending until these gates pass. Implementation tasks belong in the folder's separate checklist, once the root adds them.
