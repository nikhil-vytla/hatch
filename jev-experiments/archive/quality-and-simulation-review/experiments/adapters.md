# Typed schema adapters

Verdict: repair. Highest priority: P1. The shared response really does survive four language decoders. The next step is a common executable contract, because supported schema shapes and malformed-answer behavior currently diverge.

## Current boundary and strengths

The experiment sends one support request to Jev and asks three typed questions: support area, whether a refund is requested, and whether context is missing. Python then sends the exact same returned answers to TypeScript, Rust and Go. Each decoder reconstructs a typed ticket; no adapter independently judges the text. The published record contains one real judgment with three answers, not four independent model runs. Source: `src/jev_lab/adapters.py:22–69`. Paths are relative to `jev-experiments`; audited source and record match frozen main `4c0c40d5`.

All four recorded rows preserve the answers and yield billing, refund true and missing_context 0.89. The response evidence contains billing probability 1, refund score 0.99 and missing-context score 0.89. Those are model outputs, not independently labeled correctness results. The UI explicitly discloses the shared-response design at `experience-prototypes/src/misc.tsx:433`.

The adapters reject unsupported free text and optional fields, require semantic descriptions, validate numeric bounds and check any supplied distribution. TypeScript, Rust and Go resolve local references with bounded depth; Python intentionally supports a narrower set. Public `decide` implementations retain questions and raw answers alongside typed values. These are useful decisions for a small library. Sources: `adapters/typescript/index.ts:19–173`, `adapters/rust/src/lib.rs:39–233`, `adapters/go/adapter.go:65–286`, `src/jev_lab/semantic.py:11–64`. Four TypeScript tests, five Rust tests, the Go suite and two targeted Python contract tests passed during this review.

## Findings

### P1: a two-level rubric silently loses its semantics

The TypeScript compiler handles a number bounded 0–1 as `noul` before checking `x-jev-levels`. A score annotated with `["deny", "allow"]` therefore loses both level descriptions. A three-level rubric compiles correctly. Rust and Go have the same branch ordering. Sources: `adapters/typescript/index.ts:81–100`, `adapters/rust/src/lib.rs:109–124`, `adapters/go/adapter.go:144–159`; reproduced in [the original probe](../probes/adapters.ts) and [output](../probes/adapters.json).

