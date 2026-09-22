# Preserve Jev's question semantics

Status: accepted foundations requirement; implementation open. Owner: root with training/runtime and routing/integration. Depends on the existing typed contract and the [runtime audit](runtime-audit.md).

## Question

Can every layer preserve the meaning of a supported native Jev question and response, while local adapters report the parts they cannot implement?

## Evidence and decision

The existing wrappers narrow the provider interface before experiments reach it. The app gateway and Python question model reject structured instructions and criterion descriptions. The shared runtime lacks boolean boundaries and descriptive ordinal levels. Its ordinal result chooses an argmax, while a native Score returns an expectation. These are implementation facts, documented with call sites in the audit; they do not show that structured prompts will improve accuracy.

Correct this boundary before claiming that the lab explores the complete primitive interface. No backward-compatibility constraint applies. Preserve existing published results as historical observations under their original adapters.

The revised contract must preserve JSON entry values without coercing objects into strings, support explicit true/false descriptions, retain ordered descriptive levels and their legends, and distinguish expected score from a chosen discrete level. Keep provider confidence separate from maximum probability and application thresholds. Declare limits per primitive, including the documented native Score level limit. Validate finite JSON, byte/depth/collection limits and request cancellation at the boundary.

Each adapter declares its supported question shapes and response semantics. Unsupported structures remain explicit. A local model that accepts only string descriptions may reject richer questions or expose a separately named transformation condition; it must not silently flatten them and claim parity. The adapter identity includes that transformation revision.

## Acceptance

- Native request/response fixtures round-trip through TypeScript, Python, gateway, CLI and MCP paths without lost criterion content.
- Provider-free checks cover structured Choice descriptions, structured Score levels, Noul true/false boundaries, invalid recursive shapes, per-kind limits, fractional expected scores and distributions with the same mean but different spread.
- Hosted integration uses a pinned provider/model revision and retains actual request, response and timing artifacts. A schema fixture alone is not model evidence.
- Local adapters pass declared coverage checks and return unsupported states for the rest. Re-run only affected comparisons; never overwrite the prior training study.
- The per-experiment inspector distinguishes actual model decisions, surrounding code, recorded evidence and proposed uses.

Fable 5.1 Global reviews the frozen migration and comparison protocol before new research measurements. Implementation belongs in [IMPLEMENTATION.md](IMPLEMENTATION.md).

## Follow-on question: which representations help?

Run a small question-framing study inside existing experiments, with equal semantic information in flat prose, JSON serialized as text, and native structured fields. Hold model revision, state, candidate set and execution policy fixed. Measure task accuracy, calibration, action/review coverage, order sensitivity, latency and total cost. Report token counts rather than assuming representations cost the same. Freeze cases, splits, metrics and a bounded wording search; select on validation and keep final cases sealed.

Begin with Smart paste field grounding and the verifier's rubric boundaries. Then try descriptive Score levels and composite dimensions in judgments, and probability-guided taxonomy traversal in icons and visual search. Use deterministic downstream tests where possible and blinded human labels where necessary. Higher confidence alone cannot select a winning representation.

The [visual atlas](show-me-jev-capabilities.html) names an opportunity for every current experiment. Prefer deeper versions of existing scenes. Add a public experiment only when it answers a distinct question and has a useful entry experience. The new browser study is already a separate decision because it tests sequential intent and abstention under changing pages.
