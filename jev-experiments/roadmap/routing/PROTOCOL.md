# Routing protocol v1

Frozen before harness outcome collection on 2026-09-20. This is an integration study and a routing implementation, not evidence that routing saves money or improves model quality.

## Standing requirements

Classify a task, check hard eligibility, rank the eligible routes, execute one bounded delegation, and record the outcome as separate objects. Classification conditions share the exact selection policy and registry. A delegated task stays on its selected destination until it completes. An availability failure may fall back only when explicitly configured. Quality escalation needs an explicit verifier rejection and a measured stronger eligible route. Neither path may broaden permissions, locality, capability, context or spending restrictions.

The delegated model receives the task and the explicitly supplied context. It returns an answer, structured data or a proposed unified diff. It has no tools and cannot apply edits. The host owns filesystem access, patch application, tool permissions and independent tests. Local inference endpoints must be loopback addresses, with no implicit cloud fallback. Typed decisions use ../runtime/contract.ts.

## Selection and accounting

Normalize user quality, cost and latency weights over eligible routes. Quality and latency evidence carries measured or simulation labels. No invented benchmark scores or live prices. Unknown price is null, never zero. Cached-token calculations are estimates and are labeled observed or simulated. Hard budget eligibility uses full cold input plus maximum output charges with configured prices, never a cache discount. Unknown charges reserve the full bound for later attempts. Include classifier, executor and verifier overhead in total latency and cost, leaving the total null if any charge is unknown. Input coverage uses a conservative UTF-8 byte token bound plus an executor envelope; oversize inputs are rejected whole.

## Integration collection

Use fresh temporary fixture repositories with source files written for this study. For each installed client, record its version, invocation, MCP initialize/list/call events, sufficient-context assessment, returned artifact type, host patch application, independent task tests, and exit/failure. Each fixture has a real off-by-one bug, a test-writing request and a repository-analysis request. Delegation must actually occur through the configured MCP tool. Config parsing or successful MCP initialization alone is a failed integration gate. The fixture model sees source snippets and must generate a response; no canned fix is supplied by the server.

Separate protocol-level tests cover cancellation, unsupported inputs, unavailable destinations, malformed responses, exhausted budgets, forbidden tools, locality, cache expiry and quality escalation. Harness task runs also ask clients to handle unsupported/no-route conditions. A passing protocol test is not claimed as a passing harness behavior test. Store redacted transcripts and separate observations in ../integration/evidence.

## Comparative evaluation gate

A held-out routing quality claim requires a frozen calibration set and a distinct held-out task set, task-success grading independent of the router, fixed-model baselines, heuristic classification, host-agent classification, hosted Jev and local classification under one registry and policy. Account for every routed attempt, classifier, verifier, latency and null-priced event. Report sample counts, coverage, accuracy/calibration and failures. This gate remains open until those measurements exist. Smoke fixtures do not satisfy it.

## Review

Fable 5.1 Global reviews this protocol together with the training protocol. Preserve the response and disposition. Independently inspect consequential recommendations; reviewer output does not override user restrictions.

## Amendments after independent review

Before any held-out router comparison, category-specific easy/hard quality values now interpolate linearly at the classifier's difficulty. These are optional registry evidence, and web defaults explicitly mark them simulated. No classifier value changes hard eligibility. Custom classifiers declare locality before receiving input and a maximum charge before any capped call. Failed classifier identity is retained.

Registry validation rejects missing/nonfinite limits and invalid local/remote transports. Redirects are rejected for both execution and typed decision requests. An OpenCode delegate reserves a 32,768-token system-envelope margin in addition to the text bound, advertises configured-unverified identity, reports cost null, and is ineligible under a hard spending cap because the CLI cannot enforce a billable-token limit. HTTP delegates use a strict two-field artifact JSON schema following one preserved malformed BYOK outcome. A malformed body is retained as capped rawOutput for inspection and never becomes an applicable artifact.

Successful responses with skipped/failed verification use a note rather than a failure field. Quality escalation remains disabled under hard spending caps in v1 because no verifier maximum-charge adapter is supplied. Per-harness end-to-end cancellation and malformed-response recovery are separate acceptance work from the provider-free protocol tests; basic fixture success does not claim those behaviors were observed.


## 2026-09-21 SDK boundary amendment

Final source review reproduced verifier locality and metadata gaps, classifier identity contradictions, a direct-selector remaining-budget override, and a null registry entry crash. These provider-free corrections do not rerun or reinterpret retained model/client observations. A local-only policy now skips quality verification unless a valid local identity is declared. Skipped verification returns an explicitly unverified proposal; malformed or thrown verifier results return an error, retain readable evidence and do not escalate. Charges remain null when unknown or invalid. Adequacy must be a boolean, latency finite and nonnegative, and evidence nonempty; only a valid rejection permits quality escalation. Rejected or cancelled proposals are absent from the final outcome.

Classifier source and reported execution identity must agree with each other and with a supplied declaration. A contradictory reported identity is preserved as evidence, distinct from the declaration, and no destination executes. SDK hooks are trusted caller-owned code: validation is not network sandboxing and cannot undo activity inside a dishonest callback. Custom executor accounting and artifacts are validated before use. Remaining-budget inputs must be finite and nonnegative and can only tighten the configured cap. Invalid registry entries remain visible as ineligible candidates without crashing valid entries.

The public evidence inspector downloads protocols, comparison results, the client index, and each primary successful client's summary, audit, transcript, diff and test output as separate assets. It labels the four-held-out-task comparison as offline policy replay without a savings claim. Historical artifacts remain unchanged.


## 2026-09-21 execution identity amendment

A selected model must agree with the destination configuration and returned identity. OpenCode destination.model must equal route.model before either routing or direct executor invocation can start a process. OpenCode outcomes remain configured-unverified because its event stream does not attest the model independently.

An HTTP response or custom executor result that explicitly names another model is an error, even when its artifact is valid. Retain the reported model, valid usage and inspectable raw output, discard the usable artifact, and leave its charge unknown instead of applying the selected model's prices. The error permits neither availability fallback nor quality verification. Matching is exact; no aliases are inferred. Missing HTTP model metadata remains explicitly configured-unverified. Post-response checks cannot undo work already performed by a provider or trusted caller-owned callback.

These rules were verified with provider-free regressions. Earlier live/client observations remain unchanged and were not rerun; the retained live web response reports the exact configured model.