TypeScript additionally accepts numeric score levels and 256 levels, whereas Rust and Go require 2–255 strings. Duplicate enum values collapse into one criterion without rejection. JSON Schema requires enum elements to be unique. [Primary enum specification guide](https://json-schema.org/understanding-json-schema/reference/enum). A typed field alone does not establish whether 0–1 means a calibrated probability, ordered score or thresholded predicate. Give explicit semantic metadata precedence, validate rubric/enum uniqueness and publish one supported schema profile across languages.

### P1: raw decoding and cross-language acceptance are inconsistent

TypeScript uses `String(a.value) in q.criteria` at `index.ts:112`. The raw decoder accepts the undeclared option `constructor` through the object's prototype. The higher-level Zod parse in `decide` and the demo rejects it, and the other three typed decoders reject it too. This is a public raw-decoder defect, not a demonstrated end-to-end bypass. Use a string type check and own-property lookup, then test both raw and typed APIs.

The 40 offline decoder executions also found that absent confidence is accepted by Python, Rust and Go but rejected by TypeScript. All four accept absent/null choice distributions and a chosen option that disagrees with the supplied distribution's maximum. This is not proof that optional evidence is forbidden by the upstream wire contract; it shows that "evidence preserved" alone does not define evidence completeness or coherence. Explicitly specify missing versus null, distribution requirements, choice/value consistency and extra-answer policy. Preserve the original response and return separate validation diagnostics rather than silently repairing evidence. Source: `core.py:211–252`, TypeScript `:122–144`, Rust `:180`, Go `:213`; probe acceptance matrix.

### P1: the visible examples omit the required semantic descriptions

All four UI snippets lack descriptions, although all compilers require them. The displayed TypeScript example fails before making a request with `A semantic description is required: area`; equivalent guards are present in the other implementations. The actual repository demos include the descriptions and work. Source: `misc.tsx:368–376`, TypeScript `:61`, Rust `:94`, Go `:124`, Python `semantic.py:20`. The page teaches an incomplete contract at its central interaction. Generate snippets from executable examples and compile each in CI. Show the emitted question next to its field, including the difference between a predicate, a probability and an ordered rubric.

### P2: the live panel bypasses the adapter it presents

Live execution sends stored questions directly to `run` and manually thresholds only `refund`; it never invokes the TypeScript compiler, decoder or Zod schema. The language selector changes the snippet but retains the initial Python row. The disclosure correctly says live input uses the shared contract, yet the diagram still labels the output "Validated value." Source: `misc.tsx:377–439`. Editing the text retains the previous result, and no revision check stops a pending response from appearing under subsequently edited text. `shared.tsx:214` only manages busy/error state.

Run the browser TypeScript adapter against the same schema and bind the result to an input/schema hash. Show recorded decoder identity separately from the live execution language. Editing either input or schema should mark old evidence as stale; aborted or late requests cannot replace the active revision. These are source-level findings; no browser interaction was run.

### P2: one successful ticket cannot establish a portable contract

The only published case is an uncomplicated enum/bool/probability ticket. It exercises no nested references, score rubrics, threshold boundary, abstention or malformed response. The runner records typed-value and answer equality but discards the emitted questions returned by each child decoder, so question-meaning parity cannot be inspected. Child errors become rows without an overall conformance assertion. Source: `src/jev_lab/adapters.py:36–62`.

The existing unit tests help, but separate hand-maintained fixtures can agree on different contracts. Publish a shared, versioned corpus containing schema, expected questions, raw response, expected typed value and expected rejection stage. Fail the run if any required language diverges. Keep transport/model quality, compiler parity and runtime decoding as separate outcomes.

## Richer interaction: a contract workbench

A visitor starts with a fictional support ticket, selects a field and changes its description or rubric. The workbench shows the schema, emitted question, original answer distribution and typed value together. They can switch among a recorded response, hand-authored fault fixture and a live Jev response. The same frozen answer can be replayed through every installed decoder without another model call. A boolean field exposes the 0.5 threshold and an optional review interval; changing the threshold recomputes code output while preserving the model score. A schema diff highlights any changed semantic question.

Jev supplies judgments from the text and explicit field semantics. Code owns schema compilation, versioning, validation, threshold/review policy, immutable input hashes and the decision log. No refund is issued. A malformed answer cannot become a valid ticket; an unsupported field is rejected before transport. Missing evidence produces a declared warning or rejection according to the chosen policy. Undo restores a full schema/input/result checkpoint. A late response stays attached to its original revision.

Acceptance requires the displayed snippets to execute, emitted questions to match across supported languages, every output to identify its input and schema revision, all invalid fixtures to fail at the expected stage, recorded/live/manual provenance to remain visible, and keyboard users to inspect differences without depending on color. A frozen response must reproduce the same value in all four languages under the same policy.

## Evaluation

There is no external benchmark here. Current coverage is one authored model input and three decisions decoded by four languages; this audit adds ten response fixtures executed in all four decoders. Do not label those 40 deterministic executions as model judgments or compute semantic accuracy from equality alone.

Build 120 declared conformance cases across enum/rubric limits, required/optional fields, local references/cycles, nesting, unsafe names, numeric bounds, missing/null evidence, distribution coherence and expected failures. Add 1,000 generated schema/answer cases for each of seeds 0, 1, 2, 3 and 4. Replay all 5,120 cases in four implementations: 20,480 offline executions, zero provider requests. Compare an independently specified canonical compiler and direct language validators. Exact question equivalence, value/evidence equality, false acceptance/rejection and failure stage are the primary measures; retain each minimized counterexample. There is no sampling interval for the fixed conformance corpus; use seed-level variation only for generated coverage.

For the optional semantic study, author 60 support messages as 30 counterfactual pairs with independent area/refund/context labels before inference. Use three repeated judgments of all 60 messages, each returning three answers: 180 logical evaluations and 540 decisions. If the transport packs ten independent messages, that is 18 requests before retries; otherwise it is 180. Reuse each response across languages. Compare majority and keyword rules, report per-field accuracy, whole-ticket correctness and review error versus coverage. Use pair-clustered bootstrap intervals, separate provider failures, and never include gold labels in state. Scramble enum order as a diagnostic rather than selecting the best test permutation. Prompt and threshold changes need a separate development set.

[Zod](https://zod.dev/api) already provides the browser's runtime validation and should validate the live path. [fast-check](https://fast-check.dev/docs/introduction/) can generate and shrink schema/answer failures for the common corpus. The shared profile, not either library, must define semantic meaning. Jev earns its place by resolving the support request's meaning within that explicit profile; it is unnecessary for compiler conformance tests.

P1/S: repair rubric precedence, bounds and own-key lookup, with shared regression fixtures. P1/S: derive UI examples from executable demos. P1/M: specify common evidence/null/threshold semantics and publish canonical emitted questions. P2/M: connect the live TypeScript decoder with revision guards and provenance. P2/M: build the corpus and interactive workbench. Reuse the resulting contract fixtures in structured forms and review workflows before adding new languages.

## Investigation log

Read every adapter implementation, the runner, full recorded response, relevant tests, ADR, catalog/publication mapping and React component. Verified the audited source/record against frozen main. The Bun probe ran ten answer fixtures through the four existing decoder programs and six TypeScript compilation probes without provider calls. TypeScript and Python tests passed immediately. The shell lacked default Go/Rust toolchains; rerunning with the repository's cached toolchains passed Rust and Go tests. Go fetched ordinary module dependencies; no model weights or datasets were downloaded. Primary schema/validation/property-testing documentation was checked online. No app edits, browser automation, paid calls or commits occurred.
