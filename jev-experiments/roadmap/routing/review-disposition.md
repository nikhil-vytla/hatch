# Routing review disposition

The original Fable 5.1 Global [protocol feedback](../reviews/protocol-feedback.md) is preserved. The code and evidence changed after that snapshot.

| Finding | Disposition | Evidence |
|---|---|---|
|11 Invalid route limits pass comparisons|Fixed. validateRoute rejects nonfinite/missing limits, malformed evidence and invalid endpoints. Loader and selector both apply it.|policy.ts, invalid-limit regression|
|12 Hosted classifier may bypass locality|Fixed. Local-only requires a declared local classifier before invocation. Failed classifier metadata retains declared identity.|router.ts, locality regression|
|13 Classification does not affect ranking|Implemented optional taskQuality category/difficulty interpolation for soft ranking. Hard eligibility stays independent. The tiny comparison deliberately uses aggregate flat calibration and cannot claim classifier-driven quality benefit.|classifier.ts, policy test, comparison protocol|
|14 OpenCode failure classes and identity|Fixed. Only429,5xx and connection errors are availability failures. Other provider/config failures are errors. OpenCode identity is configured-unverified and cost null.|execute.ts, actual harness transcripts|
|15 OpenCode token envelope|Added32768-token system-envelope margin and excluded OpenCode from hard charge caps. The margin is a conservative engineering allowance, not a measured maximum system-prompt proof.|policy.ts, OpenCode usage records|
|16 Minimum quality accepts simulated evidence|Fixed. A hard minimum requires measured base quality.|policy test|
|17 Escalation remaining budget|Fixed. Selection gets remaining budget. Verification under a hard cap remains explicitly disabled until a bounded verifier adapter exists.|router.ts|
|18 Success with failure field|Skipped verification uses outcome.note and an explicit unverified record. The final boundary review below changes failed verification to an error with retained evidence.|router.ts; hooks.test.ts|
|19 Accounting otherwise sound|Preserved full reservations and null totals; also made cached-input upper bounds conservative when configured cache rates exceed uncached prices.|policy.ts|

Independent playable-agent review additionally reproduced redirect leakage, late verification cancellation, pre-cap classifier execution and malformed MCP null input. These were fixed and verified in [provider-free probes](../playable/review/routing-review.ts). Redirects now fail closed, already-cancelled tasks never call classifiers, and active stdio cancellation has its own regression.

Actual BYOK testing found a second class of failure not covered by the initial review: valid JSON could contain a malformed unified diff. The parser now checks hunk counts and preserves the raw rejected output. Applying a patch and testing the resulting repository remains the host's responsibility. The retained original sample and host recount repair are evidence of this limitation, not an unmodified success.

## Integrated prototype review

The [Fable prototype review](../reviews/prototype-feedback.md) inspected a snapshot. Findings2,4,5 included omissions in that exported review bundle; the actual retained files were present. The root owns correcting that export and the current live-route evidence.

| Finding | Disposition | Evidence |
|---|---|---|
|3 Discovery mistaken for delegation|Added explicit usable-artifact count, delegationOccurred and condition-specific pass gates. Historical approval/provider/cwd failures are failed in-file.|integration/evidence_index.py; evidence/index.json and every summary|
|4 Missing index and run metadata|README and NOTES were present but omitted from review export. Added chronological audit index, CLI version, configured host model and identity limits per run.|integration/README.md; evidence/index.json|
|6 Divergent HTTP executors|Extracted one HTTP executor used by browser and CLI. Negative usage, cached overcounts, malformed bodies, strict schema and cancellation have regressions.|http-executor.ts; http-executor.test.ts|
|7 OpenCode malformed cost differs|Every OpenCode outcome now reports null cost. Configured identity remains unverified.|execute.ts|
|8 Audit errors can kill MCP|Audit writes are caught, async dispatch has an error boundary, and an unwritable-audit stdio regression still discovers tools and pings.|mcp.ts; mcp.test.ts|
|9 Recorded correctness and provider ambiguity|Copy now says proposed patch and explicitly distinguishes live Gateway routes from the OpenCode/Bedrock recording. Host application remains independently tested.|ModelRoutingLab.tsx; integration evidence|
|10 Failure variants not reproduced by current script|Labeled original configurations historical. Current script takes a new evidence name and refuses overwrite.|integration/README.md; run_harness.py|
|12 Fixture write path scope|Pinned generated worktree plus relative read/edit allowlist for authored fixture files; external_directory denied. An actual boundary session exposed nonmatching absolute patterns; that failed condition is retained and a corrected relative-path condition is separately tested.|run_harness.py; official permission docs linked in integration README|

