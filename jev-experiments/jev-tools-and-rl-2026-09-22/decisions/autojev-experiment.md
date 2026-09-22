# When should an open decision model defer?

- Owner: training/runtime, with root/design engineering
- Stage: next wave; extend [useful uncertainty](../../roadmap/decisions/useful-uncertainty.md)
- Status: researched proposal; protocol and implementation not frozen
- Source: [Denis Yarats's AutoJev, pinned review](../autojev-analysis.md)
- Dependencies: explicit GPU capacity and accounting; pinned weights and licenses; typed adapter; redistributable labeled cases; frozen calibration/review policy; complete per-decision artifacts

## Decision

Add an AutoJev comparison that lets a visitor examine a decision, its full distribution and the mistakes left by a review policy. Begin with a recorded support-triage scene: choose a ticket, inspect the choice, boolean and ordinal answers, then change a threshold to see accepted coverage and errors. Threshold exploration does not overwrite the frozen evaluation policy. Export the selected case and exploratory settings as a versioned artifact.

Use the published checkpoint first. Do not begin with another 27B training run. The experiment asks whether this released model's probabilities and runtime behavior support a useful decision workflow. It must remain distinct from Jimothy's task-specific small-model distillation, GEPA prompt search and the completed local typed-decision study. A negative quality result or zero useful automated coverage can still support a usable, honest experience.

## Runtime boundary

Implement an explicit AutoJev adapter against the [shared contract](../../roadmap/runtime/contract.ts). Pin source commit, model revision, tokenizer, readout and temperature in its manifest. Identify AutoJev as AutoJev even when its upstream endpoint accepts a Jev-compatible alias. Preserve the actual hosted Jev identity in the comparison. Never substitute one provider silently.

Choice distributions map by stable option ID; boolean answers become false/true probabilities. Ordinal distributions map to the requested numeric levels, with the modal supported value as `selected` and the expected value as separate evidence. Reject unsupported ranges, more than ten ordinal levels, excessive context or malformed probabilities. Do not pass upstream's rescaled `confidence` field off as calibrated correctness. Declare byte, token and question limits; retain unsupported inputs in coverage denominators.

Run the Python/PyTorch service in a separate GPU environment. The Bun experience consumes recorded artifacts, with an explicitly configured live endpoint only after installation and adapter checks pass. No weights enter the Vercel bundle or current Mac installer. Test busy/unavailable responses, bounded retries, cancellation, input edits and late responses. A cancelled HTTP request must not be described as cancelled GPU computation without evidence. Image requests remain outside this first protocol.

## Proposed bounded comparison

The following is a protocol proposal, not a result or a frozen benchmark. Review and freeze exact IDs, labels, transformations, metric definitions, retry rules and monetary/GPU budgets before execution.

1. Author 240 short support-policy cases with redistribution rights. Each has one four-option routing question, one boolean question and one three-level ordinal question, for 720 decisions per condition. Supply a finite written policy and independent label review. Group templates and paraphrases before splitting into 80 calibration cases and 160 untouched final cases. Disclose the authored distribution; it is not a representative support workload or a general benchmark. Do not import the upstream monitored panel as a fresh test.
2. Run the pinned AutoJev checkpoint, its pinned pretrained base with the same answer-code/readout construction, and hosted Jev on matched states and semantically identical questions. Save complete local logits once. Derive both raw temperature 1 and released temperature 2.207568021892729 from those logits as paired offline conditions, without claiming two inference measurements. Include uniform probabilities and a frozen lexical rule baseline. Keep prompts fixed; no weight training or prompt search occurs in this phase.
3. Select review thresholds on calibration cases only. Freeze the threshold grid, error target, minimum accepted count and interval procedure before scoring. Each deployed condition receives its own measured-runtime policy; a threshold from one temperature or model cannot transfer without validation. If no threshold qualifies, record zero accepted coverage. Final labels remain closed until all policies and artifacts are locked. Do not fit another temperature in this initial study.
4. Freeze a diagnostic subset from calibration cases for option permutations, meaning-preserving wording changes, singleton versus multi-question requests and repeated runs. Permute choice labels and descriptions together, then compare canonical IDs. Preserve ordinal level order. Cap the combined primary and diagnostic work at 3,000 logical question branches across the three inference conditions, with at most one retry per failed branch. Freeze the exact diagnostic schedule and context-boundary probes before execution; report attempts separately from successful decisions.
5. Add no paid or GPU condition opportunistically after seeing final outcomes. If the pinned base or GPU runtime is unavailable, report the missing comparison and leave the relevant gate open. Unknown pretraining overlap and the missing upstream curated corpus prevent a claim of contamination-free evaluation, even for newly authored cases.

## Outcomes and completion gate

Report accuracy by question kind, macro and micro aggregation, full-distribution Brier score and log loss, ordinal mean absolute error, and fixed-bin reliability counts. Report accepted coverage and accepted correctness with denominators and uncertainty under each frozen policy. Use paired group-resampled intervals for differences; repeated variants of one case are not independent cases. Show option-order and batch differences, failures, unsupported inputs and all high-confidence errors. Treat sparse calibration bins as sparse evidence.

Measure installation bytes, cold loading, first useful result, warm p50/p95, GPU memory and total request latency. Include repeated state tokens, retries, orchestration and verifier overhead if a verifier is later added. Record hosted usage and cost when available and missing charges as unknown. Serialize GPU timing. Do not infer local speed, zero cost or savings from zero generated tokens.

Acceptance requires a fresh pinned installation, checksum verification, complete decision-level records, independent metric recomputation and working failure recovery. The recorded interaction must work before any public catalog entry: a meaningful default, keyboard/touch and mobile support, dark mode, reduced motion, stale-result protection, and an export that preserves protocol/model/input identity. Link each displayed claim to evidence and credit Yarats with the MIT code and Apache/NOTICE model terms where applicable.

Keep the earlier local-study results, Core ML exports and validation-selected installed default unchanged. This ticket does not authorize training, default promotion or image-performance claims. The root-owned implementation checklist will track adapter, protocol, evaluation and scene work separately after this decision is reviewed.