All three real clients additionally completed deliberate malformed-response handling with unchanged source and active interruption checks against controlled loopback destinations. These have their own gates and preserve the difference between observed client termination and a server cancellation notification.

The root's new strict live call preserved another wrong-count hunk as a failure. The subsequent [normalization protocol](HUNK-NORMALIZATION.md) is a distinct processing condition: only one unambiguous hunk's count fields can change, with original text and repair metadata retained. Five independent tests cover original strict failure, normalized strict application and task success, mismatched-source rejection, no repair on valid patches, and refusal of ambiguous structure. The original strict run is not relabeled as successful. Forty provider-free checks and the roadmap typecheck pass after the refactor.

Final live condition: [the scripted record](../verification/live-route.json) retains the original malformed model proposal inside artifact.repair, reports toolkitNormalizationApplied:true and hostRepairApplied:false, and independently passes strict git application plus five sum assertions. [The strict failure](../verification/live-route-strict-failure.json) remains unchanged. This closes the demonstrated first-task usability defect through a disclosed deterministic repair, not a model-quality improvement claim. The selected source hashes are invocation-file provenance rather than a full dependency closure manifest.

The final SDK boundary pass moved shared policy validation before custom classifier invocation, so an invalid NaN budget cannot trigger a paid classification call. Its regression records zero classifier calls. At that earlier boundary stage, 41 tests and 123 assertions passed, along with the roadmap TypeScript check. The current fresh-install record carries the final bundle size and checksum.

Actual boundary-client follow-up closed the additional unsupported-task-request/no-route gate for all three clients. Each made exactly two route_task calls with full source, received unsupported(empty id) and unavailable(empty registry), and preserved source/config with no destination attempts. The initial absolute-path permission condition failed its required explanation-file gate; corrected worktree-relative file rules passed in a separately retained condition. See the integration failure protocol and evidence index. These are additional client experiments; the production router's41 provider-free checks and source-built bundle are unchanged.


## Final SDK and public-evidence review

The root independently identified verifier locality/accounting gaps. Provider-free probes reproduced undeclared verifier invocation under localOnly, null/thrown verifier false success, unknown cancellation charges and a null custom executor crash before the correction. A separate probe reproduced declared-local / returned-hosted classification reaching destination execution. The direct-selector probes also reproduced widening a zero spending cap through remainingBudget and a null-entry duplicate-id crash.

| Finding | Disposition | Evidence |
|---|---|---|
|Verifier locality|Require a validated explicit local identity under localOnly. Otherwise skip the callback and label the returned proposal unverified.|hooks.test.ts; router.ts|
|Verifier metadata and accounting|Validate adequacy, evidence, finite nonnegative latency and null/nonnegative finite cost. Invalid/throwing responses fail without escalation, preserve readable evidence, and leave unknown totals null. Cancellation discards late results. Rejected proposals cannot survive a later failed escalation.|hooks.ts; hooks.test.ts|
|Classifier declaration contradiction|Validate source and reported execution identity against the declaration. Preserve valid reported identity separately when it contradicts the declaration, stop before destination execution and return an explicit error.|hooks.test.ts; Classification.declaredExecution|
|Custom executor result trust|Validate result shape, typed artifacts and usage/cost before use. Invalid metadata cannot create negative budgets or false usable outcomes.|hooks.ts; hooks.test.ts|
|Remaining budget bypass|A supplied remainingBudget must be finite/nonnegative and is clamped to the configured hard cap.|policy.test.ts|
|Malformed registry entry crash|Invalid entries stay ineligible; duplicate detection and selected-route lookup tolerate null entries.|policy.test.ts|
|Public evidence lacked usable links|Added Vite URL assets for protocols, comparison report/results and per-client summaries, audits, transcripts, diffs and tests. Native details groups keep evidence optional; copy states four held-out synthetic tasks and no savings claim.|evidence-links.ts; ModelRoutingLab.tsx|

All SDK callbacks remain trusted caller-owned implementations, not a sandbox; declarations and post-call validation cannot undo a dishonest callback's network activity. No remote client, destination or GPU sample was repeated for these provider-free changes. At that review stage, 56 routing tests, 338 assertions and the roadmap TypeScript check passed; the execution-identity follow-up below records the next 61-test result. A fresh installation produced an 81,971-byte Bun bundle with SHA-256 066ef314d0f9cbee978ad7a12e5db5310c9b4f4745a2c0762da9a939b240cc0e and passed doctor, MCP discovery, unchanged email input and uninstall. The root separately verifies browser downloads and the app build.


## Execution identity follow-up

The root identified three consequential model-identity gaps; each failed a focused provider-free probe before correction. OpenCode destination.model must now match route.model both during eligibility and at the direct executor boundary. The command and configured limits use that same model. HTTP and custom executor identity substitutions return an error with actual reported identity, valid usage and raw output retained; charge is null and no usable artifact survives. Neither availability fallback nor quality verification follows an identity contradiction. No alias mapping or model attestation is invented. Missing HTTP identity and OpenCode's configured identity remain labeled configured-unverified; post-response checks cannot undo provider work.

Five added tests cover the three contradictions, direct OpenCode rejection without access to an executable, and absent HTTP model metadata. At that execution-identity stage, routing checks passed 61 tests/364 assertions, and roadmap tsc passes. Fresh installer smoke passes with an 83,629-byte bundle, SHA-256 c5e843b0626b1169412dad5e7c104b904a605bd805472d975242ba5fae864f51. The existing provider/client evidence remains unchanged. The live web record reports the configured model exactly, so no new provider request was needed.


## Final source-review findings 5 and 6

Finding 5 exposed a real escalation inconsistency. A destination with higher aggregate measured quality but lower task-calibrated quality was invoked as a stronger alternative in the first regression. Escalation now requires both scores to improve and both to be measured. The minimumQuality hard floor deliberately remains aggregate measured quality, independent of classifier predictions; a higher task-calibrated score cannot bypass it. Tests cover both conflicting score directions and the valid improvement case. This preserves the protocol's separation of hard eligibility and classifier-driven ranking.

Finding 6 reproduced rejection of valid SQL/Lua comment deletions because their diff bodies start with `--- `. Structural headers now require complete path-header pairs. The root's follow-up also reproduced acceptance of an incomplete second file after `diff --git`; a small header-state guard now rejects it. Tests cover valid and incomplete multi-file headers with and without Git metadata, strict host application of corrected SQL/Lua patches, and retained rejection of path-shaped ambiguity.

The frozen HUNK-NORMALIZATION.md bytes remain unchanged. The `single-hunk-counts-v1` repair kind still means count-only replacement with original text and disclosure retained; this recognition fix neither changes repair semantics nor relabels historical live observations. No provider calls were repeated. The final source passes 66 routing tests/398 assertions and roadmap TypeScript. Fresh installation produces an 84,933-byte bundle with SHA-256 fadcab2dac09c7ee03368bd3f7df7316c9195f8920e5d297731c199165d56a9f.
